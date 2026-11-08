// @vhl/ui-highlight / timeline.ts — source time vs clip time.
//
// The rendered clip is a CONCAT of the selected segments, so its timeline is not
// the source timeline. Segment 3 starting at 00:42 in the input sits at the sum
// of the earlier durations in the clip. Seeking a <video> to `startSec` would
// land somewhere else for every segment after the first — a bug that only shows
// up with a real multi-segment job, which is why this lives in its own pure
// module with tests instead of inline JSX arithmetic.
//
// The `0.5` floor mirrors the engine's per-segment minimum
// (ffmpeg_engine.assemble_highlights: `duration = max(0.5, end - start)`), so the
// arithmetic matches what was actually rendered.
//
// Exact only when the engine re-encodes (`frame_accurate`); under the default
// stream copy FFmpeg snaps cuts to keyframes, so callers must treat the result as
// best-effort and never present it as a frame-exact position.

import type { Segment } from './store.ts'

/** Per-segment minimum the engine enforces when cutting. */
export const MIN_SEGMENT_SEC = 0.5

/** Start offset of each segment inside the rendered clip, in segment order. */
export function clipOffsets(segments: Segment[]): number[] {
  const offsets: number[] = []
  let cursor = 0
  for (const segment of segments) {
    offsets.push(cursor)
    cursor += Math.max(MIN_SEGMENT_SEC, segment.endSec - segment.startSec)
  }
  return offsets
}

/** Total length of the concat, i.e. what the clip's duration should be. */
export function clipDuration(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + Math.max(MIN_SEGMENT_SEC, s.endSec - s.startSec), 0)
}
