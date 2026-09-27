// The pure half of synchronized playback (sync.ts) plus the store actions
// behind it. No browser needed: since M4 a cell holds a CHAIN of windows, so
// the timeline math grew the locator (which window owns an instant, and the
// gap-hold rule) — exactly the piece a silent off-by-one would hide in. The
// store half proves the grid stays immutable (React reads snapshots by
// reference — a mutated array would leave the wall frozen).

import { describe, expect, it } from 'vitest'
import type { PlaybackEntry } from '../packages/protocol/src/index.ts'
import {
  chainSeconds,
  encodeSyncPayload,
  firstFreeSlot,
  locateInSlot,
  parseSyncPayload,
  slotWindow,
  syncRange,
  SYNC_MAX_SLOTS,
  SYNC_PAYLOAD_VERSION,
  type SyncSlot,
} from '../packages/client/console/src/sync.ts'
import { createConsoleStore, EMPTY_FALLBACK } from '../packages/client/console/src/store.ts'

const T0 = Date.parse('2026-09-26T10:00:00Z')

const win = (offsetS: number, seconds: number): PlaybackEntry => ({
  startIso: new Date(T0 + offsetS * 1000).toISOString(),
  durationSeconds: seconds,
  url: `http://127.0.0.1:9996/get?start=${offsetS}`,
})

/** A single-window cell. */
function slot(path: string, ...entries: PlaybackEntry[]): SyncSlot {
  return { path, entries }
}

const A = slot('cam1', win(0, 60)) // 10:00:00 → 10:01:00
const B = slot('cam2', win(30, 90)) // 10:00:30 → 10:02:00
/** cam1 again, as a three-window chain with a 10s recording GAP inside. */
const CHAIN = slot('cam1', win(0, 60), win(70, 30), win(100, 20))
// chain windows: [0,60] [70,100] [100,120] seconds after T0

/** A 9-cell grid with the given cells occupied. */
function grid(...occupied: Array<[number, SyncSlot]>): Array<SyncSlot | null> {
  const cells: Array<SyncSlot | null> = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
  for (const [i, s] of occupied) cells[i] = s
  return cells
}

describe('chain windows and spans', () => {
  it('derives a single-window span from timestamp + float seconds', () => {
    expect(slotWindow(A)).toEqual({ startMs: T0, endMs: T0 + 60_000 })
  })

  it('spans a CHAIN from its first window’s start to its last window’s end', () => {
    expect(slotWindow(CHAIN)).toEqual({ startMs: T0, endMs: T0 + 120_000 })
  })

  it('skips junk entries and refuses a chain with none parseable', () => {
    const partial = slot('cam1', win(0, 60), { startIso: 'not-a-time', durationSeconds: 5, url: 'u' })
    expect(slotWindow(partial)).toEqual({ startMs: T0, endMs: T0 + 60_000 })
    expect(slotWindow(slot('cam1', { startIso: 'nope', durationSeconds: 5, url: 'u' }))).toBeNull()
    expect(slotWindow(slot('cam1'))).toBeNull()
  })

  it('clamps a negative or non-finite duration to zero', () => {
    expect(slotWindow(slot('cam1', { startIso: new Date(T0).toISOString(), durationSeconds: -5, url: 'u' })))
      .toEqual({ startMs: T0, endMs: T0 })
    expect(slotWindow(slot('cam1', { startIso: new Date(T0).toISOString(), durationSeconds: Number.NaN, url: 'u' })))
      .toEqual({ startMs: T0, endMs: T0 })
  })

  it('sums the playable seconds of a chain (gaps excluded)', () => {
    expect(chainSeconds(A)).toBe(60)
    expect(chainSeconds(CHAIN)).toBe(110) // 60 + 30 + 20, the 10s gap plays nothing
    expect(chainSeconds(slot('cam1'))).toBe(0)
  })
})

describe('the shared timeline (syncRange)', () => {
  it('spans earliest start to latest end across the visible cells', () => {
    expect(syncRange(grid([0, A], [1, B]), 4)).toEqual({ startMs: T0, endMs: T0 + 120_000 })
    expect(syncRange(grid([0, CHAIN], [1, B]), 4)).toEqual({ startMs: T0, endMs: T0 + 120_000 })
  })

  it('is null for an empty wall and for one full of junk timestamps', () => {
    expect(syncRange(grid(), 4)).toBeNull()
    expect(syncRange(grid([0, slot('cam1', { startIso: 'nope', durationSeconds: 5, url: 'u' })]), 4)).toBeNull()
  })

  it('ignores cells beyond the layout — a hidden chain is not on the timeline', () => {
    const one = syncRange(grid([0, A], [3, CHAIN]), 1)
    expect(one?.endMs).toBe(T0 + 60_000)
    expect(syncRange(grid([0, A], [3, CHAIN]), 4)?.endMs).toBe(T0 + 120_000)
  })
})

describe('locating the clock inside a chain', () => {
  it('maps into the owning window with local media seconds', () => {
    expect(locateInSlot(T0, A)).toEqual({ entryIndex: 0, rel: 0 })
    expect(locateInSlot(T0 + 12_500, A)).toEqual({ entryIndex: 0, rel: 12.5 })
    expect(locateInSlot(T0 + 60_000, A)).toEqual({ entryIndex: 0, rel: 60 })
  })

  it('crosses window boundaries inside a chain', () => {
    expect(locateInSlot(T0 + 59_000, CHAIN)).toEqual({ entryIndex: 0, rel: 59 })
    expect(locateInSlot(T0 + 70_000, CHAIN)).toEqual({ entryIndex: 1, rel: 0 })
    expect(locateInSlot(T0 + 85_000, CHAIN)).toEqual({ entryIndex: 1, rel: 15 })
    expect(locateInSlot(T0 + 105_000, CHAIN)).toEqual({ entryIndex: 2, rel: 5 })
    expect(locateInSlot(T0 + 120_000, CHAIN)).toEqual({ entryIndex: 2, rel: 20 })
  })

  it('holds in a recording GAP: named window, rel null (the cell parks)', () => {
    expect(locateInSlot(T0 + 65_000, CHAIN)).toEqual({ entryIndex: 0, rel: null })
  })

  it('is null outside the chain — the panel stands the cell down', () => {
    expect(locateInSlot(T0 - 1, A)).toBeNull()
    expect(locateInSlot(T0 + 60_001, A)).toBeNull()
    expect(locateInSlot(T0 - 1, CHAIN)).toBeNull()
    expect(locateInSlot(T0 + 120_001, CHAIN)).toBeNull()
    expect(locateInSlot(T0, slot('cam1', { startIso: 'junk', durationSeconds: 5, url: 'u' }))).toBeNull()
  })
})

describe('the drag payload contract (v2 — chains)', () => {
  it('round-trips a chain', () => {
    expect(parseSyncPayload(encodeSyncPayload(CHAIN))).toEqual(CHAIN)
    expect(parseSyncPayload(encodeSyncPayload(A))).toEqual(A)
  })

  it('rejects the M3 single-window payload — a stale tab cannot inject junk', () => {
    const v1 = JSON.stringify({ v: 1, path: 'cam1', entry: win(0, 60) })
    expect(parseSyncPayload(v1)).toBeNull()
  })

  it('rejects anything else off-contract instead of throwing into the panel', () => {
    expect(parseSyncPayload('')).toBeNull()
    expect(parseSyncPayload('not json')).toBeNull()
    expect(parseSyncPayload('null')).toBeNull()
    expect(parseSyncPayload('42')).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ path: 'cam1', entries: [win(0, 1)] }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: SYNC_PAYLOAD_VERSION + 1, path: 'cam1', entries: [win(0, 1)] }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: SYNC_PAYLOAD_VERSION, path: '', entries: [win(0, 1)] }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: SYNC_PAYLOAD_VERSION, path: 7, entries: [win(0, 1)] }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: SYNC_PAYLOAD_VERSION, path: 'cam1' }))).toBeNull()
    expect(parseSyncPayload(JSON.stringify({ v: SYNC_PAYLOAD_VERSION, path: 'cam1', entries: [{ startIso: 'x' }] }))).toBeNull()
  })

  it('refuses an empty chain — nothing to play', () => {
    expect(parseSyncPayload(JSON.stringify({ v: SYNC_PAYLOAD_VERSION, path: 'cam1', entries: [] }))).toBeNull()
  })
})

describe('free-cell choice', () => {
  it('picks the first empty visible cell, and reports a full wall as -1', () => {
    expect(firstFreeSlot(grid(), 4)).toBe(0)
    expect(firstFreeSlot(grid([0, A]), 4)).toBe(1)
    expect(firstFreeSlot(grid([0, A], [1, B]), 4)).toBe(2)
    expect(firstFreeSlot(grid([0, A], [1, B], [2, A], [3, B]), 4)).toBe(-1)
    // Cell 1 is free but hidden behind a single-cell layout.
    expect(firstFreeSlot(grid([0, A], [2, B]), 1)).toBe(-1)
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
    store.syncAssign(3, CHAIN)
    store.syncSetLayout(1)
    expect(store.get().syncSlots[3]).toEqual(CHAIN)
    expect(syncRange(store.get().syncSlots, store.get().syncLayout)?.endMs).toBe(T0 + 60_000)

    store.syncClear()
    expect(store.get().syncSlots.every((s) => s === null)).toBe(true)
    expect(store.get().syncSlots).toHaveLength(SYNC_MAX_SLOTS)
  })
})
