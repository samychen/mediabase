// The derived timeline: where each element sits on the OUTPUT clock. Pure —
// the preview, the timeline panel and the export all read placement from
// here, so they cannot drift apart.
//
// Segment math derived from clawnify/OpenVideo src/client/edit.tsx (MIT)
// (`mainDur` / `mainSegments`).

import type { AudioElement, AudioTrack, Edl, MainElement, OverlayElement, OverlayTrack } from './edl.ts'

/** Seconds a source plays, looked up by its `src` string ("asset:<id>", URL…). */
export type SourceDuration = (src: string) => number | undefined

/** Duration of one main element given known source durations. */
export function mainDur(el: MainElement, srcDur: SourceDuration): number {
  if (el.type === 'image') return el.duration
  const d = srcDur(el.src)
  if (el.duration !== undefined) {
    // Play-window form: usable even before metadata loads (clamped when known).
    return d === undefined ? el.duration : Math.min(el.duration, Math.max(0, d - (el.trimStart ?? 0)))
  }
  if (d === undefined) return 0
  return Math.max(0, d - (el.trimStart ?? 0) - (el.trimEnd ?? 0))
}

export interface MainSegment {
  el: MainElement
  /** Index on the main track (the play order). */
  i: number
  /** Seconds on the output timeline. */
  start: number
  /** Seconds it plays. */
  dur: number
}

/** Segments of the main track on the output timeline. */
export function mainSegments(edl: Edl, srcDur: SourceDuration): MainSegment[] {
  let t = 0
  return edl.main.elements.map((el, i) => {
    const dur = mainDur(el, srcDur)
    const seg = { el, i, start: t, dur }
    t += dur
    return seg
  })
}

/** Length of the finished video (the main track; overlays may run past it). */
export function totalDuration(segments: readonly MainSegment[]): number {
  return segments.reduce((sum, s) => sum + s.dur, 0)
}

/** The segment under the playhead, or the last one past the end. */
export function activeSegment(segments: readonly MainSegment[], t: number): MainSegment | undefined {
  return segments.find((s) => t >= s.start && t < s.start + s.dur) ?? segments[segments.length - 1]
}

/** Overlay elements visible at output time `t` (hidden tracks excluded), tracks in composite order. */
export function activeOverlays(edl: Edl, t: number): OverlayElement[] {
  const out: OverlayElement[] = []
  for (const track of edl.overlays ?? [] as OverlayTrack[]) {
    if (track.hidden === true) continue
    for (const el of track.elements) {
      if (t >= el.startTime && t < el.startTime + el.duration) out.push(el)
    }
  }
  return out
}

/** Audio elements sounding at output time `t` (muted tracks excluded). */
export function activeAudio(edl: Edl, t: number): AudioElement[] {
  const out: AudioElement[] = []
  for (const track of edl.audio ?? [] as AudioTrack[]) {
    if (track.muted === true) continue
    for (const el of track.elements) {
      if (t >= el.startTime && (el.duration === undefined || t < el.startTime + el.duration)) out.push(el)
    }
  }
  return out
}

/** "0:07.3" — the transport clock's own format. */
export function fmtTime(t: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
