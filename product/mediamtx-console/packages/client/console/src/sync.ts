// sync.ts — the pure half of synchronized playback (M3).
//
// Several recording windows on ONE shared timeline: the global clock is
// wall-clock milliseconds (windows carry real timestamps), and every slot
// maps that to its own local seconds. Everything here is pure so vitest can
// pin it without a browser; the panel (panels/sync.tsx) owns the rAF clock,
// the <video> elements and one MsePlayer per slot.
//
// Upstream fact kept honest: the playback server's `/get` answers
// `Accept-Ranges: none` — a window can only be streamed from its first byte.
// Seeking inside the buffered range is instant; seeking forward stalls until
// the sequential fetch catches up; content evicted behind the playhead
// (mse.ts keeps ~30s) is gone for good. No cross-window CHAINING of one
// path's consecutive windows yet — this aligns windows in PARALLEL.

import { parse } from '@mediabase/schema'
import { PlaybackEntryS, type PlaybackEntry } from '@mtxconsole/protocol'

/** Grid layouts the panel offers (cells rendered = layout). */
export type SyncLayout = 1 | 4 | 9

/** The widest layout — also the fixed length of the slot array in the store. */
export const SYNC_MAX_SLOTS = 9

/** One recording window parked in a grid cell, with the path it came from. */
export interface SyncSlot {
  path: string
  entry: PlaybackEntry
}

/** The shared timeline's span, in wall-clock milliseconds. */
export interface SyncRange {
  startMs: number
  endMs: number
}

/** A slot's own span on the wall clock, or null when its timestamp is junk. */
export function slotWindow(slot: SyncSlot): SyncRange | null {
  const startMs = Date.parse(slot.entry.startIso)
  if (Number.isNaN(startMs)) return null
  const durationMs = Number.isFinite(slot.entry.durationSeconds)
    ? Math.max(0, slot.entry.durationSeconds * 1000)
    : 0
  return { startMs, endMs: startMs + durationMs }
}

/**
 * The timeline spanned by the VISIBLE slots (index < layout): earliest start
 * to latest end. null when nothing visible has a parseable window.
 */
export function syncRange(
  slots: ReadonlyArray<SyncSlot | null>,
  layout: SyncLayout,
): SyncRange | null {
  let range: SyncRange | null = null
  for (let i = 0; i < layout && i < slots.length; i++) {
    const slot = slots[i]
    if (slot === null || slot === undefined) continue
    const w = slotWindow(slot)
    if (w === null) continue
    range = range === null
      ? { startMs: w.startMs, endMs: w.endMs }
      : { startMs: Math.min(range.startMs, w.startMs), endMs: Math.max(range.endMs, w.endMs) }
  }
  return range
}

/**
 * Where the global clock (wall-clock ms) sits inside one slot, in the slot's
 * own media seconds — or null when outside its window / unparseable. This is
 * the mapping the master clock applies to every <video> each tick.
 */
export function slotRelSeconds(globalMs: number, slot: SyncSlot): number | null {
  const w = slotWindow(slot)
  if (w === null) return null
  const rel = (globalMs - w.startMs) / 1000
  if (rel < 0 || rel > (w.endMs - w.startMs) / 1000) return null
  return rel
}

/** The drag-and-drop wire shape (versioned — a stale tab must not inject junk). */
export const SYNC_PAYLOAD_VERSION = 1

export function encodeSyncPayload(slot: SyncSlot): string {
  return JSON.stringify({ v: SYNC_PAYLOAD_VERSION, path: slot.path, entry: slot.entry })
}

/**
 * Parse a dataTransfer payload back into a slot. Anything off-contract
 * (wrong version, failed schema, non-JSON) is null — a drop must never
 * throw into the panel.
 */
export function parseSyncPayload(json: string): SyncSlot | null {
  let raw: unknown
  try {
    raw = JSON.parse(json) as unknown
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.v !== SYNC_PAYLOAD_VERSION) return null
  if (typeof obj.path !== 'string' || obj.path === '') return null
  try {
    return { path: obj.path, entry: parse(PlaybackEntryS, obj.entry) }
  } catch {
    return null
  }
}

/**
 * Where the recordings panel parks the next window: the first empty visible
 * cell, or -1 when the grid is full (the caller then cycles back to cell 0 —
 * a review wall replaces, it does not grow).
 */
export function firstFreeSlot(
  slots: ReadonlyArray<SyncSlot | null>,
  layout: SyncLayout,
): number {
  for (let i = 0; i < layout && i < slots.length; i++) {
    const slot = slots[i]
    if (slot === null || slot === undefined) return i
  }
  return -1
}
