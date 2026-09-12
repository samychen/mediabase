// @mediabase/gateway — standalone unit tests.
//
// The gateway carried the most machinery per line (static SPA semantics, WS
// upgrade routing, raw byte routes, health merge, auth, stream backpressure,
// broadcast) and was only covered indirectly through whole-host tests. These are
// the properties a host depends on but no capability exercises directly.

import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGateway, type Gateway } from '../packages/base/gateway/src/index.ts'

const cleanups: Array<() => void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** A dist directory with one index.html so SPA semantics can be observed. */
function dist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'avstudio-gateway-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">shell</div>')
  writeFileSync(join(dir, 'app.js'), 'console.log("hi")')
  return dir
}

async function gateway(options: Partial<Parameters<typeof createGateway>[0]> = {}): Promise<Gateway> {
  const g = createGateway({
    host: '127.0.0.1',
    port: 0,
    distIndex: join(dist(), 'index.html'),
    methods: { 'demo.ping': async () => 'pong' },
    ...options,
  })
  await g.ready()
  cleanups.push(() => { void g.close() })
  return g
}

const url = (g: Gateway, path: string): string => `http://127.0.0.1:${g.port()}${path}`

/** Minimal WS exchange helper (Node's global WebSocket). */
function rpcCall(g: Gateway, method: string, params: unknown = {}): Promise<{ result?: unknown; error?: { code: number } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${g.port()}/rpc`)
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }))
    ws.onmessage = (event) => {
      resolve(JSON.parse(String(event.data)) as { result?: unknown; error?: { code: number } })
      ws.close()
    }
    ws.onerror = () => reject(new Error('ws failed'))
  })
}

describe('gateway: static SPA semantics', () => {
  it('serves the index for / and the asset it points at', async () => {
    const g = await gateway()
    const index = await fetch(url(g, '/'))
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('shell')

    const asset = await fetch(url(g, '/app.js'))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
  })

  it('falls back to index.html for an unknown path but refuses traversal', async () => {
    const g = await gateway()
    // SPA routing: a client-side route must not 404
    const deep = await fetch(url(g, '/some/client/route'))
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('shell')

    // Traversal outside the dist root must never read a file. Two shapes matter:
    //
    // 1) PLAIN `../`: the WHATWG URL parser normalizes it before the gateway sees
    //    it, so the request becomes a harmless SPA fallback (asserted below — the
    //    point is that it does not reach the filesystem).
    // 2) PERCENT-ENCODED `%2e%2e%2f`: the parser leaves it alone and the gateway
    //    decodes it by hand, which is exactly when the 403 guard fires. `fetch`
    //    would re-encode/normalize, so both cases go through a raw request.
    const rawGet = (path: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: g.port(), method: 'GET', path }, (res) => {
          let body = ''
          res.on('data', (chunk: Buffer) => { body += chunk.toString() })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        req.on('error', reject)
        req.end()
      })

    const plain = await rawGet('/../../../../etc/hosts')
    expect(plain.status).toBe(200) // normalized to /etc/hosts -> SPA fallback
    expect(plain.body).toContain('shell')
    expect(plain.body).not.toContain('localhost')

    const encoded = await rawGet('/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/hosts')
    expect(encoded.status).toBe(403)
    expect(encoded.body).not.toContain('localhost')
  })

  it('answers only GET/HEAD and 405s anything else', async () => {
    const g = await gateway()
    const res = await fetch(url(g, '/'), { method: 'POST' })
    expect(res.status).toBe(405)
  })
})

describe('gateway: control plane', () => {
  it('dispatches JSON-RPC and reports unknown methods with a code', async () => {
    const g = await gateway()
    expect(await rpcCall(g, 'demo.ping')).toEqual({ jsonrpc: '2.0', id: 7, result: 'pong' })
    const missing = await rpcCall(g, 'demo.nope')
    expect(missing.error?.code).toBe(-32601)
  })

  it('resolves the method map per request, so late registrations are callable', async () => {
    const methods: Record<string, (p?: unknown) => unknown> = { 'demo.ping': async () => 'pong' }
    const g = await gateway({ methods: () => methods })
    expect((await rpcCall(g, 'demo.ping')).result).toBe('pong')
    methods['demo.late'] = async () => 'late'
    expect((await rpcCall(g, 'demo.late')).result).toBe('late')
  })

  it('broadcasts notifications to every connected client', async () => {
    const g = await gateway()
    const received: string[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${g.port()}/rpc`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws failed'))
    })
    ws.onmessage = (event) => received.push(String(event.data))
    g.broadcast('demo.tick', { n: 1 })
    await new Promise((r) => setTimeout(r, 100))
    expect(JSON.parse(received[0] ?? '{}')).toMatchObject({ method: 'demo.tick', params: { n: 1 } })
    ws.close()
  })
})

describe('gateway: data plane', () => {
  it('serves raw routes, 404s an empty payload, and merges health', async () => {
    const g = await gateway({
      rawRoutes: {
        'demo.bin': () => ({ body: new Uint8Array([1, 2, 3]), headers: { 'x-demo': 'yes' } }),
        'demo.empty': () => ({ body: null }),
      },
      health: () => ({ extra: true }),
    })
    const bin = await fetch(url(g, '/api/demo.bin'))
    expect(bin.status).toBe(200)
    expect(bin.headers.get('x-demo')).toBe('yes')
    expect(new Uint8Array(await bin.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

    // no bytes yet is a 404, not an empty 200
    expect((await fetch(url(g, '/api/demo.empty'))).status).toBe(404)
    // unknown route falls through to the SPA (still 200), not to the raw layer
    expect((await fetch(url(g, '/api/nope'))).status).toBe(200)

    expect(await fetch(url(g, '/api/health')).then((r) => r.json())).toEqual({ ok: true, extra: true })
  })
})

describe('gateway: lifecycle', () => {
  it('reports the bound port, is ready once, and closes idempotently', async () => {
    const g = await gateway()
    expect(g.port()).toBeGreaterThan(0)
    await expect(g.ready()).resolves.toBeUndefined()
    expect(g.streamSubscribers()).toEqual({})
    await g.close()
    await g.close() // second close must not throw
    await expect(fetch(url(g, '/'))).rejects.toThrow()
  })

  it('refuses an unknown WS path instead of leaving the socket hanging', async () => {
    const g = await gateway()
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${g.port()}/nope`)
      ws.onopen = () => resolve('open')
      ws.onerror = () => resolve('refused')
      ws.onclose = () => resolve('refused')
      setTimeout(() => resolve('timeout'), 1_000)
    })
    expect(outcome).toBe('refused')
  })
})
