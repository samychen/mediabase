// The main stage's chain-transport math (playlist.ts): the mapping between
// the whole-chain scrubber and (window index, media second). A one-second
// error here shows up as "I dragged to 12:00 and got 11:00" — pinned without
// a browser, including the boundary and zero-length-window rules.

import { describe, expect, it } from 'vitest'
import type { PlaybackEntry } from '../packages/protocol/src/index.ts'
import {
  chainLocate,
  chainOffsetMs,
  chainTotalMs,
} from '../packages/client/console/src/playlist.ts'

const win = (seconds: number): PlaybackEntry => ({
  startIso: '2026-09-26T10:00:00Z',
  durationSeconds: seconds,
  url: `http://127.0.0.1:9996/get?d=${seconds}`,
})

const P = [win(60), win(30), win(20)] // 110s total: [0,60) [60,90) [90,110]

describe('chain totals and offsets', () => {
  it('sums the windows (junk durations count as zero)', () => {
    expect(chainTotalMs(P)).toBe(110_000)
    expect(chainTotalMs([])).toBe(0)
    expect(chainTotalMs([win(60), { ...win(Number.NaN) }, { ...win(-5) }])).toBe(60_000)
  })

  it('places each window’s start on the transport, clamped', () => {
    expect(chainOffsetMs(P, 0)).toBe(0)
    expect(chainOffsetMs(P, 1)).toBe(60_000)
    expect(chainOffsetMs(P, 2)).toBe(90_000)
    expect(chainOffsetMs(P, 99)).toBe(110_000) // past the end: the full total
  })
})

describe('locating a transport offset in the chain', () => {
  it('maps inside windows', () => {
    expect(chainLocate(P, 0)).toEqual({ index: 0, relMs: 0 })
    expect(chainLocate(P, 12_500)).toEqual({ index: 0, relMs: 12_500 })
    expect(chainLocate(P, 75_000)).toEqual({ index: 1, relMs: 15_000 })
    expect(chainLocate(P, 95_000)).toEqual({ index: 2, relMs: 5_000 })
  })

  it('gives a boundary to the NEXT window, except the chain’s very end', () => {
    expect(chainLocate(P, 60_000)).toEqual({ index: 1, relMs: 0 })
    expect(chainLocate(P, 90_000)).toEqual({ index: 2, relMs: 0 })
    expect(chainLocate(P, 110_000)).toEqual({ index: 2, relMs: 20_000 })
  })

  it('clamps out-of-range and junk offsets', () => {
    expect(chainLocate(P, -5_000)).toEqual({ index: 0, relMs: 0 })
    expect(chainLocate(P, 999_999)).toEqual({ index: 2, relMs: 20_000 })
    expect(chainLocate(P, Number.NaN)).toEqual({ index: 0, relMs: 0 })
  })

  it('steps over zero-length windows — they own no time', () => {
    const z = [win(0), win(60), win(0), win(30)]
    expect(chainLocate(z, 0)).toEqual({ index: 1, relMs: 0 })
    expect(chainLocate(z, 60_000)).toEqual({ index: 3, relMs: 0 })
    expect(chainLocate(z, 75_000)).toEqual({ index: 3, relMs: 15_000 })
  })

  it('degrades on an empty chain without throwing', () => {
    expect(chainLocate([], 5_000)).toEqual({ index: 0, relMs: 0 })
  })
})
