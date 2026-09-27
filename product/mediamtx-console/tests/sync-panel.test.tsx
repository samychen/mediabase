// @vitest-environment jsdom
// The wall's DOM half (M5): everything the pure suites cannot reach — the
// panel actually RENDERS, the store seam actually drives it, and the
// degradation path is the honest one. jsdom has no MediaSource, which is
// exactly the point: an occupied cell must show the CODED "MSE unsupported"
// badge instead of a black rectangle. The rAF clock's frame accuracy still
// needs real hardware (the README's LIVE checklist says so); what a headless
// DOM can prove, this proves.
//
// Harness mirrors product/openvideo/tests/shell.test.tsx: real cordis
// Context, real i18n plugin, hand-provided store (no polling — the panels
// under test read snapshots, they do not need the server loop).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as i18n from '../../../packages/client/i18n/src/index.ts'
import { messages } from '../packages/client/console/src/messages.ts'
import { createConsoleStore, type ConsoleStore } from '../packages/client/console/src/store.ts'
import { SyncPanel } from '../packages/client/console/src/panels/sync.tsx'
import { RecordingsPanel } from '../packages/client/console/src/panels/recordings.tsx'
import { encodeSyncPayload, type SyncSlot } from '../packages/client/console/src/sync.ts'
import type { PlaybackEntry } from '../packages/protocol/src/index.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

const T0 = Date.parse('2026-09-26T10:00:00Z')
const win = (offsetS: number, seconds: number): PlaybackEntry => ({
  startIso: new Date(T0 + offsetS * 1000).toISOString(),
  durationSeconds: seconds,
  url: `http://127.0.0.1:9996/get?start=${offsetS}`,
})
const CHAIN: SyncSlot = { path: 'cam1', entries: [win(0, 60), win(60, 30)] }

/** rpc stub: the wall never calls it; the recordings panel gets a canned world. */
function fakeRpc(handlers: Record<string, unknown> = {}): never {
  return {
    call: async (method: string): Promise<unknown> => {
      if (method in handlers) return JSON.parse(JSON.stringify(handlers[method])) as unknown
      throw Object.assign(new Error(`no stub for ${method}`), { code: -32601 })
    },
  } as never
}

describe('the sync wall, rendered', () => {
  let ctx: Context
  let store: ConsoleStore
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    ctx = new Context()
    ctx.plugin(i18n, { locale: 'zh-CN' })
    await settle()
    for (const [locale, table] of Object.entries(messages)) ctx.i18n.addMessages(locale, table)
    store = createConsoleStore(fakeRpc())
    ctx.reflect.provide('mtxConsole', store)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<SyncPanel ctx={ctx} />)
      await settle()
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
    await ctx.fiber.dispose()
  })

  const cells = (): NodeListOf<Element> => container.querySelectorAll('.mx-sync__cell')
  const playBtn = (): HTMLButtonElement => container.querySelector('.mx-sync__bar .mx-btn') as HTMLButtonElement
  const scrubber = (): HTMLInputElement => container.querySelector('.mx-sync__scrub') as HTMLInputElement

  it('renders the empty quad wall: four drop targets, the hint, a dead transport', () => {
    expect(cells()).toHaveLength(4)
    expect(container.textContent).toContain('拖入录像窗口')
    expect(container.textContent).toContain('还没有画面')
    expect(playBtn().disabled).toBe(true) // no timeline, nothing to play
    expect(scrubber().disabled).toBe(true)
  })

  it('a parked chain lights the cell up — label, live transport, and the CODED mse-unsupported badge (jsdom has no MediaSource, and the panel says so instead of showing a black rectangle)', async () => {
    await act(async () => {
      store.syncAssign(0, CHAIN)
      await settle()
    })
    expect(playBtn().disabled).toBe(false)
    expect(scrubber().disabled).toBe(false)
    const label = cells()[0]!.querySelector('.mx-sync__label')
    expect(label?.textContent).toContain('cam1')
    expect(label?.textContent).toContain('1:30') // 60s + 30s chain
    const badge = cells()[0]!.querySelector('.mx-sync__badge')
    expect(badge?.textContent).toContain('MediaSource')
    expect(badge?.getAttribute('data-state')).toBe('err')
  })

  it('accepts a v2 drop payload on a cell', async () => {
    const target = cells()[1]!
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', {
      value: { getData: (): string => encodeSyncPayload(CHAIN) },
    })
    await act(async () => {
      target.dispatchEvent(ev)
      await settle()
    })
    expect(store.get().syncSlots[1]).toEqual(CHAIN)
  })

  it('refuses an off-contract drop without touching the store', async () => {
    const target = cells()[1]!
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', {
      value: { getData: (): string => JSON.stringify({ v: 1, path: 'cam1', entry: win(0, 5) }) }, // M3-era payload
    })
    await act(async () => {
      target.dispatchEvent(ev)
      await settle()
    })
    expect(store.get().syncSlots[1]).toBeNull()
  })

  it('the ✕ empties one cell; 清空 empties the wall and kills the transport', async () => {
    await act(async () => {
      store.syncAssign(0, CHAIN)
      store.syncAssign(1, { path: 'cam2', entries: [win(0, 10)] })
      await settle()
    })
    await act(async () => {
      (cells()[0]!.querySelector('.mx-sync__remove') as HTMLButtonElement).click()
      await settle()
    })
    expect(store.get().syncSlots[0]).toBeNull()
    expect(store.get().syncSlots[1]).not.toBeNull()

    const clearBtn = [...container.querySelectorAll<HTMLButtonElement>('.mx-sync__bar .mx-btn')]
      .find((b) => b.textContent?.includes('清空'))
    expect(clearBtn).toBeDefined()
    await act(async () => {
      clearBtn!.click()
      await settle()
    })
    expect(store.get().syncSlots.every((s) => s === null)).toBe(true)
    expect(playBtn().disabled).toBe(true)
  })

  it('the layout select re-renders the grid size', async () => {
    const select = container.querySelector('.mx-sync__layout select') as HTMLSelectElement
    await act(async () => {
      select.value = '9'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
    })
    expect(store.get().syncLayout).toBe(9)
    expect(cells()).toHaveLength(9)
  })
})

describe('the recordings panel → wall seam, rendered', () => {
  let ctx: Context
  let store: ConsoleStore
  let container: HTMLDivElement
  let root: Root

  const W = [win(0, 60), win(60, 30), win(90, 30)]

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    ctx = new Context()
    ctx.plugin(i18n, { locale: 'zh-CN' })
    await settle()
    for (const [locale, table] of Object.entries(messages)) ctx.i18n.addMessages(locale, table)
    store = createConsoleStore(fakeRpc({
      'mediamtx.recordings.list': { recordings: [{ name: 'cam1' }] },
      'mediamtx.playback.list': { entries: W },
    }))
    ctx.reflect.provide('mtxConsole', store)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<RecordingsPanel ctx={ctx} />)
      await settle()
      await settle()
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
    await ctx.fiber.dispose()
  })

  it('lists the windows and the ⊞ parks the CHAIN from the clicked window (first free cell, then the next)', async () => {
    const rows = container.querySelectorAll('.mx-row')
    expect(rows).toHaveLength(3)

    // ⊞ on row 2 → chain = windows 2..3 into cell 0
    await act(async () => {
      (rows[1]!.querySelectorAll('button')[0] as HTMLButtonElement).click()
      await settle()
    })
    expect(store.get().syncSlots[0]).toEqual({ path: 'cam1', entries: [W[1], W[2]] })

    // ⊞ on row 1 → the full chain lands in the next free cell
    await act(async () => {
      (rows[0]!.querySelectorAll('button')[0] as HTMLButtonElement).click()
      await settle()
    })
    expect(store.get().syncSlots[1]).toEqual({ path: 'cam1', entries: W })
  })

  it('a row carries the same chain as a draggable v2 payload', async () => {
    const row = container.querySelectorAll('.mx-row')[0] as HTMLElement
    expect(row.getAttribute('draggable')).toBe('true')
    let carried: string | null = null
    const ev = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', {
      value: {
        setData: (_type: string, data: string): void => { carried = data },
        effectAllowed: '',
      },
    })
    await act(async () => {
      row.dispatchEvent(ev)
      await settle()
    })
    expect(carried).not.toBeNull()
    expect(JSON.parse(carried!)).toEqual({ v: 2, path: 'cam1', entries: W })
  })
})
