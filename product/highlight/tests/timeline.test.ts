// product/highlight — clip-time arithmetic.
//
// This is the one piece of the browser layer with a numeric contract, so it is
// tested without a DOM: a wrong offset silently seeks the reviewer to the wrong
// moment, which is worse than a crash.

import { describe, expect, it } from 'vitest'
import { clipDuration, clipOffsets, MIN_SEGMENT_SEC } from '../packages/client/panel/src/timeline.ts'

const seg = (startSec: number, endSec: number) => ({ startSec, endSec, score: 0, signals: {} })

describe('clipOffsets', () => {
  it('is empty for no segments', () => {
    expect(clipOffsets([])).toEqual([])
    expect(clipDuration([])).toBe(0)
  })

  it('starts the first segment at zero, regardless of its source time', () => {
    expect(clipOffsets([seg(2.8, 12)])).toEqual([0])
  })

  it('accumulates durations instead of reusing source times', () => {
    // A concat of 6s + 4s + 9s: the third segment starts at 10s in the clip,
    // not at its 00:42-ish source position.
    const offsets = clipOffsets([seg(10, 16), seg(40, 44), seg(120, 129)])
    expect(offsets).toEqual([0, 6, 10])
    expect(clipDuration([seg(10, 16), seg(40, 44), seg(120, 129)])).toBe(19)
  })

  it('floors a too-short segment at the engine minimum', () => {
    // assemble_highlights cuts with duration = max(0.5, end - start).
    const offsets = clipOffsets([seg(1, 1.2), seg(5, 8)])
    expect(offsets).toEqual([0, MIN_SEGMENT_SEC])
  })
})
