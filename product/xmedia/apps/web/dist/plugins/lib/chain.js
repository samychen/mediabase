// chain.js — the pure half of the main stage's recording CHAIN (M4).
// entryDurationMs comes from ../_lib.js.
//
// The chain transport spans the playlist's total playing time; these helpers
// map between "chain offset" (transport pixels) and (window index, media
// second inside it) — the same locate idea sync-math.js has for the wall, but
// for ONE path's ordered windows on the stage. Durations come from upstream
// as float seconds; anything non-finite or negative counts as zero (a junk
// window must not poison the whole transport).

import { entryDurationMs } from './_lib.js'

function durationMs(entry) {
  return entry === undefined ? 0 : entryDurationMs(entry)
}

/** Total playing time of the chain, in milliseconds (the stage plays window
 * after window — gaps do not exist here). */
export function chainTotalMs(entries) {
  let total = 0
  for (const entry of entries) total += durationMs(entry)
  return total
}

/** Where window `index` starts on the chain transport (clamped). */
export function chainOffsetMs(entries, index) {
  let cum = 0
  for (let i = 0; i < entries.length && i < index; i++) cum += durationMs(entries[i])
  return cum
}

/**
 * Map a transport offset to (window, media ms inside it). The offset is
 * clamped into [0, total]; a window boundary belongs to the NEXT window
 * (except the chain's very end, which stays in the last one); zero-length
 * windows own no time and are stepped over.
 */
export function chainLocate(entries, offsetMs) {
  if (entries.length === 0) return { index: 0, relMs: 0 }
  const total = chainTotalMs(entries)
  const clamped = Math.min(Math.max(Number.isFinite(offsetMs) ? offsetMs : 0, 0), total)
  let cum = 0
  for (let i = 0; i < entries.length; i++) {
    const dur = durationMs(entries[i])
    if (clamped < cum + dur || i === entries.length - 1) return { index: i, relMs: clamped - cum }
    cum += dur
  }
  return { index: entries.length - 1, relMs: 0 }
}
