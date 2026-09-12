// Plugin sandbox: process isolation for runtime plugins.
//
// The in-process `requires` check (tested in access-control) constrains a
// COOPERATIVE plugin. These tests are about the properties only a separate process
// can give:
//
//   1. a plugin's service calls are checked on the HOST side — it cannot skip the
//      check because it never holds a host object;
//   2. a crashing plugin (uncaught throw, process.exit) does not take the host down;
//   3. a plugin stuck in apply() can be PREEMPTED — impossible in-process;
//   4. unloading is a process teardown, so nothing leaks;
//   5. a sandboxed plugin can still do useful work: log, emit events, call declared
//      services, and expose its own API as `plugins.call`.
//
// Real child processes are spawned, so this suite is slower than the unit ones.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as log from '../packages/base/log/src/index.ts'
import { IDENTITY } from '../apps/cli/src/identity.ts'
import * as api from '../packages/host/api/src/index.ts'
import * as plugins from '../packages/host/plugins/src/index.ts'
import { ROOT } from './support/host.ts'
import type { LogRecord } from '../packages/base/log/src/index.ts'

const settle = (ms = 20): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * The two entries a deployment can use: the BUNDLED `build/sandbox.cjs` (what a
 * packaged app spawns) and the TypeScript source via tsx (what a checkout uses).
 * Both are exercised — the bundled one is a different module system (CJS), and an
 * `import.meta` slip there once killed every sandboxed child at import time.
 */
function sandboxEntries(): Array<{ label: string; entry: string; nodeArgs?: string[] }> {
  const bundled = join(ROOT, 'build/sandbox.cjs')
  const source = join(ROOT, 'packages/host/plugins/sandbox/entry.ts')
  const entries: Array<{ label: string; entry: string; nodeArgs?: string[] }> = []
  if (existsSync(bundled)) entries.push({ label: 'bundled build/sandbox.cjs', entry: bundled })
  entries.push({ label: 'source via tsx', entry: source, nodeArgs: ['--import', 'tsx'] })
  return entries
}

const made: string[] = []
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

/** Write a plugin module inside the repo (vitest's loader refuses outside paths). */
function pluginModule(source: string): string {
  mkdirSync(join(ROOT, 'tests/.tmp-plugins'), { recursive: true })
  const dir = mkdtempSync(join(ROOT, 'tests/.tmp-plugins/sandbox-'))
  made.push(dir)
  const file = join(dir, 'plugin.mjs')
  writeFileSync(file, source)
  return file
}

interface Fixture {
  ctx: Context
  records: LogRecord[]
  /** Calls the fake service received from sandboxed plugins. */
  serviceCalls: Array<{ method: string; args: unknown[] }>
  /** Events a sandboxed plugin emitted onto the host bus. */
  events: Array<{ name: string; payload: unknown }>
}

async function compose(
  entries: Array<{ id: string; module: string; requires?: string[]; isolation?: 'process'; restarts?: number }>,
  sandboxOption?: { entry: string; nodeArgs?: string[] },
): Promise<Fixture> {
  const ctx = new Context()
  const records: LogRecord[] = []
  const serviceCalls: Array<{ method: string; args: unknown[] }> = []
  const events: Array<{ name: string; payload: unknown }> = []

  ctx.plugin(log, { level: 'debug', scope: IDENTITY.bin, sink: (r) => records.push(r) })
  await settle(0)
  ctx.plugin(api)
  await settle(0)
  // A service a sandboxed plugin may call — the host side of the boundary.
  ctx.plugin({
    name: 'demo-service',
    apply(c: Context): void {
      c.reflect.provide('demo', {
        echo: async (value: unknown) => {
          serviceCalls.push({ method: 'echo', args: [value] })
          return { echoed: value }
        },
        boom: async () => {
          serviceCalls.push({ method: 'boom', args: [] })
          throw new Error('service exploded')
        },
        secret: async () => {
          serviceCalls.push({ method: 'secret', args: [] })
          return 'should not be reachable'
        },
      })
    },
  })
  await settle(0)

  const sandbox = sandboxOption ?? sandboxEntries()[0]!
  await ctx.plugin(plugins, {
    catalog: entries.map((e) => ({ ...e, isolation: 'process' as const })),
    sandbox: { ...sandbox, applyTimeoutMs: 3_000, callTimeoutMs: 3_000 },
  })
  await settle(0)

  const dispose = ctx.events.on('sandbox.ping', (payload: unknown) => {
    events.push({ name: 'sandbox.ping', payload })
  })
  void dispose
  return { ctx, records, serviceCalls, events }
}

const WORKER = `
export const name = 'sandbox-worker'
export const api = {
  add: (a, b) => a + b,
  slow: async () => { await new Promise((r) => setTimeout(r, 50)); return 'slow-done' },
  fail: () => { throw new Error('imported api failed') },
  failCoded: () => {
    const e = new Error('插件自己说的失败')
    e.code = -32001
    e.messageKey = 'demo.pluginFailure'
    e.messageParams = { what: 'coded' }
    throw e
  },
}
export function apply(ctx) {
  ctx.log.info('沙箱插件已启动', { id: ctx.id })
  ctx.effect(() => ctx.log.info('沙箱插件已清理'))
  ctx.events.emit('sandbox.ping', { from: 'apply' })
  ctx.events.on('host.broadcast', (payload) => { void ctx.services.demo.echo(payload) })
  return (async () => {
    await ctx.services.demo.echo('hello')
  })()
}
`

describe.each(sandboxEntries().map((e) => [e.label, e] as const))(
  'sandboxed plugins via %s',
  (label, sandboxOption) => {
  it('runs a plugin in its own process, with declared service calls and events', async () => {
    const module = pluginModule(WORKER)
    const f = await compose([{ id: 'worker', module, requires: ['demo'] }], sandboxOption)
    try {
      const loaded = await f.ctx.plugins.load('worker')
      expect(loaded).toMatchObject({ id: 'worker', state: 'loaded' })
      await settle(100)

      // the plugin's own log reached the host logger under its scope
      expect(f.records.some((r) => r.scope === 'mediabase.plugins.worker' && r.msg.includes('沙箱插件已启动'))).toBe(true)
      // ...and its events reached the HOST bus (so clients can receive them)
      expect(f.events.some((e) => (e.payload as { from?: string })?.from === 'apply')).toBe(true)
      // ...and its declared service call arrived with the value intact
      expect(f.serviceCalls).toEqual([{ method: 'echo', args: ['hello'] }])

      // the host can call the plugin's exported api across the boundary
      const invoked = await f.ctx.api.call('plugins.call', { id: 'worker', method: 'add', args: [2, 3] })
      expect(invoked).toBe(5)
      expect(await f.ctx.api.call('plugins.call', { id: 'worker', method: 'slow' })).toBe('slow-done')

      // A coded error raised INSIDE the child must survive the IPC boundary: the code
      // picks the UI's error bucket and the key is what makes it translatable. Both
      // used to be dropped (only `message` crossed), so a NOT_FOUND arrived as INTERNAL
      // with prose only.
      const codedFailure = await f.ctx.api.call('plugins.call', { id: 'worker', method: 'failCoded' }).then(
        () => null,
        (e: { code?: number; message?: string; messageKey?: string; messageParams?: unknown }) => e,
      )
      expect(codedFailure?.code).toBe(-32001)
      expect(codedFailure?.message).toBe('插件自己说的失败')
      expect(codedFailure?.messageKey).toBe('demo.pluginFailure')
      expect(codedFailure?.messageParams).toEqual({ what: 'coded' })

      // A method the plugin does not export is a METHOD_NOT_FOUND with a key the host
      // can translate (the child names it, because only the child knows the export list).
      const noMethod = await f.ctx.api.call('plugins.call', { id: 'worker', method: 'nope' }).then(
        () => null,
        (e: { code?: number; messageKey?: string; messageParams?: Record<string, unknown> }) => e,
      )
      expect(noMethod?.code).toBe(-32601)
      expect(noMethod?.messageKey).toBe('plugins.noSuchMethod')
      expect(noMethod?.messageParams).toEqual({ method: 'nope' })

      // host→plugin events are forwarded only for names it subscribed to
      f.ctx.events.emit('host.broadcast', 'from-host')
      await settle(150)
      expect(f.serviceCalls).toContainEqual({ method: 'echo', args: ['from-host'] })

      const status = await f.ctx.api.call('plugins.sandboxStatus') as Record<string, { state: string; calls: number; api: string[]; subscriptions: string[] }>
      expect(status['worker']).toMatchObject({ state: 'ready', api: expect.arrayContaining(['add', 'slow', 'fail']) })
      expect(status['worker']?.subscriptions).toContain('host.broadcast')
      expect(status['worker']?.calls).toBeGreaterThanOrEqual(2) // apply + broadcast

      await f.ctx.plugins.unload('worker')
      await settle(100)
      expect(f.records.some((r) => r.msg.includes('沙箱插件已清理'))).toBe(true)
    } finally {
      await f.ctx.fiber.dispose()
    }
  })

  it('refuses an undeclared service on the HOST side, where the plugin cannot skip it', async () => {
    const module = pluginModule(`
export const name = 'sneaky'
export function apply(ctx) {
  // No requires for 'demo': the proxy refuses locally AND the host refuses the call.
  return ctx.services.demo.secret().catch((e) => ctx.log.warn('被拒绝: ' + e.message))
}
`)
    const f = await compose([{ id: 'sneaky', module, requires: [] }], sandboxOption)
    try {
      await f.ctx.plugins.load('sneaky')
      await settle(150)
      expect(f.serviceCalls).toEqual([]) // never reached the service
      expect(f.records.some((r) => r.msg.includes('被拒绝') && r.msg.includes('demo'))).toBe(true)
    } finally {
      await f.ctx.fiber.dispose()
    }
  })

  it('survives a plugin that crashes: the host stays up and the failure is visible', async () => {
    const crasher = pluginModule(`
export const name = 'crasher'
export function apply(ctx) {
  ctx.log.info('即将崩溃')
  setTimeout(() => { throw new Error('uncaught in timer') }, 20)
  setTimeout(() => process.exit(7), 60)
}
`)
    const stable = pluginModule(`
export const name = 'stable'
export const api = { ping: () => 'stable-pong' }
export function apply(ctx) { ctx.log.info('stable up') }
`)
    const f = await compose([
      { id: 'crasher', module: crasher, requires: [] },
      { id: 'stable', module: stable, requires: [] },
    ], sandboxOption)
    try {
      await f.ctx.plugins.load('stable')
      await f.ctx.plugins.load('crasher')
      await settle(300)

      // the host is alive and still serving: another plugin works, RPC works
      expect(await f.ctx.api.call('plugins.call', { id: 'stable', method: 'ping' })).toBe('stable-pong')
      expect(f.ctx.api.list().length).toBeGreaterThan(5)

      // the crash is recorded, not swallowed
      expect(f.records.some((r) => r.level === 'error' && r.msg.includes('crasher') && r.msg.includes('进程退出'))).toBe(true)
      const listed = await f.ctx.plugins.list()
      expect(listed.find((d) => d.id === 'crasher')?.state).toBe('error')
      // probing a sandboxed plugin checks its live state, not a service on ctx
      expect(await f.ctx.plugins.probe('crasher')).toMatchObject({ state: 'error', provided: false })
    } finally {
      await f.ctx.fiber.dispose()
    }
  })

  it('preempts a plugin stuck in apply() instead of hanging the host', async () => {
    const spinner = pluginModule(`
export const name = 'spinner'
export function apply() {
  // In-process this would block the host's event loop forever.
  for (;;) { /* spin */ }
}
`)
    const f = await compose([{ id: 'spinner', module: spinner, requires: [] }], sandboxOption)
    try {
      const started = Date.now()
      await expect(f.ctx.plugins.load('spinner')).rejects.toThrow(/apply\(\) 超时/)
      expect(Date.now() - started).toBeLessThan(6_000)
      // host responsive afterwards
      expect(await f.ctx.api.call('plugins.list')).toBeInstanceOf(Array)
      expect(f.records.some((r) => r.level === 'error' && r.msg.includes('spinner'))).toBe(true)
      void label
    } finally {
      await f.ctx.fiber.dispose()
    }
  })

  it('reports a service that throws as an error across the boundary', async () => {
    const module = pluginModule(`
export const name = 'caller'
export function apply(ctx) {
  return ctx.services.demo.boom().catch((e) => ctx.log.warn('调用失败: ' + e.message))
}
`)
    const f = await compose([{ id: 'caller', module, requires: ['demo'] }], sandboxOption)
    try {
      await f.ctx.plugins.load('caller')
      await settle(150)
      expect(f.serviceCalls).toEqual([{ method: 'boom', args: [] }])
      expect(f.records.some((r) => r.msg.includes('调用失败') && r.msg.includes('service exploded'))).toBe(true)
    } finally {
      await f.ctx.fiber.dispose()
    }
  })
},
)
