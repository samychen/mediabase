// @mediabase/gateway — robustness limits: a front door that is exposed to clients
// must survive hostile or broken input, and must shut down without cutting a
// response in half. These are base properties (no capability involved): they hold
// for ANY host built on this gateway, which is exactly why they are tested here
// rather than through a product capability.
//
// What is asserted, and why each one is load-bearing:
//   - an oversized incoming frame is refused by the transport, not buffered, and
//     the host keeps answering (a 100 MB JSON.parse is a remote OOM)
//   - the connection budget is finite and frees up when a client leaves
//   - a throwing method map / route producer answers an error instead of exiting
//     the process (Node kills the process on an unhandled rejection)
//   - close() drains: in-flight responses finish, WS clients get a 1001 farewell
//     (not a 1006 vanish), and no new work is accepted

import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGateway, type Gateway } from '../packages/base/gateway/src/index.ts'
import { RpcCode } from '../packages/base/rpc/src/index.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  // Awaited: an unclosed gateway keeps its port (and undici's pooled socket)
  // alive, so the NEXT test could talk to the previous server.
  while (cleanups.length > 0) await cleanups.pop()!()
})

function dist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mediabase-gateway-limits-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">shell</div>')
  return dir
}

async function gateway(options: Partial<Parameters<typeof createGateway>[0]> = {}): Promise<Gateway> {
  const g = createGateway({
    host: '127.0.0.1',
    port: 0,
    distIndex: join(dist(), 'index.html'),
    methods: { 'demo.ping': () => 'pong' },
    ...options,
  })
  await g.ready()
  cleanups.push(() => g.close({ drainMs: 200 }))
  return g
}

/** Open a WS and report its close code (1006 when the peer vanished without one). */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.addEventListener('close', (e) => resolve((e as CloseEvent).code))
  })
}

/**
 * Plain HTTP GET over a fresh socket. Deliberately NOT `fetch`: undici pools
 * keep-alive connections across tests, which can make a request land on a
 * previous server's socket and hide the behaviour under test.
 */
function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}

function openRpc(g: Gateway): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${g.port()}/rpc`)
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error('ws failed')))
  })
}

interface Frame {
  id?: number | null
  result?: unknown
  error?: { code: number; message: string }
}

/** One request/response over a fresh socket; resolves the parsed frame. */
function call(g: Gateway, raw: string): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${g.port()}/rpc`)
    ws.addEventListener('open', () => ws.send(raw))
    ws.addEventListener('message', (e) => {
      resolve(JSON.parse(String(e.data)) as Frame)
      ws.close()
    })
    ws.addEventListener('error', () => reject(new Error('ws failed')))
  })
}

describe('gateway limits: incoming WS payload', () => {
  it('refuses an oversized frame without buffering it, and stays alive', async () => {
    const g = await gateway({ maxPayload: 4096 })
    const ws = await openRpc(g)
    const closed = closeCode(ws)

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'demo.ping', params: { pad: 'x'.repeat(64 * 1024) } }))

    // ws rejects the frame at the transport level (1009 = message too big).
    expect(await closed).toBe(1009)
    // ...and the host is still serving: one oversized frame is not an outage.
    const after = await call(g, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'demo.ping' }))
    expect(after.error).toBeUndefined()
    expect(after.result).toBe('pong')
  })

  it('leaves server->client payloads alone (only INCOMING frames are capped)', async () => {
    const big = 'y'.repeat(64 * 1024)
    const g = await gateway({ maxPayload: 4096, methods: { 'demo.big': () => big } })
    const r = await call(g, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'demo.big' }))
    expect(r.error).toBeUndefined()
    expect(r.result).toBe(big)
  })
})

describe('gateway limits: connections and broken capabilities', () => {
  it('enforces a connection budget and frees it when a client leaves', async () => {
    const g = await gateway({ maxConnections: 1 })
    const first = await openRpc(g)
    await new Promise((r) => setTimeout(r, 20)) // let wss.clients see it

    const refused = new WebSocket(`ws://127.0.0.1:${g.port()}/rpc`)
    await new Promise<void>((resolve) => {
      refused.addEventListener('error', () => resolve())
      refused.addEventListener('open', () => { refused.close(); resolve() })
    })
    // The upgrade is answered with 503 (the client reports it as an error event),
    // never a silent hang or an accepted-but-useless socket.
    expect(refused.readyState).not.toBe(1)

    first.close()
    await new Promise((r) => setTimeout(r, 50))
    const after = await openRpc(g)
    expect(after.readyState).toBe(1)
    after.close()
  })

  it('answers a throwing method map with a coded error instead of exiting', async () => {
    const failures: string[] = []
    const g = await gateway({
      methods: () => { throw new Error('capability mid-unload') },
      onError: (_e, where) => failures.push(where),
    })
    const frame = await call(g, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'demo.ping' }))
    expect(frame.error).toEqual({ code: RpcCode.INTERNAL, message: 'capability mid-unload' })
    expect(failures).toEqual(['ws /rpc'])
    // Still alive.
    expect((await get(`http://127.0.0.1:${g.port()}/api/health`)).status).toBe(200)
  })

  it('answers 500 when a capability route producer throws, instead of exiting', async () => {
    const failures: string[] = []
    const g = await gateway({
      rawRoutes: () => ({ 'boom.rgb': () => { throw new Error('producer died') } }),
      onError: (_e, where) => failures.push(where),
    })
    const res = await get(`http://127.0.0.1:${g.port()}/api/boom.rgb`)
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'internal' })
    expect(failures).toEqual(['GET /api/boom.rgb'])
    expect((await get(`http://127.0.0.1:${g.port()}/api/health`)).status).toBe(200)
  })

  it('answers 500 when a health probe throws, instead of exiting', async () => {
    const g = await gateway({ health: () => { throw new Error('health broke') } })
    expect((await get(`http://127.0.0.1:${g.port()}/api/health`)).status).toBe(500)
    // The static shell (the SPA) is unaffected by a broken probe.
    expect((await get(`http://127.0.0.1:${g.port()}/`)).status).toBe(200)
  })
})

describe('gateway limits: graceful close', () => {
  it('says goodbye (1001) instead of vanishing (1006), then refuses new work', async () => {
    const g = await gateway({ drainTimeoutMs: 20_000 })
    const ws = await openRpc(g)
    const closed = closeCode(ws)

    const started = Date.now()
    await g.close({ drainMs: 300 })
    // 1006 would mean the socket was killed; 1001 lets the UI say "reconnecting".
    expect(await closed).toBe(1001)
    // A peer that never answers the close frame must not block shutdown.
    expect(Date.now() - started).toBeLessThan(2000)
    // Nothing listens any more: a restart can rebind the port immediately.
    await expect(get(`http://127.0.0.1:${g.port()}/api/health`)).rejects.toThrow()
    // Closing twice is a no-op, not a second shutdown against a closed server
    // (a listen failure, a signal handler and a fiber dispose all call it).
    await expect(g.close()).resolves.toBeUndefined()
  })

  it('does not cut a response that is still streaming to a slow reader', async () => {
    // A restart must not corrupt a response in flight. The body is far larger
    // than any socket buffer, so with a client that stops reading the response
    // provably CANNOT finish — which is precisely the window close() has to
    // respect (terminating sockets here would truncate the body).
    const big = new Uint8Array(64 * 1024 * 1024)
    const g = await gateway({ rawRoutes: () => ({ 'big.bin': () => ({ body: big }) }) })

    let headers!: () => void
    const gotHeaders = new Promise<void>((r) => { headers = r })
    const received = new Promise<number>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: g.port(), path: '/api/big.bin', agent: false, headers: { connection: 'close' } }, (res) => {
        let bytes = 0
        res.pause()
        headers()
        setTimeout(() => res.resume(), 300)
        res.on('data', (chunk: Buffer) => { bytes += chunk.byteLength })
        res.on('end', () => resolve(bytes))
        res.on('error', reject)
      })
      req.on('error', reject)
    })

    await gotHeaders
    const closing = g.close({ drainMs: 10_000 })
    expect(await received).toBe(big.byteLength)
    await closing
  })
})
