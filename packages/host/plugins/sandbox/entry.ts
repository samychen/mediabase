// @mediabase/plugins / sandbox/entry.ts — the CHILD half of a sandboxed plugin.
//
// Runs in its own Node process, away from the host's isolate. Everything it can do
// is defined here: it receives `init`, imports the plugin module, and hands `apply`
// a small async API whose only exit points are messages to the host:
//
//   ctx.log.*                     → host logger (scoped to the plugin id)
//   ctx.services.<svc>.<method>() → host service call (declared services only,
//                                   checked on the HOST side)
//   ctx.events.emit(name, data)   → host event bus (so clients can receive it)
//   ctx.events.on(name, handler)  → host forwards only subscribed names
//   ctx.effect(fn)                → cleanup on dispose
//   api: { method() {} }          → exposed to the host as plugins.call(id, method)
//
// Two properties matter and are deliberate: every service call is `await`ed (no
// shared objects cross the boundary), and `apply` must finish before the host's
// deadline or the process is killed.

import { pathToFileURL } from 'node:url'
import type {
  SandboxChildMessage,
  SandboxHostMessage,
  SerializedError,
} from '../sandbox-protocol.ts'

interface PendingServiceCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Errors arrive as plain data; turn them back into Error instances. */
function toError(e: SerializedError | undefined): Error {
  if (e === undefined) return new Error('unknown sandbox error')
  const error = new Error(e.message) as Error & {
    code?: number
    messageKey?: string
    messageParams?: Record<string, string | number>
  }
  if (e.code !== undefined) error.code = e.code
  if (e.messageKey !== undefined) error.messageKey = e.messageKey
  if (e.messageParams !== undefined) error.messageParams = e.messageParams
  if (e.stack !== undefined) error.stack = e.stack
  return error
}

function send(message: SandboxChildMessage): void {
  process.send?.(message)
}

/** The async, message-only view of the host a sandboxed plugin gets. */
interface SandboxApi {
  log: {
    debug(msg: string, data?: Record<string, unknown>): void
    info(msg: string, data?: Record<string, unknown>): void
    warn(msg: string, data?: Record<string, unknown>): void
    error(msg: string, data?: Record<string, unknown>): void
  }
  events: {
    emit(name: string, payload?: unknown): void
    on(name: string, handler: (payload: unknown) => void): () => void
  }
  services: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
  effect(fn: () => void): void
  config: unknown
  id: string
}

const pendingCalls = new Map<number, PendingServiceCall>()
let nextCallId = 1
const cleanups: Array<() => void> = []
const eventHandlers = new Map<string, Set<(payload: unknown) => void>>()
let declaredServices: readonly string[] = []

/**
 * A lazy proxy per service: the plugin writes `ctx.services.media.probe(...)` and
 * each property access becomes a remote call, so no host object ever exists here.
 */
function serviceProxy(name: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get(_target, method: string | symbol) {
      if (typeof method === 'symbol') return undefined
      return (...args: unknown[]): Promise<unknown> => {
        if (!declaredServices.includes(name)) {
          // Fail fast locally with the same wording the host uses, so a mistake
          // shows up immediately instead of as a round-trip refusal.
          return Promise.reject(new Error(`插件调用了未声明的服务 "${name}"`))
        }
        const id = nextCallId++
        return new Promise((resolve, reject) => {
          pendingCalls.set(id, { resolve, reject })
          send({ t: 'call', id, service: name, method, args })
        })
      }
    },
  })
}

const servicesProxy = new Proxy({} as SandboxApi['services'], {
  get(_target, name: string | symbol) {
    if (typeof name === 'symbol') return undefined
    return serviceProxy(name)
  },
})

const log = (level: 'debug' | 'info' | 'warn' | 'error') =>
  (msg: string, data?: Record<string, unknown>): void => {
    const message: SandboxChildMessage = { t: 'log', level, msg }
    if (data !== undefined) message.data = data
    send(message)
  }

const sandbox: SandboxApi = {
  log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
  events: {
    emit: (name, payload) => send({ t: 'emit', name, payload }),
    on: (name, handler) => {
      const set = eventHandlers.get(name) ?? new Set()
      set.add(handler)
      eventHandlers.set(name, set)
      send({ t: 'subscribe', name })
      return () => set.delete(handler)
    },
  },
  services: servicesProxy,
  effect: (fn) => cleanups.push(fn),
  config: undefined,
  id: process.env['MEDIABASE_SANDBOX_ID'] ?? process.env['AVSTUDIO_SANDBOX_ID'] ?? 'sandbox',
}

/** The module's exported `api` object becomes host-callable methods. */
function describeApi(api: unknown): Array<{ name: string; description?: string }> {
  if (api === null || typeof api !== 'object') return []
  return Object.entries(api as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => ({ name }))
}

let exposedApi: Record<string, unknown> = {}

async function handle(message: SandboxHostMessage): Promise<void> {
  switch (message.t) {
    case 'init': {
      sandbox.config = message.config
      sandbox.id = message.instanceId
      declaredServices = message.requires
      try {
        const mod = (await import(pathToFileURL(message.module).href)) as {
          name?: string
          default?: { apply?: unknown; api?: unknown }
          apply?: unknown
          api?: unknown
        }
        const plugin = typeof mod.apply === 'function' ? mod : mod.default
        if (plugin === undefined || typeof plugin.apply !== 'function') {
          throw new Error(`沙箱插件模块没有 apply(): ${message.module}`)
        }
        exposedApi = (plugin.api ?? {}) as Record<string, unknown>
        await (plugin.apply as (ctx: SandboxApi) => unknown)(sandbox)
        send({ t: 'ready', api: { methods: describeApi(exposedApi) } })
      } catch (e) {
        const error = e as { message?: string; stack?: string }
        const failure: SandboxChildMessage = { t: 'error', message: error.message ?? String(e) }
        if (error.stack !== undefined) failure.stack = error.stack
        send(failure)
      }
      return
    }
    case 'result': {
      const slot = pendingCalls.get(message.id)
      if (!slot) return
      pendingCalls.delete(message.id)
      if (message.error !== undefined) slot.reject(toError(message.error))
      else slot.resolve(message.value)
      return
    }
    case 'event': {
      for (const handler of eventHandlers.get(message.name) ?? []) {
        try {
          handler(message.payload)
        } catch (e) {
          send({ t: 'log', level: 'warn', msg: `事件 ${message.name} 的处理器抛错: ${String(e)}` })
        }
      }
      return
    }
    case 'invoke': {
      const fn = exposedApi[message.method]
      if (typeof fn !== 'function') {
        send({
          t: 'invoke-result',
          id: message.id,
          error: {
            message: `没有导出的方法 "${message.method}"`,
            code: -32601, // METHOD_NOT_FOUND: the plugin simply does not export this one
            messageKey: 'plugins.noSuchMethod',
            messageParams: { method: message.method },
          },
        })
        return
      }
      try {
        const value = await (fn as (...a: unknown[]) => unknown).apply(exposedApi, message.args)
        send({ t: 'invoke-result', id: message.id, value })
      } catch (e) {
        // Keep what the plugin said: a coded error (and its i18n key/params) must
        // survive the IPC boundary, or a NOT_FOUND thrown in the child arrives as
        // INTERNAL with prose only.
        const error = e as { message?: string; code?: number; messageKey?: string; messageParams?: Record<string, string | number> }
        send({
          t: 'invoke-result',
          id: message.id,
          error: {
            message: error.message ?? String(e),
            ...(typeof error.code === 'number' ? { code: error.code } : {}),
            ...(typeof error.messageKey === 'string' ? { messageKey: error.messageKey } : {}),
            ...(error.messageParams !== undefined ? { messageParams: error.messageParams } : {}),
          },
        })
      }
      return
    }
    case 'dispose': {
      // Cleanups run in reverse order, like a fiber teardown; failures are logged
      // but never block the exit.
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup()
        } catch (e) {
          send({ t: 'log', level: 'warn', msg: `cleanup 抛错: ${String(e)}` })
        }
      }
      cleanups.length = 0
      send({ t: 'disposed' })
      // Give the host a tick to read `disposed` before the process goes away.
      setTimeout(() => process.exit(0), 20)
      return
    }
    default:
      return
  }
}

process.on('message', (raw: unknown) => {
  void handle(raw as SandboxHostMessage)
})

// A sandboxed plugin must not keep the process alive on its own timers/sockets: the
// host decides when it ends (init → work → dispose).
process.on('disconnect', () => process.exit(0))

// Exported so the module is a valid ES module with something to tree-shake around;
// NOTE: no `import.meta` usage anywhere here — this file is also bundled to CJS
// (`build/sandbox.cjs`) where `import.meta.url` does not exist.
export { handle, sandbox }
