// Access control + plugin least privilege.
//
// Honest scope: AVStudio runs the host as a LOCAL service for one user, so
// `MEDIABASE_TOKEN` is a local trust boundary (another process on the machine),
// not a login system — the base has no TLS, sessions or user model. What is
// checked here:
//   1. a gateway with `auth` refuses the data plane, /api/health and BOTH WS
//      endpoints without the token, and serves them with it,
//   2. the static SPA shell stays public (it holds no data),
//   3. a runtime plugin declaring `requires` cannot touch an undeclared service —
//      and the error tells you which declaration to add,
//   4. control-plane calls are audited through ctx.log (one choke point).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createGateway } from '../packages/base/gateway/src/index.ts'
import { openStream, streamUrl } from '../packages/client/connection/src/stream.ts'
import { ROOT } from './support/host.ts'
import * as log from '../packages/base/log/src/index.ts'
import { IDENTITY } from '../apps/cli/src/identity.ts'
import * as api from '../packages/host/api/src/index.ts'
import * as plugins from '../packages/host/plugins/src/index.ts'
import type { ApiService } from '../packages/host/api/src/index.ts'
import type { LogRecord } from '../packages/base/log/src/index.ts'

const settle = (ms = 20): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
const TOKEN = 'sekrit-token'

function distDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mediabase-auth-dist-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>')
  return dir
}

const cleanups: Array<() => void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('gateway token auth', () => {
  async function gatewayWithToken(): Promise<{ port: number; close: () => Promise<void> }> {
    const dir = distDir()
    const gateway = createGateway({
      host: '127.0.0.1',
      port: 0,
      distIndex: join(dir, 'index.html'),
      methods: { 'demo.ping': async () => 'pong' },
      rawRoutes: { 'demo.bin': () => ({ body: new Uint8Array([1, 2, 3]) }) },
      streams: { 'demo.frames': { name: 'demo.frames', attach: () => () => {} } },
      auth: { token: TOKEN },
    })
    await gateway.ready()
    cleanups.push(() => { void gateway.close() })
    return { port: gateway.port(), close: () => gateway.close() }
  }

  it('refuses the data plane and health without the token, serves them with it', async () => {
    const { port } = await gatewayWithToken()
    const base = `http://127.0.0.1:${port}`

    for (const path of ['/api/demo.bin', '/api/health']) {
      const denied = await fetch(`${base}${path}`)
      expect(denied.status).toBe(401)
      expect(await denied.json()).toEqual({ error: 'unauthorized' })

      const allowed = await fetch(`${base}${path}?token=${TOKEN}`)
      expect(allowed.status).toBe(200)
    }
    // wrong token is refused too (and compared in constant time)
    expect((await fetch(`${base}/api/health?token=nope`)).status).toBe(401)
    // the SPA shell is public: it contains no data
    expect((await fetch(`${base}/`)).status).toBe(200)
  })

  it('refuses both WS endpoints without the token and accepts them with it', async () => {
    const { port } = await gatewayWithToken()
    const good = streamUrl('/stream', `127.0.0.1:${port}`)

    // /stream without a token: the upgrade is rejected, so the client never
    // becomes live (it keeps retrying rather than pretending frames are coming).
    const unauthorized = openStream('demo.frames', { onFrame: () => {} }, { url: good, retryMs: 20 })
    await settle(150)
    expect(unauthorized.status()).not.toBe('live')
    unauthorized.close()

    const authorized = openStream('demo.frames', { onFrame: () => {} }, { url: `${good}?token=${TOKEN}`, retryMs: 20 })
    await waitForState(authorized.status, 'live')
    authorized.close()

    // /rpc behaves the same way
    const denied = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
    const deniedClosed = new Promise<boolean>((resolve) => {
      denied.onclose = () => resolve(true)
      denied.onerror = () => resolve(true)
      setTimeout(() => resolve(false), 1_000)
    })
    expect(await deniedClosed).toBe(true)

    const allowed = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`)
    const reply = await new Promise<string>((resolve, reject) => {
      allowed.onopen = () => allowed.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'demo.ping', params: {} }))
      allowed.onmessage = (e) => resolve(String(e.data))
      allowed.onerror = () => reject(new Error('authenticated rpc socket failed'))
    })
    expect(JSON.parse(reply)).toMatchObject({ id: 1, result: 'pong' })
    allowed.close()
  })
})

function waitForState(read: () => string, expected: string, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (read() === expected) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`never became ${expected} (is ${read()})`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe('runtime plugin least privilege', () => {
  // Plugin modules must live INSIDE the repo: vitest's module runner refuses to
  // import files outside the project root (a real constraint for `plugins.load`
  // when the host runs under vitest rather than plain node/tsx).
  const madeDirs: string[] = []
  function pluginDir(source: string): string {
    mkdirSync(join(ROOT, 'tests/.tmp-plugins'), { recursive: true })
    const dir = mkdtempSync(join(ROOT, 'tests/.tmp-plugins/plugin-'))
    madeDirs.push(dir)
    writeFileSync(join(dir, 'plugin.mjs'), source)
    return join(dir, 'plugin.mjs')
  }
  afterEach(() => {
    while (madeDirs.length > 0) rmSync(madeDirs.pop()!, { recursive: true, force: true })
  })

  async function composePluginManager(entries: Array<Parameters<typeof buildEntry>[0]>): Promise<{ ctx: Context; records: LogRecord[] }> {
    const ctx = new Context()
    const records: LogRecord[] = []
    // `scope`: the base has no app name of its own, so a composition states it — the row
    // does this with `scope: !!js ctx.appPaths.bin`.
    ctx.plugin(log, { level: 'debug', scope: IDENTITY.bin, sink: (r) => records.push(r) })
    await settle(0)
    ctx.plugin(api)
    await settle(0)
    ctx.plugin(plugins, { catalog: entries.map(buildEntry) })
    await settle(0)
    cleanups.push(() => { void ctx.fiber.dispose() })
    return { ctx, records }
  }

  function buildEntry(entry: { id: string; module: string; requires?: string[]; provides?: string[] }): {
    id: string; module: string; requires?: string[]; provides?: string[]
  } {
    return entry
  }

  it('refuses a plugin whose inject exceeds its declared requires', async () => {
    // cordis resolves `inject` for the plugin, so that list must fit the entry's
    // allowance — otherwise the declaration silently widens the plugin's reach.
    const module = pluginDir(`
export const name = 'needs-media'
export const inject = ['media']
export function apply(ctx) { ctx.effect(() => () => {}) }
`)
    const { ctx } = await composePluginManager([{ id: 'needs-media', module, requires: [] }])
    await expect(ctx.plugins.load('needs-media')).rejects.toThrow(/inject 了未声明的服务 "media"/)
  })

  it('refuses a direct access to an undeclared service and names the fix', async () => {
    const module = pluginDir(`
export const name = 'sneaky'
export function apply(ctx) { ctx.media.ping() }
`)
    const { ctx } = await composePluginManager([{ id: 'sneaky', module, requires: [] }])
    await expect(ctx.plugins.load('sneaky')).rejects.toThrow(/未声明的服务 "media"/)
    await expect(ctx.plugins.load('sneaky')).rejects.toThrow(/requires: \["media"\]/)
  })

  it('lets a plugin use what it declared (and still tears it down)', async () => {
    const module = pluginDir(`
export const name = 'greeter'
export function apply(ctx) {
  ctx.reflect.provide('greeter', { hi: () => 'hi' })
  ctx.effect(() => () => {})
}
`)
    const { ctx, records } = await composePluginManager([{ id: 'greeter', module, provides: ['greeter'], requires: [] }])
    const descriptor = await ctx.plugins.load('greeter')
    expect(descriptor).toMatchObject({ id: 'greeter', state: 'loaded' })
    expect(ctx.reflect.get('greeter')).toBeDefined()
    // the manager audits load/unload through ctx.log (scope: avstudio.plugins)
    expect(records.some((r) => r.msg.includes('插件已加载') && r.scope === 'mediabase.plugins')).toBe(true)

    await ctx.plugins.unload('greeter')
    expect(ctx.reflect.get('greeter')).toBeUndefined()
    expect(records.some((r) => r.msg.includes('插件已卸载'))).toBe(true)
  })

  it('audits control-plane calls: unknown methods warn, successes debug', async () => {
    const ctx = new Context()
    const records: LogRecord[] = []
    // `scope`: the base has no app name of its own, so a composition states it — the row
    // does this with `scope: !!js ctx.appPaths.bin`.
    ctx.plugin(log, { level: 'debug', scope: IDENTITY.bin, sink: (r) => records.push(r) })
    await settle(0)
    ctx.plugin(api)
    await settle(0)
    const registry: ApiService = ctx.get('api')!
    registry.register({ name: 'demo.ok', description: 'x', handler: () => 1 })
    await registry.call('demo.ok')
    await expect(registry.call('demo.missing')).rejects.toThrow(/method not found/)
    registry.register({ name: 'demo.boom', description: 'x', handler: () => { throw new Error('nope') } })
    await expect(registry.call('demo.boom')).rejects.toThrow('nope')

    const audit = records.filter((r) => r.scope === 'mediabase.api')
    expect(audit.some((r) => r.level === 'debug' && r.msg.includes('demo.ok ok') && typeof r.data?.['ms'] === 'number')).toBe(true)
    expect(audit.some((r) => r.level === 'warn' && r.msg.includes('未知方法: demo.missing'))).toBe(true)
    expect(audit.some((r) => r.level === 'warn' && r.msg.includes('demo.boom 失败'))).toBe(true)
    await ctx.fiber.dispose()
  })
})
