// @mediabase/confine — declarative confinement for a CHILD process.
//
// A child process is not automatically a boundary. The child of a Node host runs
// as the same user, with the same filesystem and network access, so "run it in a
// process" contains a crash and a runaway loop — not a hostile module.
//
// This package turns a declarative policy into the two mechanisms that DO restrict
// the child, and it never claims more than it enforces:
//
//   1. `node-permission` — Node's own permission model (`--permission`): denies
//      filesystem access outside the declared roots, plus spawning child
//      processes, worker threads and native addons. Portable, and available
//      wherever the host's Node supports it — verified by RUNNING it.
//   2. `seatbelt` (macOS `sandbox-exec`) / `bubblewrap` (Linux `bwrap`) — the OS
//      layer, which is the only way to express what the Node model cannot:
//      **network denial** (Node has no `--allow-net`), plus syscall/namespace
//      confinement independent of the runtime.
//
// Availability is probed by EXECUTION, not by `which` or a version check: a
// mechanism that exists but cannot be applied (a nested sandbox, a hardened
// kernel, a missing helper) is reported with the reason it gave. A caller that
// requires a denial it cannot get must fail closed — `complete` and `unavailable`
// are what that decision is made from, and `describe()` is what a log, a health
// payload or a plugin status line shows the user.
//
// The report is part of the honesty: a refused mechanism is named, but a platform
// with no mechanism at all is reported as `no-os-mechanism` rather than as some
// other platform's tool (see `UnavailableMechanism`).

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export type ConfineMechanism = 'node-permission' | 'seatbelt' | 'bubblewrap'

/**
 * What an `Unavailable` entry can name: a real mechanism that refused, or
 * `no-os-mechanism` for a platform that has none at all.
 *
 * The distinction exists because naming a mechanism that cannot exist on this
 * platform is a WRONG diagnosis, not a harmless label. Reporting "bubblewrap
 * unavailable" on Windows sends the reader looking for a Linux tool; the honest
 * report is "this platform has no OS sandbox layer". `available` and `layers`
 * stay `ConfineMechanism` — a non-mechanism must never be able to enter the
 * plan, only the report.
 */
export type UnavailableMechanism = ConfineMechanism | 'no-os-mechanism'

/** A requested denial that could not be enforced, and why. */
export interface Unavailable {
  mechanism: UnavailableMechanism
  reason: string
}

export interface ConfineRequest {
  /**
   * Directories/files the child may READ. The runtime (the Node binary, the
   * entry script and anything it loads) must live inside one of these, or the
   * child cannot start at all.
   */
  read?: string[]
  /** Directories the child may WRITE. Omitted or empty means read-only. */
  write?: string[]
  /**
   * Deny network access. Requires an OS mechanism — Node's permission model has
   * no network control, so this is reported as unavailable without one.
   */
  denyNetwork?: boolean
  /** Deny child processes, worker threads and native addons (default true). */
  confineProcesses?: boolean
  /**
   * The child's ENTRY needs worker threads (a transpiler loader such as tsx
   * registers its ESM hooks in a worker). Denying workers would make the child
   * unable to start, so the process denial is given up — and REPORTED, because a
   * silent weakening is exactly what a policy layer must never do.
   */
  allowWorker?: boolean
  /**
   * Fail closed: when a requested denial cannot be enforced, the caller should
   * refuse to run the child instead of quietly running it less confined. The
   * planner only reports; refusing is the caller's decision (see `complete`).
   */
  required?: boolean
}

/** Result of probing the mechanisms on this machine (memoized). */
export interface Probe {
  platform: NodeJS.Platform
  available: ConfineMechanism[]
  unavailable: Unavailable[]
}

export interface ResolvedRoots {
  read: string[]
  write: string[]
}

export interface Confinement {
  /**
   * What is ACTUALLY enforced — the only thing a caller may claim.
   * `inherit` means "as the host has it": no claim at all.
   */
  enforced: {
    filesystem: 'read-only' | 'read-write' | 'inherit'
    network: 'deny' | 'inherit'
    processes: 'deny' | 'inherit'
  }
  /** Layers that made it into the plan. */
  layers: ConfineMechanism[]
  /** Requested denials that are NOT enforced, with the mechanism's own reason. */
  unavailable: Unavailable[]
  /** True when everything requested is enforced. */
  complete: boolean
  /** Realpath-resolved roots the plan was built from (macOS: /tmp is /private/tmp). */
  roots: ResolvedRoots
  /** Binary + full argv to spawn, with `entry` last (and `nodeArgs` before it). */
  spawn(entry: string, nodeArgs?: string[]): { bin: string; args: string[] }
  /** One line for a log, a health payload or a status card. */
  describe(): string
}

export interface PlanOptions {
  platform?: NodeJS.Platform
  /** Node binary whose permission-model support is probed (default `process.execPath`). */
  execPath?: string
  /** Injected probe (tests, or a caller that already probed). */
  probe?: Probe
}

/**
 * Every root in BOTH forms it can be named by.
 *
 * Measured on Node 23: the permission model compares the path a child asks for
 * against the allowance LITERALLY (no symlink resolution). On macOS that cuts both
 * ways — `/tmp/x` and `/private/tmp/x` are the same directory but different
 * strings, and a relative path is resolved against a cwd that IS realpath'd. So a
 * single form silently denies half the intended accesses: allow the raw path and a
 * realpath-resolved lookup fails; allow only the realpath and the caller's own
 * spelling fails. Allowing both removes the guessing.
 *
 * A non-existent root (a data dir the caller is about to create) keeps its absolute
 * form only.
 */
export function resolveRoots(request: ConfineRequest): ResolvedRoots {
  const forms = (p: string): string[] => {
    const absolute = resolve(p)
    let real = absolute
    try {
      real = realpathSync(absolute)
    } catch {
      /* not created yet: the absolute form is all there is */
    }
    return real === absolute ? [absolute] : [absolute, real]
  }
  const all = (paths: string[] | undefined): string[] => [...new Set((paths ?? []).flatMap(forms))]
  return { read: all(request.read), write: all(request.write) }
}

/** `--allow-fs-read`/`--allow-fs-write` flags for Node's permission model. */
export function nodePermissionArgs(roots: ResolvedRoots, allowWorker = false): string[] {
  const args = ['--permission']
  for (const p of roots.read) args.push(`--allow-fs-read=${p}`)
  for (const p of roots.write) args.push(`--allow-fs-write=${p}`)
  // Deliberately no --allow-child-process / --allow-addons: Node itself warns that
  // those "could invalidate the permission model", and a confined child that can
  // spawn an unconfined grandchild is not confined.
  //
  // `--allow-worker` is the ONE exception, and only when the plan has already given
  // that denial up: an entry that cannot start without a transpiling loader (tsx
  // registers ESM hooks through a worker) would otherwise die at once while the
  // report claimed a policy the child never ran under. The give-up is named in
  // `enforced.processes` and in `unavailable` either way, so this is the reported
  // decision REACHING the child, not a quiet weakening.
  if (allowWorker) args.push('--allow-worker')
  return args
}

/**
 * A Seatbelt (macOS) profile for the request. Pure, so the policy can be read and
 * reviewed as text — and so a profile change is a unit test rather than a mystery
 * "it stopped working" report.
 *
 * `allow default` + targeted denies (rather than a whitelist) keeps the child
 * working with unknown-but-harmless syscalls while making the REQUESTED denials
 * absolute.
 */
export function seatbeltProfile(roots: ResolvedRoots, request: ConfineRequest): string {
  const quote = (p: string): string => `"${p.replace(/"/g, '\\"')}"`
  const lines = ['(version 1)', '(allow default)']
  if (request.denyNetwork === true) {
    lines.push('(deny network*)', '(deny system-socket)', '(deny mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))')
  }
  lines.push('(deny file-write*)', '(allow file-write*', '  (literal "/dev/null")', '  (literal "/dev/stdout")', '  (literal "/dev/stderr")', '  (literal "/dev/dtracehelper")')
  for (const p of roots.write) lines.push(`  (subpath ${quote(p)})`)
  lines.push(')')
  return lines.join('\n')
}

/**
 * Bubblewrap (Linux) argv. `--unshare-net` is the network denial; the rest is a
 * read-only view of the host filesystem with the declared write roots bound back
 * in read-write.
 */
export function bubblewrapArgs(roots: ResolvedRoots, request: ConfineRequest): string[] {
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']
  if (request.denyNetwork === true) args.push('--unshare-net')
  if (request.confineProcesses !== false) args.push('--unshare-pid')
  for (const p of roots.write) args.push('--bind', p, p)
  return args
}

/**
 * Run each mechanism to find out whether it is actually usable here, and keep the
 * failure text. Never throws: an unusable mechanism is data, not an exception.
 */
export function probeMechanisms(options: { platform?: NodeJS.Platform; execPath?: string } = {}): Probe {
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const available: ConfineMechanism[] = []
  const unavailable: Unavailable[] = []
  const attempt = (mechanism: ConfineMechanism, bin: string, args: string[]): void => {
    try {
      execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5_000 })
      available.push(mechanism)
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string; code?: string }
      const stderr = (typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? '').trim()
      const reason = stderr.split('\n').filter(Boolean).at(-1) ?? err.message ?? String(e)
      unavailable.push({ mechanism, reason: reason.replace(/^sandbox-exec:\s*/, '') })
    }
  }

  // Node's permission model: the only portable layer, so it is probed the same way
  // (an old Node must be a reported fact, not a boot crash).
  attempt('node-permission', execPath, ['--permission', '-e', ''])
  if (platform === 'darwin') {
    attempt('seatbelt', 'sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])
  } else if (platform === 'linux') {
    attempt('bubblewrap', 'bwrap', ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', execPath, '-e', ''])
  }
  return { platform, available, unavailable }
}

let cachedProbe: Probe | null = null

/** The probe result for this machine (cached: it shells out, and never changes). */
export function defaultProbe(options: { platform?: NodeJS.Platform; execPath?: string } = {}): Probe {
  cachedProbe ??= probeMechanisms(options)
  return cachedProbe
}

/** Reset the memo (tests that inject a platform). */
export function resetProbeCache(): void {
  cachedProbe = null
}

/**
 * Build the plan: what will be enforced, by which layers, and what was asked for
 * but cannot be enforced here.
 *
 * The asymmetry is deliberate: the Node layer is REQUIRED for a filesystem or
 * process policy (without it there is nothing to enforce), while the OS layer is
 * required only for network denial. A request that cannot be honoured is reported
 * in `unavailable` AND left out of `enforced` — never claimed and not delivered.
 */
export function planConfinement(request: ConfineRequest, options: PlanOptions = {}): Confinement {
  const probe = options.probe ?? defaultProbe(options)
  const roots = resolveRoots(request)
  const unavailable: Unavailable[] = []
  const layers: ConfineMechanism[] = []

  const nodeLayer = probe.available.includes('node-permission')
  const osMechanism: ConfineMechanism | undefined = probe.available.includes('seatbelt')
    ? 'seatbelt'
    : probe.available.includes('bubblewrap') ? 'bubblewrap' : undefined

  const fsRequested = roots.read.length > 0 || (request.write ?? []).length > 0
  if (fsRequested && !nodeLayer) {
    const why = probe.unavailable.find((u) => u.mechanism === 'node-permission')?.reason ?? 'unknown'
    unavailable.push({ mechanism: 'node-permission', reason: why })
  }
  if (request.allowWorker === true && request.confineProcesses !== false) {
    unavailable.push({
      mechanism: 'node-permission',
      reason: '该入口需要 worker 线程(转译加载器),已放弃对 worker/子进程的禁止',
    })
  }
  if (!fsRequested && request.confineProcesses === true) {
    // The Node layer needs a readable root: with `--permission` and no allowance
    // the child cannot even read its own entry file. Say so instead of silently
    // loading a process that is not confined.
    unavailable.push({
      mechanism: 'node-permission',
      reason: '未声明 read 根:开启权限模型后子进程连自己的入口文件都读不到',
    })
  }
  // The layer is only in the plan when the child can actually start under it.
  const nodeLayerApplied = fsRequested && nodeLayer
  if (nodeLayerApplied) layers.push('node-permission')
  if (request.denyNetwork === true) {
    if (osMechanism === undefined) {
      // Name the mechanism this platform WOULD have used and pass on its own words
      // ("sandbox_apply: Operation not permitted" is the actionable part). A platform
      // that has no such mechanism gets `no-os-mechanism`, never a tool it cannot run:
      // "bubblewrap unavailable" on Windows is a wrong diagnosis, not a harmless label.
      const wanted: UnavailableMechanism = probe.platform === 'darwin'
        ? 'seatbelt'
        : probe.platform === 'linux' ? 'bubblewrap' : 'no-os-mechanism'
      const why = wanted === 'no-os-mechanism'
        ? `此平台(${probe.platform})没有可用的 OS 沙箱机制 —— Seatbelt 仅 macOS、Bubblewrap 仅 Linux,因此网络限制无法生效`
        : probe.unavailable.find((u) => u.mechanism === wanted)?.reason
      unavailable.push({ mechanism: wanted, reason: why ?? `此平台没有可用的 ${wanted} 机制` })
    } else {
      layers.push(osMechanism)
    }
  }

  const writes = (request.write ?? []).length > 0
  const confinedFs = nodeLayerApplied
  const enforced: Confinement['enforced'] = {
    filesystem: confinedFs ? (writes ? 'read-write' : 'read-only') : 'inherit',
    network: request.denyNetwork === true && osMechanism !== undefined ? 'deny' : 'inherit',
    processes: nodeLayerApplied && request.confineProcesses !== false && request.allowWorker !== true ? 'deny' : 'inherit',
  }

  const nodeBin = options.execPath ?? process.execPath
  // One condition decides both the report and the spawn: `allowWorker` above says the
  // process denial was given up, and the child must be spawned with that same
  // decision (see nodePermissionArgs).
  const workerAllowed = request.allowWorker === true && request.confineProcesses !== false
  const spawn = (entry: string, nodeArgs: string[] = []): { bin: string; args: string[] } => {
    const nodeArgv = nodeLayerApplied ? [...nodePermissionArgs(roots, workerAllowed), ...nodeArgs, entry] : [...nodeArgs, entry]
    if (request.denyNetwork === true && osMechanism === 'seatbelt') {
      return { bin: 'sandbox-exec', args: ['-p', seatbeltProfile(roots, request), nodeBin, ...nodeArgv] }
    }
    if (request.denyNetwork === true && osMechanism === 'bubblewrap') {
      return { bin: 'bwrap', args: [...bubblewrapArgs(roots, request), nodeBin, ...nodeArgv] }
    }
    return { bin: nodeBin, args: nodeArgv }
  }

  const layersText = layers.length > 0 ? layers.join(' + ') : '无(未受限)'
  const describe = (): string => {
    const fs = enforced.filesystem === 'read-write'
      ? '读写(仅声明目录)'
      : enforced.filesystem === 'read-only' ? '只读(仅声明目录)' : '不限'
    const parts = [
      `层=${layersText}`,
      `文件系统=${fs}`,
      `子进程=${enforced.processes === 'deny' ? '禁止' : '允许'}`,
      `网络=${enforced.network === 'deny' ? '禁止' : '未限制'}`,
    ]
    if (unavailable.length > 0) {
      parts.push(`未生效=${unavailable.map((u) => `${u.mechanism}: ${u.reason}`).join(' · ')}`)
    }
    return parts.join(' · ')
  }

  return {
    enforced,
    layers,
    unavailable,
    complete: unavailable.length === 0,
    roots,
    spawn,
    describe,
  }
}
