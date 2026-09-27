// The pure half of synchronized playback (sync.ts) plus the store actions
// behind it. No browser needed: the timeline math and the drag payload
// contract are exactly the pieces a silent off-by-one would hide in, and
// the store half proves the grid stays immutable (React reads snapshots by
// reference — a mutated array would leave the wall frozen).

import { describe, expect, it } from 'vitest'
import type { PlaybackEntry } from '../packages/protocol/src/index.ts'
import {
  encodeSyncPayload,
  firstFreeSlot,
  parseSyncPayload,
  slotRelSeconds,
  slotWindow,
  syncRange,
  SYNC_MAX_SLOTS,
  type SyncSlot,
} from '../packages/client/console/src/sync.ts'
import { createConsoleStore, EMPTY_FALLBACK } from '../packages/client/console/src/store.ts'

/** A window starting at a fixed wall-clock instant, `seconds` long. */
function slot(path: string, startIso: string, seconds: number): SyncSlot {
  const entry: PlaybackEntry = { startIso, durationSeconds: seconds, url: `http://127.0.0.1:9996/get?path=${path}` }
  return { path, entry }
}

const A = slot('cam1', '2026-09-26T10:00:00Z', 60)
const B = slot('cam2', '2026-09-26T10:00:30Z', 90)

/** A 9-cell grid with the given cells occupied. */
function grid(...occupied: Array<[number, SyncSlot]>): Array<SyncSlot | null> {
  const cells: Array<SyncSlot | null> = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
  for (const [i, s] of occupied) cells[i] = s
  return cells
}

describe('the sync timeline (sync.ts)', () => {
  it('derives a slot window from the upstream timestamp + float seconds', () => {
    const start = Date.parse('2026-09-26T10:00:00Z')
    expect(slotWindow(A)).toEqual({ startMs: start, endMs: start + 60_000 })
  })

  it('refuses a window whose timestamp is junk instead of inventing one', () => {
    expect(slotWindow(slot('cam1', 'not-a-time', 10))).toBeNull()
    expect(slotWindow(slot('cam1', '', 10))).toBeNull()
  })

  it('clamps a negative or non-finite duration to zero', () => {
    const start = Date.parse('2026-09-26T10:00:00Z')
    expect(slotWindow(slot('cam1', '2026-09-26T10:00:00Z', -5))).toEqual({ startMs: start, endMs: start })
    expect(slotWindow(slot('cam1', '2026-09-26T10:00:00Z', Number.NaN))).toEqual({ startMs: start, endMs: start })
  })

  it('spans earliest start to latest end across the visible cells', () => {
    const range = syncRange(grid([0, A], [1, B]), 4)
    expect(range).toEqual({
      startMs: Date.parse('2026-09-26T10:00:00Z'),
      endMs: Date.parse('2026-09-26T10:02:00Z'),
    })
  })

  it('is null for an empty wall and for one full of junk timestamps', () => {
    expect(syncRange(grid(), 4)).toBeNull()
    expect(syncRange(grid([0, slot('cam1', 'nope', 5)]), 4)).toBeNull()
  })

  it('ignores cells beyond the layout — a hidden window is not on the timeline', () => {
    // B ends 30s after A; park it in cell 3 and show a single cell only.
    const one = syncRange(grid([0, A], [3, B]), 1)
    expect(one?.endMs).toBe(Date.parse('2026-09-26T10:01:00Z'))
    expect(syncRange(grid([0, A], [3, B]), 4)?.endMs).toBe(Date.parse('2026-09-26T10:02:00Z'))
  })

  it('maps the global clock into a slot’s own media seconds', () => {
    const start = Date.parse('2026-09-26T10:00:30Z')
    expect(slotRelSeconds(start, B)).toBe(0)
    expect(slotRelSeconds(start + 12_500, B)).toBe(12.5)
    expect(slotRelSeconds(start + 90_000, B)).toBe(90)
  })

  it('is null outside the window — the panel parks that cell instead of seeking', () => {
    const start = Date.parse('2026-09-26T10:00:30Z')
    expect(slotRelSeconds(start - 1, B)).toBeNull()
    expect(slotRelSeconds(start + 90_001, B)).toBeNull()
    expect(slotRelSeconds(start, slot('cam1', 'junk', 10))).toBeNull()
  })

  it('picks the first empty visible cell, and reports a full wall as -1', () => {
    expect(firstFreeSlot(grid(), 4)).toBe(0)
    expect(firstFreeSlot(grid([0, A]), 4)).toBe(1)
    expect(firstFreeSlot(grid([0, A], [1, B]), 4)).toBe(2)
    expect(firstFreeSlot(grid([0, A], [1, B], [2, A], [3, B]), 4)).toBe(-1)
    // Cell 1 is free but hidden behind a single-cell layout.
    expect(firstFreeSlot(grid([0, A], [2, B]), 1)).toBe(-1)
  })
})

describe('the drag payload contract', () => {
  it('round-trips a slot', () => {
    expect(parseSyncPayload(encodeSyncPayload(A))).toEqual(A)
  })

  it('rejects anything off-contract instead of throwing into the panel', () => {
    expect(parseSyncPayload('')).toBeNull()
    expect(parseSyncPayload('not json')).toBeNull()
    expect(parseSyncPayload('null')).toBeNull()
    expect(parseSyncPayload('42')).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ path: 'cam1', entry: A.entry }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: 999, path: 'cam1', entry: A.entry }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: 1, path: '', entry: A.entry }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: 1, path: 7, entry: A.entry }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: 1, path: 'cam1' }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: 1, path: 'cam1', entry: { startIso: 'x' } }))).toBeNull()
  })

  it('drops an entry field the upstream schema requires', () => {
    const partial = { v: 1, path: 'cam1', entry: { startIso: A.entry.startIso, durationSeconds: 60 } }
    expect(parseSyncPayload(JSON.stringify(partial))).toBeNull()
  })
})

/** The store needs an rpc object; the sync half never calls it. */
function offlineStore() {
  return createConsoleStore({
    call: async (): Promise<never> => { throw new Error('offline') },
  } as never)
}

describe('the store’s sync grid', () => {
  it('starts as an empty 9-cell wall at the quad layout', () => {
    const snap = offlineStore().get()
    expect(snap.syncSlots).toHaveLength(SYNC_MAX_SLOTS)
    expect(snap.syncSlots.every((s) => s === null)).toBe(true)
    expect(snap.syncLayout).toBe(4)
    expect(EMPTY_FALLBACK.syncSlots).toHaveLength(SYNC_MAX_SLOTS)
  })

  it('assigns and clears a cell with a NEW array (snapshots are immutable)', () => {
    const store = offlineStore()
    const before = store.get().syncSlots
    store.syncAssign(1, A)
    const after = store.get().syncSlots
    expect(after).not.toBe(before)
    expect(after[1]).toEqual(A)
    expect(before[1]).toBeNull()

    store.syncAssign(1, null)
    expect(store.get().syncSlots[1]).toBeNull()
  })

  it('notifies subscribers so the wall re-renders', () => {
    const store = offlineStore()
    let hits = 0
    const off = store.subscribe(() => { hits += 1 })
    store.syncAssign(0, A)
    store.syncSetLayout(9)
    expect(hits).toBe(2)
    off()
    store.syncAssign(0, null)
    expect(hits).toBe(2)
  })

  it('drops an out-of-range or fractional cell index', () => {
    const store = offlineStore()
    const before = store.get().syncSlots
    store.syncAssign(-1, A)
    store.syncAssign(SYNC_MAX_SLOTS, A)
    store.syncAssign(1.5, A)
    expect(store.get().syncSlots).toBe(before)
  })

  it('keeps cells when the layout shrinks and clears them all on syncClear', () => {
    const store = offlineStore()
    store.syncAssign(0, A)
    store.syncAssign(3, B)
    store.syncSetLayout(1)
    expect(store.get().syncSlots[3]).toEqual(B)
    expect(syncRange(store.get().syncSlots, store.get().syncLayout)?.endMs)
      .toBe(Date.parse('2026-09-26T10:01:00Z'))

    store.syncClear()
    expect(store.get().syncSlots.every((s) => s === null)).toBe(true)
    expect(store.get().syncSlots).toHaveLength(SYNC_MAX_SLOTS)
  })
})
