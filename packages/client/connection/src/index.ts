// @mediabase/connection — client plugin: control-plane WebSocket to the host.
//
// Provides ctx.rpc (JSON-RPC client over WS /rpc) with auto-reconnect, and
// emits `connection.status` events ({ connected }) that the UI subscribes to.
// Mirrors a DSH client plugin: `name`, `apply`, service via ctx.reflect.provide,
// typed through declare module.

import type { Context } from '@deepseek-ai/cordis'
import { CONTROL_PROTOCOL_VERSION, makeClient, RpcCode, RpcError, type HostInfo } from '@mediabase/protocol'
import { openStream, streamUrl, type StreamHandle, type StreamHandlers } from './stream.ts'

export { openStream, streamUrl }
export type { StreamFrameMeta, StreamHandle, StreamHandlers, StreamStatus } from './stream.ts'
// The ring sink is opt-in for a caller that wants frames in shared memory (no
// per-frame allocation, readable from a worker); the default path stays per-frame.
export { openRingStream, ringSupported } from './ring.ts'
export type { RingStream, RingStreamOptions } from './ring.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** JSON-RPC client for host `media.*` methods. */
    rpc: RpcService
    /** Data-plane push channel subscriber (WS /stream). */
    streams: StreamsService
    /** URL/token helper for the control + data planes. */
    net: NetService
  }
}

export interface RpcService {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  connected(): boolean
  /** Control-plane handshake result (null until the host answered). */
  handshake(): HandshakeState
}

/** Result of the protocol handshake with the host (`server.info`). */
export interface HandshakeState {
  /** Protocol the client speaks (`CONTROL_PROTOCOL_VERSION`). */
  client: number
  /** Protocol the host reported, or null when it never answered. */
  host: number | null
  /** null = unknown yet, false = the host speaks a different protocol. */
  compatible: boolean | null
}

export interface StreamsService {
  /** Subscribe to a stream channel; frames arrive via `onFrame`. */
  open(channel: string, handlers: StreamHandlers): StreamHandle
  /** Stream endpoint URL for this page. */
  url(): string
}

/**
 * Host URLs carry the shared token when the host enforces one (`AVSTUDIO_TOKEN`).
 * The token is taken from `?token=` (then remembered in localStorage) so a link
 * like `http://127.0.0.1:3088/?token=…` authenticates both WS endpoints and every
 * `/api/*` fetch — including the ones panels do themselves.
 */
export interface NetService {
  /** Add the token to an app-relative URL (`/api/preview.rgb`). */
  apiUrl(path: string): string
  /** WebSocket URL for a host path, token included. */
  wsUrl(path: string): string
  /** The token in use, or null when the host does not require one. */
  token(): string | null
  /** Where this client is talking to. */
  host(): string
}

export const name = 'connection'

const TOKEN_KEY = 'avstudio:token'

/** `?token=` wins (and is remembered); otherwise the stored one is reused. */
function resolveToken(): string | null {
  if (typeof location === 'undefined') return null
  try {
    const fromQuery = new URLSearchParams(location.search).get('token')
    if (fromQuery !== null && fromQuery !== '') {
      localStorage.setItem(TOKEN_KEY, fromQuery)
      return fromQuery
    }
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function apply(ctx: Context): void {
  let ws: WebSocket | null = null
  /**
   * Requests written before the socket is OPEN.
   *
   * Why this exists: `client.handle()` is fed by the socket, so a call issued while
   * the socket is still CONNECTING (the panels mount and call immediately) or between
   * reconnects used to be handed to a `send` that dropped it on the floor — no error,
   * no retry, just a 30s timeout and an empty panel. Measured in the real-browser
   * suite: the API console's `api.list` call landed in that window and the panel
   * stayed empty with nothing logged.
   *
   * Bounded on purpose: when the host is unreachable, `send` throws so the caller gets
   * an error NOW instead of an outbox that grows forever.
   */
  const outbox: string[] = []
  const OUTBOX_MAX = 200

  // One client for the lifetime of this plugin (the connection may drop and come
  // back; the client is the stable handle callers hold, so it must not be replaced).
  const client = makeClient(
    (raw) => sendOrQueue(raw),
    (method, params) => ctx.events.emit(method, params),
  )

  /** Compared once the socket opens; surfaced through ctx.rpc.handshake(). */
  const handshake: HandshakeState = { client: CONTROL_PROTOCOL_VERSION, host: null, compatible: null }

  const token = resolveToken()
  const withToken = (path: string): string => {
    if (token === null) return path
    return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
  }
  const net: NetService = {
    apiUrl: (path) => withToken(path),
    wsUrl: (path) => withToken(streamUrl(path)),
    token: () => token,
    host: () => (typeof location === 'undefined' ? '127.0.0.1' : location.host),
  }
  ctx.reflect.provide('net', net)

  /** Send now, or queue until the socket opens; never drop silently. */
  function sendOrQueue(raw: string): void {
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(raw)
      return
    }
    if (outbox.length >= OUTBOX_MAX) {
      // Throwing inside `makeClient`'s promise executor rejects THAT call, which is
      // what the caller needs to hear.
      throw new RpcError(RpcCode.UNAVAILABLE, 'host unreachable: rpc outbox is full')
    }
    outbox.push(raw)
  }

  function flushOutbox(): void {
    const socket = ws
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    while (outbox.length > 0) {
      const next = outbox.shift()!
      socket.send(next)
    }
  }

  function connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(withToken(`${proto}://${location.host}/rpc`))
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      ctx.events.emit('connection.status', { connected: true })
      // Anything the panels asked for while we were connecting goes out now.
      flushOutbox()
      // Handshake: ask the host what protocol it speaks. A mismatch is reported
      // (and shown in the UI) rather than discovered method by method.
      void rpc.call<HostInfo>('server.info')
        .then((info) => {
          handshake.host = typeof info?.protocol === 'number' ? info.protocol : null
          handshake.compatible = handshake.host === null ? null : handshake.host === CONTROL_PROTOCOL_VERSION
          if (handshake.compatible === false) {
            console.error(
              `[avstudio] 控制面协议不匹配:宿主 v${String(handshake.host)} vs 客户端 v${CONTROL_PROTOCOL_VERSION}` +
              '(请把宿主与前端一起升级)',
            )
          }
          ctx.events.emit('connection.status', {
            connected: true,
            protocol: handshake.host,
            compatible: handshake.compatible,
          })
        })
        .catch(() => { /* older host without server.info: leave compatible unknown */ })
    }
    ws.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
      client.handle(data)
    }
    ws.onclose = () => {
      ctx.events.emit('connection.status', { connected: false })
      // Requests already on the wire will never be answered: fail them so a caller
      // sees "connection lost" instead of waiting out the timeout.
      client.fail(new RpcError(RpcCode.UNAVAILABLE, 'control-plane connection lost'))
      setTimeout(connect, 1000)
    }
    ws.onerror = () => {
      /* the close handler retries */
    }
  }

  const rpc: RpcService = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      return client.call<T>(method, params)
    },
    connected() {
      return ws !== null && ws.readyState === WebSocket.OPEN
    },
    handshake: () => ({ ...handshake }),
  }
  ctx.reflect.provide('rpc', rpc)

  const streams: StreamsService = {
    open: (channel, handlers) => openStream(channel, handlers, { url: streams.url() }),
    url: () => net.wsUrl('/stream'),
  }
  ctx.reflect.provide('streams', streams)

  // Host notifications ({ jsonrpc, method, params } with no id) are re-emitted on the
  // event bus by the client created above, so plugins subscribe with
  // ctx.events.on('<method>', ...) — e.g. the workflow plugin listens to
  // 'workflow.progress'.
  connect()

  ctx.effect(() => () => ws?.close(), `${name}: socket`)
}
