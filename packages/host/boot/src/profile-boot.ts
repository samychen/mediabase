// @mediabase/boot — profile boot: compose a host from PATCH LAYERS.
//
// Ported from deepseek-harness `apps/cli/src/profile-boot.ts` (0.1.5-rc.2), with the
// same mechanism: the vendored pair the harness uses
//
//   @deepseek-ai/cordis-plugin-loader   mounts a tree from a YAML entry list
//   @deepseek-ai/cordis-plugin-include  supplies the `cordis:include` root and the
//                                       id-targeted patch semantics
//
// A profile lives in `<home>/profiles/<name>/`:
//
//   package.json       `<profileKey>.profile.bundles` — the bundle layers, in order
//   cordis.yml         the include ROOT: an empty entry list (rewritten every boot)
//   cordis.patch.yml   the profile's own layer — the file a deployment edits
//
// Layers, in application order (a later layer overrides an earlier row BY ID):
//
//   bundle layers → profile layer → $<PREFIX>HOME/cordis.patch.yml → --patch overlays
//
// Deliberate simplifications against the harness, stated rather than implied (the
// full list is in docs/STATUS.zh.md): startup-frozen patches (no live reload), no
// config dump, no `.env` layering, no telemetry row, and no per-profile
// node_modules projection — bundles and bare plugin names resolve from the
// installation anchor, so a profile outside the workspace still works.

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { Context, type FiberState } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { CapabilityEnv } from '@mediabase/protocol'
import { discoverCapabilities } from './dropins.ts'
import type { BootIdentity } from './identity.ts'

/** Profile-manifest key namespace (the diagnostic prefix comes from the boot identity). */
export const PROFILES_DIR = 'profiles'
/** The include root inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'
/** The profile's own patch layer. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
/** The machine-local layer, applied after every profile layer. */
export const HOME_PATCH_FILENAME = 'cordis.patch.yml'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Composition facts a `!!js` row reads: where the app and its state live, and what the
     * app is called (a row that needs a name — a log scope, a window title — takes it from
     * here instead of a base package hardcoding one).
     */
    appPaths: { root: string; home: string; bin: string }
    /** The deployment environment a `!!js` row reads: see `deploymentEnv`. */
    env: DeploymentEnv
  }
}

/**
 * The deployment environment a patch row may read from a `!!js` expression — the same
 * device the harness uses for `dshHomePath`: the composition states a deployment value
 * (`token: !!js ctx.env.str('TOKEN')`, resolved against the identity's prefix) without a
 * capability having to invent it,
 * and without number/flag/list parsing living in YAML.
 *
 * The readers FAIL LOUD on a value that cannot mean what it says: `ENGINE_FPS=ten`
 * stops the boot naming the variable, instead of silently becoming `NaN` or a default that
 * hides the typo. An unset (or empty) variable is `undefined`, which leaves the field
 * absent so the capability's own `Config` default applies.
 */
export interface DeploymentEnv {
  /** The vocabulary prefix in force (`MEDIABASE_`, `AVSTUDIO_`, …). */
  readonly prefix: string
  /** The full variable name a short one resolves to (`TOKEN` → `${prefix}TOKEN`). */
  name(variable: string): string
  /**
   * The app's own vocabulary, by SHORT name: a composition row says `TOKEN`, and the boot
   * prepends the prefix, so no row (and no base package) spells a product name.
   */
  str(variable: string): string | undefined
  num(variable: string): number | undefined
  flag(variable: string): boolean | undefined
  /** Separated list (default `,`), trimmed with empties dropped. */
  list(variable: string, separator?: string): string[] | undefined
  /**
   * A value from a fixed set, or `undefined` when it is unset, empty or not one of them.
   *
   * This is for knobs where a typo must NOT stop the boot: `LOG_LEVEL=verbose` yields
   * `undefined`, the schema default applies, and the reader stays the single place that
   * decides it (a capability no longer reads the environment itself).
   */
  choice<T extends string>(variable: string, allowed: readonly T[]): T | undefined
  /**
   * A variable the ENVIRONMENT owns, read WITHOUT the prefix: `PORT`, `PATH`, `HOME`.
   *
   * Keeping this explicit is the point — `str('HOME')` means `${prefix}HOME`, while
   * `raw('HOME')` is the user's home directory, and a reader should never have to guess
   * which one it is looking at.
   */
  raw(variable: string): string | undefined
  /** A NUMBER the environment owns, read without the prefix (`PORT`), failing loud on a typo. */
  rawNum(variable: string): number | undefined
}

/** Build the readers over one environment (the boot's env, not necessarily `process.env`). */
export function deploymentEnv(env: CapabilityEnv, prefix: string, bin: string): DeploymentEnv {
  const nameOf = (variable: string): string => `${prefix}${variable}`
  const read = (variable: string, unprefixed = false): string | undefined => {
    const value = env[unprefixed ? variable : nameOf(variable)]
    return value === undefined || value === '' ? undefined : value
  }
  const bad = (variable: string, value: string, want: string, unprefixed = false): never => {
    const name = unprefixed ? variable : nameOf(variable)
    throw new Error(`${bin}: 环境变量 ${name}=${JSON.stringify(value)} 不是${want}`)
  }
  return {
    prefix,
    name: nameOf,
    str: (variable) => read(variable),
    num: (variable) => {
      const value = read(variable)
      if (value === undefined) return undefined
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return bad(variable, value, '合法数字')
      return parsed
    },
    flag: (variable) => {
      const value = read(variable)
      if (value === undefined) return undefined
      if (value === '1' || value === 'true') return true
      if (value === '0' || value === 'false') return false
      return bad(variable, value, '布尔值(1/0/true/false)')
    },
    list: (variable, separator = ',') => {
      const value = read(variable)
      if (value === undefined) return undefined
      return value.split(separator).map((item) => item.trim()).filter(Boolean)
    },
    choice: <T extends string>(variable: string, allowed: readonly T[]): T | undefined => {
      const value = read(variable)
      return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
    },
    raw: (variable) => env[variable] === undefined || env[variable] === '' ? undefined : env[variable],
    rawNum: (variable) => {
      const value = read(variable, true)
      if (value === undefined) return undefined
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return bad(variable, value, '合法数字', true)
      return parsed
    },
  }
}

/** A shipped profile template (used when the profile directory does not exist yet). */
export interface ProfileTemplate {
  /** Ordered bundle layer package names. */
  bundles: readonly string[]
}

/** Shipped templates, by profile name. */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  web: { bundles: ['@mediabase/bundle-app'] },
  headless: { bundles: ['@mediabase/bundle-app'] },
}

/**
 * The user layer a first boot writes. It is generated FROM the identity on purpose: the file
 * a deployment reads must name the variables that deployment actually has (`MEDIABASE_HOME`
 * for the base, `AVSTUDIO_HOME` for AVStudio), never a product's name baked into the base.
 */
function profilePatchTemplate(identity: BootIdentity): string {
  return `# Your patch layer for this ${identity.bin} profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries. Target a row by id to replace its
# whole config, or insert new rows:
#
#   - id: server
#     config: { port: 4000 }
#   - insert:
#       - id: my-capability
#         name: './my-capability.mjs'
#
# \`!!js\` expressions are allowed under \`config\`. In scope: ctx.appPaths ({root, home})
# and ctx.env — deployment readers over the ${identity.envPrefix}* vocabulary, by SHORT name
# (str/num/flag/list/choice/raw, e.g. ctx.env.num('PORT') is ${identity.envPrefix}PORT).
#
# A patch REPLACES the targeted row's whole config, so restate every field the row needs
# (its root, and any env-derived value the deployment wants) instead of only the changed
# one — see packages/bundle/app/cordis.patch.yml for the rows and their full configs.
[]
`
}

/** The include root: an empty entry list, rewritten on every boot. */
function profileRootConfig(identity: BootIdentity): string {
  return `# ${identity.bin} profile root — an empty entry list. The tree is composed as patches:
# every bundle layer, then cordis.patch.yml, then $${identity.envPrefix}HOME/cordis.patch.yml,
# then any --patch overlays. Edit cordis.patch.yml, not this file.
[]
`
}

interface ProfileManifest {
  [scope: string]: { profile?: { bundles?: string[] } } | unknown
}

/**
 * `${envPrefix}HOME` or `~/${homeDir}`: where profiles and persisted state live.
 *
 * The identity (not this function) decides both names, so the same code serves the neutral
 * base and any product built on it.
 */
export function resolveHome(env: CapabilityEnv, identity: BootIdentity): string {
  const fromEnv = env[`${identity.envPrefix}HOME`]
  return fromEnv !== undefined && fromEnv !== '' ? resolve(fromEnv) : join(homedir(), identity.homeDir)
}

/** The profile directory for `name`; the path need not exist yet. */
export function resolveProfileDir(name: string, home: string, bin: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`${bin}: 非法 profile 名 ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

/**
 * Write the profile files a first boot needs: the manifest carrying the bundle list,
 * the (empty) user patch layer, and nothing else. Existing files are left alone — a
 * deployment's edits are the point of the directory.
 */
export function initProfile(dir: string, bundles: readonly string[], identity: BootIdentity): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: ProfileManifest & { name: string; private: boolean; dependencies: Record<string, string> } = {
      name: `${identity.bin}-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      [identity.profileKey]: { profile: { bundles: [...bundles] } },
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, profilePatchTemplate(identity))
}

/**
 * Parse one patch list. `required` separates a file the caller NAMED (a bundle or a
 * `--patch` overlay: missing is a misconfiguration) from an optional layer (a profile
 * or home patch file that may legitimately be absent).
 */
export function loadPatches(file: string, required: boolean, bin: string): PatchOptions[] | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (e) {
    if (!required && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${bin}: 无法读取 patch 文件 ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  let parsed: unknown
  try {
    // The same YAML dialect the include mounts: `!!js` scalars survive as expression
    // nodes for the Loader to evaluate at entry activation.
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (e) {
    throw new Error(`${bin}: patch 文件不是合法 YAML(${file}): ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${bin}: patch 文件顶层必须是数组(loader patch 条目): ${file}`)
  }
  return parsed as PatchOptions[]
}

/**
 * Resolve a bundle PACKAGE to its directory. The installation anchor is tried first
 * (a workspace/installation owns its bundles), then the profile directory (a
 * deployment may install a bundle of its own beside the profile).
 */
export function resolveBundleDir(
  packageName: string,
  anchorManifest: string,
  profileDir: string,
  bundledDirs: readonly string[] = [],
  bin = 'boot',
): string {
  // 1) the installation (a checkout: `pnpm install` linked the bundles),
  // 2) the profile's own directory (a deployment may install a bundle beside it),
  // 3) a CLOSED BUNDLE DIR beside the running entry (`<host dir>/bundles/<name>/`) — how a
  //    packaged app ships its layer, because on the target machine there is no repo and no
  //    node_modules to resolve from. Same "beside the entry" rule as the plugin manifest.
  for (const anchor of [anchorManifest, join(profileDir, 'package.json')]) {
    try {
      return dirname(createRequire(anchor).resolve(`${packageName}/package.json`))
    } catch {
      /* try the next anchor */
    }
  }
  for (const dir of bundledDirs) {
    const candidate = join(dir, packageName, 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
  }
  throw new Error(
    `${bin}: 无法解析 bundle ${JSON.stringify(packageName)}`
    + `(从安装锚点、${profileDir}${bundledDirs.length > 0 ? ` 或 ${bundledDirs.join(', ')}` : ''});`
    + '先运行 pnpm install,或把它装进 bundle 目录',
  )
}

/**
 * Bundle directories a PACKAGED host ships beside itself (`<entry dir>/bundles/`).
 *
 * The host bundle is one file, but a bundle is a directory with a manifest and a patch layer;
 * shipping it next to the entry keeps the packaged app resolvable without a repo or a
 * `node_modules`. `undefined` entry (an embedder without argv) means no such directory.
 */
export function bundledBundleDirs(entry: string | undefined = process.argv[1]): string[] {
  if (entry === undefined) return []
  const dir = join(dirname(resolve(entry)), 'bundles')
  return existsSync(dir) ? [dir] : []
}

/** One bundle's contribution: the layer file and the patches it holds. */
export interface BundleLayer {
  packageName: string
  patchPath: string
  patches: PatchOptions[]
}

/** A loaded profile: its bundle layers in order, plus its own patch layer. */
export interface Profile {
  name: string
  dir: string
  /** Absolute paths of the bundle patch files, for diagnostics. */
  bundlePatchPaths: string[]
  /** The same bundle patches, flattened — the view a mount uses. */
  bundlePatches: PatchOptions[]
  /** One entry per bundle, in application order (what `--dump-config` labels). */
  bundleLayers: BundleLayer[]
  /** The profile's own patch file (may be absent). */
  profilePatchPath: string
  profilePatches: PatchOptions[]
}

/** Read a profile's manifest and resolve every bundle layer it names. */
export function loadProfile(
  name: string,
  home: string,
  anchorManifest: string,
  bundledDirs: readonly string[] = [],
  identity: BootIdentity,
): Profile {
  const dir = resolveProfileDir(name, home, identity.bin)
  const manifestPath = join(dir, 'package.json')
  let manifest: ProfileManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
  } catch (e) {
    throw new Error(`${identity.bin}: 无法读取 profile 清单 ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  const scope = manifest[identity.profileKey] as { profile?: { bundles?: string[] } } | undefined
  const bundles = scope?.profile?.bundles ?? []
  if (!Array.isArray(bundles)) {
    throw new Error(`${identity.bin}: profile 清单的 ${identity.profileKey}.profile.bundles 必须是数组: ${manifestPath}`)
  }
  const bundleLayers: BundleLayer[] = []
  for (const packageName of bundles) {
    const bundleDir = resolveBundleDir(packageName, anchorManifest, dir, bundledDirs, identity.bin)
    const patchPath = join(bundleDir, PROFILE_PATCH_FILENAME)
    bundleLayers.push({ packageName, patchPath, patches: loadPatches(patchPath, true, identity.bin) ?? [] })
  }
  const bundlePatchPaths = bundleLayers.map((layer) => layer.patchPath)
  const bundlePatches = bundleLayers.flatMap((layer) => layer.patches)
  const profilePatchPath = join(dir, PROFILE_PATCH_FILENAME)
  return {
    name,
    bundleLayers,
    dir,
    bundlePatchPaths,
    bundlePatches,
    profilePatchPath,
    profilePatches: loadPatches(profilePatchPath, false, identity.bin) ?? [],
  }
}

/** Rows a patch list inserts, in order (what the tree will mount). */
export function insertedRows(patches: readonly PatchOptions[]): EntryOptions[] {
  return patches.flatMap((patch) => patch.insert ?? [])
}

export interface RunProfileOptions {
  /** Boot identity: the prefix, home directory and name this application uses. */
  identity: BootIdentity
  /**
   * Absolute path of the APP's package.json (the installation anchor). Bundles and bare
   * row names resolve from here — never from `@mediabase/boot`'s own manifest.
   */
  anchor: string
  /** Profile templates keyed by name; defaults to PROFILE_TEMPLATES. */
  templates?: Record<string, ProfileTemplate>
  /** Profile name (`web` by default). */
  profile: string
  /** Application root: repo root in dev, resource root when packaged. */
  root: string
  env?: CapabilityEnv
  /** `--patch <path>` overlays, in argv order. */
  patchFiles?: readonly string[]
}

export interface BootedProfile {
  ctx: Context
  profile: Profile
  /** Patch layers applied, in order — reported at boot so a deployment can see them. */
  layerFiles: string[]
  /** Closed-runtime manifest in use, when this installation ships one (see below). */
  pluginManifest?: string
}

/**
 * Cordis's `FiberState` is a const enum with no runtime object, so the three values an
 * audit needs are mirrored here — the same numbers deepseek-harness mirrors in its own
 * boot audit.
 */
const FIBER_PENDING = 0 as FiberState
const FIBER_ACTIVE = 2 as FiberState
const FIBER_FAILED = 3 as FiberState

/**
 * After the tree settles, reject entries with no fiber: a row whose module could not be
 * resolved is a broken composition, not a warning. `disabled` is the only valid fiber-less
 * state.
 */
export function assertEntriesLoaded(ctx: Context, bin: string): void {
  const loader = ctx.get('loader')
  if (loader === undefined) return
  const failed = [...loader.entries()].filter((entry) => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    throw new Error(`${bin}: 以下条目未能加载: ${failed.map((entry) => entry.options.name).join(', ')}(模块无法解析,原因见上面的日志)`)
  }
}

/**
 * Audit a SETTLED tree: every enabled entry must be ACTIVE.
 *
 * Without this, a row that failed to activate — a bad `Config` value, a missing service —
 * would be reported by the Loader and then IGNORED, and the host would come up missing a
 * capability with nothing failing. A patch layer that replaces a row's whole config and
 * forgets a required field is exactly how that happens, so the boot must say which row and
 * why (a pending entry names the service it waits for; a failed one keeps its own stack).
 */
export async function assertEntriesActivated(ctx: Context, bin: string): Promise<void> {
  assertEntriesLoaded(ctx, bin)
  const loader = ctx.get('loader')
  if (loader === undefined) return
  const failures: string[] = []
  const reasons: unknown[] = []
  for (const entry of loader.entries()) {
    const fiber = entry.fiber
    if (fiber === undefined || entry.disabled) continue
    if (fiber.state === FIBER_ACTIVE) continue
    if (fiber.state === FIBER_FAILED) {
      try {
        await fiber.await()
      } catch (error) {
        reasons.push(error)
        failures.push(`${entry.options.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    if (fiber.state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === undefined)
      failures.push(`${entry.options.name}: 仍在等待服务 ${missing.join(', ') || '(未知)'}`)
    } else {
      failures.push(`${entry.options.name}: fiber 状态 ${String(fiber.state)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${bin}: ${failures.length} 个条目没有激活\n${failures.join('\n')}`,
      reasons.length > 0 ? { cause: reasons[0] } : undefined,
    )
  }
}

/**
 * Report a boot failure with every reason it carries.
 *
 * The Loader mounts entries concurrently and reports a multi-entry failure as an
 * `AggregateError` whose `message` is only "loader entries failed to apply" — printing that
 * alone turns "which row, and why" into a dead end. A nested `AggregateError` is walked
 * rather than stringified, and the chain is kept indented so the cause is readable.
 */
export function describeBootFailure(e: unknown, depth = 0): string {
  const indent = '  '.repeat(depth)
  if (e instanceof AggregateError && e.errors.length > 0) {
    const head = `${indent}${e.message}(${e.errors.length} 个原因)`
    return [head, ...e.errors.map((inner) => describeBootFailure(inner, depth + 1))].join('\n')
  }
  const line = `${indent}${e instanceof Error ? e.message : String(e)}`
  // The Loader wraps its aggregate in a cause — `new Error('failed to apply loader entry …',
  // { cause })` — so a walk that stops at that Error prints the wrapper and nothing else:
  // exactly the dead end this function exists to prevent.
  const cause = e instanceof Error ? (e as { cause?: unknown }).cause : undefined
  if (cause === undefined || cause === e) return line
  const causeText = cause instanceof Error ? cause.message : String(cause)
  const nested = describeBootFailure(cause, depth + 1).split('\n')
  // A wrapper that already quotes its cause verbatim would print the same sentence twice;
  // keep what the cause CARRIES (an aggregate's reasons, or a cause of its own). Compare the
  // two sentences — not just the rendering — or a leaf cause is dropped from every chain.
  const quoted = `${'  '.repeat(depth + 1)}${causeText}`
  const redundant = causeText !== '' && line.includes(causeText) && nested[0] === quoted
  return [line, ...(redundant ? nested.slice(1) : nested)].join('\n')
}

/**
 * Every row `name` a layer declares, however deeply it is nested (`insert` lists, and a
 * patch that names `cordis:include` with its own `patches`).
 */
function rowNames(patches: readonly PatchOptions[]): Array<{ id: string; name: string }> {
  const found: Array<{ id: string; name: string }> = []
  const walkEntry = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walkEntry(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const entry = value as Record<string, unknown>
    if (typeof entry['name'] === 'string') {
      found.push({ id: typeof entry['id'] === 'string' ? entry['id'] : '(未命名)', name: entry['name'] })
    }
    for (const child of Object.values(entry)) walkEntry(child)
  }
  walkEntry(patches)
  return found
}

/**
 * Resolve every row specifier before the tree mounts, and fail naming the ROW.
 *
 * The Loader resolves a row relative to the profile directory, which works only because the
 * host runs under a loader that can also see the installation (`tsx` in a checkout). A host
 * with neither — a single-file bundle, a packaged app without the packages beside it —
 * fails with "loader entries failed to apply", which says nothing about WHICH row is
 * unresolvable or how to fix it. This pre-flight turns that into one actionable message,
 * and it is the runtime half of `scripts/verify-composition.mjs` (the static half).
 *
 * Relative (`./x.mjs`) names are left to the Loader: they resolve beside the profile, which
 * is what a deployment's own file expects. `cordis:*` are builtins. A bare name is resolved
 * from the installation anchor (or already replaced by the closed-runtime manifest, in which
 * case it is an absolute path that must exist — a stale manifest is a broken bundle).
 */
export function resolveRowSpecifiers(
  patches: readonly PatchOptions[],
  anchorManifest: string,
  pluginManifest: PluginManifest | undefined,
  bin: string,
): void {
  const require = createRequire(anchorManifest)
  // A closed runtime mounts bundled FILES, so a failure there is reported with both the
  // specifier the deployment wrote and the file it resolved to — otherwise the message
  // names a path nobody typed.
  const specifierOf = new Map(
    Object.entries(pluginManifest?.plugins ?? {}).map(([name, file]) => [file, name]),
  )
  const unresolved: string[] = []
  for (const row of rowNames(patches)) {
    if (row.name.startsWith('cordis:') || row.name.startsWith('.')) continue
    if (row.name.startsWith('/') || row.name.startsWith('file:')) {
      const file = row.name.startsWith('file:') ? fileURLToPath(row.name) : row.name
      if (!existsSync(file)) {
        const specifier = specifierOf.get(file)
        const shown = specifier === undefined ? row.name : `${specifier} → ${row.name}`
        unresolved.push(`行 "${row.id}": ${shown}(封闭运行时里没有这个文件,重新构建宿主)`)
      }
      continue
    }
    try {
      require.resolve(row.name)
    } catch {
      unresolved.push(`行 "${row.id}": ${row.name}`)
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `${bin}: 以下组合行无法从安装锚点解析(${anchorManifest}):\n  ${unresolved.join('\n  ')}\n`
      + '把该包加进锚点(或对应 bundle)的 dependencies,先运行 pnpm install;'
      + '相对路径的行则相对于 profile 目录解析。',
    )
  }
}

/** A closed runtime: the bare specifiers a host ships as its own bundled modules. */
export interface PluginManifest {
  path: string
  /** Bare specifier → absolute path of the bundled module. */
  plugins: Record<string, string>
}

/**
 * Load the closed-runtime manifest, when this installation ships one.
 *
 * A single-file host (`build/host.cjs`) has nothing beside it to resolve a row's bare name
 * from, so the build emits `plugins.json` next to it and the host mounts those files. The
 * lookup order is what makes a packaged app relocatable: `${prefix}PLUGIN_MANIFEST` wins
 * (the seam a test uses), then the manifest BESIDE THE RUNNING ENTRY (`process.argv[1]`, so a
 * copied `build/` directory carries its own runtime), then the one the installation anchor
 * implies (`<app>/build/plugins.json`, the checkout case). A packaged app that is neither
 * sets the env var, like every other `${prefix}*` path.
 */
export function loadPluginManifest(
  anchorManifest: string,
  env: CapabilityEnv,
  entry: string | undefined,
  prefix: string,
  bin: string,
): PluginManifest | undefined {
  const explicit = env[`${prefix}PLUGIN_MANIFEST`]
  const candidates = [
    ...(explicit !== undefined && explicit !== '' ? [resolve(explicit)] : []),
    ...(entry === undefined ? [] : [join(dirname(resolve(entry)), 'plugins.json')]),
    join(dirname(anchorManifest), '..', '..', 'build', 'plugins.json'),
  ]
  const path = candidates.find((candidate) => existsSync(candidate))
  if (path === undefined) return undefined
  let parsed: { plugins?: Record<string, string> }
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as { plugins?: Record<string, string> }
  } catch (e) {
    throw new Error(`${bin}: 封闭运行时清单不是合法 JSON(${path}): ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  const dir = dirname(path)
  const plugins: Record<string, string> = {}
  for (const [name, file] of Object.entries(parsed.plugins ?? {})) plugins[name] = resolve(dir, file)
  return { path, plugins }
}

/**
 * Replace the bare row names a closed runtime ships with the bundled files, so the Loader
 * imports what is actually there. Rows it does not ship are left alone: the pre-flight
 * reports them, which is the honest failure (a name missing from the manifest is a build
 * that did not include it, not something to paper over).
 */
export function applyPluginManifest(
  patches: readonly PatchOptions[],
  plugins: Record<string, string>,
): PatchOptions[] {
  const rewriteEntry = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteEntry)
    if (value === null || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'name' && typeof item === 'string' && plugins[item] !== undefined) out[key] = plugins[item]
      else out[key] = rewriteEntry(item)
    }
    return out
  }
  return patches.map((patch) => rewriteEntry(patch) as PatchOptions)
}

/** One layer, with the label a reader knows it by (a file path, or the drop-in marker). */
export interface CompositionLayer {
  label: string
  patches: PatchOptions[]
}

/** Everything a boot applies, resolved but NOT mounted — shared with `--dump-config`. */
export interface CompositionPlan {
  home: string
  dir: string
  anchor: string
  profile: Profile
  /** Layers in application order. The boot and the dump read the SAME list. */
  layers: CompositionLayer[]
  /** Flattened patches, in mount order (what the include receives). */
  patches: PatchOptions[]
  /**
   * `patches` with a closed runtime's bundled modules substituted for bare names — what the
   * Loader is actually given. Identical to `patches` for a checkout.
   */
  mountPatches: PatchOptions[]
  pluginManifest?: PluginManifest
  /** Files only, for the boot's layer report. */
  layerFiles: string[]
  /** The include root (`cordis.yml`) the tree is mounted over. */
  rootConfigPath: string
}

/**
 * Resolve a profile into the layers a boot would apply, WITHOUT mounting anything.
 *
 * Extracted so `--dump-config` cannot drift from the boot: one function decides which layers
 * exist, in what order, and with which patches — the boot renders them into a tree, the dump
 * renders them into a file a deployment can read. `bundlesOnly` is the recovery diagnostic
 * (`--dump-default-config`): it skips the profile's own layer, the machine-local layer, the
 * overlays and the drop-ins, so a broken user layer is never parsed.
 */
export async function planComposition(
  options: RunProfileOptions,
  { bundlesOnly = false }: { bundlesOnly?: boolean } = {},
): Promise<CompositionPlan> {
  const env = options.env ?? process.env
  const identity = options.identity
  const bin = identity.bin
  const home = resolveHome(env, identity)
  const dir = resolveProfileDir(options.profile, home, bin)
  // A packaged host ships its bundles beside its entry; a checkout resolves them from the
  // installation. Both are consulted, so the same profile works in either.
  const entry = process.argv[1]
  const templates = options.templates ?? PROFILE_TEMPLATES
  if (!existsSync(join(dir, 'package.json'))) {
    const template = templates[options.profile]
    if (template === undefined) {
      throw new Error(
        `${bin}: profile ${JSON.stringify(options.profile)} 不存在且没有内置模板`
        + `(已内置: ${Object.keys(templates).sort().join(', ')})`,
      )
    }
    initProfile(dir, template.bundles, identity)
  }

  // The installation anchor is the APP's package.json (passed by the caller), never this
  // package's own — bundles and bare plugin names resolve from the product that mounts them.
  const anchor = options.anchor
  const profile = loadProfile(options.profile, home, anchor, bundledBundleDirs(entry), identity)
  const homePatchPath = join(home, HOME_PATCH_FILENAME)
  const overlayFiles = (options.patchFiles ?? []).map((file) => resolve(file))

  const layers: CompositionLayer[] = profile.bundleLayers.map((layer) => ({
    label: layer.patchPath,
    patches: layer.patches,
  }))
  if (!bundlesOnly) {
    const homePatches = loadPatches(homePatchPath, false, bin) ?? []
    const overlays = overlayFiles.map((file) => ({ label: file, patches: loadPatches(file, true, bin) ?? [] }))
    // Drop-ins are a LAYER, not a special case: the files are discovered once and become
    // insert rows, so a third-party capability reaches the same registries.
    const dropIns = await discoverCapabilities(env, identity.envPrefix)
    if (existsSync(profile.profilePatchPath)) {
      layers.push({ label: profile.profilePatchPath, patches: profile.profilePatches })
    }
    if (existsSync(homePatchPath)) layers.push({ label: homePatchPath, patches: homePatches })
    layers.push(...overlays)
    if (dropIns.length > 0) {
      layers.push({
        label: `${identity.envPrefix}CAPABILITY_DIR(${dropIns.length})`,
        patches: [{ insert: dropIns.map((dropIn) => ({ id: dropIn.id, name: dropIn.path })) }],
      })
    }
  }

  const patches = layers.flatMap((layer) => layer.patches)
  // A closed runtime (a single-file host) ships its own bundled modules: mount those
  // instead of resolving names that are not installed beside the bundle.
  const manifest = loadPluginManifest(anchor, env, process.argv[1], identity.envPrefix, bin)
  const mountPatches = manifest === undefined ? patches : applyPluginManifest(patches, manifest.plugins)
  // Fail with the row's name before the Loader reports a nameless aggregate.
  resolveRowSpecifiers(mountPatches, anchor, manifest, bin)

  return {
    home,
    dir,
    anchor,
    profile,
    layers,
    patches,
    mountPatches,
    ...(manifest === undefined ? {} : { pluginManifest: manifest }),
    layerFiles: layers.map((layer) => layer.label),
    rootConfigPath: join(dir, PROFILE_ROOT_FILENAME),
  }
}

/**
 * Boot one profile: compose the layers, mount the tree over the include root, and wait
 * for every entry to activate. The caller owns signals and disposal (see
 * `apps/cli/src/index.ts`), so this function only reports what it composed.
 */
export async function runProfile(options: RunProfileOptions): Promise<BootedProfile> {
  const plan = await planComposition(options)
  const identity = options.identity
  const { mountPatches, pluginManifest: manifest, profile, layerFiles } = plan
  const { dir, rootConfigPath: rootConfig } = plan
  // Always rewritten: the root is a loader anchor, not a place to write rows. A
  // composed tree baked into it would duplicate every bundle insert on the next boot.
  writeFileSync(rootConfig, profileRootConfig(identity))

  const env = options.env ?? process.env
  const { home } = plan
  const ctx = new Context()
  // Relative includes inside the tree resolve against the profile directory.
  ctx.baseUrl = `${pathToFileURL(dir).href}/`
  ctx.reflect.provide('appPaths', { root: options.root, home, bin: identity.bin })
  // Both are read by `!!js` expressions in a row's config, evaluated when it activates.
  ctx.reflect.provide('env', deploymentEnv(env, identity.envPrefix, identity.bin))
  await ctx.plugin(Loader)
  // `cordis:include` is the file-backed root builtin (the profile's cordis.yml).
  ctx.loader.builtins.include = Include
  // Typed as an entry first: `create()` takes the row WITHOUT an id (it allocates one)
  // and returns it, so passing a literal with `id` would be an excess property.
  const rootInclude: EntryOptions = {
    id: 'include',
    name: 'cordis:include',
    config: { path: pathToFileURL(rootConfig).href, patches: mountPatches },
  }
  await ctx.loader.create(rootInclude)
  await ctx.get('loader')?.await()
  // A settled tree is not a WORKING tree: audit it before anyone calls it composed.
  await assertEntriesActivated(ctx, identity.bin)

  // The plan's labels ARE the layer report (a file path, or the drop-in marker).
  return {
    ctx,
    profile,
    layerFiles,
    ...(manifest === undefined ? {} : { pluginManifest: manifest.path }),
  }
}

