// Sync playback (M3): a wall of recording windows on ONE shared timeline.
//
// The grid cells are the store's syncSlots (recordings panel fills them —
// button or drag-and-drop); this panel owns everything time-shaped: a rAF
// master clock in wall-clock milliseconds, the mapping from global time to
// each slot's media seconds (sync.ts), and one MsePlayer per occupied cell.
// `<video src>` is NOT an option here for the reason mse.ts documents: the
// playback server's /get answers Accept-Ranges: none and puts moov last —
// every window streams through MSE, browser ⇄ playback server directly.
//
// The clock deliberately lives OUTSIDE the store: a 60fps tick must not
// re-emit the snapshot six other panels render from. The store carries the
// declarative state (slots, layout); timeRef + direct DOM writes on the
// scrubber/label carry the fast state.

import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'
import { fmtClock, fmtDur } from '../format.ts'
import { MsePlayer, type MseState } from '../mse.ts'
import { IconClose, IconGrid, IconPause, IconPlay } from '../icons.tsx'
import {
  parseSyncPayload,
  slotRelSeconds,
  syncRange,
  SYNC_MAX_SLOTS,
  type SyncLayout,
  type SyncSlot,
} from '../sync.ts'

/** How far a video may drift from the master clock before it gets snapped. */
const DRIFT_S = 0.4

/** Stable empty grid for the store-absent render path (hooks need constants). */
const NO_SLOTS: ReadonlyArray<SyncSlot | null> = Object.freeze(
  Array.from({ length: SYNC_MAX_SLOTS }, () => null),
)

interface SlotBadge {
  state: MseState
  detail?: string
}

/** One cell's stream state; 'playing' shows no badge (a clean wall). */
type SlotBadges = ReadonlyArray<SlotBadge | null>

const NO_BADGES: SlotBadges = Object.freeze(Array.from({ length: SYNC_MAX_SLOTS }, () => null))

export function SyncPanel({ ctx }: { ctx: Context }): ReactElement | null {
  // Hook order is sacred (same rule as player.tsx): everything runs
  // unconditionally; the store-absent case degrades to nulls at the end.
  const cons = useConsole(ctx)
  const { t } = useI18n(ctx)
  const store = cons?.store ?? null
  const snap = cons?.snap ?? null
  const slots = snap?.syncSlots ?? NO_SLOTS
  const layout = snap?.syncLayout ?? 4

  const [playing, setPlaying] = useState(false)
  const [badges, setBadges] = useState<SlotBadges>(NO_BADGES)

  // Fast state and element handles — refs, never snapshot fields.
  const videosRef = useRef<Array<HTMLVideoElement | null>>(Array.from({ length: SYNC_MAX_SLOTS }, () => null))
  const playersRef = useRef<Array<MsePlayer | null>>(Array.from({ length: SYNC_MAX_SLOTS }, () => null))
  const attachedRef = useRef<Array<string | null>>(Array.from({ length: SYNC_MAX_SLOTS }, () => null))
  const guardsRef = useRef<Array<(() => void) | null>>(Array.from({ length: SYNC_MAX_SLOTS }, () => null))
  const slotsRef = useRef(slots)
  const layoutRef = useRef(layout)
  const playingRef = useRef(playing)
  const timeRef = useRef(0)
  const scrubberRef = useRef<HTMLInputElement | null>(null)
  const clockRef = useRef<HTMLSpanElement | null>(null)

  const range = useMemo(() => syncRange(slots, layout), [slots, layout])
  const rangeRef = useRef(range)

  /** Per-cell identity: re-attach the MSE stream only when the window changed. */
  const idsKey = useMemo(
    () => slots
      .map((s, i) => (i < layout && s !== null ? `${s.path}|${s.entry.startIso}|${s.entry.url}` : ''))
      .join('\u0000'),
    [slots, layout],
  )

  // Keep the refs current for the closures below (runs before every other
  // effect in the same commit — declaration order is the guarantee).
  useEffect(() => {
    slotsRef.current = slots
    layoutRef.current = layout
    playingRef.current = playing
    rangeRef.current = range
  })

  /** Paint scrubber + wall-clock label without a React render. */
  const paintTransport = (globalMs: number): void => {
    const scrubber = scrubberRef.current
    if (scrubber !== null) scrubber.value = String(globalMs)
    const clock = clockRef.current
    const r = rangeRef.current
    if (clock !== null) {
      clock.textContent = r === null
        ? '—'
        : `${fmtClock(new Date(globalMs).toISOString())} / ${fmtClock(new Date(r.endMs).toISOString())}`
    }
  }

  /**
   * Apply the global clock to every visible cell: map to local seconds, snap
   * drifted videos back, and play/pause with the transport. Seeks are honest
   * about /get's missing Range support: inside the buffer they are instant,
   * forward they stall until the sequential fetch catches up, and positions
   * already evicted behind the playhead clamp to what remains.
   */
  const drive = (globalMs: number, run: boolean): void => {
    const cur = slotsRef.current
    const lay = layoutRef.current
    for (let i = 0; i < SYNC_MAX_SLOTS; i++) {
      const video = videosRef.current[i]
      const slot = i < lay ? cur[i] : null
      if (video === null || video === undefined || slot === null || slot === undefined) continue
      const rel = slotRelSeconds(globalMs, slot)
      if (rel === null) {
        // Outside this slot's window (not started yet, or already over):
        // hold it paused; the clock brings it back into range on its own.
        if (!video.paused) video.pause()
        continue
      }
      if (video.buffered.length > 0 && Math.abs(video.currentTime - rel) > DRIFT_S) {
        const bufStart = video.buffered.start(0)
        video.currentTime = rel < bufStart ? bufStart : rel
      }
      if (run) {
        if (video.paused) video.play().catch(() => { /* next tick retries */ })
      } else if (!video.paused) {
        video.pause()
      }
    }
  }

  // ---- stream lifecycle: one MsePlayer per occupied cell --------------------

  useEffect(() => {
    const ids = idsKey.split('\u0000')
    for (let i = 0; i < SYNC_MAX_SLOTS; i++) {
      const id = ids[i] ?? ''
      if (attachedRef.current[i] === id) continue
      playersRef.current[i]?.dispose()
      playersRef.current[i] = null
      guardsRef.current[i]?.()
      guardsRef.current[i] = null
      attachedRef.current[i] = id
      const idx = i
      setBadges((prev) => {
        const next = [...prev]
        next[idx] = null
        return next
      })
      if (id === '') continue
      const video = videosRef.current[i]
      const slot = slotsRef.current[i]
      if (video === null || video === undefined || slot === null || slot === undefined) continue
      const player = new MsePlayer(video, (state, detail) => {
        setBadges((prev) => {
          const next = [...prev]
          next[idx] = state === 'playing' ? null : detail === undefined ? { state } : { state, detail }
          return next
        })
      })
      playersRef.current[i] = player
      // MsePlayer calls video.play() as soon as the source opens, but the
      // master clock may be parked — re-assert the pause when media starts.
      const guard = (): void => {
        if (!playingRef.current) video.pause()
      }
      video.addEventListener('playing', guard)
      guardsRef.current[i] = () => video.removeEventListener('playing', guard)
      void player.play(slot.entry.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  // Full teardown with the panel: no leaked fetches or MediaSource objects.
  useEffect(() => () => {
    for (let i = 0; i < SYNC_MAX_SLOTS; i++) {
      playersRef.current[i]?.dispose()
      playersRef.current[i] = null
      guardsRef.current[i]?.()
      guardsRef.current[i] = null
      attachedRef.current[i] = null
    }
  }, [])

  // ---- the master clock ------------------------------------------------------

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop)
      const dt = now - last
      last = now
      const r = rangeRef.current
      if (r === null) return
      let next = timeRef.current + dt
      if (next >= r.endMs) {
        next = r.endMs
        setPlaying(false)
      }
      timeRef.current = next
      drive(next, true)
      paintTransport(next)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // drive/paintTransport read refs only — the closure stays valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, idsKey])

  // Slot or timeline changes: re-clamp the clock, re-paint, and re-map every
  // cell once (while playing, the rAF loop takes over from here). An empty
  // wall stops the transport — a running clock with no timeline would spin.
  useEffect(() => {
    if (range === null) {
      timeRef.current = 0
      setPlaying(false)
    } else {
      timeRef.current = Math.min(Math.max(timeRef.current, range.startMs), range.endMs)
    }
    paintTransport(timeRef.current)
    drive(timeRef.current, playingRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, idsKey])

  // Parking the clock pauses the wall (and a paused scrub still previews).
  useEffect(() => {
    if (!playing) drive(timeRef.current, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  if (cons === null || store === null || snap === null) return null

  const occupied = slots.slice(0, layout).some((s) => s !== null)

  const togglePlay = (): void => {
    if (range === null) return
    if (playing) {
      setPlaying(false)
      return
    }
    // Pressing play at the end means "again from the top".
    if (timeRef.current >= range.endMs) {
      timeRef.current = range.startMs
      paintTransport(timeRef.current)
    }
    setPlaying(true)
  }

  const onScrub = (e: { target: { value: string } }): void => {
    const v = Number(e.target.value)
    if (!Number.isFinite(v)) return
    timeRef.current = v
    drive(v, playingRef.current)
    paintTransport(v)
  }

  const onCellDrop = (e: ReactDragEvent, i: number): void => {
    e.preventDefault()
    const slot = parseSyncPayload(e.dataTransfer.getData('text/plain'))
    if (slot !== null) store.syncAssign(i, slot)
  }

  const badgeText = (b: SlotBadge): string => {
    if (b.state === 'opening') return t('player.connecting')
    if (b.state === 'ended') return t('player.stopped')
    return b.detail === 'mse-unsupported' ? t('player.mseUnsupported') : t('common.error', { detail: b.detail ?? '?' })
  }

  return (
    <section className="mx-sync">
      <div className="mx-sync__bar">
        <button
          type="button"
          className="mx-btn"
          disabled={range === null}
          title={playing ? t('sync.pause') : t('sync.play')}
          onClick={togglePlay}
        >
          {playing ? <IconPause /> : <IconPlay />} {playing ? t('sync.pause') : t('sync.play')}
        </button>
        <input
          ref={scrubberRef}
          type="range"
          className="mx-sync__scrub"
          aria-label={t('panel.sync.title')}
          disabled={range === null}
          step={250}
          min={range?.startMs ?? 0}
          max={range?.endMs ?? 1}
          onChange={onScrub}
        />
        <span ref={clockRef} className="mx-mono mx-sync__clock">—</span>
        <label className="mx-sync__layout">
          <span className="mx-dim mx-sync__layout-label"><IconGrid /> {t('sync.layout')}</span>
          <select
            className="mx-select"
            value={layout}
            onChange={(e) => store.syncSetLayout(Number(e.target.value) as SyncLayout)}
          >
            <option value={1}>{t('sync.layout.1')}</option>
            <option value={4}>{t('sync.layout.4')}</option>
            <option value={9}>{t('sync.layout.9')}</option>
          </select>
        </label>
        <button type="button" className="mx-btn" disabled={!occupied} onClick={() => { setPlaying(false); store.syncClear() }}>
          <IconClose /> {t('sync.clear')}
        </button>
      </div>
      {!occupied && <p className="mx-dim mx-sync__empty">{t('sync.empty')}</p>}
      <div className="mx-sync__grid" data-layout={layout}>
        {Array.from({ length: layout }, (_, i) => {
          const slot = slots[i] ?? null
          const badge = badges[i] ?? null
          return (
            <div
              key={i}
              className="mx-sync__cell"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onCellDrop(e, i)}
            >
              {slot === null
                ? <span className="mx-dim mx-sync__cellhint">{t('sync.dropHint')}</span>
                : (
                    <>
                      <video
                        ref={(el) => { videosRef.current[i] = el }}
                        muted
                        playsInline
                      />
                      <span className="mx-sync__label">
                        {slot.path} · {fmtClock(slot.entry.startIso)} · {fmtDur(slot.entry.durationSeconds)}
                      </span>
                      {badge !== null && (
                        <span className="mx-badge mx-sync__badge" data-state={badge.state === 'error' ? 'err' : 'idle'}>
                          {badgeText(badge)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="mx-btn mx-btn--icon mx-sync__remove"
                        title={t('sync.removeSlot')}
                        onClick={() => store.syncAssign(i, null)}
                      >
                        <IconClose />
                      </button>
                    </>
                  )}
            </div>
          )
        })}
      </div>
      <p className="mx-dim mx-sync__hint">{t('sync.seekHint')}</p>
    </section>
  )
}
