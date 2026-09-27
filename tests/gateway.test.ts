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
import { createGateway, type Gateway, type RawRouteFn } from '../packages/base/gateway/src/index.ts'

const cleanups: Array<() => void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** A dist directory with one index.html so SPA semantics can be observed. */
function dist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mediabase-gateway-'))
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

describe('gateway: byte ranges (data plane)', () => {
  const FULL = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

  /** A producer that honours the window and hands back only those bytes. */
  const slicing = (): Record<string, RawRouteFn> => ({
    'slice.bin': (range) => {
      if (!range) return { body: FULL, totalSize: FULL.byteLength }
      const start = Math.min(range.start, FULL.byteLength - 1)
      const end = Math.min(range.end, FULL.byteLength - 1)
      return { body: FULL.subarray(start, end + 1), totalSize: FULL.byteLength }
    },
  })

  it('answers 206 + Content-Range when the producer slices', async () => {
    const g = await gateway({ rawRoutes: slicing() })
    const r = await fetch(url(g, '/api/slice.bin'), { headers: { Range: 'bytes=3-5' } })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 3-5/10')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([3, 4, 5])
  })

  it('advertises ranges on the plain 200 too — a client probes before it seeks', async () => {
    const g = await gateway({ rawRoutes: slicing() })
    const r = await fetch(url(g, '/api/slice.bin'))
    expect(r.status).toBe(200)
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect([...new Uint8Array(await r.arrayBuffer())].length).toBe(10)
  })

  it('slices on the gateway when a route declares a total but ignores the window', async () => {
    const g = await gateway({ rawRoutes: { 'lazy.bin': () => ({ body: FULL, totalSize: FULL.byteLength }) } })
    const r = await fetch(url(g, '/api/lazy.bin'), { headers: { Range: 'bytes=8-9' } })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 8-9/10')
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([8, 9])
  })

  it('never range-serves a route that declares no total (a live frame is not seekable)', async () => {
    const g = await gateway({ rawRoutes: { 'frame.rgb': () => ({ body: FULL }) } })
    const r = await fetch(url(g, '/api/frame.rgb'), { headers: { Range: 'bytes=2-4' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('accept-ranges')).toBeNull()
    expect([...new Uint8Array(await r.arrayBuffer())].length).toBe(10)
  })

  it('answers 416 with the real size when the window starts past the end', async () => {
    const g = await gateway({ rawRoutes: slicing() })
    const r = await fetch(url(g, '/api/slice.bin'), { headers: { Range: 'bytes=99-120' } })
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */10')
  })

  it('clamps an open-ended tail to the resource instead of overflowing', async () => {
    const g = await gateway({ rawRoutes: slicing() })
    const r = await fetch(url(g, '/api/slice.bin'), { headers: { Range: 'bytes=7-' } })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 7-9/10')
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([7, 8, 9])
  })

  // Degrading to the whole representation is legal (RFC 9110 §14.2 ranges are a
  // MAY) and is the only sane answer for a spec this gateway does not slice.
  it('degrades to 200 for a multi-range or suffix spec', async () => {
    const g = await gateway({ rawRoutes: slicing() })
    for (const spec of ['bytes=0-1,4-5', 'bytes=-3', 'bytes=9-2', 'items=0-1']) {
      const r = await fetch(url(g, '/api/slice.bin'), { headers: { Range: spec } })
      expect(r.status, spec).toBe(200)
      expect([...new Uint8Array(await r.arrayBuffer())].length, spec).toBe(10)
    }
  })

  it('keeps a range-aware route behind the token gate', async () => {
    const g = await gateway({ rawRoutes: slicing(), auth: { token: 's3cret' } })
    expect((await fetch(url(g, '/api/slice.bin'), { headers: { Range: 'bytes=0-1' } })).status).toBe(401)
    const ok = await fetch(`${url(g, '/api/slice.bin')}?token=s3cret`, { headers: { Range: 'bytes=0-1' } })
    expect(ok.status).toBe(206)
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
