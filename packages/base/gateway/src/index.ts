// @mediabase/gateway — neutral HTTP/WS gateway (route-B extraction from
// @mediabase/server). Capability-agnostic: static SPA serving (frontend-static
// semantics), a WS JSON-RPC control plane over your method map, raw byte routes
// (data plane, pull) and byte STREAMS (data plane, push). Apps bring their own
// method map / routes / channels; nothing here knows any business service.
//
// Two shapes of data plane, because they answer different problems:
//   GET /api/<name>   pull  — one-shot/latest bytes, cacheable, trivially scalable
//   WS  /stream       push  — real-time frames with no per-frame HTTP overhead
// A producer publishes through the SAME sink interface for either; the gateway
// decides delivery and applies backpressure (dropping frames is better than
// building an unbounded queue in front of a live viewer).

import http from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { makeServer, RpcCode, type RpcMethods } from '@mediabase/rpc'

export interface RawRoute {
  body: Uint8Array | null
  headers?: Record<string, string>
}

/**
 * A transport sink bound to one subscriber. `send` returns false when the frame
 * was dropped (slow client) — the producer learns that real-time data is being
 * shed instead of silently queueing it.
 */
export interface StreamSink {
  send(meta: Record<string, unknown>, body: Uint8Array): boolean
  subscribers(): number
  dropped(): number
}

/** What a capability registers so clients can subscribe to its channel. */
export interface StreamChannel {
  name: string
  attach(sink: StreamSink): () => void
}

export interface GatewayOptions {
  host?: string
  port?: number
  /** Absolute path to index.html inside the built web client. */
  distIndex: string
  /**
   * JSON-RPC method map (control plane). Pass a FUNCTION when the registry can
   * change while the gateway runs (a capability mounted at runtime): the map is
   * then resolved per request instead of frozen at construction.
   */
  methods: RpcMethods | (() => RpcMethods)
  /** Raw byte routes served at /api/<name> (data plane); same lazy rule. */
  rawRoutes?: Record<string, () => RawRoute> | (() => Record<string, () => RawRoute>)
  /**
   * Optional shared-secret gate. When set, the data plane (`/api/*`), the WS
   * endpoints and `/api/health` require `?token=` (or `Authorization: Bearer`).
   * The static SPA shell stays public — it holds no data. This is a local
   * trust boundary (another process on the machine), NOT a substitute for TLS or
   * multi-user auth.
   */
  auth?: { token: string }
  /** Bytes buffered in a socket above this are shed instead of queued (default 8 MiB). */
  streamHighWaterMark?: number
  /** Stream channels clients may subscribe to; same lazy rule as methods. */
  streams?: Record<string, StreamChannel> | (() => Record<string, StreamChannel>)
  /** Extra payload merged under GET /api/health's {ok:true,...}. */
  health?: () => unknown
  /**
   * Serve `Cross-Origin-Opener-Policy: same-origin` +
   * `Cross-Origin-Embedder-Policy: require-corp`, which is what makes
   * `SharedArrayBuffer` available to the page (a prerequisite for the
   * `@mediabase/shm` frame ring in a browser).
   *
   * Off by default on purpose: a cross-origin-isolated document refuses to load
   * cross-origin subresources that do not opt in with CORP/CORS, so a deployment
   * that embeds anything external would break. Turn it on when the client uses the
   * ring (AVSTUDIO_CROSS_ORIGIN_ISOLATION=1) and keep the app self-hosted, or serve
   * the extra headers from the fronting proxy instead.
   */
  crossOriginIsolation?: boolean
  /**
   * Largest INCOMING WS frame accepted, in bytes (default 1 MiB). The control
   * plane carries commands and status, never media: a client that sends more is
   * a bug or an attack, and ws closes the socket (1009) instead of buffering it.
   * Server->client payloads are not affected (a capability may answer with more).
   */
  maxPayload?: number
  /** Concurrent WS connections across /rpc and /stream (default 64); beyond it an upgrade is refused with 503. */
  maxConnections?: number
  /** How long close() waits for in-flight HTTP responses and WS farewells (default 2000 ms). */
  drainTimeoutMs?: number
  /**
   * Called when a request handler throws — the gateway answers 500 and keeps
   * serving. Without this hook the failure would be silent (the gateway names no
   * logger by design: the host passes `ctx.log`).
   */
  onError?: (error: unknown, where: string) => void
}

export interface Gateway {
  /** Actual bound port (config.port may have been 0). */
  port(): number
  /** Live stream subscribers (per channel) — for health/introspection. */
  streamSubscribers(): Record<string, number>
  /** Resolves once the server is listening (or rejects on error). */
  ready(): Promise<void>
  /** Push a JSON-RPC notification to every connected client. */
  broadcast(method: string, params: unknown): void
  /**
   * Stop accepting, say goodbye to live sockets, let in-flight responses finish,
   * then resolve. Bounded by `drainTimeoutMs` (or `drainMs` here) — a stuck
   * socket delays shutdown, it never blocks it forever.
   */
  close(options?: { drainMs?: number }): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

async function serveStatic(pathname: string, res: http.ServerResponse, distRoot: string, distIndex: string): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const serveIndex = async (): Promise<void> => {
    try {
      const body = await readFile(distIndex)
      res.writeHead(200, { 'content-type': MIME['.html'] ?? 'text/html; charset=utf-8' })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('web client not built.')
    }
  }
  if (target === distRoot || target === distIndex) {
    await serveIndex()
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    await serveIndex()
  }
}

/** Constant-time comparison so a token cannot be guessed byte by byte. */
function tokenMatches(expected: string, provided: string | null): boolean {
  if (provided === null) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** `?token=` first, then `Authorization: Bearer` (WS clients cannot set headers). */
function presentedToken(url: URL, req: http.IncomingMessage): string | null {
  const fromQuery = url.searchParams.get('token')
  if (fromQuery !== null && fromQuery !== '') return fromQuery
  const header = req.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return null
}

export function createGateway(opts: GatewayOptions): Gateway {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 3088
  const distRoot = dirname(opts.distIndex)
  const maxPayload = opts.maxPayload ?? 1024 * 1024
  const maxConnections = opts.maxConnections ?? 64
  const drainTimeoutMs = opts.drainTimeoutMs ?? 2000
  const resolveRaw = (): Record<string, () => RawRoute> =>
    typeof opts.rawRoutes === 'function' ? opts.rawRoutes() : opts.rawRoutes ?? {}

  // In-flight HTTP responses. close() waits for this to reach 0 (bounded) so a
  // restart does not cut a frame in half — the shell's boot handshake is an HTTP
  // request too.
  let inFlight = 0
  let draining = false
  let closing: Promise<void> | null = null
  // Shutdown waiters: woken when an in-flight response finishes or a socket goes.
  const wakeups = new Set<() => void>()
  const notify = (): void => {
    for (const wake of wakeups) wake()
    wakeups.clear()
  }
  const waitFor = async (ready: () => boolean, deadline: number): Promise<void> => {
    while (!ready() && Date.now() < deadline) {
      await new Promise<void>((res) => {
        wakeups.add(res)
        const timer = setTimeout(() => { wakeups.delete(res); res() }, Math.max(1, deadline - Date.now()))
        timer.unref?.()
      })
    }
  }
  // Tracked so shutdown can close sockets gracefully (FIN) instead of destroying
  // them (which can reset a client that still has data to read).
  // `Duplex` because the upgrade event hands one over (see server.on('upgrade')).
  const sockets = new Set<Socket | Duplex>()
  const wsSockets = new Set<Duplex>()
  const requestDone = (): void => {
    inFlight--
    if (inFlight === 0) notify()
  }

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    const pathname = decodeURIComponent(url.pathname)

    const needsAuth = opts.auth !== undefined && (pathname.startsWith('/api/'))
    if (needsAuth && !tokenMatches(opts.auth!.token, presentedToken(url, req))) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    const rawMatch = pathname.startsWith('/api/') ? pathname.slice('/api/'.length) : ''
    const rawRoutes = resolveRaw()
    if (rawMatch && rawMatch in rawRoutes) {
      const route = rawRoutes[rawMatch]!()
      if (!route.body) {
        res.writeHead(404)
        res.end('no data yet')
        return
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        ...(route.headers ?? {}),
      })
      res.end(route.body)
      return
    }
    if (pathname === '/api/health') {
      // The probe runs BEFORE the status line is written: a throwing probe must
      // yield 500, not a 200 whose body happens to be an error object.
      const extra = opts.health ? opts.health() as Record<string, unknown> : {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...extra }))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    void serveStatic(pathname, res, distRoot, opts.distIndex)
  }

  const server = http.createServer((req, res) => {
    if (opts.crossOriginIsolation === true) {
      // Set on EVERY response: the shell, the data plane and the health probe are all
      // part of the same document's isolation.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    }
    if (draining) {
      // Refused instead of raced: a client reconnecting during shutdown learns to
      // come back, and the drain gets to finish.
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'connection': 'close' })
      res.end(JSON.stringify({ error: 'draining' }))
      return
    }
    inFlight++
    let counted = false
    const done = (): void => {
      if (counted) return
      counted = true
      requestDone()
    }
    res.on('finish', done)
    res.on('close', done)
    try {
      handleRequest(req, res)
    } catch (e) {
      // A capability's route producer (or health probe) threw. Answer 500 and
      // stay up: a broken capability must fail loudly, never take the host down.
      opts.onError?.(e, `${req.method ?? 'GET'} ${req.url ?? '/'}`)
      done()
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'internal' }))
    }
  })

  // ---- data plane: /stream (push) -------------------------------------------
  // Protocol (deliberately tiny, so any client can speak it):
  //   client -> {"type":"subscribe","channel":"preview.rgb"}
  //   server -> {"type":"meta","channel":...,"seq":N,"bytes":N,...}   (text)
  //             <binary payload>                                      (the frame)
  //             {"type":"dropped","channel":...,"count":N}            (backpressure)
  //             {"type":"error","message":...}
  const highWaterMark = opts.streamHighWaterMark ?? 8 * 1024 * 1024
  const resolveStreams = (): Record<string, StreamChannel> =>
    typeof opts.streams === 'function' ? opts.streams() : opts.streams ?? {}
  const subscribers = new Map<string, number>()
  const streamWss = new WebSocketServer({ noServer: true, maxPayload })
  streamWss.on('connection', (ws) => {
    let detach: (() => void) | null = null
    let channel = ''
    let seq = 0
    let dropped = 0

    const stop = (): void => {
      if (detach) detach()
      detach = null
      if (channel) subscribers.set(channel, Math.max(0, (subscribers.get(channel) ?? 1) - 1))
      channel = ''
    }

    ws.on('message', (raw) => {
      let msg: { type?: string; channel?: string }
      try {
        msg = JSON.parse(raw.toString()) as { type?: string; channel?: string }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }))
        return
      }
      if (msg.type === 'unsubscribe') {
        stop()
        return
      }
      if (msg.type !== 'subscribe' || typeof msg.channel !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'expected {type:"subscribe",channel}' }))
        return
      }
      const found = resolveStreams()[msg.channel]
      if (!found) {
        ws.send(JSON.stringify({ type: 'error', message: `unknown channel: ${msg.channel}` }))
        return
      }
      stop()
      channel = msg.channel
      subscribers.set(channel, (subscribers.get(channel) ?? 0) + 1)
      const sink: StreamSink = {
        send(meta, body): boolean {
          if (ws.readyState !== 1) return false // 1 == OPEN
          // Backpressure: a viewer that cannot keep up LOSES frames. Queueing an
          // ever-growing backlog in front of a live viewer is worse than dropping.
          if (ws.bufferedAmount > highWaterMark) {
            dropped++
            if (dropped === 1 || dropped % 30 === 0) {
              ws.send(JSON.stringify({ type: 'dropped', channel, count: dropped }))
            }
            return false
          }
          seq++
          ws.send(JSON.stringify({ type: 'meta', channel, seq, bytes: body.byteLength, ...meta }))
          ws.send(body)
          return true
        },
        subscribers: () => (ws.readyState === 1 ? 1 : 0),
        dropped: () => dropped,
      }
      detach = found.attach(sink)
    })
    ws.on('close', stop)
    ws.on('error', stop)
  })

  // Two WS endpoints on one HTTP server. Each `WebSocketServer` runs with
  // `noServer` because ws ABORTS (HTTP 400) any upgrade whose path it does not
  // own — with path-based servers the second endpoint would kill the first
  // endpoint's handshakes. One upgrade listener routes by pathname instead.
  const wss = new WebSocketServer({ noServer: true, maxPayload })
  // Resolved per request: a capability registered after boot is callable.
  const handle = (raw: string): Promise<string | undefined> =>
    makeServer(typeof opts.methods === 'function' ? opts.methods() : opts.methods)(raw)
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      void (async () => {
        let resp: string | undefined
        try {
          resp = await handle(data.toString())
        } catch (e) {
          // A method map that throws while resolving (a capability mid-unload) or
          // an error escaping makeServer must not reject unhandled — Node turns
          // that into a process exit, i.e. one broken capability kills the host.
          opts.onError?.(e, 'ws /rpc')
          resp = JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: RpcCode.INTERNAL, message: e instanceof Error ? e.message : String(e) },
          })
        }
        if (resp !== undefined && ws.readyState === 1) ws.send(resp) // 1 == OPEN
      })()
    })
    ws.on('error', () => { /* client disconnected mid-flight; ignore */ })
  })

  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      wsSockets.delete(socket)
      notify()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    const pathname = url.pathname
    const target = pathname === '/rpc' ? wss : pathname === '/stream' ? streamWss : null
    if (!target || draining) {
      socket.destroy()
      return
    }
    // Connection budget is shared by both endpoints: /stream viewers are the
    // ones that can pile up (each holds a frame sink), so one cap covers both.
    if (wss.clients.size + streamWss.clients.size >= maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (opts.auth !== undefined && !tokenMatches(opts.auth.token, presentedToken(url, req))) {
      // 401 before the handshake: an unauthenticated client learns why instead of
      // seeing a mysterious disconnect.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    // From here on the socket speaks WS, not HTTP: excluded from the graceful
    // HTTP FIN in close() (it gets a 1001 close frame and its own force path).
    wsSockets.add(socket)
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req))
  })

  let resolveReady!: () => void
  let rejectReady!: (e: Error) => void
  const readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })

  const gateway: Gateway = {
    port(): number {
      const addr = server.address()
      return typeof addr === 'object' && addr ? addr.port : port
    },
    ready(): Promise<void> {
      return readyPromise
    },
    streamSubscribers(): Record<string, number> {
      return Object.fromEntries(subscribers)
    },
    broadcast(method, params): void {
      const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
      for (const c of wss.clients) {
        if (c.readyState === 1) c.send(msg) // 1 == WebSocket.OPEN
      }
    },
    close(closeOpts): Promise<void> {
      // Idempotent: a listen failure, a signal and a fiber dispose all call this.
      if (closing !== null) return closing
      draining = true
      const drainMs = closeOpts?.drainMs ?? drainTimeoutMs
      const deadline = Date.now() + drainMs
      const waitUntil = async (t: number): Promise<void> => {
        const ms = t - Date.now()
        if (ms <= 0) return
        await new Promise<void>((res) => {
          const timer = setTimeout(res, ms)
          timer.unref?.()
        })
      }

      // 1. Say goodbye to live WS clients instead of killing the socket: 1001
      //    ("going away") reaches the UI as a clean disconnect, so it shows
      //    "reconnecting" instead of an unexplained drop.
      for (const c of [...wss.clients, ...streamWss.clients]) {
        try { c.close(1001, 'server shutting down') } catch { c.terminate() }
      }

      closing = (async () => {
        // 2. Let in-flight responses finish BEFORE touching the listener. This
        //    order is not cosmetic: server.close() runs closeIdleConnections()
        //    internally, and a connection whose response is still queued counts
        //    as closeable there — measured on Node 23, closing first delivered
        //    1.7 MB of a 64 MB body and reset the rest. New work is already
        //    refused (the `draining` check answers 503).
        await waitFor(() => inFlight === 0, deadline)

        // 3. Hang up gracefully: FIN (socket.end) rather than destroy, because a
        //    client may still hold bytes in its receive buffer that an RST
        //    discards. Upgraded sockets get their close handshake instead.
        for (const socket of sockets) {
          if (!wsSockets.has(socket)) socket.end()
        }
        await waitFor(() => sockets.size === 0, deadline)

        // 4. Stop accepting last: the listening socket closes here, so a restart
        //    can rebind the port as soon as close() resolves.
        let finished = false
        const closed = new Promise<void>((res) => server.close(() => { finished = true; res() }))
        await Promise.race([closed, waitUntil(deadline)])
        if (!finished) {
          // Someone refused to leave within the budget: make it explicit instead
          // of hanging shutdown forever.
          for (const c of wss.clients) c.terminate()
          for (const c of streamWss.clients) c.terminate()
          server.closeAllConnections?.()
          await Promise.race([closed, waitUntil(deadline)])
        }
        wss.close()
        streamWss.close()
      })()
      // Never reset to null: this gateway is one-shot, so a later close() gets the
      // settled promise instead of replaying shutdown against a closed server.
      return closing
    },
  }

  server.on('listening', () => resolveReady())
  server.on('error', (e) => rejectReady(e instanceof Error ? e : new Error(String(e))))
  server.listen(port, host)
  return gateway
}
