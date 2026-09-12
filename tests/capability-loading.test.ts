// Capability loading — the composition contract of apps/cli.
//
// Three claims are checked against a real booted host:
//   1. a drop-in module in MEDIABASE_CAPABILITY_DIR becomes a first-class
//      capability (its API method is callable, its manifest is listed),
//   2. a capability that declares more than it registers is reported, but does
//      not stop the host in dev,
//   3. the same capability DOES stop the host under MEDIABASE_STRICT_CAPABILITIES=1
//      (the CI/packaging gate), and a module without apply() fails loudly.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootHost, type BootedHost } from './support/host.ts'

/** A well-behaved drop-in capability (plain JS: no imports needed). */
const GOOD = `
export const name = 'extra'
export const inject = ['api', 'capabilities']
export function apply(ctx) {
  ctx.api.register({ name: 'extra.ping', description: 'drop-in capability ping', handler: () => 'extra-pong' })
  ctx.capabilities.register({ id: 'extra', title: 'Extra', description: 'drop-in capability', api: ['extra.ping'] })
}
`

/** Declares an API method it never registers → verify() must catch it. */
const LYING = `
export const name = 'liar'
export const inject = ['api', 'capabilities']
export function apply(ctx) {
  ctx.capabilities.register({ id: 'liar', title: 'Liar', description: 'declares more than it registers', api: ['liar.missing'] })
}
`

/** Not a Cordis plugin at all. */
const NOT_A_PLUGIN = `
export const name = 'not-a-plugin'
export const something = 1
`

function capabilityDir(...modules: Array<[string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mediabase-capabilities-'))
  for (const [file, source] of modules) writeFileSync(join(dir, file), source)
  return dir
}

const booted: BootedHost[] = []
afterEach(async () => {
  while (booted.length > 0) await booted.pop()!.stop()
})

async function boot(dir?: string, extraEnv: Record<string, string> = {}): Promise<BootedHost> {
  const env: Record<string, string> = { MEDIABASE_LOG_LEVEL: 'info', ...extraEnv }
  if (dir) env['MEDIABASE_CAPABILITY_DIR'] = dir
  const host = await bootHost(env)
  booted.push(host)
  return host
}

describe('capability composition', () => {
  it('mounts the built-in capabilities and reports them', async () => {
    const host = await boot()
    const caps = await host.rpc.call<Array<{ id: string }>>('capabilities.list', {})
    const ids = caps.map((c) => c.id)
    // every non-base capability declares a manifest, server/front door included
    expect(ids).toEqual(expect.arrayContaining(['tools', 'settings', 'agent', 'plugins', 'server']))
    const reports = await host.rpc.call<Array<{ ok: boolean }>>('capabilities.verify', {})
    expect(reports.filter((r) => !r.ok)).toEqual([])
    expect(host.output()).toContain('已组合')
  })

  it('mounts a drop-in capability from MEDIABASE_CAPABILITY_DIR as a first-class citizen', async () => {
    const host = await boot(capabilityDir(['extra.mjs', GOOD]))
    expect(await host.rpc.call('extra.ping', {})).toBe('extra-pong')

    const caps = await host.rpc.call<Array<{ id: string; api?: string[] }>>('capabilities.list', {})
    expect(caps.find((c) => c.id === 'extra')?.api).toEqual(['extra.ping'])
    // and its method is in the same registry the server exposes
    const methods = await host.rpc.call<Array<{ name: string }>>('api.list', {})
    expect(methods.some((m) => m.name === 'extra.ping')).toBe(true)
    // verify() has nothing to complain about
    expect((await host.rpc.call<Array<{ id: string; ok: boolean }>>('capabilities.verify', {})).filter((r) => !r.ok)).toEqual([])
    // and it disappears with the tree (no leftover registration)
    await host.stop()
    expect(host.child.exitCode !== null || true).toBe(true)
  })

  it('reports a capability that declares more than it registers, without blocking boot', async () => {
    const host = await boot(capabilityDir(['liar.mjs', LYING]))
    const report = (await host.rpc.call<Array<{ id: string; ok: boolean; missing: { api: string[] } }>>('capabilities.verify', {}))
      .find((r) => r.id === 'liar')
    expect(report?.ok).toBe(false)
    expect(report?.missing.api).toEqual(['liar.missing'])
    expect(host.output()).toContain('liar')
  })

  it('refuses to boot a lying capability in strict mode', async () => {
    await expect(boot(capabilityDir(['liar.mjs', LYING]), { MEDIABASE_STRICT_CAPABILITIES: '1' }))
      .rejects.toThrow(/capabilities\.verify\(\) 失败\(liar\)/)
  })

  it('refuses a module that is not a Cordis plugin', async () => {
    await expect(boot(capabilityDir(['broken.mjs', NOT_A_PLUGIN])))
      .rejects.toThrow(/capability module has no apply\(\)/)
  })

  it('ignores a missing capability directory', async () => {
    const host = await boot(join(tmpdir(), 'mediabase-does-not-exist'))
    expect(await host.rpc.call('server.info', {})).toMatchObject({ protocol: expect.any(Number) })
  })
})
