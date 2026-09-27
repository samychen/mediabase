// sync.ts — the pure half of synchronized playback (M3 wall, M4 chaining).
//
// Several recording CHAINS on ONE shared timeline: a cell holds a path's
// consecutive windows (M4 — the wall used to hold one window each), the
// global clock is wall-clock milliseconds, and every tick maps that time to
// (which window of the chain, which media second inside it). Everything here
// is pure so vitest can pin it without a browser; the panel (panels/sync.tsx)
// owns the rAF clock, the <video> elements and one MsePlayer per cell.
//
// Upstream facts kept honest: the playback server's `/get` answers
// `Accept-Ranges: none` — a window can only be streamed from its first byte,
// so a cross-window hop re-streams the target window from its start, seeking
// inside the buffered range is instant, and content evicted behind the
// playhead (mse.ts keeps ~30s) is gone for good.

import { parse, z } from '@mediabase/schema'
import { entryDurationMs, PlaybackEntryS, type PlaybackEntry } from '@mtxconsole/protocol'

/** Grid layouts the panel offers (cells rendered = layout). */
export type SyncLayout = 1 | 4 | 9

/** The widest layout — also the fixed length of the slot array in the store. */
export const SYNC_MAX_SLOTS = 9

/**
 * One cell's content: consecutive windows of ONE path, in timeline order.
 * A single-window cell is just a chain of length 1.
 */
export interface SyncSlot {
  path: string
  entries: PlaybackEntry[]
}

/** The shared timeline's span, in wall-clock milliseconds. */
export interface SyncRange {
  startMs: number
  endMs: number
}

/** Where the global clock sits inside a cell's chain. */
export interface SlotPosition {
  /** The chain window that owns this instant. */
  entryIndex: number
  /** Media seconds inside that window, or null when the clock sits in a GAP
   * between windows (recordings pause — the cell holds, paused, until the
   * next window starts). */
  rel: number | null
}

interface EntryWindow {
  startMs: number
  endMs: number
}

/** One entry's wall-clock span, or null when its timestamp is junk. */
function entryWindow(entry: PlaybackEntry): EntryWindow | null {
  const startMs = Date.parse(entry.startIso)
  if (Number.isNaN(startMs)) return null
  return { startMs, endMs: startMs + entryDurationMs(entry) }
}

/** The parseable windows of a chain, in order, with their chain index. */
function chainWindows(slot: SyncSlot): Array<EntryWindow & { index: number }> {
  const out: Array<EntryWindow & { index: number }> = []
  for (let i = 0; i < slot.entries.length; i++) {
    const entry = slot.entries[i]
    if (entry === undefined) continue
    const w = entryWindow(entry)
    if (w !== null) out.push({ ...w, index: i })
  }
  return out
}

/** A chain's own span on the wall clock, or null when nothing parses. */
export function slotWindow(slot: SyncSlot): SyncRange | null {
  const windows = chainWindows(slot)
  if (windows.length === 0) return null
  let startMs = Infinity
  let endMs = -Infinity
  for (const w of windows) {
    if (w.startMs < startMs) startMs = w.startMs
    if (w.endMs > endMs) endMs = w.endMs
  }
  return { startMs, endMs }
}

/**
 * The timeline spanned by the VISIBLE cells (index < layout): earliest start
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
 * Map the global clock (wall-clock ms) into one cell's chain: which window
 * owns the instant, and the media second inside it. Returns:
 *   { entryIndex, rel }    — inside a window (play/pause/seek target)
 *   { entryIndex, rel: null } — inside a GAP: hold at the named window
 *       (its end), paused, until the clock reaches the next one
 *   null                   — outside the chain entirely (before its first
 *       window / after its last): the cell stands down
 */
export function locateInSlot(globalMs: number, slot: SyncSlot): SlotPosition | null {
  const windows = chainWindows(slot)
  if (windows.length === 0) return null
  const first = windows[0]!
  const last = windows[windows.length - 1]!
  if (globalMs < first.startMs || globalMs > last.endMs) return null
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!
    if (globalMs >= w.startMs && globalMs <= w.endMs) {
      return { entryIndex: w.index, rel: (globalMs - w.startMs) / 1000 }
    }
    // A gap: between this window's end and the next parseable start.
    const next = windows[i + 1]
    if (next !== undefined && globalMs > w.endMs && globalMs < next.startMs) {
      return { entryIndex: w.index, rel: null }
    }
  }
  // Unreachable for parseable chains (the span is covered), but overlapping
  // upstream windows could land here — hold at the last window rather than
  // inventing a position.
  return { entryIndex: last.index, rel: null }
}

/** Total media seconds of a chain (gaps excluded — it is what plays). */
export function chainSeconds(slot: SyncSlot): number {
  let total = 0
  for (const entry of slot.entries) total += entryDurationMs(entry)
  return total / 1000
}

/** The drag-and-drop wire shape (versioned — a stale tab must not inject junk). */
export const SYNC_PAYLOAD_VERSION = 2

const SyncSlotPayloadS = z.object({
  v: z.const(SYNC_PAYLOAD_VERSION).required(),
  path: z.string().min(1).required(),
  entries: z.array(PlaybackEntryS).required(),
})

export function encodeSyncPayload(slot: SyncSlot): string {
  return JSON.stringify({ v: SYNC_PAYLOAD_VERSION, path: slot.path, entries: slot.entries })
}

/**
 * Parse a dataTransfer payload back into a slot. Anything off-contract
 * (wrong version — e.g. an M3 single-window tab, failed schema, non-JSON)
 * is null — a drop must never throw into the panel.
 */
export function parseSyncPayload(json: string): SyncSlot | null {
  let raw: unknown
  try {
    raw = JSON.parse(json) as unknown
  } catch {
    return null
  }
  try {
    const parsed = parse(SyncSlotPayloadS, raw)
    // An empty chain has nothing to play — refuse it instead of parking it.
    return parsed.entries.length === 0 ? null : { path: parsed.path, entries: parsed.entries }
  } catch {
    return null
  }
}

/**
 * Where the recordings panel parks the next chain: the first empty visible
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
