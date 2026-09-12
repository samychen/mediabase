// @mediabase/plugins / sandbox-host.ts — the host half of an ISOLATED plugin.
//
// Why a child process and not a Proxy (the in-process `requires` check): a Proxy
// constrains what a cooperative plugin touches, but the plugin still shares the
// host's isolate, heap and event loop. Here the plugin runs elsewhere, so:
//
//   * a crash (`process.exit`, an uncaught throw in a timer) cannot take the host
//     down — the host sees an `exit` event and reports it;
//   * an infinite loop can be PREEMPTED (`apply` deadline → `kill`), which is
//     impossible in-process;
//   * the plugin's ONLY channel back is this message protocol, and every service
//     call is checked against the entry's `requires` list ON THE HOST SIDE — a
//     malicious or buggy plugin cannot reach around a check it does not control;
//   * unloading is a process teardown, so nothing can leak.
//
// On top of that, the child is CONFINED when a policy is declared: `@mediabase/confine`
// builds the spawn from Node's permission model (filesystem limited to the declared
// roots, no subprocesses/workers/native addons) plus an OS mechanism where one is
// available (Seatbelt on macOS, Bubblewrap on Linux) for network denial. What could
// not be enforced is reported, never assumed — `status().confinement` carries the
// enforced level AND the reason a requested denial is missing.

import { spawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { RpcCode, RpcError, describeRpcError } from '@mediabase/rpc'
import { serializeError, type SandboxChildMessage, type SandboxHostMessage } from './sandbox-protocol.ts'
import { planConfinement, type Confinement, type ConfineRequest } from '@mediabase/confine'

export interface SandboxOptions {
  /** Absolute path of the sandbox entry script (bundled or TS via tsx). */
  entry: string
  /** Extra node flags for the child (e.g. `['--import', 'tsx']` for a TS entry). */
  nodeArgs?: string[]
  /**
   * True when this entry cannot start without worker threads (a transpiler
   * loader). Confinement therefore cannot deny workers for it — see
   * `@mediabase/confine`'s `allowWorker`.
   */
  requiresWorker?: boolean
  /** Node executable (defaults to the host's own). */
  execPath?: string
  /** Deadline for import + apply (default 10s); the child is killed on expiry. */
  applyTimeoutMs?: number
  /** Per service-call deadline (default 15s). */
  callTimeoutMs?: number
  /** Extra environment for the child. */
  env?: Record<string, string>
  /**
   * Confinement policy for the child. Omitted = no confinement (plain process
   * isolation, as before). See @mediabase/confine for what each field enforces and
   * what is reported when it cannot be enforced here.
   */
  confinement?: ConfineRequest
}

export interface SandboxCall {
  service: string
  method: string
  args: unknown[]
}

export interface SandboxHostEvents {
  onLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
  onEmit(name: string, payload: unknown): void
  onExit(info: { code: number | null; signal: string | null; expected: boolean; uptimeMs: number }): void
  onApi(methods: Array<{ name: string; description?: string }>): void
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type SandboxState = 'starting' | 'ready' | 'error' | 'stopped'

/**
 * One sandboxed plugin instance. The caller (the plugin manager) owns lifetime:
 * `start()` waits for the child's `ready`, `invoke()` calls an API the plugin
 * exported, `dispose()` runs its cleanups and tears the process down.
 */
export class SandboxedPlugin {
  readonly id: string
  private readonly ctx: Context
  private readonly options: SandboxOptions
  private readonly handlers: SandboxHostEvents
  private readonly requires: readonly string[]
  private proc: ChildProcess | null = null
  private pending = new Map<number, PendingCall>()
  private nextInvokeId = 1_000_000
  private startedAt = 0
  private disposed = false
  private state: SandboxState = 'stopped'
  private apiMethods: Array<{ name: string; description?: string }> = []
  private readonly subscriptions = new Set<string>()
  private readonly eventForwarders = new Map<string, () => void>()
  private callCount = 0
  private refusedCount = 0
  /** Resolved once per instance (the plan runs a probe the first time). */
  private readonly confinement: Confinement | null

  constructor(id: string, ctx: Context, requires: readonly string[], options: SandboxOptions, handlers: SandboxHostEvents) {
    this.id = id
    this.ctx = ctx
    this.requires = requires
    this.options = options
    this.handlers = handlers
    this.confinement = options.confinement === undefined ? null : planConfinement(options.confinement)
  }

  status(): { state: SandboxState; calls: number; refused: number; subscriptions: string[]; api: string[]; confinement: string | null; confined: boolean } {
    return {
      state: this.state,
      calls: this.callCount,
      refused: this.refusedCount,
      subscriptions: [...this.subscriptions],
      api: this.apiMethods.map((m) => m.name),
      // The PLAN is reported before the child exists, so a status read is never a
      // guess; `confined` says whether anything is actually enforced.
      confinement: this.confinement?.describe() ?? null,
      confined: this.confinement?.layers.length !== 0 && this.confinement !== null,
    }
  }

  /** Spawn the child, hand it the module, and wait (bounded) for `ready`. */
  async start(module: string, config?: unknown): Promise<void> {
    this.state = 'starting'
    const nodeArgs = this.options.nodeArgs ?? []
    // Confined spawn: the plan's argv (permission flags, maybe an OS wrapper) is
    // built here so an unavailable denial is visible in the log at load time.
    if (this.confinement !== null) {
      this.handlers.onLog(this.confinement.complete ? 'info' : 'warn', `沙箱限制: ${this.confinement.describe()}`)
    }
    const spawnPlan = this.confinement?.spawn(this.options.entry, nodeArgs)
      ?? { bin: this.options.execPath ?? process.execPath, args: [...nodeArgs, this.options.entry] }
    const proc = spawn(spawnPlan.bin, spawnPlan.args, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // structured clone over IPC: Buffers/Uint8Array survive service calls
      serialization: 'advanced',
      env: { ...process.env, ...(this.options.env ?? {}) },
    })
    this.proc = proc
    this.startedAt = Date.now()

    proc.stdout?.on('data', (chunk: Buffer) => this.handlers.onLog('debug', chunk.toString().trimEnd()))
    proc.stderr?.on('data', (chunk: Buffer) => this.handlers.onLog('debug', chunk.toString().trimEnd()))
    proc.on('exit', (code, signal) => this.handleExit(code, signal))
    proc.on('error', (e) => {
      this.state = 'error'
      this.handlers.onLog('error', `无法启动沙箱进程: ${e.message}`)
    })

    const ready = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new RpcError(RpcCode.UNAVAILABLE, `插件 "${this.id}" 的 apply() 超时(${this.options.applyTimeoutMs ?? 10_000}ms),已终止`, undefined, {
          messageKey: 'plugins.applyTimeout',
          messageParams: { id: this.id, ms: this.options.applyTimeoutMs ?? 10_000 },
        }))
      }, this.options.applyTimeoutMs ?? 10_000)
      this.pendingReady = { resolve, reject, deadline }
    })
    proc.on('message', (raw: unknown) => this.handleMessage(raw as SandboxChildMessage))

    const init: SandboxHostMessage = {
      t: 'init',
      module,
      requires: this.requires,
      instanceId: `${this.id}-${process.pid}-${Date.now()}`,
    }
    if (config !== undefined) init.config = config
    proc.send(init)

    try {
      await ready
    } catch (e) {
      await this.terminate()
      throw e
    }
  }

  private pendingReady: { resolve: () => void; reject: (e: Error) => void; deadline: ReturnType<typeof setTimeout> } | null = null

  /**
   * Why a CONFINED child may die before it is ready — the failure a policy layer
   * itself causes, which the raw exit code cannot explain. Measured while building
   * this: a child spawned under `--permission` starts, then exits 1 because its
   * transpiler loader needs a worker thread, and the host's own log said only
   * "启动即退出(code=1)". The hint names the policy, not a guess about the plugin.
   */
  private startupHint(): string {
    if (this.confinement === null) return ''
    const hints: string[] = []
    if (this.confinement.enforced.processes === 'deny') {
      hints.push('若入口需要 worker 线程(如 tsx 转译加载器),禁止 worker 会让它启动即失败 —— 见 @mediabase/confine 的 allowWorker')
    }
    if (this.confinement.enforced.filesystem !== 'inherit') {
      hints.push('受限子进程只能读声明的根、写声明的数据目录,入口或依赖在根之外也会启动即失败')
    }
    return hints.length === 0 ? '' : ` —— 提示(受限策略): ${hints.join(';')}`
  }

  /** Call a method the plugin exported through its `api` descriptor. */
  invoke(method: string, args: unknown[]): Promise<unknown> {
    if (this.state !== 'ready' || this.proc === null) {
      return Promise.reject(new RpcError(RpcCode.UNAVAILABLE, `插件 "${this.id}" 未在运行(state=${this.state})`, undefined, {
        messageKey: 'plugins.notRunning',
        messageParams: { id: this.id, state: this.state },
      }))
    }
    const id = this.nextInvokeId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(RpcCode.UNAVAILABLE, `插件 "${this.id}" 的 ${method} 调用超时`, undefined, {
          messageKey: 'plugins.callTimeout',
          messageParams: { id: this.id, method },
        }))
      }, this.options.callTimeoutMs ?? 15_000)
      this.pending.set(id, { resolve, reject, timer })
      this.proc?.send({ t: 'invoke', id, method, args } as never)
    })
  }

  /** Run the plugin's cleanups, then make sure the process is gone. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const proc = this.proc
    if (proc !== null && this.state === 'ready') {
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        this.onDisposed = () => { clearTimeout(timer); resolve() }
      })
      try {
        proc.send({ t: 'dispose' })
      } catch {
        /* already gone */
      }
      await done
    }
    await this.terminate()
    this.state = 'stopped'
  }

  private onDisposed: (() => void) | null = null

  private async terminate(): Promise<void> {
    const proc = this.proc
    this.proc = null
    this.clearForwarders()
    for (const [id, slot] of this.pending) {
      clearTimeout(slot.timer)
      slot.reject(new RpcError(RpcCode.UNAVAILABLE, `插件 "${this.id}" 已终止`, undefined, {
        messageKey: 'plugins.terminated',
        messageParams: { id: this.id },
      }))
      this.pending.delete(id)
    }
    if (proc !== null && proc.exitCode === null) {
      proc.removeAllListeners('exit')
      try {
        proc.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      // give it a moment, then be firm (a plugin may ignore SIGTERM)
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    const wasReady = this.state === 'ready'
    this.state = wasReady ? 'error' : this.state === 'starting' ? 'error' : 'stopped'
    const uptimeMs = Date.now() - this.startedAt
    this.clearForwarders()
    for (const [id, slot] of this.pending) {
      clearTimeout(slot.timer)
      slot.reject(new RpcError(RpcCode.UNAVAILABLE, `插件 "${this.id}" 进程退出(code=${code}, signal=${signal})`, undefined, {
        messageKey: 'plugins.exited',
        messageParams: { id: this.id, code: code ?? '', signal: signal ?? '' },
      }))
      this.pending.delete(id)
    }
    if (this.pendingReady !== null && this.state === 'error') {
      clearTimeout(this.pendingReady.deadline)
      this.pendingReady.reject(new RpcError(RpcCode.UNAVAILABLE, `插件 "${this.id}" 启动即退出(code=${code}, signal=${signal})${this.startupHint()}`, undefined, {
        messageKey: 'plugins.startupFailed',
        messageParams: { id: this.id, code: code ?? '', signal: signal ?? '' },
      }))
      this.pendingReady = null
    }
    this.handlers.onExit({ code, signal, expected: this.disposed, uptimeMs })
  }

  private clearForwarders(): void {
    for (const dispose of this.eventForwarders.values()) dispose()
    this.eventForwarders.clear()
    this.subscriptions.clear()
  }

  private handleMessage(message: SandboxChildMessage): void {
    switch (message.t) {
      case 'ready': {
        this.state = 'ready'
        this.apiMethods = message.api?.methods ?? []
        this.handlers.onApi(this.apiMethods)
        if (this.pendingReady !== null) {
          clearTimeout(this.pendingReady.deadline)
          this.pendingReady.resolve()
          this.pendingReady = null
        }
        return
      }
      case 'error': {
        this.state = 'error'
        if (this.pendingReady !== null) {
          clearTimeout(this.pendingReady.deadline)
          this.pendingReady.reject(new RpcError(RpcCode.INTERNAL, `插件 "${this.id}" 初始化失败: ${message.message}`, undefined, {
        messageKey: 'plugins.initFailed',
        messageParams: { id: this.id, detail: message.message },
      }))
          this.pendingReady = null
        } else {
          this.handlers.onLog('error', `插件运行时错误: ${message.message}`)
        }
        return
      }
      case 'log':
        this.handlers.onLog(message.level, message.msg, message.data)
        return
      case 'emit':
        // Re-emitted on the HOST bus, so a sandboxed plugin can push notifications
        // to clients through the same path as any other capability.
        this.handlers.onEmit(message.name, message.payload)
        return
      case 'subscribe':
        this.subscribe(message.name)
        return
      case 'call':
        void this.dispatchCall(message)
        return
      case 'invoke-result': {
        const slot = this.pending.get(message.id)
        if (!slot) return
        clearTimeout(slot.timer)
        this.pending.delete(message.id)
        if (message.error !== undefined) {
          // A pass-through: the error was raised INSIDE the plugin, so it brings its own
          // code and (when the author provided one) its own message key. The host adds
          // nothing — inventing a key here would misattribute the failure.
          slot.reject(new RpcError(message.error.code ?? RpcCode.INTERNAL, message.error.message, undefined, {
            ...(message.error.messageKey === undefined ? {} : { messageKey: message.error.messageKey }),
            ...(message.error.messageParams === undefined ? {} : { messageParams: message.error.messageParams }),
          }))
        }
        else slot.resolve(message.value)
        return
      }
      case 'disposed':
        this.onDisposed?.()
        this.onDisposed = null
        return
      default:
        return
    }
  }

  /** Forward a host event to the child (only names the plugin subscribed to). */
  private subscribe(name: string): void {
    if (this.eventForwarders.has(name)) return
    this.subscriptions.add(name)
    const dispose = this.ctx.events.on(name, (payload: unknown) => {
      try {
        this.proc?.send({ t: 'event', name, payload })
      } catch {
        /* child gone */
      }
    })
    this.eventForwarders.set(name, typeof dispose === 'function' ? dispose : () => {})
  }

  /**
   * The enforcement point: a sandboxed plugin may call ONLY services its catalog
   * entry declared, and only methods that exist. The check lives here (host side),
   * so the plugin's own code cannot skip it.
   */
  private async dispatchCall(message: { id: number; service: string; method: string; args: unknown[] }): Promise<void> {
    const reply = (value: unknown): void => {
      try {
        this.proc?.send({ t: 'result', id: message.id, value })
      } catch {
        /* child gone */
      }
    }
    const fail = (error: unknown): void => {
      try {
        this.proc?.send({ t: 'result', id: message.id, error: serializeError(error) })
      } catch {
        /* child gone */
      }
    }

    if (!this.requires.includes(message.service)) {
      this.refusedCount++
      const detail = `插件 "${this.id}" 调用了未声明的服务 "${message.service}"(在该条目 requires 里补上)`
      this.handlers.onLog('warn', detail)
      fail(new RpcError(RpcCode.FORBIDDEN, detail, { service: message.service }, {
        messageKey: 'plugins.serviceNotAllowed',
        messageParams: { id: this.id, service: message.service },
      }))
      return
    }
    const service = this.ctx.reflect.get(message.service) as Record<string, unknown> | undefined
    if (service === undefined) {
      fail(new RpcError(RpcCode.NOT_FOUND, `插件 "${this.id}": 宿主没有服务 "${message.service}"`, undefined, {
        messageKey: 'plugins.serviceMissing',
        messageParams: { id: this.id, service: message.service },
      }))
      return
    }
    const fn = service[message.method]
    if (typeof fn !== 'function') {
      fail(new RpcError(RpcCode.NOT_FOUND, `插件 "${this.id}": 服务 "${message.service}" 没有方法 "${message.method}"`, undefined, {
        messageKey: 'plugins.methodMissing',
        messageParams: { id: this.id, service: message.service, method: message.method },
      }))
      return
    }
    this.callCount++
    try {
      const value = await (fn as (...a: unknown[]) => unknown).apply(service, message.args)
      reply(value)
    } catch (e) {
      this.handlers.onLog('warn', `插件 "${this.id}" 调用 ${message.service}.${message.method} 失败: ${describeRpcError(e)}`)
      fail(e)
    }
  }
}
