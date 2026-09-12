// Confinement (@mediabase/confine + the sandboxed plugin path): what a CHILD PROCESS
// is actually prevented from doing.
//
// Process isolation contains a crash; it does not restrict a hostile module — the
// child runs as the same user with the same filesystem and network. These tests are
// about the restriction itself, and about the honesty of its reporting:
//
//   1. the planner turns a declarative policy into flags/wrappers, per platform
//      (pure functions: the policy is reviewable text);
//   2. availability is PROBED BY EXECUTION, and a mechanism that cannot be applied
//      is reported with its own error — never assumed;
//   3. a real confined child is denied out-of-root reads/writes, spawn, workers and
//      (where an OS mechanism exists) network, while its declared data dir works;
//   4. a policy marked `required` FAILS CLOSED when a denial is unavailable, so a
//      plugin can never run with less confinement than it declared.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  bubblewrapArgs,
  defaultProbe,
  nodePermissionArgs,
  planConfinement,
  resolveRoots,
  seatbeltProfile,
  type Probe,
} from '../packages/base/confine/src/index.ts'
import * as log from '../packages/base/log/src/index.ts'
import { IDENTITY } from '../apps/cli/src/identity.ts'
import * as api from '../packages/host/api/src/index.ts'
import * as plugins from '../packages/host/plugins/src/index.ts'
import { sandboxEntryFor } from '../packages/host/plugins/src/index.ts'
import { RpcCode } from '../packages/base/rpc/src/index.ts'
import { ROOT } from './support/host.ts'
import type { LogRecord } from '../packages/base/log/src/index.ts'
import type { PluginEntry } from '../packages/host/plugins/src/index.ts'

const settle = (ms = 20): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

const made: string[] = []
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

const probe = (available: Probe['available'], unavailable: Probe['unavailable'] = [], platform: NodeJS.Platform = 'darwin'): Probe =>
  ({ platform, available, unavailable })

describe('@mediabase/confine: the plan is the policy, as text', () => {
  it('realpath-resolves roots (an unresolved symlink denies what it meant to allow)', () => {
    const target = tempDir('avstudio-confine-target-')
    const link = join(tempDir('avstudio-confine-link-'), 'link')
    symlinkSync(target, link)
    mkdirSync(join(target, 'sub'), { recursive: true })
    const roots = resolveRoots({ read: [link], write: [join(link, 'sub')] })
    // BOTH spellings are allowed, because Node's permission model compares the
    // requested path against the allowance literally: macOS /tmp vs /private/tmp are
    // one directory and two strings, and a relative lookup is resolved against a
    // realpath'd cwd.
    expect(roots.read).toEqual([link, realpathSync(target)])
    expect(roots.write).toEqual([join(link, 'sub'), join(realpathSync(target), 'sub')])
    // A root that does not exist yet (a data dir the caller is about to create)
    // falls back to an absolute path instead of throwing.
    expect(resolveRoots({ write: [join(link, 'not-yet')] }).write).toEqual([join(link, 'not-yet')])
    // No duplicates when the two forms coincide (and a trailing slash in the input
    // must not produce a second, subtly different entry).
    expect(resolveRoots({ read: [`${ROOT}/`] }).read).toHaveLength(1)
  })

  it('builds permission flags without the escape hatches', () => {
    const args = nodePermissionArgs({ read: ['/a'], write: ['/b'] })
    expect(args[0]).toBe('--permission')
    expect(args).toContain('--allow-fs-read=/a')
    expect(args).toContain('--allow-fs-write=/b')
    // Node warns these "could invalidate the permission model" — a confined child
    // that can spawn an unconfined grandchild is not confined.
    expect(args.join(' ')).not.toContain('--allow-child-process')
    expect(args.join(' ')).not.toContain('--allow-worker')
    expect(args.join(' ')).not.toContain('--allow-addons')
  })

  it('writes a reviewable Seatbelt profile (network + write denials, declared writes back)', () => {
    const profile = seatbeltProfile({ read: ['/app'], write: ['/data/pl"ug'] }, { denyNetwork: true })
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(subpath "/data/pl\\"ug")')
    expect(profile).toContain('(literal "/dev/null")') // the child must still be able to log
    const noNetwork = seatbeltProfile({ read: ['/app'], write: [] }, {})
    expect(noNetwork).not.toContain('(deny network*)')
  })

  it('builds bubblewrap args for the Linux path', () => {
    const args = bubblewrapArgs({ read: ['/app'], write: ['/data'] }, { denyNetwork: true })
    expect(args).toContain('--unshare-net')
    expect(args).toContain('--unshare-pid')
    expect(args).toContain('--bind')
    expect(bubblewrapArgs({ read: ['/app'], write: [] }, {}).includes('--unshare-net')).toBe(false)
  })

  it('never claims a denial it cannot enforce', () => {
    // Node layer only (this machine's reality: Seatbelt exists but refuses to apply).
    const degraded = planConfinement(
      { read: ['/app'], write: ['/data'], denyNetwork: true },
      { probe: probe(['node-permission'], [{ mechanism: 'seatbelt', reason: 'sandbox_apply: Operation not permitted' }]) },
    )
    expect(degraded.complete).toBe(false)
    expect(degraded.enforced.network).toBe('inherit')
    expect(degraded.enforced.filesystem).toBe('read-write')
    expect(degraded.enforced.processes).toBe('deny')
    expect(degraded.unavailable[0]).toEqual({ mechanism: 'seatbelt', reason: 'sandbox_apply: Operation not permitted' })
    // The reason a user needs is the mechanism's own words, and the plan says so.
    expect(degraded.describe()).toContain('sandbox_apply: Operation not permitted')
    expect(degraded.spawn('/entry.ts').bin).toBe(process.execPath)

    // Both layers: complete, and the OS wrapper is outermost.
    const full = planConfinement(
      { read: ['/app'], denyNetwork: true },
      { probe: probe(['node-permission', 'seatbelt']) },
    )
    expect(full.complete).toBe(true)
    expect(full.enforced.network).toBe('deny')
    const spawn = full.spawn('/entry.ts', ['--import', 'tsx'])
    expect(spawn.bin).toBe('sandbox-exec')
    expect(spawn.args[0]).toBe('-p')
    // The OS wrapper is outermost; the entry stays last, so the child's own flags
    // (a loader, for instance) are untouched.
    expect(spawn.args.join(' ')).toContain('--permission --allow-fs-read=')
    expect(spawn.args).toContain('--import')
    expect(spawn.args.at(-1)).toBe('/entry.ts')
  })

  it('names a mechanism only where that mechanism can exist (the report must not misdiagnose)', () => {
    // Windows has neither Seatbelt nor Bubblewrap. Reporting "bubblewrap unavailable"
    // there sends the reader after a Linux tool: the honest answer is that the PLATFORM
    // has no OS sandbox layer, so the network denial simply cannot be had.
    const windows = planConfinement(
      { read: ['C:\\app'], write: ['C:\\data'], denyNetwork: true },
      { probe: probe(['node-permission'], [], 'win32') },
    )
    expect(windows.complete).toBe(false)
    expect(windows.enforced.network).toBe('inherit')
    expect(windows.enforced.filesystem).toBe('read-write')
    expect(windows.unavailable).toHaveLength(1)
    expect(windows.unavailable[0]!.mechanism).toBe('no-os-mechanism')
    // ...and the reason says WHY, naming the platforms each mechanism belongs to.
    expect(windows.unavailable[0]!.reason).toContain('win32')
    expect(windows.unavailable[0]!.reason).toContain('Seatbelt')
    expect(windows.unavailable[0]!.reason).toContain('Bubblewrap')
    expect(windows.describe()).toContain('no-os-mechanism')
    // No Linux/macOS tool is mentioned as if it were the missing piece here.
    expect(windows.describe()).not.toMatch(/未生效=bubblewrap|未生效=seatbelt/)
    // A non-mechanism can never enter the plan itself, only the report.
    expect(windows.layers).toEqual(['node-permission'])
    expect(windows.spawn('C:\\entry.js').bin).toBe(process.execPath)

    // Where the mechanism DOES belong to the platform, it is still named directly —
    // and its own failure text is preserved.
    const mac = planConfinement(
      { read: ['/app'], denyNetwork: true },
      { probe: probe(['node-permission'], [{ mechanism: 'seatbelt', reason: 'sandbox_apply: Operation not permitted' }], 'darwin') },
    )
    expect(mac.unavailable[0]).toEqual({ mechanism: 'seatbelt', reason: 'sandbox_apply: Operation not permitted' })
    const linux = planConfinement(
      { read: ['/app'], denyNetwork: true },
      { probe: probe(['node-permission'], [{ mechanism: 'bubblewrap', reason: 'bwrap: No such file or directory' }], 'linux') },
    )
    expect(linux.unavailable[0]?.mechanism).toBe('bubblewrap')
    expect(linux.unavailable[0]?.reason).toBe('bwrap: No such file or directory')
  })

  it('reports a missing Node layer instead of pretending, and needs a read root', () => {
    const noNode = planConfinement(
      { read: ['/app'], write: ['/data'] },
      { probe: probe([], [{ mechanism: 'node-permission', reason: 'unknown option --permission' }]) },
    )
    expect(noNode.enforced.filesystem).toBe('inherit')
    expect(noNode.unavailable[0]?.mechanism).toBe('node-permission')
    expect(noNode.spawn('/e.ts').args).toEqual(['/e.ts']) // no flags it cannot honour

    // Process denial needs a readable root: under --permission with no allowances
    // the child cannot even read its own entry file.
    const noRoots = planConfinement({ confineProcesses: true }, { probe: probe(['node-permission']) })
    expect(noRoots.enforced.processes).toBe('inherit')
    expect(noRoots.unavailable.some((u) => u.reason.includes('read 根'))).toBe(true)
  })

  it('probes this machine by RUNNING the mechanisms', () => {
    // Whatever the answer is, it must come with usable evidence: a reason for every
    // mechanism that is not available.
    const here = defaultProbe()
    expect(here.platform).toBe(process.platform)
    for (const u of here.unavailable) {
      expect(u.reason.length).toBeGreaterThan(0)
      expect(here.available).not.toContain(u.mechanism)
    }
    // The Node layer is the portable one; if this Node lacks it, the suite below
    // would be meaningless, so make that failure explicit rather than silent.
    expect(here.available).toContain('node-permission')
  })
})

// ---- the real thing: a confined child process ------------------------------

const PROBE_PLUGIN = `
export const name = 'confined-probe'

export const api = {
  probe: async () => {
    const dataDir = process.env.MEDIABASE_PLUGIN_DATA_DIR ?? ''
    const rows = []
    const attempt = async (what, fn) => {
      try {
        const value = await fn()
        rows.push({ what, allowed: true, detail: typeof value === 'string' ? value : 'ok' })
      } catch (e) { rows.push({ what, allowed: false, detail: e.code ?? e.message ?? String(e) }) }
    }
    await attempt('read-outside', () => readFileSync('/etc/hosts', 'utf8').length)
    await attempt('read-module', () => readFileSync(new URL(import.meta.url).pathname, 'utf8').length)
    await attempt('write-data-dir', () => writeFileSync(join(dataDir, 'probe.txt'), 'ok'))
    await attempt('write-outside', () => writeFileSync('/tmp/avstudio-confinement-should-not-exist.txt', 'x'))
    await attempt('spawn', () => execSync('echo should-not-run'))
    await attempt('worker', () => new Worker('1', { eval: true }))
    await attempt('network', () => new Promise((resolve, reject) => {
      const socket = connect(1, '127.0.0.1')
      socket.on('connect', () => { socket.destroy(); resolve('connected') })
      // A refused connection still proves the OS allowed the socket to be opened.
      socket.on('error', (e) => e.code === 'ECONNREFUSED' ? resolve('socket allowed') : reject(e))
    }))
    return rows
  },
}

export function apply(ctx) { ctx.log.info('confined probe started') }
`

/**
 * Write the probe plugin inside the repo: the child is confined to the declared
 * read roots (default: the app root), so a module outside them would be denied by
 * the policy itself and the test would be measuring the wrong thing.
 */
function probeModule(): string {
  mkdirSync(join(ROOT, 'tests/.tmp-plugins'), { recursive: true })
  const file = join(ROOT, 'tests/.tmp-plugins', `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, `import { readFileSync, writeFileSync } from 'node:fs'\nimport { execSync } from 'node:child_process'\nimport { join } from 'node:path'\nimport { connect } from 'node:net'\nimport { Worker } from 'node:worker_threads'\n${PROBE_PLUGIN}`)
  made.push(file)
  return file
}

interface Fixture {
  ctx: Context
  records: LogRecord[]
  load: (id: string) => Promise<unknown>
  call: (id: string, method: string, args?: unknown[]) => Promise<unknown>
  probePlugin: (id: string) => Promise<{ state: string; confined?: boolean; confinement?: string | null }>
}

async function compose(entry: PluginEntry): Promise<Fixture> {
  const ctx = new Context()
  const records: LogRecord[] = []
  ctx.plugin(log, { level: 'debug', scope: IDENTITY.bin, sink: (r) => records.push(r) })
  await settle(0)
  ctx.plugin(api)
  await settle(0)
  await ctx.plugin(plugins, {
    catalog: [entry],
    root: ROOT,
    dataRoot: join(tempDir('avstudio-plugin-data-'), 'data'),
    // The SAME entry resolution the app uses (a confined child cannot start under
    // a worker-based transpiler loader — see @mediabase/confine).
    sandbox: { ...sandboxEntryFor(ROOT, {})!, applyTimeoutMs: 15_000, callTimeoutMs: 15_000 },
  })
  await settle(0)
  const service = ctx.get('plugins')!
  return {
    ctx,
    records,
    load: (id) => service.load(id),
    // Through the control plane, exactly as a UI or the agent would call it.
    call: (id, method, args) => ctx.api.call('plugins.call', { id, method, args: args ?? [] }),
    probePlugin: async (id) => service.probe(id) as Promise<{ state: string; confined?: boolean; confinement?: string | null }>,
  }
}

describe('a confined sandboxed plugin', () => {
  it('is denied out-of-root files, spawn and workers, while its data dir works', async () => {
    const fx = await compose({
      id: 'confined',
      module: probeModule(),
      requires: [],
      isolation: 'process',
      restarts: 0,
      // Policy as a plugin author would declare it: strict defaults.
      confinement: {},
    })
    try {
      await fx.load('confined')
      const rows = await fx.call('confined', 'probe') as Array<{ what: string; allowed: boolean; detail: string }>
      const by = (what: string): { allowed: boolean; detail: string } => rows.find((r) => r.what === what)!

      // Enforcement, observed BY THE CHILD (not asserted from the outside).
      expect(by('read-outside').allowed, 'reading /etc/hosts must be denied').toBe(false)
      expect(by('read-outside').detail).toBe('ERR_ACCESS_DENIED')
      expect(by('write-outside').allowed, 'writing outside the write roots must be denied').toBe(false)
      expect(by('spawn').allowed, 'spawning a child must be denied').toBe(false)
      expect(by('worker').allowed, 'a worker thread must be denied').toBe(false)
      // ...and the plugin is still a working plugin: its module and its own data dir.
      expect(by('read-module').allowed).toBe(true)
      expect(by('write-data-dir').allowed, 'the declared data dir must be writable').toBe(true)

      // Network is the OS layer's job. Claim only what the plan claims: on a machine
      // where the mechanism is unavailable the child is NOT network-confined, and the
      // probe must show that rather than hide it.
      const plan = planConfinement({ read: [ROOT], write: [join(ROOT, '.tmp')], denyNetwork: true })
      if (plan.enforced.network === 'deny') {
        expect(by('network').allowed, 'network must be denied when the OS layer is active').toBe(false)
      } else {
        // Not confined: the child IS allowed to open a socket (nothing listens on
        // port 1, so the connection itself is refused). Reporting this honestly is
        // the point — a plan that cannot deny network must not look like it did.
        expect(by('network').allowed).toBe(true)
        expect(by('network').detail).toBe('socket allowed')
        expect(plan.unavailable.some((u) => u.mechanism === 'seatbelt' || u.mechanism === 'bubblewrap')).toBe(true)
      }

      // The entry this repo resolves needs no worker loader, so nothing was given
      // up for it; when it does (tsx), the plan says so instead of silently
      // allowing workers.
      const entryPlan = planConfinement({ read: [ROOT], confineProcesses: true, allowWorker: true })
      expect(entryPlan.enforced.processes).toBe('inherit')
      expect(entryPlan.unavailable.some((u) => u.reason.includes('worker'))).toBe(true)

      // The status a UI/log sees must carry the enforced level AND the gap.
      const probed = await fx.probePlugin('confined')
      expect(probed.state).toBe('loaded')
      expect(probed.confined).toBe(true)
      expect(probed.confinement).toContain('node-permission')
      expect(probed.confinement).toContain(plan.enforced.network === 'deny' ? '网络=禁止' : '网络=未限制')
      // The warning is logged at load time, so the gap is visible without asking.
      expect(fx.records.some((r) => r.msg.includes('沙箱限制'))).toBe(true)
    } finally {
      await fx.ctx.fiber.dispose()
    }
  }, 60_000)

  it('refuses to load at all when a required denial cannot be enforced', async () => {
    const here = defaultProbe()
    const fx = await compose({
      id: 'strict',
      module: probeModule(),
      requires: [],
      isolation: 'process',
      restarts: 0,
      // Fail closed: the plugin promises "no network", and this machine cannot
      // deliver it, so running it would be a lie.
      confinement: { required: true },
    })
    try {
      const failure = await fx.load('strict').then(() => null, (e: { code?: number; message: string; messageKey?: string }) => e)
      if (here.available.includes('seatbelt') || here.available.includes('bubblewrap')) {
        // A machine with a working OS layer: the policy is satisfied, so it loads.
        expect(failure).toBeNull()
      } else {
        expect(failure?.code).toBe(RpcCode.UNAVAILABLE)
        expect(failure?.message).toContain('无法完全生效')
        expect(failure?.messageKey).toBe('plugins.confinementUnavailable')
        // The reason is the mechanism's own words, and nothing was loaded.
        expect(failure?.message).toContain(defaultProbe().unavailable[0]!.reason)
        expect((await fx.probePlugin('strict')).state).not.toBe('loaded')
      }
    } finally {
      await fx.ctx.fiber.dispose()
    }
  }, 60_000)

  it('refuses a confinement policy on an in-process plugin instead of ignoring it', async () => {
    const fx = await compose({
      id: 'inproc',
      module: probeModule(),
      requires: [],
      // No isolation: the plugin shares the host's privileges, so the policy cannot
      // take effect — a silent no-op would leave a false sense of a boundary.
      confinement: {},
    })
    try {
      const failure = await fx.load('inproc').then(() => null, (e: { code?: number; message: string }) => e)
      expect(failure?.code).toBe(RpcCode.INVALID_PARAMS)
      expect(failure?.message).toContain('isolation')
    } finally {
      await fx.ctx.fiber.dispose()
    }
  }, 30_000)

  it('loads the shipped example under the same policy (the demo the GUI calls)', async () => {
    const fx = await compose({
      id: 'sandboxed-demo',
      module: join(ROOT, 'examples/plugins/sandboxed-demo.ts'),
      requires: [],
      isolation: 'process',
      restarts: 0,
      confinement: {},
    })
    try {
      await fx.load('sandboxed-demo')
      const rows = await fx.call('sandboxed-demo', 'probeConfinement') as Array<{ what: string; allowed: boolean }>
      expect(rows.find((r) => r.what === 'read-outside')?.allowed).toBe(false)
      expect(rows.find((r) => r.what === 'write-data-dir')?.allowed).toBe(true)
      // Its normal API still works: confinement must not break a working plugin.
      expect(await fx.call('sandboxed-demo', 'sum', [[1, 2, 3]])).toBe(6)
      expect(await fx.call('sandboxed-demo', 'describe')).toContain('sandboxed plugin')
    } finally {
      await fx.ctx.fiber.dispose()
    }
  }, 60_000)
})
