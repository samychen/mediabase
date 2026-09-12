// mediabase / packages/base/rpc
//
// Tiny JSON-RPC 2.0 over any message channel (WebSocket here). Both sides share
// this file:
//   - host:   const handle = makeServer({ 'media.decode': async (p) => ... })
//             ws.on('message', (s) => { const r = await handle(s); if (r) ws.send(r) })
//   - client: const client = makeClient((s) => ws.send(s))
//             const frame = await client.call('media.decode', { file, time, w, h })
//             ws.on('message', (s) => client.handle(s))

/** Handler receives the params object (or undefined); may return a promise. */
export type RpcHandler = (params?: unknown) => unknown | Promise<unknown>
export type RpcMethods = Record<string, RpcHandler>

export interface RpcErrorShape {
  code: number
  message: string
  /**
   * Optional i18n key (+ params) for the message. `message` stays the host's own
   * prose: it is what a log, a CLI or a bug report shows, and the fallback when a
   * client has no translation for the key. A client that DOES have it renders
   * localized text instead of the host's language — the seam that keeps a
   * Chinese-prose host usable from an English UI without translating in the host.
   */
  messageKey?: string
  messageParams?: Record<string, string | number>
  data?: unknown
}

/** Optional extras a handler can attach to a coded error. */
export interface RpcErrorOptions {
  cause?: unknown
  messageKey?: string
  messageParams?: Record<string, string | number>
}

interface Request {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
}

interface Response {
  jsonrpc: string
  id: number | string | null
  result?: unknown
  error?: RpcErrorShape
}

const VERSION = '2.0'

/**
 * Transport codes are JSON-RPC standard; the -320xx block is mediabase's
 * application surface, so clients branch on `code` instead of matching prose.
 */
export const RpcCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** A named resource (file, plugin, setting) does not exist. */
  NOT_FOUND: -32001,
  /** The capability exists but cannot serve right now (engine down, no key). */
  UNAVAILABLE: -32002,
  /** The C++ engine reported a failure. */
  ENGINE: -32003,
  /** A worker/sidecar (e.g. the python process) reported a failure. */
  WORKER: -32005,
  /** The request is understood but refused by policy/state. */
  CONFLICT: -32004,
  /** Credentials are missing or rejected (e.g. LLM key/HTTP 401). */
  UNAUTHORIZED: -32020,
  /** Authenticated, but the access policy forbids this method. */
  FORBIDDEN: -32021,
} as const

export type RpcCodeName = keyof typeof RpcCode

/** An error a handler can throw to control the wire error (code + optional data). */
export class RpcError extends Error {
  readonly code: number
  readonly data?: unknown
  readonly messageKey?: string
  readonly messageParams?: Record<string, string | number>

  constructor(code: number, message: string, data?: unknown, options?: RpcErrorOptions) {
    super(message, options as ErrorOptions)
    this.name = 'RpcError'
    this.code = code
    if (data !== undefined) this.data = data
    if (options?.messageKey !== undefined) this.messageKey = options.messageKey
    if (options?.messageParams !== undefined) this.messageParams = options.messageParams
  }

  static notFound(message: string, data?: unknown, options?: RpcErrorOptions): RpcError {
    // i18n: forwards the caller's options — the key comes from the throw site
    return new RpcError(RpcCode.NOT_FOUND, message, data, options)
  }

  static invalidParams(message: string, data?: unknown, options?: RpcErrorOptions): RpcError {
    // i18n: forwards the caller's options — the key comes from the throw site
    return new RpcError(RpcCode.INVALID_PARAMS, message, data, options)
  }

  static unavailable(message: string, data?: unknown, options?: RpcErrorOptions): RpcError {
    // i18n: forwards the caller's options — the key comes from the throw site
    return new RpcError(RpcCode.UNAVAILABLE, message, data, options)
  }

  static unauthorized(message: string, data?: unknown, options?: RpcErrorOptions): RpcError {
    // i18n: forwards the caller's options — the key comes from the throw site
    return new RpcError(RpcCode.UNAUTHORIZED, message, data, options)
  }

  static worker(message: string, data?: unknown, options?: RpcErrorOptions): RpcError {
    // i18n: forwards the caller's options — the key comes from the throw site
    return new RpcError(RpcCode.WORKER, message, data, options)
  }

  static forbidden(message: string, data?: unknown, options?: RpcErrorOptions): RpcError {
    // i18n: forwards the caller's options — the key comes from the throw site
    return new RpcError(RpcCode.FORBIDDEN, message, data, options)
  }
}

/**
 * True for any error carrying a wire code (host or client side). The optional
 * key/params are part of the guard's shape so a rendering layer can use them
 * without a second cast.
 */
export function hasRpcCode(e: unknown): e is { code: number; message: string; messageKey?: string; messageParams?: Record<string, string | number> } {
  return typeof (e as { code?: unknown } | null)?.code === 'number'
}

/**
 * One rendering for every error a user sees: `[code] message` when the error
 * carries a wire code (so "bad params" is distinguishable from "engine down"
 * without parsing prose), the plain message otherwise.
 */
export function describeRpcError(e: unknown): string {
  if (hasRpcCode(e)) return `[${e.code}] ${e.message}`
  return e instanceof Error ? e.message : String(e)
}

function makeError(id: number | string | null, code: number, message: string, data?: unknown, extra?: { messageKey?: string; messageParams?: Record<string, string | number> }): Response {
  const error: RpcErrorShape = { code, message }
  if (extra?.messageKey !== undefined) error.messageKey = extra.messageKey
  if (extra?.messageParams !== undefined) error.messageParams = extra.messageParams
  if (data !== undefined) error.data = data
  return { jsonrpc: VERSION, id, error }
}

export function makeServer(methods: RpcMethods): (raw: string) => Promise<string | undefined> {
  return async (raw: string) => {
    let req: Request
    try {
      req = JSON.parse(raw) as Request
    } catch {
      return JSON.stringify(makeError(null, RpcCode.PARSE_ERROR, 'parse error', undefined, { messageKey: 'api.parseError' }))
    }
    if (req === null || typeof req !== 'object' || typeof req.method !== 'string') {
      return JSON.stringify(makeError(req?.id ?? null, RpcCode.INVALID_REQUEST, 'invalid request', undefined, { messageKey: 'api.invalidRequest' }))
    }
    // JSON-RPC: a notification (no id) never gets a response — not even an
    // error. Side effects still run when the method exists; errors are dropped.
    const notification = req.id === undefined || req.id === null
    const id: number | string | null = req.id ?? null
    const fn = methods[req.method]
    if (typeof fn !== 'function') {
      return notification
        ? undefined
        : JSON.stringify(makeError(id, RpcCode.METHOD_NOT_FOUND, `method not found: ${req.method}`, undefined, {
          messageKey: 'api.methodNotFound',
          messageParams: { method: req.method },
        }))
    }
    try {
      const result = await fn(req.params)
      if (notification) return undefined
      return JSON.stringify({ jsonrpc: VERSION, id, result } satisfies Response)
    } catch (e) {
      if (notification) return undefined
      // A handler that throws RpcError picks its own code; anything else is an
      // internal failure — the message is still forwarded so the UI can show it.
      if (e instanceof RpcError) {
        return JSON.stringify(makeError(id, e.code, e.message, e.data, e))
      }
      return JSON.stringify(makeError(id, RpcCode.INTERNAL, e instanceof Error ? e.message : String(e)))
    }
  }
}

export interface RpcClient {
  /** Send a request and await its response. Timeouts after 30s. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  /** Feed an inbound message (JSON-RPC response or notification) back in. */
  handle(raw: string): void
  /**
   * Fail every in-flight call (the transport went away). Without this a lost
   * connection leaves callers waiting for the 30s timeout on requests that were
   * already sent and will never be answered — a UI that could have said "connection
   * lost" instead shows nothing for half a minute.
   */
  fail(error: Error): void
}

/** Called for inbound notifications: { jsonrpc, method, params } with no id. */
export type NotificationHandler = (method: string, params?: unknown) => void

const TIMEOUT_MS = 30_000

export function makeClient(send: (raw: string) => void, onNotify?: NotificationHandler): RpcClient {
  let nextId = 1
  // The timeout timer is kept so it can be cleared: a stray 30s timer keeps a
  // Node process alive (and would restart a browser's event loop) long after the
  // call settled. unref() makes it not hold the loop open either.
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>()

  const client: RpcClient = {
    async call<T = unknown>(method: string, params?: unknown): Promise<T> {
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const slot: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = {
          resolve: (v) => resolve(v as T),
          reject,
        }
        slot.timer = setTimeout(() => {
          if (!pending.delete(id)) return
          reject(new RpcError(RpcCode.UNAVAILABLE, `rpc timeout: ${method}`, { method }, {
            messageKey: 'api.timeout',
            messageParams: { method },
          }))
        }, TIMEOUT_MS)
        // Node timers have unref(), DOM timers do not: optional call keeps this
        // package isomorphic without dragging Node types into the client plane.
        ;(slot.timer as unknown as { unref?: () => void }).unref?.()
        pending.set(id, slot)
        send(JSON.stringify({ jsonrpc: VERSION, id, method, params: params ?? {} }))
      })
    },
    fail(error: Error): void {
      for (const [id, slot] of pending) {
        pending.delete(id)
        if (slot.timer !== undefined) clearTimeout(slot.timer)
        slot.reject(error)
      }
    },
    handle(raw: string): void {
      // Inbound frames: either a response {id,...} or a notification
      // {method,params} without an id.
      let res: { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown; error?: RpcErrorShape; result?: unknown }
      try {
        res = JSON.parse(raw)
      } catch {
        return
      }
      if (res === null || res.jsonrpc !== VERSION) return
      // Notification: no id -> route by method to the registered handler.
      if (res.id === undefined || res.id === null) {
        if (onNotify && res.method) onNotify(res.method, res.params)
        return
      }
      const slot = pending.get(res.id as number)
      if (!slot) return
      pending.delete(res.id as number)
      if (slot.timer !== undefined) clearTimeout(slot.timer)
      // Reject with a coded error: callers switch on `code`, not on prose. The wire error
      // already carries code/messageKey/messageParams and the RpcError constructor copies
      // them from this options argument.
      // i18n: pass-through (the key, if any, comes from the host)
      if (res.error) slot.reject(new RpcError(res.error.code, res.error.message, res.error.data, res.error))
      else slot.resolve(res.result)
    },
  }
  return client
}
