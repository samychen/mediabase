// Control-plane registry + schema bridge + logger — unit level (no processes).
//
// Item 1/2 of the base work: capabilities register their own API, the server
// only reads the registry, and every boundary (params, results, tool args) is
// validated by one schema language with coded errors.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RpcCode } from '../packages/base/rpc/src/index.ts'
import { SchemaError, parse, toJsonSchema, z } from '../packages/base/schema/src/index.ts'
import { createLogger, type LogRecord } from '../packages/base/log/src/index.ts'
import * as log from '../packages/base/log/src/index.ts'
import { IDENTITY } from '../apps/cli/src/identity.ts'
import * as api from '../packages/host/api/src/index.ts'
import * as tools from '../packages/host/tools/src/index.ts'
import type { ApiService, CapabilitiesService } from '../packages/host/api/src/index.ts'
import type { RegistryService } from '../packages/base/protocol/src/index.ts'

/** cordis activates a plugin's services on a microtask. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

async function compose(): Promise<{ ctx: Context; api: ApiService; caps: CapabilitiesService; tools: RegistryService }> {
  const ctx = new Context()
  // Same order as the real composition: infrastructure first (the api
  // registry injects ctx.log for its audit trail).
  ctx.plugin(log, { level: 'error', sink: () => {} })
  await settle()
  ctx.plugin(api)
  await settle()
  ctx.plugin(tools)
  await settle()
  const apiService = ctx.get('api')
  const caps = ctx.get('capabilities')
  const toolsService = ctx.get('tools')
  if (!apiService || !caps || !toolsService) throw new Error('services missing')
  return { ctx, api: apiService, caps, tools: toolsService }
}

/** Capture a rejection with its wire code. */
interface Rejection {
  code?: number
  message: string
  messageKey?: string
  messageParams?: Record<string, string | number>
  data?: unknown
}

async function rejection(fn: () => Promise<unknown>): Promise<Rejection> {
  try {
    await fn()
  } catch (e) {
    const err = e as Rejection
    return {
      ...(typeof err.code === 'number' ? { code: err.code } : {}),
      message: err.message,
      ...(err.messageKey !== undefined ? { messageKey: err.messageKey } : {}),
      ...(err.messageParams !== undefined ? { messageParams: err.messageParams } : {}),
      ...(err.data !== undefined ? { data: err.data } : {}),
    }
  }
  throw new Error('expected the call to reject')
}

describe('schema dialect + JSON-Schema bridge', () => {
  it('fills defaults, rejects a bad type with a path, ignores extra keys', () => {
    const schema = z.object({ file: z.string().required(), time: z.number().default(0) })
    expect(schema({ file: 'a.mp4' })).toEqual({ file: 'a.mp4', time: 0 })
    expect(schema({ file: 'a.mp4', extra: 1 })).toMatchObject({ file: 'a.mp4' })

    expect(() => parse(schema, {}, 'media.decode 参数')).toThrow(SchemaError)
    try {
      parse(schema, { file: 5 }, 'media.decode 参数')
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as SchemaError
      expect(err.path).toEqual(['file'])
      expect(err.message).toContain('media.decode 参数')
    }
  })

  it('derives the LLM JSON Schema from the same declaration', () => {
    const json = toJsonSchema(z.object({
      file: z.string().required().description('路径'),
      time: z.number().default(1.5),
      mode: z.union([z.const('fast'), z.const('slow')]),
      tags: z.array(z.string()),
    }))
    expect(json.type).toBe('object')
    expect(json.required).toEqual(['file'])
    expect(json.properties?.file).toEqual({ description: '路径', type: 'string' })
    // an explicit default survives; the implicit empty-object default does not
    expect(json.properties?.time).toMatchObject({ type: 'number', default: 1.5 })
    expect(json.default).toBeUndefined()
    expect(json.properties?.mode?.enum).toEqual(['fast', 'slow'])
    expect(json.properties?.tags).toMatchObject({ type: 'array', items: { type: 'string' } })
  })
})

describe('ctx.api method registry', () => {
  it('registers, introspects and calls methods (self-registered introspection included)', async () => {
    const { api: registry } = await compose()
    const names = registry.list().map((m) => m.name)
    expect(names).toEqual(expect.arrayContaining(['api.list', 'capabilities.list', 'capabilities.verify']))

    registry.register({
      name: 'demo.echo',
      description: '返回收到的文本',
      params: z.object({ text: z.string().required() }),
      result: z.object({ text: z.string(), len: z.number() }),
      handler: (p) => ({ text: p.text, len: p.text.length }),
    })
    const view = registry.list().find((m) => m.name === 'demo.echo')
    expect(view?.signature).toBe('{ text: string }')
    expect(await registry.call('demo.echo', { text: 'abc' })).toEqual({ text: 'abc', len: 3 })
    await expect(registry.call('demo.echo', {})).rejects.toThrow(/demo\.echo 参数/)
  })

  it('exposes the registry as a JSON-RPC method map (the server is generic)', async () => {
    const { api: registry } = await compose()
    registry.register({
      name: 'demo.fail',
      description: '总是抛错的演示方法',
      handler: () => { throw new Error('boom') },
    })
    const map = registry.methodMap()
    expect(Object.keys(map)).toContain('demo.fail')
    // methodMap is in registration order; list() sorts for display.
    expect(Object.keys(map).sort()).toEqual(registry.list().map((m) => m.name).sort())
  })

  it('rejects a malformed name, a duplicate name, and an unknown method with the right codes', async () => {
    const { api: registry } = await compose()
    expect(() => registry.register({ name: 'nodots', description: 'x', handler: () => 1 })).toThrow(/方法名必须/)
    registry.register({ name: 'demo.one', description: 'x', handler: () => 1 })
    expect(() => registry.register({ name: 'demo.one', description: 'y', handler: () => 2 })).toThrow(/重复/)

    const missing = await rejection(() => registry.call('demo.nope'))
    expect(missing.code).toBe(RpcCode.METHOD_NOT_FOUND)

    registry.register({
      name: 'demo.typed',
      description: 'x',
      params: z.object({ n: z.number().required() }),
      handler: (p) => p.n,
    })
    const bad = await rejection(() => registry.call('demo.typed', { n: 'x' }))
    expect(bad.code).toBe(RpcCode.INVALID_PARAMS)
    expect(bad.data).toEqual({ path: ['n'] })
  })

  it('turns a capability that breaks its own result contract into an INTERNAL error', async () => {
    const { api: registry } = await compose()
    registry.register({
      name: 'demo.liar',
      description: 'x',
      result: z.object({ width: z.number().required() }),
      // The result schema types this handler's return, so breaking the contract
      // needs a deliberate cast — exactly the mistake the runtime check catches.
      handler: () => ({ width: 'not-a-number' }) as unknown as { width: number },
    })
    const r = await rejection(() => registry.call('demo.liar'))
    expect(r.code).toBe(RpcCode.INTERNAL)
    expect(r.message).toContain('能力契约不符')
  })

  it('drops methods, routes and manifests when the api fiber is disposed', async () => {
    const { ctx, api: registry, caps } = await compose()
    registry.register({ name: 'demo.tmp', description: 'x', handler: () => 1 })
    caps.register({ id: 'demo', title: 'Demo', description: 'x', api: ['demo.tmp'] })
    expect(registry.list().some((m) => m.name === 'demo.tmp')).toBe(true)

    await ctx.fiber.dispose()
    expect(registry.list()).toEqual([])
    expect(caps.list()).toEqual([])
  })
})

describe('capability manifests', () => {
  it('verifies declarations against what actually registered', async () => {
    const { api: registry, caps, tools: toolRegistry } = await compose()
    registry.register({ name: 'demo.a', description: 'x', handler: () => 1 })
    toolRegistry.register({ name: 'demo.tool', description: 'x', execute: () => 1 })
    caps.register({ id: 'good', title: 'Good', description: 'x', api: ['demo.a'], tools: ['demo.tool'] })
    caps.register({ id: 'broken', title: 'Broken', description: 'x', services: ['nope'], api: ['demo.missing'], tools: ['demo.absent'] })

    const reports = caps.verify()
    expect(reports.find((r) => r.id === 'good')).toMatchObject({ ok: true, missing: { services: [], api: [], tools: [] } })
    const broken = reports.find((r) => r.id === 'broken')
    expect(broken?.ok).toBe(false)
    expect(broken?.missing.services).toEqual(['nope'])
    expect(broken?.missing.api).toEqual(['demo.missing'])
    expect(broken?.missing.tools).toEqual(['demo.absent'])
  })

  it('notifies subscribers so late capabilities still get their events forwarded', async () => {
    const { caps } = await compose()
    const seen: string[] = []
    caps.subscribe((m) => seen.push(m.id))
    caps.register({ id: 'late', title: 'Late', description: 'x', events: ['late.tick'] })
    expect(seen).toEqual(['late']) // 'tools' registered before the subscription
    expect(caps.list().map((m) => m.id)).toEqual(['tools', 'late'])
  })
})

describe('access policy (method-level ACL)', () => {
  it('denies by list and wildcard, and reports FORBIDDEN with the policy attached', async () => {
    const { api: registry } = await compose()
    registry.register({ name: 'demo.read', description: 'x', handler: () => 'read' })
    registry.register({ name: 'demo.write', description: 'x', mutates: true, handler: () => 'write' })

    registry.policy({ deny: ['demo.write'] })
    expect(await registry.call('demo.read')).toBe('read')
    const denied = await rejection(() => registry.call('demo.write'))
    expect(denied.code).toBe(RpcCode.FORBIDDEN)
    expect(denied.message).toContain('deny 列表拒绝')
    expect(denied.data).toMatchObject({ method: 'demo.write' })
    // A refusal also carries a message KEY: the host keeps its prose for the log,
    // and a client explains the refusal in the user's language (see ctx.i18n).
    expect(denied.messageKey).toBe('error.acl.denied')
    expect(denied.messageParams).toEqual({ method: 'demo.write' })

    // wildcard covers a whole namespace
    registry.policy({ deny: ['demo.*'] })
    expect((await rejection(() => registry.call('demo.read'))).code).toBe(RpcCode.FORBIDDEN)

    // allow-list is a whitelist: anything not listed is refused
    registry.policy({ allow: ['demo.read'] })
    expect(await registry.call('demo.read')).toBe('read')
    expect((await rejection(() => registry.call('demo.write'))).code).toBe(RpcCode.FORBIDDEN)
  })

  it('read-only mode refuses exactly the methods declared as mutating', async () => {
    const { api: registry } = await compose()
    registry.register({ name: 'demo.status', description: 'x', handler: () => 'status' })
    registry.register({ name: 'demo.play', description: 'x', mutates: true, handler: () => 'playing' })

    expect(registry.mutates('demo.play')).toBe(true)
    expect(registry.mutates('demo.status')).toBe(false)
    // api.list exposes the flag so a UI can disable mutating buttons
    expect(registry.list().find((m) => m.name === 'demo.play')?.mutates).toBe(true)

    registry.policy({ readonly: true })
    expect(await registry.call('demo.status')).toBe('status')
    const refused = await rejection(() => registry.call('demo.play'))
    expect(refused.code).toBe(RpcCode.FORBIDDEN)
    expect(refused.message).toContain('只读模式')
    expect(refused.messageKey).toBe('error.acl.readonly')
    expect(registry.currentPolicy()).toEqual({ readonly: true })

    registry.policy({}) // clearing the policy restores full access
    expect(await registry.call('demo.play')).toBe('playing')
  })

  it('audits refusals through ctx.log', async () => {
    const ctx = new Context()
    const records: LogRecord[] = []
    // `scope` is the app's name in production (the row states `!!js ctx.appPaths.bin`); a
    // capability composed directly has to be told, because the base names no product.
    ctx.plugin(log, { level: 'debug', scope: IDENTITY.bin, sink: (r) => records.push(r) })
    await settle()
    ctx.plugin(api)
    await settle()
    const registry = ctx.get('api')!
    registry.register({ name: 'demo.write', description: 'x', mutates: true, handler: () => 1 })
    registry.policy({ readonly: true })
    await expect(registry.call('demo.write')).rejects.toThrow()
    expect(records.some((r) => r.level === 'warn' && r.msg.includes('拒绝调用 demo.write') && r.scope === 'mediabase.api')).toBe(true)
    await ctx.fiber.dispose()
  })
})

describe('tool registry validation', () => {
  it('validates tool args and derives the LLM schema from the same declaration', async () => {
    const { tools: registry } = await compose()
    registry.register({
      name: 'demo.decode',
      description: '解码一帧',
      params: z.object({ file: z.string().required(), time: z.number().default(0) }),
      execute: (args) => ({ file: args.file, time: args.time }),
    })

    const view = registry.list()[0]!
    expect(view.signature).toBe('{ file: string, time?: number }')
    expect(view.parameters).toMatchObject({ type: 'object', required: ['file'] })
    expect(await registry.run('demo.decode', { file: 'a.mp4' })).toEqual({ file: 'a.mp4', time: 0 })

    const bad = await rejection(() => registry.run('demo.decode', {}))
    expect(bad.code).toBe(RpcCode.INVALID_PARAMS)
    expect(bad.data).toEqual({ path: ['file'] })

    const unknown = await rejection(() => registry.run('demo.nope', {}))
    expect(unknown.code).toBe(RpcCode.NOT_FOUND)
  })
})

describe('ctx.log', () => {
  it('filters by level, scopes children and forwards to the sink', () => {
    const records: LogRecord[] = []
    const logger = createLogger({ level: 'info', scope: 'mediabase', sink: (r) => records.push(r), timestamps: false })
    logger.debug('hidden')
    logger.info('shown')
    logger.child('media').warn('scoped', { file: 'a.mp4' })

    expect(records.map((r) => [r.level, r.scope, r.msg])).toEqual([
      ['info', 'mediabase', 'shown'],
      ['warn', 'mediabase.media', 'scoped'],
    ])
    expect(records[1]?.data).toEqual({ file: 'a.mp4' })

    logger.setLevel('debug')
    logger.debug('now visible')
    expect(records).toHaveLength(3)
    expect(logger.level()).toBe('debug')
  })
})
