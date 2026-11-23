// sync-math.js — the pure half of synchronized playback (M3 wall, M4 chaining).
// Hand-written version check for the sync payload; entryDurationMs from ../_lib.js.
//
// Several recording CHAINS on ONE shared timeline: a cell holds a path's
// consecutive windows, the global clock is wall-clock milliseconds, and every
// tick maps that time to (which window of the chain, which media second inside
// it). Everything here is pure so tests can pin it without a browser; the
// panel (../sync.js) owns the rAF clock, the <video> elements and one
// MsePlayer per cell.
//
// Upstream facts kept honest: the playback server's `/get` answers
// `Accept-Ranges: none` — a window can only be streamed from its first byte,
// so a cross-window hop re-streams the target window from its start, seeking
// inside the buffered range is instant, and content evicted behind the
// playhead (mse.js keeps ~30s) is gone for good.

import { entryDurationMs } from './_lib.js'

/** Grid layouts the panel offers (cells rendered = layout). */
export const SYNC_MAX_SLOTS = 9

/**
 * One cell's content: consecutive windows of ONE path, in timeline order.
 * A single-window cell is just a chain of length 1.
 */
// SyncSlot = { path: string, entries: PlaybackEntry[] }

/** The shared timeline's span, in wall-clock milliseconds. */
// SyncRange = { startMs, endMs }

/** Where the global clock sits inside a cell's chain. */
// SlotPosition = { entryIndex, rel: number | null }

function entryWindow(entry) {
  const startMs = Date.parse(entry.startIso)
  if (Number.isNaN(startMs)) return null
  return { startMs, endMs: startMs + entryDurationMs(entry) }
}

/** The parseable windows of a chain, in order, with their chain index. */
function chainWindows(slot) {
  const out = []
  for (let i = 0; i < slot.entries.length; i++) {
    const entry = slot.entries[i]
    if (entry === undefined) continue
    const w = entryWindow(entry)
    if (w !== null) out.push({ ...w, index: i })
  }
  return out
}

/** A chain's own span on the wall clock, or null when nothing parses. */
export function slotWindow(slot) {
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
export function syncRange(slots, layout) {
  let range = null
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
 *   { entryIndex, rel }       — inside a window (play/pause/seek target)
 *   { entryIndex, rel: null } — inside a GAP: hold at the named window
 *       (its end), paused, until the clock reaches the next one
 *   null                      — outside the chain entirely (before its first
 *       window / after its last): the cell stands down
 */
export function locateInSlot(globalMs, slot) {
  const windows = chainWindows(slot)
  if (windows.length === 0) return null
  const first = windows[0]
  const last = windows[windows.length - 1]
  if (globalMs < first.startMs || globalMs > last.endMs) return null
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]
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

/**
 * Sequential ("chain") alignment: concatenate the chain's windows into one
 * relative timeline and map an elapsed offset into {entryIndex, rel}. Unlike
 * locateInSlot() this ignores REAL wall-clock gaps between windows, so every
 * cell starts at its own first window at elapsed=0 and N cells play together.
 *
 * This is the default for the wall: streams are published one after another,
 * so their recording start times differ by seconds/minutes. Wall-clock
 * alignment would leave every cell except the earliest black for most of the
 * timeline. Sequential alignment is what "同步回放" actually means to a user.
 */
export function locateInChain(slot, elapsedSec) {
  const entries = slot?.entries
  if (!Array.isArray(entries) || entries.length === 0) return null
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return null
  let acc = 0
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e === null || typeof e !== 'object') continue
    const dur = entryDurationMs(e) / 1000
    if (!Number.isFinite(dur) || dur <= 0) continue
    if (elapsedSec < acc + dur) return { entryIndex: i, rel: elapsedSec - acc }
    acc += dur
  }
  // Elapsed is past the chain's last window: stand down at its final window.
  return { entryIndex: entries.length - 1, rel: null }
}

/** Total media seconds of a chain (gaps excluded — it is what plays). */
export function chainSeconds(slot) {
  let total = 0
  for (const entry of slot.entries) total += entryDurationMs(entry)
  return total / 1000
}

/** The drag-and-drop wire shape (versioned — a stale tab must not inject junk). */
export const SYNC_PAYLOAD_VERSION = 2

function validSlotPayload(raw) {
  if (raw === null || typeof raw !== 'object') return false
  const r = raw
  if (r.v !== SYNC_PAYLOAD_VERSION) return false
  if (typeof r.path !== 'string' || r.path === '') return false
  if (!Array.isArray(r.entries) || r.entries.length === 0) return false
  return r.entries.every((e) => e !== null && typeof e === 'object'
    && typeof e.startIso === 'string'
    && Number.isFinite(e.durationSeconds)
    && typeof e.url === 'string')
}

export function encodeSyncPayload(slot) {
  return JSON.stringify({ v: SYNC_PAYLOAD_VERSION, path: slot.path, entries: slot.entries })
}

/**
 * Parse a dataTransfer payload back into a slot. Anything off-contract
 * (wrong version, failed check, non-JSON) is null — a drop must never throw
 * into the panel.
 */
export function parseSyncPayload(json) {
  let raw
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!validSlotPayload(raw)) return null
  return { path: raw.path, entries: raw.entries }
}

/**
 * Where the recordings panel parks the next chain: the first empty visible
 * cell, or -1 when the grid is full (the caller then cycles back to cell 0 —
 * a review wall replaces, it does not grow).
 */
export function firstFreeSlot(slots, layout) {
  for (let i = 0; i < layout && i < slots.length; i++) {
    if (slots[i] === null || slots[i] === undefined) return i
  }
  return -1
}
