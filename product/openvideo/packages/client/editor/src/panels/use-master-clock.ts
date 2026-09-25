// The master clock: one rAF loop that owns "what time is it on the output
// timeline". The wall clock carries it; the PLAYING main-track video corrects
// it when it can be trusted (paused/starved elements are not clocks — letting
// them freeze the playhead was the upstream bug this scheme avoids).
//
// Extracted from the player panel so the loop's contract is readable on its
// own: it reads segments/total through refs (never stale, never re-subscribed
// per frame) and writes only through the store.

import { useEffect, type MutableRefObject, type RefObject } from 'react'
import { activeSegment, type MainSegment } from '@openvideo/edl'
import type { EditorStore } from '../store.ts'

export interface MasterClockOptions {
  playing: boolean
  store: EditorStore | null
  segmentsRef: MutableRefObject<MainSegment[]>
  totalRef: MutableRefObject<number>
  videoRef: RefObject<HTMLVideoElement>
}

export function useMasterClock(opts: MasterClockOptions): void {
  const { playing, store, segmentsRef, totalRef, videoRef } = opts
  useEffect(() => {
    if (!playing || store === null) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const dt = (now - last) / 1000
      last = now
      let clockT = store.get().playhead + dt
      const seg = activeSegment(segmentsRef.current, clockT)
      const v = videoRef.current
      if (seg !== undefined && seg.el.type === 'video' && v !== null && !v.paused && v.readyState >= 2) {
        clockT = seg.start + (v.currentTime - (seg.el.trimStart ?? 0))
      }
      if (clockT >= totalRef.current) {
        store.setPlayhead(totalRef.current)
        store.setPlaying(false)
        return
      }
      store.setPlayhead(clockT)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, store, segmentsRef, totalRef, videoRef])
}
