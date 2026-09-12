// @mediabase/connection — stream client (data plane, push).
//
// Opens the gateway's WS `/stream` endpoint for one channel and hands frames to
// the caller. Deliberately tiny and transport-only: it knows the envelope
// (`meta` / binary / `dropped` / `error`), not what the bytes mean — rgb24,
// PCM, whatever the channel declares.
//
// Reconnect policy lives here (a viewer should come back after a host restart);
// the caller decides what to do while not live (`onStatus`), typically falling
// back to the pull route (GET /api/<channel>).

export interface StreamFrameMeta {
  channel: string
  seq: number
  bytes: number
  /** Channel-specific fields (width/height/format/time …). */
  [key: string]: unknown
}

export type StreamStatus = 'connecting' | 'live' | 'closed'

export interface StreamHandlers {
  /** One frame: metadata + the raw payload. */
  onFrame(meta: StreamFrameMeta, body: Uint8Array): void
  /** Transport state changed (live → paint from the stream, otherwise poll). */
  onStatus?(status: StreamStatus): void
  /** Frames the host shed under backpressure (a slow client). */
  onDropped?(channel: string, count: number): void
  onError?(message: string): void
}

export interface StreamHandle {
  close(): void
  status(): StreamStatus
}

export interface StreamClientOptions {
  /** Absolute ws(s) URL of the stream endpoint, e.g. `ws://host/stream`. */
  url: string
  /** Reconnect delay in ms (default 1000); set 0 to disable reconnecting. */
  retryMs?: number
}

/**
 * Subscribe to one channel. Returns immediately; frames arrive as they are
 * published. The socket is closed when `close()` is called (no further retries).
 */
export function openStream(
  channel: string,
  handlers: StreamHandlers,
  options: StreamClientOptions,
): StreamHandle {
  let ws: WebSocket | null = null
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let status: StreamStatus = 'connecting'
  /** Metadata of the frame whose payload has not arrived yet. */
  let pendingMeta: StreamFrameMeta | null = null

  const setStatus = (next: StreamStatus): void => {
    if (status === next) return
    status = next
    handlers.onStatus?.(next)
  }

  function connect(): void {
    if (closed) return
    setStatus('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(options.url)
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e.message : String(e))
      scheduleRetry()
      return
    }
    ws = socket
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      if (closed) return
      socket.send(JSON.stringify({ type: 'subscribe', channel }))
      setStatus('live')
    }
    socket.onmessage = (e) => {
      // Text = envelope (meta/dropped/error); binary = the payload announced by
      // the preceding meta. Keeping them separate avoids parsing headers off the
      // hot path (one JSON parse per frame, not per byte).
      if (typeof e.data === 'string') {
        let msg: { type?: string; channel?: string; count?: number; message?: string } & Partial<StreamFrameMeta>
        try {
          msg = JSON.parse(e.data) as typeof msg
        } catch {
          return
        }
        if (msg.type === 'meta') {
          pendingMeta = msg as StreamFrameMeta
        } else if (msg.type === 'dropped') {
          handlers.onDropped?.(msg.channel ?? channel, msg.count ?? 0)
        } else if (msg.type === 'error') {
          handlers.onError?.(msg.message ?? 'stream error')
        }
        return
      }
      const body = new Uint8Array(e.data as ArrayBuffer)
      const meta = pendingMeta
      pendingMeta = null
      if (!meta) return // payload without metadata: ignore rather than guess
      handlers.onFrame(meta, body)
    }
    socket.onclose = () => {
      setStatus('closed')
      ws = null
      scheduleRetry()
    }
    socket.onerror = () => {
      // onclose follows; the retry is scheduled there.
    }
  }

  function scheduleRetry(): void {
    if (closed || retryMs === 0) return
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      connect()
    }, retryMs)
  }

  const retryMs = options.retryMs ?? 1_000
  connect()

  return {
    close(): void {
      closed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      try {
        ws?.close()
      } catch {
        /* already gone */
      }
      ws = null
      setStatus('closed')
    },
    status: () => status,
  }
}

/** Stream endpoint URL for the current page (browser) or an explicit host. */
export function streamUrl(path = '/stream', host = typeof location === 'undefined' ? '127.0.0.1' : location.host): string {
  const proto = typeof location === 'undefined' ? 'ws' : location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${host}${path}`
}
