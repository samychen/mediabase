// @mediabase/plugins — host plugin: runtime plugin manager (E: hot load).
//
// Loads / unloads / reloads Cordis plugins **at runtime** through the same
// ctx.plugin() seam the CLI uses at boot. Unload disposes the plugin's fiber,
// which cordis uses to tear down every effect and unregister every service that
// fiber provided — no bespoke cleanup needed.
//
// Entries are resolved lazily (dynamic import) only on load(), so a missing
// module never breaks host boot.

import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { planConfinement, type Confinement, type ConfineRequest } from '@mediabase/confine'
import type {
  CapabilityEnv,
  PluginDescriptor,
  PluginProbe,
  PluginService,
} from '@mediabase/protocol'
import { SandboxedPlugin, type SandboxOptions } from './sandbox-host.ts'
import { parse, z, type Schema } from '@mediabase/schema'
import { RpcCode, RpcError } from '@mediabase/rpc'
import type {} from '@mediabase/api'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Runtime plugin manager. */
    plugins: PluginService
  }
}

/**
 * The neutral default prefix: a BASE package must not name a product. Every caller that
 * knows the deployment's prefix passes it (the plugin manager takes it from its `Config`,
 * which the row states as `envPrefix: !!js ctx.env.prefix`).
 */
export const DEFAULT_ENV_PREFIX = 'MEDIABASE_'

/** Plugin name (stable identity). */
export const name = 'plugins'

/** Services required before apply() runs. */
export const inject = ['api', 'capabilities', 'log'] as const

export interface PluginEntry {
  /** Stable id used by list/load/unload/reload. */
  id: string
  description?: string
  /** Absolute path of the plugin module (.ts/.mjs) providing apply(). */
  module: string
  /** Service names the plugin provides; probe() checks their presence. */
  provides?: string[]
  /**
   * Services the plugin is ALLOWED to consume. Everything else is refused at
   * access time, so a runtime plugin gets least privilege instead of the whole
   * host context. Omit to keep the previous "full context" behaviour.
   */
  requires?: string[]
  /**
   * `'in-process'` (default) mounts the module on this ctx with a restricted
   * context; `'process'` runs it in a SANDBOXED child process that can only reach
   * the host through the sandbox protocol (declared service calls, log, events,
   * its exported `api`). Process isolation contains crashes and lets the host
   * PREEMPT a plugin stuck in `apply()`; it is not an OS permission sandbox.
   */
  isolation?: 'in-process' | 'process'
  /** Restart a sandboxed plugin after an unexpected exit (default 0 = leave it down). */
  restarts?: number
  /**
   * Confinement for a sandboxed plugin (process isolation only). The defaults are
   * the strict ones — read = the app root + this module, write = the plugin's own
   * data dir, no subprocesses, network denied — because a plugin that asked for
   * process isolation has already opted into being contained.
   *
   * `required: true` means FAIL CLOSED: if a requested denial cannot be enforced
   * here (e.g. network on a machine whose OS sandbox refuses to apply), the load
   * is refused with the reason instead of running a less confined child.
   */
  confinement?: {
    /** Read roots (default: app root + this module's directory). */
    read?: string[]
    /** Write roots (default: this plugin's data dir). */
    write?: string[]
    /** Deny network (default true; needs an OS mechanism — see @mediabase/confine). */
    denyNetwork?: boolean
    /** Deny child processes/workers/addons (default true). */
    confineProcesses?: boolean
    /** Fail closed when a requested denial is unavailable (default: env override). */
    required?: boolean
  }
  /** Config handed to the plugin (sandbox: structured-cloned over IPC). */
  config?: unknown
}

export interface PluginsConfig {
  /** Runtime plugins this host may load; omitted = the shipped demo catalog. */
  catalog?: PluginEntry[]
  /**
   * The deployment's env vocabulary prefix (`MEDIABASE_`, `AVSTUDIO_`…), stated by the row as
   * `envPrefix: !!js ctx.env.prefix`. This capability is one of the two the base still lets
   * read the environment directly — the sandbox entry and the demo catalog are found by
   * variable, not by config — and it must do so without hardcoding a product name.
   */
  envPrefix?: string
  /**
   * Deployment-wide fail-closed switch for confinement: when true, a confined entry whose
   * policy cannot be fully enforced here is REFUSED instead of loaded with less
   * confinement than it declared. Per-entry `confinement.required` overrides it.
   */
  confinementRequired?: boolean
  /** Application root (default for read roots). */
  root?: string
  /** Where per-plugin writable data dirs live (default `<baseDir>/.avstudio`). */
  dataRoot?: string
  /** Where the sandbox entry script lives (bundled `.cjs` or the TS source). */
  sandbox?: SandboxOptions
}

interface FiberHandle {
  dispose(): Promise<void>
}

/** A loaded plugin, whichever isolation it uses. */
type LoadedPlugin =
  | { kind: 'in-process'; entry: PluginEntry; fiber: FiberHandle }
  | { kind: 'process'; entry: PluginEntry; sandbox: SandboxedPlugin; restarts: number }

/**
 * Cordis' own surface (lifecycle, events, reflection, plugin/isolate) always
 * stays available: it is the framework, not a capability. Anything else must be
 * declared in `requires`.
 */
const FRAMEWORK_MEMBERS = new Set([
  'get', 'set', 'provide', 'effect', 'plugin', 'isolate', 'on', 'once', 'off', 'emit',
  'events', 'reflect', 'fiber', 'lifecycle', 'registry', 'scope', 'root', 'config',
  'logger', 'log', 'then', 'constructor', 'toJSON', 'inspect',
])

/** Wrap a context so undeclared services throw instead of silently working. */
function restrictContext(fiberCtx: Context, id: string, allowed: readonly string[]): Context {
  const allow = new Set([...FRAMEWORK_MEMBERS, ...allowed])
  return new Proxy(fiberCtx, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || allow.has(prop)) return Reflect.get(target, prop, receiver)
      // Refuse BEFORE touching the target: cordis' own guard would otherwise fire
      // first with a message that says nothing about the plugin's declaration.
      // `ctx.get(name)` stays available (see FRAMEWORK_MEMBERS) for probing an
      // optional service without property access.
      throw new Error(
        `plugins: 插件 "${id}" 访问了未声明的服务 "${String(prop)}"` +
        `(在该插件条目里加 requires: ["${String(prop)}"],或用 ctx.get() 探测)`,
      )
    },
  })
}

/**
 * `${envPrefix}HELLO` points at the example plugin (compiled in packaged builds).
 *
 * The sandbox entry is resolved here too: a packaged host ships the compiled
 * `build/sandbox.cjs`, while a repo checkout runs the TypeScript source through
 * tsx. `${envPrefix}SANDBOX_ENTRY` overrides both.
 */
/**
 * Which child entry to spawn, and whether it needs a worker-based transpiler.
 *
 * The order matters for CONFINEMENT, not just for convenience: a confined child
 * cannot register worker threads, and `tsx` does exactly that to install its ESM
 * hooks. The bundled `.cjs` needs no loader; a checkout can run the TypeScript
 * source with Node's own type stripping (no loader, no worker); `tsx` is the last
 * resort and is reported as such (`requiresWorker`), because the policy layer must
 * never quietly give up the process denial.
 */
export function sandboxEntryFor(
  root: string,
  env: Record<string, string | undefined>,
  envPrefix = DEFAULT_ENV_PREFIX,
): SandboxOptions | undefined {
  const explicit = env[`${envPrefix}SANDBOX_ENTRY`]
  if (explicit !== undefined && explicit !== '') {
    // An explicit entry is the deployer's choice: assume it is self-contained
    // (bundled), which is what packaging passes.
    return { entry: explicit }
  }
  const bundled = join(root, 'build/sandbox.cjs')
  if (existsSync(bundled)) return { entry: bundled }
  const source = join(root, 'packages/host/plugins/sandbox/entry.ts')
  if (!existsSync(source)) return undefined
  // `process.features.typescript` is 'strip' when this runtime runs .ts by itself.
  const nativeTs = (process.features as { typescript?: string | boolean }).typescript
  if (nativeTs !== undefined && nativeTs !== false) {
    return { entry: source, nodeArgs: ['--disable-warning=ExperimentalWarning'] }
  }
  return { entry: source, nodeArgs: ['--import', 'tsx'], requiresWorker: true }
}

/**
 * One catalog entry, validated: a row in a composition states which modules this host
 * may load, and a typo ("isolation: sandbox") must stop the boot with a path instead of
 * loading a plugin with the WRONG isolation. `config` stays arbitrary — it is the
 * plugin's own schema, and this registry never interprets it.
 */
const entrySchema = z.object({
  id: z.string().required().description('stable id used by list/load/unload/reload'),
  description: z.string().description('human-readable purpose'),
  module: z.string().required().description('absolute path of the plugin module'),
  provides: z.array(z.string()).description('services the plugin provides'),
  requires: z.array(z.string()).description('services the plugin may consume (least privilege)'),
  isolation: z.union([z.const('in-process'), z.const('process')]).description("'process' = sandboxed child"),
  restarts: z.natural().description('restart a sandboxed plugin after a crash (default 0)'),
  confinement: z.object({
    read: z.array(z.string()).description('readable roots (default: app root + module dir)'),
    write: z.array(z.string()).description('writable roots (default: the plugin data dir)'),
    denyNetwork: z.boolean().description('deny network (default true)'),
    confineProcesses: z.boolean().description('deny subprocesses/workers/addons (default true)'),
    required: z.boolean().description('fail closed when a denial cannot be enforced'),
  }).description('confinement for a process-isolated entry'),
  config: z.any().description("the plugin's own config"),
})

/**
 * The DEPLOYMENT CONFIG for the plugin manager: the SCALARS a composition states.
 * Everything is optional — with nothing stated the manager still runs, it just has
 * nothing to load, which is the right default for a host that ships no runtime plugins.
 *
 * `catalog` and `sandbox` are deliberately validated separately below, and the reason is
 * a real difference in MEANING rather than tidiness: `requires`/`confinement` change
 * behaviour depending on whether they were STATED (see keepStatedShape), and a config
 * field is normalised before the plugin starts — the dialect turns an absent array into
 * `[]` and an absent object into `{}` — which is exactly the distinction that would be
 * lost. Validating them in `apply` against the stated value keeps the schema's paths and
 * messages while preserving the difference.
 */
export const Config: Schema<PluginsConfig, PluginsConfig> = z.object({
  root: z.string().description('application root; default process.cwd()'),
  dataRoot: z.string().description('where per-plugin writable data dirs live'),
  confinementRequired: z.boolean().description('fail closed for every confined entry that cannot enforce its policy'),
  envPrefix: z.string().description("env vocabulary prefix for the sandbox entry / demo catalog lookups (default 'MEDIABASE_')"),
})

/** The runtime-plugin catalog, validated when it is used (see Config). */
const catalogSchema: Schema<PluginEntry[], PluginEntry[]> = z.array(entrySchema)

/**
 * The child-entry options for process isolation, validated when it is used (see Config).
 *
 * A `Config` field would also lose the required `entry`: an absent object materialises to
 * `{}`, which then fails its own required field — so a host that does not use process
 * isolation could not boot at all.
 */
const sandboxConfig: Schema<SandboxOptions, SandboxOptions> = z.object({
  entry: z.string().required().description('child entry script (bundled .cjs or TS source)'),
  nodeArgs: z.array(z.string()).description('extra node flags for the child'),
  requiresWorker: z.boolean().description('the entry cannot start without worker threads'),
  execPath: z.string().description('node executable (default: the host binary)'),
  applyTimeoutMs: z.natural().description('deadline for import + apply (default 10s)'),
  callTimeoutMs: z.natural().description('per service-call deadline (default 15s)'),
  env: z.dict(z.string()).description('extra environment for the child'),
  confinement: z.object({
    read: z.array(z.string()),
    write: z.array(z.string()),
    denyNetwork: z.boolean(),
    confineProcesses: z.boolean(),
    required: z.boolean(),
  }).description('confinement policy for the child'),
})

/**
 * The default catalog: the two demo plugins this checkout ships. `confinementRequired` is
 * the deployment-wide fail-closed switch (`AVSTUDIO_SANDBOX_CONFINE_REQUIRED=1`), passed in
 * rather than read here so the same flag also covers an entry a composition states itself.
 */
export function defaultCatalog(
  root: string,
  env: CapabilityEnv,
  confinementRequired: boolean,
  envPrefix = DEFAULT_ENV_PREFIX,
): PluginEntry[] {
  return [
    {
      id: 'hello',
      description: 'greeter plugin (runtime-loaded)',
      module: env[`${envPrefix}HELLO`] ?? join(root, 'examples/plugins/hello.ts'),
      provides: ['hello'],
      // Least privilege: the greeter needs nothing but the framework. Add service
      // names here when a runtime plugin legitimately consumes one.
      requires: [],
    },
    {
      id: 'sandboxed-demo',
      description: 'greeter in a SANDBOXED child process (process isolation demo)',
      module: env[`${envPrefix}SANDBOX_HELLO`] ?? join(root, 'examples/plugins/sandboxed-demo.ts'),
      // Sandbox mode denies by default: this plugin declares nothing it may call.
      requires: [],
      isolation: 'process',
      restarts: 0,
      confinement: { required: confinementRequired },
    },
  ]
}

/** What apply() works with: the catalog is resolved by then, so nothing below re-checks it. */
interface ResolvedPluginsConfig extends PluginsConfig {
  catalog: PluginEntry[]
}

/** What a row stated for one entry, read BEFORE parsing (see keepStatedShape). */
interface StatedEntry {
  id: string
  /** Present (even as `[]`) only when the row stated it — that IS the distinction. */
  requires: string[] | undefined
  confinement: PluginEntry['confinement'] | undefined
}

/**
 * Restore the "absent, not empty" meaning of two entry fields.
 *
 * `parse` materialises an absent array as `[]` and an absent object as `{}`, but here the
 * difference is a BOUNDARY, not a style: `requires` omitted keeps the plugin's full
 * context while `requires: []` grants it nothing, and a `confinement` object is refused
 * outright on an in-process entry — so a materialised `{}` would fail every entry that
 * never declared one. Which of the two was meant is read from what the row STATED, so an
 * operator who writes `requires: []` still gets exactly that.
 */
function keepStatedShape(validated: PluginEntry[], stated: StatedEntry[]): PluginEntry[] {
  const byId = new Map(stated.map((entry) => [entry.id, entry]))
  return validated.map((entry) => {
    const fromRow = byId.get(entry.id)
    if (fromRow === undefined) return entry
    const out = { ...entry }
    // The STATED value is authoritative for these two — it already passed the schema, so
    // keep it rather than the normalised copy: an empty `read` list means "may read
    // nothing" while an absent one falls back to the strict default, and only the raw
    // object still tells the two apart.
    if (fromRow.requires === undefined) delete out.requires
    else out.requires = fromRow.requires
    if (fromRow.confinement === undefined) delete out.confinement
    else out.confinement = fromRow.confinement
    return out
  })
}

export function apply(ctx: Context, rawConfig: PluginsConfig = {}): void {
  // No env layering here: a row states the values a deployment derives from the
  // environment (`!!js ctx.env.X`), because the dialect normalises a validated config
  // in place and would erase what the row actually stated. See Config's comment.
  const stated: PluginsConfig = { ...rawConfig }
  // Read what the row STATED before validating: this dialect normalises its input IN
  // PLACE (materialising an absent array/object), so asking afterwards would always see
  // the materialised value.
  const statedCatalog = (stated.catalog ?? []).map((entry) => ({
    id: entry.id,
    requires: entry.requires,
    confinement: entry.confinement,
  }))
  const statedSandbox = stated.sandbox
  const parsed = parse(Config, stated)
  const root = parsed.root ?? process.cwd()
  // An absent catalog means "use the shipped defaults"; a STATED empty catalog is a
  // deployment saying "load nothing", and it stays empty.
  const confinementRequired = parsed.confinementRequired === true
  const envPrefix = parsed.envPrefix ?? DEFAULT_ENV_PREFIX
  const catalog = stated.catalog === undefined
    ? defaultCatalog(root, process.env, confinementRequired, envPrefix)
    : keepStatedShape(parse(catalogSchema, stated.catalog), statedCatalog)
  // Which child entry to spawn is INSTALLATION knowledge (the bundled `.cjs`, else the
  // repo's TS source through Node's own type stripping), so the capability resolves it
  // rather than every composition restating it; a stated value wins. `undefined` means
  // this installation has no usable entry, and then an `isolation: 'process'` entry is
  // REFUSED instead of silently mounted somewhere less contained.
  const childOptions = statedSandbox === undefined
    ? sandboxEntryFor(root, process.env, envPrefix)
    : parse(sandboxConfig, statedSandbox)
  const config: ResolvedPluginsConfig = {
    ...parsed,
    root,
    catalog,
    ...(childOptions === undefined ? {} : { sandbox: childOptions }),
  }
  const log = ctx.log.child(name)
  const loaded = new Map<string, LoadedPlugin>()
  const state = new Map<string, 'loaded' | 'unloaded' | 'error'>()
  /**
   * Live introspection for sandboxed plugins. Deliberately derived from the
   * SandboxedPlugin at read time: a crashed child must not keep reporting "loaded".
   */
  function sandboxStatuses(): Record<string, ReturnType<SandboxedPlugin['status']>> {
    const out: Record<string, ReturnType<SandboxedPlugin['status']>> = {}
    for (const [id, item] of loaded) {
      if (item.kind === 'process') out[id] = item.sandbox.status()
    }
    return out
  }

  /**
   * What a descriptor/probe should say. For process isolation the child's own state
   * wins: `loaded` means the plugin is running right now.
   */
  function reportedState(id: string): 'loaded' | 'unloaded' | 'error' {
    const item = loaded.get(id)
    if (item?.kind === 'process') return item.sandbox.status().state === 'ready' ? 'loaded' : 'error'
    return item !== undefined ? 'loaded' : (state.get(id) ?? 'unloaded')
  }

  /** Every manager call resolves an id first: unknown ids are NOT_FOUND, not text. */
  function entryOf(id: string): PluginEntry {
    const entry = config.catalog.find((e) => e.id === id)
    if (!entry) {
      throw RpcError.notFound(`plugins: 未知插件 id "${id}"`, { known: config.catalog.map((e) => e.id) }, {
        messageKey: 'plugins.unknownId',
        messageParams: { id },
      })
    }
    return entry
  }

  /**
   * The confinement policy for one entry: strict defaults, the entry's overrides,
   * and the plugin's own writable data dir. Returned as a plan so the reason an
   * enforcement is missing can be reported BEFORE a child exists.
   */
  /**
   * The writable data dir for one confined plugin. A confined child can write
   * NOWHERE else, so the host must find a directory it can actually create instead
   * of failing to load the plugin — and SAY which one it settled on, because a
   * plugin's data moving between runs is something an operator needs to know.
   *
   * The check is the operation itself (`mkdirSync` of the final dir), not "is the
   * parent writable": a parent that exists says nothing about being able to create
   * something inside it (a read-only mount, a restrictive sandbox, a permission bit).
   */
  function dataDirFor(id: string): string {
    const explicit = config.dataRoot
    const candidates = explicit !== undefined
      ? [explicit]
      : [join(homedir(), '.avstudio'), join(config.root ?? process.cwd(), '.avstudio'), join(tmpdir(), 'avstudio')]
    const failures: string[] = []
    for (const [index, candidate] of candidates.entries()) {
      const dir = join(candidate, 'plugin-data', id)
      try {
        mkdirSync(dir, { recursive: true })
        if (index > 0) {
          log.warn(`插件数据目录回退到 ${candidate}(前 ${index} 个候选不可写)`, {
            preferred: candidates[0],
            tried: failures,
          })
        }
        return dir
      } catch (e) {
        failures.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    throw new RpcError(RpcCode.UNAVAILABLE, `找不到沙箱插件可写的数据目录(受限子进程只能在声明目录内写文件): ${failures.join('; ')}`, {
      tried: failures,
    }, {
      messageKey: 'plugins.noDataDir',
      messageParams: { detail: failures.join('; ') },
    })
  }

  function confinementFor(entry: PluginEntry): { request: ConfineRequest; plan: Confinement; dataDir: string } | null {
    const declared = entry.confinement
    if (declared === undefined) {
      // No policy declared: keep the historical behaviour (plain process isolation)
      // rather than silently confining a plugin whose author never asked for it.
      return null
    }
    // A confined plugin needs a writable home it can actually create.
    const dataDir = dataDirFor(entry.id)
    const request: ConfineRequest = {
      read: declared.read ?? [config.root ?? process.cwd(), dirname(entry.module)],
      write: declared.write ?? [dataDir],
      denyNetwork: declared.denyNetwork ?? true,
      confineProcesses: declared.confineProcesses ?? true,
      // Reported, never silent: an entry that cannot run without a worker loader
      // gives up the process denial, and the plan says so.
      allowWorker: config.sandbox?.requiresWorker === true,
      required: declared.required ?? config.confinementRequired === true,
    }
    return { request, plan: planConfinement(request), dataDir }
  }

  /** Start a plugin in its own process and wire its channels back to this host. */
  async function loadSandboxed(entry: PluginEntry, options: SandboxOptions): Promise<void> {
    const requires = entry.requires ?? []
    const confinement = confinementFor(entry)
    if (confinement !== null) {
      const { plan } = confinement
      if (!plan.complete) {
        const missing = plan.unavailable.map((u) => `${u.mechanism}: ${u.reason}`).join('; ')
        if (confinement.request.required === true) {
          // Fail closed: a plugin that requires a denial it cannot get must not run
          // with less confinement than its policy promises.
          throw new RpcError(RpcCode.UNAVAILABLE, `插件 "${entry.id}" 声明的限制无法完全生效,已拒绝加载 — ${missing}`, {
            confinement: plan.describe(),
          }, {
            messageKey: 'plugins.confinementUnavailable',
            messageParams: { id: entry.id, reason: missing },
          })
        }
        log.warn(`沙箱插件 ${entry.id} 的限制未完全生效(仍加载,策略未要求 fail-closed): ${missing}`)
      }
    }
    // A confined child cannot write anywhere else, so it must be TOLD where its one
    // writable directory is; without this the write root would be unusable.
    const sandboxOptions: SandboxOptions = confinement === null
      ? options
      : {
        ...options,
        confinement: confinement.request,
        env: { ...(options.env ?? {}), [`${envPrefix}PLUGIN_DATA_DIR`]: confinement.dataDir },
      }
    const sandbox = new SandboxedPlugin(entry.id, ctx, requires, sandboxOptions, {
      onLog: (level, msg, data) => {
        const scoped = log.child(entry.id)
        if (data !== undefined) scoped[level](msg, data)
        else scoped[level](msg)
      },
      // Re-emitted on the host bus: a sandboxed plugin can push notifications to
      // clients exactly like an in-process capability, with no special casing.
      onEmit: (eventName, payload) => ctx.events.emit(eventName, payload),
      onApi: (methods) => {
        log.debug(`沙箱插件 ${entry.id} 暴露 ${methods.length} 个方法`, {
          methods: methods.map((m) => m.name),
        })
      },
      onExit: (info) => {
        if (info.expected) return
        log.error(`沙箱插件 ${entry.id} 进程退出(code=${info.code}, signal=${info.signal}, 运行 ${info.uptimeMs}ms)`)
        state.set(entry.id, 'error')
        const record = loaded.get(entry.id)
        if (record?.kind !== 'process') return
        const allowed = entry.restarts ?? 0
        if (record.restarts >= allowed) return
        record.restarts++
        log.warn(`重启沙箱插件 ${entry.id}(第 ${record.restarts}/${allowed} 次)`)
        void record.sandbox.start(entry.module, entry.config).catch((e) => {
          log.error(`沙箱插件 ${entry.id} 重启失败: ${describeRpcErrorSafe(e)}`)
        })
      },
    })
    await sandbox.start(entry.module, entry.config)
    loaded.set(entry.id, { kind: 'process', entry, sandbox, restarts: 0 })
    state.set(entry.id, 'loaded')
    log.info(`沙箱插件已加载: ${entry.id}`, {
      module: entry.module,
      requires: requires.length > 0 ? requires : '(无:沙箱模式下默认不能调用任何服务)',
      confinement: sandbox.status().confinement ?? '(未声明限制)',
    })
  }

  async function load(entry: PluginEntry): Promise<void> {
    if (loaded.has(entry.id)) return // idempotent
    if (entry.confinement !== undefined && entry.isolation !== 'process') {
      // A declaration that cannot take effect must fail loudly: an in-process plugin
      // shares the host's own privileges, and silently ignoring the policy would
      // leave an operator believing a boundary exists where there is none.
      throw RpcError.invalidParams(
        `插件 "${entry.id}" 声明了 confinement,但 isolation 不是 'process':限制只能作用于隔离子进程`,
        { id: entry.id, isolation: entry.isolation ?? 'in-process' },
        { messageKey: 'plugins.confinementInProcess', messageParams: { id: entry.id } },
      )
    }
    try {
      if (entry.isolation === 'process') {
        if (config.sandbox === undefined) {
          throw new RpcError(RpcCode.UNAVAILABLE, `插件 "${entry.id}" 要求进程隔离,但组合层没有配置沙箱入口(sandbox)`, undefined, {
            messageKey: 'plugins.isolationRequired',
            messageParams: { id: entry.id },
          })
        }
        await loadSandboxed(entry, config.sandbox)
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(pathToFileURL(entry.module).href)) as unknown as {
        name?: string
        apply: (ctx: Context) => void
      }
      if (typeof mod.apply !== 'function') throw new Error(`module has no apply: ${entry.id}`)
      // A plugin's own `inject` list is what cordis will resolve for it, so it
      // must fit inside what the entry allowed — otherwise the declaration is a
      // lie that silently widens the plugin's reach.
      const declaredInject = (mod as { inject?: readonly string[] }).inject ?? []
      if (entry.requires !== undefined) {
        const overreach = declaredInject.filter((serviceName) => !entry.requires!.includes(serviceName))
        if (overreach.length > 0) {
          throw new Error(
            `plugins: 插件 "${entry.id}" inject 了未声明的服务 ${overreach.map((s) => `"${s}"`).join(', ')}` +
            `(在条目 requires 里补齐:${JSON.stringify([...entry.requires, ...overreach])})`,
          )
        }
      }
      // `requires` is enforced by handing the module a restricted proxy of its own
      // fiber context: effects/services still bind to that fiber (so unload stays
      // a full teardown), but an undeclared service access is refused.
      const plugin = entry.requires === undefined
        ? mod
        : {
            name: mod.name ?? entry.id,
            apply: (fiberCtx: Context) => mod.apply(restrictContext(fiberCtx, entry.id, entry.requires ?? [])),
          }
      const fiber = (await ctx.plugin(plugin)) as unknown as FiberHandle
      loaded.set(entry.id, { kind: 'in-process', entry, fiber })
      state.set(entry.id, 'loaded')
      log.info(`插件已加载: ${entry.id}`, {
        module: entry.module,
        requires: entry.requires ?? 'all',
        provides: entry.provides ?? [],
      })
    } catch (e) {
      state.set(entry.id, 'error')
      log.error(`插件加载失败: ${entry.id}`, {
        module: entry.module,
        isolation: entry.isolation ?? 'in-process',
        error: e instanceof Error ? e.message : String(e),
      })
      // A coded refusal keeps its code: a client branches on `code`/`messageKey`,
      // and a confinement refusal must reach the UI as the refusal it is rather
      // than as an anonymous load failure.
      if (e instanceof RpcError) {
        throw new RpcError(e.code, `plugins.load(${entry.id}) failed: ${e.message}`, e.data, {
          cause: e,
          // A specific refusal keeps its key (the UI explains THAT); anything else falls
          // back to the generic load failure, whose detail is the underlying prose.
          messageKey: e.messageKey ?? 'plugins.loadFailed',
          messageParams: e.messageParams ?? { id: entry.id, detail: e.message },
        })
      }
      throw new Error(`plugins.load(${entry.id}) failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
  }

  async function unload(id: string): Promise<void> {
    const item = loaded.get(id)
    if (!item) return // idempotent
    if (item.kind === 'process') await item.sandbox.dispose()
    else await item.fiber.dispose()
    loaded.delete(id)
    state.set(id, 'unloaded')
    log.info(`插件已卸载: ${id}`)
  }

  const plugins: PluginService = {
    list: async (): Promise<PluginDescriptor[]> =>
      config.catalog.map((entry) => ({
        id: entry.id,
        description: entry.description ?? '',
        state: reportedState(entry.id),
      })),
    async load(id: string): Promise<PluginDescriptor> {
      const entry = entryOf(id)
      await load(entry)
      return plugins.list().then((l) => l.find((d) => d.id === id)!)
    },
    async unload(id: string): Promise<PluginDescriptor> {
      entryOf(id)
      await unload(id)
      return plugins.list().then((l) => l.find((d) => d.id === id)!)
    },
    async reload(id: string): Promise<PluginDescriptor> {
      await unload(id)
      return plugins.load(id)
    },
    async probe(id: string): Promise<PluginProbe> {
      const entry = entryOf(id)
      // A sandboxed plugin cannot provide host services (it has no ctx.reflect), so
      // `provides` only applies to in-process entries.
      const provided = entry.isolation === 'process'
        ? reportedState(id) === 'loaded'
        : (entry.provides ?? []).every((serviceName) => ctx.reflect.get(serviceName) !== undefined)
      const record = loaded.get(id)
      const status = record?.kind === 'process' ? record.sandbox.status() : null
      return {
        id,
        state: reportedState(id),
        provides: entry.provides ?? [],
        provided,
        // What is ACTUALLY enforced for a sandboxed plugin (null for in-process),
        // so a caller never has to infer containment from "isolation: process".
        ...(status === null ? {} : { confinement: status.confinement, confined: status.confined }),
      }
    },
  }

  // Sandboxed plugins expose their own API through the control plane, so a
  // capability that lives in another process is still callable by the UI/agent.
  ctx.reflect.provide('plugins', plugins)

  function describeRpcErrorSafe(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  // ---- self-registration: control plane + manifest --------------------------
  const ById = z.object({ id: z.string().required().description('插件 id(见 plugins.list)') })
  const disposers = [
    ctx.api.register({
      name: 'plugins.list',
      description: '列出运行时插件目录及加载状态',
      params: z.object({}),
      handler: () => plugins.list(),
    }),
    ctx.api.register({ name: 'plugins.load', description: '加载插件(动态 import,挂到当前 ctx)', params: ById, mutates: true,
      handler: (p) => plugins.load(p.id) }),
    ctx.api.register({ name: 'plugins.unload', description: '卸载插件(销毁其 Fiber,回收 service/工具/面板)', params: ById, mutates: true,
      handler: (p) => plugins.unload(p.id) }),
    ctx.api.register({ name: 'plugins.reload', description: '重载插件(卸载后重新加载)', params: ById, mutates: true,
      handler: (p) => plugins.reload(p.id) }),
    ctx.api.register({ name: 'plugins.probe', description: '探测插件的服务是否真的提供了', params: ById,
      handler: (p) => plugins.probe(p.id) }),
    ctx.api.register({
      name: 'plugins.call',
      description: '调用沙箱插件导出的方法(进程隔离插件对宿主的唯一入口)',
      params: z.object({
        id: z.string().required().description('插件 id'),
        method: z.string().required().description('插件导出 api 上的方法名'),
        args: z.array(z.any()).default([]).description('位置参数'),
      }),
      mutates: true,
      handler: async (p) => {
        const item = loaded.get(p.id)
        if (item === undefined) {
          throw RpcError.notFound(`plugins: 插件 "${p.id}" 未加载`, undefined, {
            messageKey: 'plugins.notLoaded',
            messageParams: { id: p.id },
          })
        }
        if (item.kind !== 'process') {
          throw RpcError.invalidParams(`plugins: 插件 "${p.id}" 是进程内插件,没有沙箱调用入口`, undefined, {
            messageKey: 'plugins.notSandboxed',
            messageParams: { id: p.id },
          })
        }
        return item.sandbox.invoke(p.method, p.args)
      },
    }),
    ctx.api.register({
      name: 'plugins.sandboxStatus',
      description: '沙箱插件运行状况(状态/服务调用次数/被拒绝次数/订阅事件/导出方法)',
      params: z.object({}),
      handler: () => sandboxStatuses(),
    }),
  ]

  ctx.capabilities.register({
    id: 'plugins',
    title: '运行时插件管理',
    description: '在运行时 load/unload/reload Cordis 插件,卸载即销毁 Fiber 并回收其一切副作用',
    services: ['plugins'],
    api: ['plugins.list', 'plugins.load', 'plugins.unload', 'plugins.reload', 'plugins.probe', 'plugins.call', 'plugins.sandboxStatus'],
  })

  ctx.effect(() => () => disposers.forEach((d) => d()), `${name}: api`)
}
