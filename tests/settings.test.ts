// @mediabase/settings — direct unit tests.
//
// The settings capability was only covered through the host integration suite, which
// proves "a value survives a round trip through the control plane" and nothing about
// the store itself: the file format, delete semantics, what happens to a malformed
// file, whether a FAILED write lies to the next reader, or what the API layer refuses.
// Those are exactly the properties a consumer (the agent) depends on.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as log from '../packages/base/log/src/index.ts'
import * as api from '../packages/host/api/src/index.ts'
import * as settings from '../packages/host/settings/src/index.ts'
import { RpcCode } from '../packages/base/rpc/src/index.ts'
import type { SettingsService } from '../packages/base/protocol/src/index.ts'
import type { ApiService } from '../packages/host/api/src/index.ts'

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

const made: string[] = []
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

function tempDir(prefix = 'avstudio-settings-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

interface Fixture {
  ctx: Context
  settings: SettingsService
  api: ApiService
  file: string
}

async function compose(file: string): Promise<Fixture> {
  const ctx = new Context()
  ctx.plugin(log, { level: 'error', sink: () => {} })
  await settle()
  ctx.plugin(api)
  await settle()
  ctx.plugin(settings, { file })
  await settle()
  const service = ctx.get('settings')
  const apiService = ctx.get('api')
  if (!service || !apiService) throw new Error('settings/api service missing')
  return { ctx, settings: service, api: apiService, file }
}

interface Rejection {
  code?: number
  message: string
  messageKey?: string
  messageParams?: Record<string, string | number>
}

async function rejection(fn: () => Promise<unknown>): Promise<Rejection> {
  try {
    await fn()
  } catch (e) {
    const err = e as Rejection
    return {
      message: err.message,
      ...(typeof err.code === 'number' ? { code: err.code } : {}),
      ...(err.messageKey !== undefined ? { messageKey: err.messageKey } : {}),
      ...(err.messageParams !== undefined ? { messageParams: err.messageParams } : {}),
    }
  }
  throw new Error('expected the call to reject')
}

describe('@mediabase/settings: the store', () => {
  it('reads an absent file as empty and does not create it by reading', async () => {
    const file = join(tempDir(), 'settings.json')
    const { settings: store } = await compose(file)

    expect(await store.list()).toEqual({})
    expect(await store.get('llm.key')).toBeUndefined()
    // Reading is not writing: a host that only reads settings must leave no file behind.
    expect(existsSync(file)).toBe(false)
  })

  it('persists to disk, and a NEW host instance reads the same value back', async () => {
    const file = join(tempDir(), 'settings.json')
    const first = await compose(file)
    await first.settings.set('llm.key', 'sk-persisted')
    await first.ctx.fiber.dispose()

    // The file is the contract (a restart must see it), so assert its bytes and then
    // read it through a second, independent composition.
    const raw = readFileSync(file, 'utf8')
    expect(JSON.parse(raw)).toEqual({ 'llm.key': 'sk-persisted' })
    expect(raw).toContain('\n  ') // pretty-printed: a human edits this file by hand

    const second = await compose(file)
    expect(await second.settings.get('llm.key')).toBe('sk-persisted')
    await second.ctx.fiber.dispose()
  })

  it('deletes on an empty string and on undefined, in memory AND on disk', async () => {
    const file = join(tempDir(), 'settings.json')
    const { settings: store } = await compose(file)
    await store.set('llm.key', 'sk-1')
    await store.set('llm.model', 'm-1')

    await store.set('llm.key', '') // the UI's "clear this field" path
    expect(await store.list()).toEqual({ 'llm.model': 'm-1' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'llm.model': 'm-1' })

    await store.set('llm.model', undefined)
    expect(await store.list()).toEqual({})
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('creates missing parent directories', async () => {
    const file = join(tempDir(), 'deep', 'nested', 'settings.json')
    const { settings: store } = await compose(file)
    await store.set('llm.key', 'sk-nested')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'llm.key': 'sk-nested' })
  })

  it('treats a malformed file as empty and repairs it on the next write', async () => {
    const file = join(tempDir(), 'settings.json')
    writeFileSync(file, '{ this is not json')
    const { settings: store } = await compose(file)

    expect(await store.list()).toEqual({})
    await store.set('llm.key', 'sk-repaired')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'llm.key': 'sk-repaired' })
  })

  it('does NOT report a value whose write failed (memory and disk stay in agreement)', async () => {
    // The parent path is a regular FILE, so mkdir/write must fail.
    const dir = tempDir()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const file = join(blocker, 'settings.json')
    const { settings: store } = await compose(file)

    const failure = await rejection(() => store.set('llm.key', 'sk-doomed'))
    expect(failure.message).toContain('无法写入')
    // The heart of it: the store must not now answer with a value that is not on disk.
    expect(await store.list()).toEqual({})
    expect(await store.get('llm.key')).toBeUndefined()
  })
})

describe('@mediabase/settings: the control-plane surface', () => {
  it('refuses an unknown key with a key+params a client can localize', async () => {
    const { api: registry } = await compose(join(tempDir(), 'settings.json'))
    const failure = await rejection(() => registry.call('settings.set', { key: 'nope.key', value: 'x' }))
    expect(failure.code).toBe(RpcCode.INVALID_PARAMS)
    expect(failure.messageKey).toBe('settings.unknownKey')
    expect(failure.messageParams).toEqual({ key: 'nope.key' })
  })

  it('validates a known key against its schema instead of storing a wrong type', async () => {
    const { api: registry, settings: store } = await compose(join(tempDir(), 'settings.json'))
    const failure = await rejection(() => registry.call('settings.set', { key: 'llm.key', value: 123 }))
    expect(failure.code).toBe(RpcCode.INVALID_PARAMS)
    expect(failure.message).toContain('llm.key')
    expect(await store.list()).toEqual({}) // nothing was stored

    await registry.call('settings.set', { key: 'llm.key', value: 'sk-ok' })
    expect(await store.get('llm.key')).toBe('sk-ok')
    // `null` from the panel means "unset", not "store null".
    await registry.call('settings.set', { key: 'llm.key', value: null })
    expect(await store.get('llm.key')).toBeUndefined()
  })

  it('lists the known keys with their signatures (what the settings panel renders)', async () => {
    const { api: registry } = await compose(join(tempDir(), 'settings.json'))
    const keys = await registry.call('settings.keys', {}) as Array<{ key: string; signature: string }>
    expect(keys.map((k) => k.key).sort()).toEqual(['llm.base', 'llm.key', 'llm.model'])
    for (const entry of keys) expect(entry.signature.length).toBeGreaterThan(0)

    // The mutating declaration is what makes read-only mode able to refuse a write.
    const methods = registry.list()
    expect(methods.find((m) => m.name === 'settings.set')?.mutates).toBe(true)
    expect(methods.find((m) => m.name === 'settings.list')?.mutates).not.toBe(true)
  })

  it('declares exactly what it registers (the manifest is not a wish list)', async () => {
    const { ctx } = await compose(join(tempDir(), 'settings.json'))
    const capabilities = ctx.get('capabilities')
    if (!capabilities) throw new Error('capabilities service missing')
    const report = capabilities.verify()
    const own = report.find((r) => r.id === 'settings')
    expect(own, 'settings must declare a manifest').toBeDefined()
    expect(own?.ok).toBe(true)
    expect(own?.missing).toEqual({ services: [], api: [], tools: [] })
  })

  it('unregisters its API with the fiber (no method outlives the plugin)', async () => {
    const { ctx, api: registry } = await compose(join(tempDir(), 'settings.json'))
    expect(registry.list().some((m) => m.name === 'settings.set')).toBe(true)
    await ctx.fiber.dispose()
    expect(registry.list().some((m) => m.name === 'settings.set')).toBe(false)
  })
})

describe('@mediabase/settings: the file it writes', () => {
  it('writes where it was told to, not where it usually does', async () => {
    const dir = tempDir()
    const file = join(dir, 'explicit', 'settings.json')
    mkdirSync(dirname(file), { recursive: true })
    const { settings: store } = await compose(file)
    await store.set('llm.model', 'from-env-config')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'llm.model': 'from-env-config' })
  })
})
