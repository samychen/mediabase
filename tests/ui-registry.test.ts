// UI panel registry unit test (client-side package, no DOM needed).
//
// Covers the two contracts the shell relies on: ordered per-area listing with
// unique ids, and the revision/subscribe pair that makes late (post-mount)
// registrations re-render.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as ui from '../packages/client/ui/src/index.ts'
import type { UiPanel, UiService } from '../packages/client/ui/src/index.ts'

/** Minimal element stand-in: the registry never inspects the component. */
const component = (() => null) as unknown as UiPanel['component']

/** cordis activates a plugin's service on a microtask, so wait one macrotask. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

async function compose(): Promise<{ ctx: Context; ui: UiService }> {
  const ctx = new Context()
  ctx.plugin(ui)
  await settle()
  const service = ctx.get('ui')
  if (!service) throw new Error('ctx.ui missing')
  return { ctx, ui: service }
}

describe('ctx.ui panel registry', () => {
  it('lists per area, ordered by order then registration sequence', async () => {
    const { ui: registry } = await compose()
    registry.register({ id: 'b', title: 'B', area: 'sidebar', order: 20, component })
    registry.register({ id: 'a', title: 'A', area: 'sidebar', order: 10, component })
    registry.register({ id: 'c', title: 'C', area: 'sidebar', order: 10, component })
    registry.register({ id: 'mon', title: '', area: 'monitor', order: 0, component })
    registry.register({ id: 'hdr', title: '', area: 'header', order: 0, component })

    expect(registry.list('sidebar').map((p) => p.id)).toEqual(['a', 'c', 'b'])
    expect(registry.list('monitor').map((p) => p.id)).toEqual(['mon'])
    expect(registry.list('header').map((p) => p.id)).toEqual(['hdr'])
    // internal bookkeeping must not leak into the public panel shape
    expect(Object.keys(registry.list('sidebar')[0] ?? {})).not.toContain('seq')
  })

  it('rejects duplicate ids and unregisters through the returned disposer', async () => {
    const { ui: registry } = await compose()
    const off = registry.register({ id: 'dup', title: 'D', area: 'sidebar', component })
    expect(() => registry.register({ id: 'dup', title: 'D', area: 'sidebar', component })).toThrow(/重复/)
    off()
    off() // idempotent
    expect(registry.list('sidebar')).toHaveLength(0)
    registry.register({ id: 'dup', title: 'D', area: 'sidebar', component })
    expect(registry.list('sidebar')).toHaveLength(1)
  })

  it('bumps revision and notifies subscribers on register and unregister', async () => {
    const { ui: registry } = await compose()
    let changes = 0
    const seen: number[] = []
    const off = registry.subscribe(() => { changes++; seen.push(registry.revision()) })
    const before = registry.revision()

    const unregister = registry.register({ id: 'p', title: 'P', area: 'sidebar', component })
    expect(changes).toBe(1)
    expect(registry.revision()).toBe(before + 1)

    unregister()
    expect(changes).toBe(2)
    expect(seen[1]).toBeGreaterThan(seen[0] ?? 0)

    // disposing twice must not emit a phantom change (React would re-render)
    unregister()
    expect(changes).toBe(2)

    off()
    registry.register({ id: 'q', title: 'Q', area: 'sidebar', component })
    expect(changes).toBe(2)
  })

  it('drops panels, announces the teardown and forgets subscribers on fiber dispose', async () => {
    const { ctx, ui: registry } = await compose()
    let changes = 0
    registry.subscribe(() => { changes++ })
    registry.register({ id: 'p', title: 'P', area: 'sidebar', component })
    const revisionAfterRegister = registry.revision()

    await ctx.fiber.dispose()
    expect(registry.list('sidebar')).toHaveLength(0)
    // teardown is a change: a mounted consumer must re-render to the empty state
    expect(registry.revision()).toBe(revisionAfterRegister + 1)
    expect(changes).toBe(2)

    registry.register({ id: 'late', title: 'L', area: 'sidebar', component })
    expect(changes).toBe(2) // listeners were dropped with the fiber
  })

  it('hides panels and overrides order via setLayout', async () => {
    const { ui: registry } = await compose()
    registry.register({ id: 'a', title: 'A', area: 'sidebar', order: 10, component })
    registry.register({ id: 'b', title: 'B', area: 'sidebar', order: 20, component })
    registry.register({ id: 'c', title: 'C', area: 'sidebar', order: 30, component })

    let changes = 0
    registry.subscribe(() => { changes++ })
    registry.setLayout({ hiddenIds: ['b'], orderById: { c: 1, a: 2, b: 3 } })
    expect(changes).toBe(1)
    expect(registry.list('sidebar').map((p) => p.id)).toEqual(['c', 'a'])
    expect(registry.listAll('sidebar').map((p) => p.id)).toEqual(['c', 'a', 'b'])
    expect(registry.getLayout()).toEqual({ hiddenIds: ['b'], orderById: { c: 1, a: 2, b: 3 } })
  })
})
