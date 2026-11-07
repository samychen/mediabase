// @mediabase/mcp — the MCP endpoint's protocol behavior, and the gateway's
// POST-endpoint branch it rides on.
//
// Protocol tests compose the real plugins and drive the registered handler
// directly (no socket): initialize negotiation, tools/list shape (inputSchema
// from the registry, annotations from mutates, wire-name mapping), tools/call
// through the control plane (results, tool failures, policy refusals — all as
// isError RESULTS, the MCP way), notifications → 202, and the JSON-RPC error
// codes for the malformed cases.
//
// The gateway tests prove the transport half: a POST reaches the handler, the
// endpoint path is token-gated like /api/*, GET answers 405, and an
// over-maxPayload body is shed with 413 instead of buffered.

import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from '../packages/base/schema/src/index.ts'
import { RpcError } from '../packages/base/rpc/src/index.ts'
import * as log from '../packages/base/log/src/index.ts'
import * as api from '../packages/host/api/src/index.ts'
import * as tools from '../packages/host/tools/src/index.ts'
import * as mcp from '../packages/host/mcp/src/index.ts'
import { createGateway } from '../packages/base/gateway/src/index.ts'

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

const made: string[] = []
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

interface Fixture {
  ctx: Context
  /** The mounted endpoint handler: body in, HTTP-ish response out. */
  post: (body: unknown) => Promise<{ status: number; headers: Record<string, string>; body: string }>
  toolCalls: Array<{ name: string; args: unknown }>
}

async function compose(): Promise<Fixture> {
  const ctx = new Context()
  const toolCalls: Array<{ name: string; args: unknown }> = []
  const dir = mkdtempSync(join(tmpdir(), 'mediabase-mcp-'))
  made.push(dir)

  ctx.plugin(log, { level: 'error', sink: () => {} })
  await settle()
  ctx.plugin(api)
  await settle()
  ctx.plugin(tools)
  await settle()

  ctx.tools.register({
    name: 'media.probe',
    description: '读取媒体文件时长',
    mutates: false,
    params: z.object({ file: z.string().required() }),
    execute: (a) => {
      toolCalls.push({ name: 'media.probe', args: a })
      return { duration: 3 }
    },
  })
  ctx.tools.register({
    name: 'a_b',
    description: 'collides with the mangled media_probe? no — but pairs with a.b in the wire map test',
    execute: () => 'second',
  })
  ctx.tools.register({
    name: 'media.write',
    description: '一个会改状态的工具',
    mutates: true,
    execute: () => { throw RpcError.unavailable('下游不可用(mock)') },
  })
  await settle()

  ctx.plugin(mcp, { path: '/mcp' })
  await settle()

  const handler = ctx.api.endpointMap()['/mcp']
  if (handler === undefined) throw new Error('mcp endpoint missing')
  const post = async (body: unknown): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    const out = await handler({
      body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
      contentType: 'application/json',
    })
    return { status: out.status ?? 200, headers: out.headers ?? {}, body: typeof out.body === 'string' ? out.body : new TextDecoder().decode(out.body) }
  }
  return { ctx, post, toolCalls }
}

interface Wire {
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

const rpc = (id: number, method: string, params?: Record<string, unknown>): Record<string, unknown> =>
  ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })

// ---- protocol ---------------------------------------------------------------

describe('@mediabase/mcp: the protocol', () => {
  it('negotiates initialize: echoes a supported version, answers with its own otherwise', async () => {
    const fx = await compose()
    try {
      const ok = await fx.post(rpc(1, 'initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'test' } }))
      expect(ok.status).toBe(200)
      const parsed = JSON.parse(ok.body) as Wire
      expect(parsed.result?.['protocolVersion']).toBe('2025-03-26')
      expect(parsed.result?.['capabilities']).toMatchObject({ tools: {} })
      expect((parsed.result?.['serverInfo'] as Record<string, unknown>)?.name).toBe('mediabase-mcp')

      const future = await fx.post(rpc(2, 'initialize', { protocolVersion: '2999-01-01' }))
      expect((JSON.parse(future.body) as Wire).result?.['protocolVersion']).toBe('2025-06-18')
    } finally {
      await fx.ctx.fiber.dispose()
    }
  })

  it('lists tools with the registry-derived inputSchema, mutates annotations and wire names', async () => {
    const fx = await compose()
    try {
      const res = await fx.post(rpc(1, 'tools/list'))
      const listed = (JSON.parse(res.body) as Wire).result?.['tools'] as Array<Record<string, unknown>>
      const probe = listed.find((t) => t['name'] === 'media_probe')
      expect(probe?.['description']).toBe('读取媒体文件时长')
      expect(probe?.['inputSchema']).toMatchObject({ type: 'object' })
      // mutates: false → an honest readOnlyHint: true.
      expect(probe?.['annotations']).toMatchObject({ readOnlyHint: true })
      // mutates: true → the write is declared as one.
      expect(listed.find((t) => t['name'] === 'media_write')?.['annotations']).toMatchObject({ readOnlyHint: false })
      // undeclared → no annotation at all, rather than a wrong one.
      expect(listed.find((t) => t['name'] === 'a_b')?.['annotations']).toBeUndefined()
    } finally {
      await fx.ctx.fiber.dispose()
    }
  })

  it('calls a tool through the control plane and wraps the result as content', async () => {
    const fx = await compose()
    try {
      const res = await fx.post(rpc(1, 'tools/call', { name: 'media_probe', arguments: { file: '/tmp/x.mp4' } }))
      const parsed = JSON.parse(res.body) as Wire
      expect(parsed.result?.['isError']).toBe(false)
      const content = parsed.result?.['content'] as Array<{ text: string }> | undefined
      expect(JSON.parse(content?.[0]?.text ?? 'null')).toEqual({ duration: 3 })
      // It went through tools.run (registry validation), not around it.
      expect(fx.toolCalls).toEqual([{ name: 'media.probe', args: { file: '/tmp/x.mp4' } }])
    } finally {
      await fx.ctx.fiber.dispose()
    }
  })

  it('reports tool failures and policy refusals INSIDE the result (isError), the MCP way', async () => {
    const fx = await compose()
    try {
      const failed = await fx.post(rpc(1, 'tools/call', { name: 'media_write', arguments: {} }))
      const bad = JSON.parse(failed.body) as Wire
      expect(bad.result?.['isError']).toBe(true)
      expect((bad.result?.['content'] as Array<{ text: string }> | undefined)?.[0]?.text).toContain('下游不可用')

      fx.ctx.api.policy({ deny: ['tools.run'] })
      const denied = await fx.post(rpc(2, 'tools/call', { name: 'media_probe', arguments: { file: 'x' } }))
      const refused = JSON.parse(denied.body) as Wire
      expect(refused.result?.['isError']).toBe(true)
      expect((refused.result?.['content'] as Array<{ text: string }> | undefined)?.[0]?.text).toContain('deny')
    } finally {
      await fx.ctx.fiber.dispose()
    }
  })

  it('answers an unknown tool with an isError result, and protocol errors with JSON-RPC codes', async () => {
    const fx = await compose()
    try {
      const unknown = await fx.post(rpc(1, 'tools/call', { name: 'not_a_tool', arguments: {} }))
      const unknownParsed = JSON.parse(unknown.body) as Wire
      expect(unknownParsed.result?.['isError']).toBe(true)
      expect((unknownParsed.result?.['content'] as Array<{ text: string }> | undefined)?.[0]?.text).toContain('unknown tool')

      const noMethod = await fx.post(rpc(1, 'no/such/method'))
      expect((JSON.parse(noMethod.body) as Wire).error?.code).toBe(-32601)

      const badJson = await fx.post('not json at all')
      expect(badJson.status).toBe(400)
      expect((JSON.parse(badJson.body) as Wire).error?.code).toBe(-32700)

      const badRequest = await fx.post({ jsonrpc: '1.0', id: 1, method: 'tools/list' })
      expect((JSON.parse(badRequest.body) as Wire).error?.code).toBe(-32600)
    } finally {
      await fx.ctx.fiber.dispose()
    }
  })

  it('accepts notifications with 202 and no body', async () => {
    const fx = await compose()
    try {
      const res = await fx.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
      expect(res.status).toBe(202)
      expect(res.body).toBe('')
    } finally {
      await fx.ctx.fiber.dispose()
    }
  })
})

// ---- the gateway branch it rides on -----------------------------------------

describe('@mediabase/mcp: the gateway POST branch', () => {
  const dist = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mediabase-mcp-gw-'))
    made.push(dir)
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">shell</div>')
    return dir
  }

  const withGateway = async (
    options: Partial<Parameters<typeof createGateway>[0]> = {},
    run: (base: string) => Promise<void>,
  ): Promise<void> => {
    const g = createGateway({
      distIndex: join(dist(), 'index.html'),
      methods: {},
      port: 0, // OS-picked: a test must never race a real host on 3088
      ...options,
    })
    await g.ready()
    try {
      await run(`http://127.0.0.1:${g.port()}`)
    } finally {
      await g.close()
    }
  }

  const echoHandler = async (req: { body: Uint8Array }): Promise<{ body: string }> => {
    const msg = JSON.parse(new TextDecoder().decode(req.body)) as { hello?: string }
    return { body: JSON.stringify({ echo: msg.hello ?? null }) }
  }

  it('routes POST to the endpoint and answers 405 for other methods on its path', async () => {
    await withGateway({ postEndpoints: { '/mcp': echoHandler } }, async (base) => {
      const post = await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify({ hello: '世界' }) })
      expect(post.status).toBe(200)
      expect(await post.json()).toEqual({ echo: '世界' })

      const get = await fetch(`${base}/mcp`)
      expect(get.status).toBe(405)
    })
  })

  it('token-gates the endpoint path exactly like /api/*', async () => {
    await withGateway({ postEndpoints: { '/mcp': echoHandler }, auth: { token: 'sekret' } }, async (base) => {
      const denied = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })
      expect(denied.status).toBe(401)
      const allowed = await fetch(`${base}/mcp?token=sekret`, { method: 'POST', body: '{}' })
      expect(allowed.status).toBe(200)
    })
  })

  it('sheds an over-maxPayload body with 413 instead of buffering it', async () => {
    await withGateway({ postEndpoints: { '/mcp': echoHandler }, maxPayload: 64 }, async (base) => {
      const big = await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify({ hello: 'x'.repeat(1000) }) })
      expect(big.status).toBe(413)
    })
  })
})

// ---- the stdio bridge (scripts/mcp-stdio.mjs) -------------------------------

describe('@mediabase/mcp: the stdio bridge', () => {
  it('forwards stdio JSON-RPC to the host endpoint and returns responses on stdout', async () => {
    // A stand-in /mcp endpoint: echoes the method back with the id it got.
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      req.on('end', () => {
        const msg = JSON.parse(raw) as { id: number; method: string }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { served: msg.method } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const child = spawn(process.execPath, ['scripts/mcp-stdio.mjs'], {
      env: { ...process.env, MEDIABASE_URL: `http://127.0.0.1:${port}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const lines: string[] = []
      const waiters: Array<{ pattern: (id: unknown) => boolean; resolve: (line: string) => void }> = []
      let buffer = ''
      child.stdout.on('data', (d: Buffer) => {
        buffer += d.toString()
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          lines.push(line)
          const parsed = JSON.parse(line) as { id?: number }
          const i = waiters.findIndex((w) => parsed.id !== undefined && w.pattern(parsed.id))
          if (i >= 0) waiters.splice(i, 1)[0]!.resolve(line)
        }
      })
      const next = (id: number): Promise<string> => new Promise((resolve) => {
        if (lines.some((l) => (JSON.parse(l) as { id?: number }).id === id)) resolve('')
        else waiters.push({ pattern: (got) => got === id, resolve })
      })

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`)
      const first = JSON.parse(await next(7)) as { result?: { served?: string } }
      expect(first.result?.served).toBe('tools/list')

      // notifications go out but never come back; the next request still works
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' })}\n`)
      const second = JSON.parse(await next(8)) as { result?: { served?: string } }
      expect(second.result?.served).toBe('ping')
      expect(lines.filter((l) => (JSON.parse(l) as { id?: number }).id === undefined)).toHaveLength(0)
    } finally {
      child.kill()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 15_000)
})
