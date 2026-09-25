// Player panel (monitor): orchestration — state, the clock hook, the element
// sync effects, the caption fetch and the export run. The frame itself is
// stage.tsx, the controls are transport.tsx, the clock loop is
// use-master-clock.ts; this file is the wiring between them and the store.
//
// Preview semantics (from the upstream editor, MIT): one master clock; the
// playing video corrects it; seeks only on real jumps (each seek empties the
// buffer); the stage shows cuts, layout and timing — pixel-exact rendering is
// the export's job.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import {
  activeAudio,
  activeOverlays,
  activeSegment,
  captionText,
  mainSegments,
  totalDuration,
  type Cue,
  type OverlayElement,
} from '@openvideo/edl'
import { useEditor } from '../use-editor.ts'
import { captionLines } from '../store.ts'
import { exportProject, exportSupported, ExportError } from '../export.ts'
import { StageLayers, trackOf } from './stage.tsx'
import { ExportBar, IDLE_EXPORT, TransportBar, type ExportState } from './transport.tsx'
import { useMasterClock } from './use-master-clock.ts'

export function PlayerPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useEditor(ctx)
  const { t } = useI18n(ctx)
  const boxRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayVideos = useRef(new Map<string, HTMLVideoElement>())
  const audioEls = useRef(new Map<string, HTMLAudioElement>())
  const [fit, setFit] = useState({ w: 0, h: 0, scale: 1 })
  const [cuesBySrc, setCuesBySrc] = useState<Map<string, Cue[]>>(new Map())
  const [exportState, setExportState] = useState<ExportState>(IDLE_EXPORT)
  /** A decoded-nothing situation must be VISIBLE: black stage + silent catch
    * is how a codec problem used to look like "the editor is broken". */
  const [mediaIssue, setMediaIssue] = useState<{ key: string; params?: Record<string, string | number> } | null>(null)
  const [diag, setDiag] = useState<string | null>(null)
  const [savedExport, setSavedExport] = useState(false)
  const exportBlob = useRef<Blob | null>(null)
  const exportAbort = useRef<AbortController | null>(null)

  const state = editor?.state ?? null
  const store = editor?.store ?? null
  const draft = state?.draft ?? null
  const durations = state?.durations ?? {}

  // Fit the stage to the pane: the limiting dimension wins (see the upstream
  // note — aspect-ratio alone let the frame run off the bottom).
  const outputW = draft?.output.width ?? 16
  const outputH = draft?.output.height ?? 9
  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const measure = (): void => {
      const cs = getComputedStyle(box)
      const width = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const height = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      const s = Math.min(width / outputW, height / outputH)
      if (s > 0 && Number.isFinite(s)) setFit({ w: outputW * s, h: outputH * s, scale: s })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [outputW, outputH])

  const segments = useMemo(
    () => (draft === null ? [] : mainSegments(draft, (src) => durations[src])),
    [draft, durations],
  )
  const total = totalDuration(segments)
  const playhead = state?.playhead ?? 0
  const playing = state?.playing ?? false
  const active = draft === null ? undefined : activeSegment(segments, playhead)
  const overlays = draft === null ? [] : activeOverlays(draft, playhead)
  const sounds = draft === null ? [] : activeAudio(draft, playhead)

  const nameForSrc = (src: string): string => {
    if (!src.startsWith('asset:')) return src
    const id = src.slice(6)
    const assets = store?.get().assets ?? []
    return assets.find((a) => a.id === id)?.name ?? id.slice(0, 12)
  }

  const resolveSrc = (src: string): string | null => (store === null ? null : store.playUrlFor(src))

  // Captions: fetch the transcripts the project needs whenever it (re)opens
  // or captions toggle; missing transcripts simply contribute no lines.
  const captionsOn = draft?.captions?.enabled === true
  const openId = state?.openId ?? null
  useEffect(() => {
    if (store === null || draft === null || !captionsOn) return
    let dead = false
    const srcs = [...new Set(draft.main.elements.filter((el) => el.type === 'video').map((el) => el.src))]
    void Promise.all(srcs.map(async (src) => [src, await store.transcriptFor(src)] as const))
      .then((entries) => {
        if (dead) return
        const map = new Map<string, Cue[]>()
        for (const [src, cues] of entries) {
          if (cues !== null) map.set(src, cues)
        }
        setCuesBySrc(map)
      })
      .catch(() => {})
    return () => {
      dead = true
    }
  }, [store, draft, captionsOn, openId])

  const captionNow = useMemo(() => {
    if (draft === null || !captionsOn || draft.captions === undefined) return []
    const style = draft.captions.style
    const frame = { width: draft.output.width, height: draft.output.height }
    return captionLines(draft, cuesBySrc, durations)
      .filter((line) => playhead >= line.from && playhead < line.to)
      .map((line, i) => captionText(line, style, frame, `cap-${i}`))
  }, [draft, captionsOn, cuesBySrc, durations, playhead])

  // ---- the master clock (its own hook; refs keep it off the render path) ----
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments
  const totalRef = useRef(total)
  totalRef.current = total
  useMasterClock({ playing, store, segmentsRef, totalRef, videoRef })

  // ---- sync the media elements to the clock ---------------------------------
  const playBlocked = (err: unknown): void => {
    const e = err as { name?: string; message?: string }
    store?.flash('ov.player.playBlocked', { error: e?.name ?? e?.message ?? 'play()' })
  }

  const activeVideoSrc = active !== undefined && active.el.type === 'video' ? active.el.src : null
  useEffect(() => {
    const v = videoRef.current
    if (v === null) return
    if (activeVideoSrc === null || active === undefined || active.el.type !== 'video') {
      if (!v.paused) v.pause()
      return
    }
    const el = active.el
    const wanted = (el.trimStart ?? 0) + (playhead - active.start)
    // A real jump (a scrub or a cut) is worth a seek; small drift is not —
    // each seek empties the buffer.
    const jumped = Math.abs(v.currentTime - wanted) > (playing ? 0.75 : 0.05)
    if (jumped && !v.seeking) v.currentTime = wanted
    v.volume = Math.min(1, el.volume ?? 1)
    v.muted = el.sourceAudio === false
    if (playing && v.paused) v.play().catch(playBlocked)
    if (!playing && !v.paused) v.pause()
  }, [playhead, playing, activeVideoSrc, active, store])

  // Overlay videos: played muted (their words would fight the audio bed, and
  // the document carries no per-overlay audio fields).
  for (const el of overlays) {
    if (el.type !== 'video') continue
    const v = overlayVideos.current.get(el.id)
    if (v === undefined) continue
    const wanted = (el.trimStart ?? 0) + (playhead - el.startTime)
    if (Math.abs(v.currentTime - wanted) > 0.5 && !v.seeking) v.currentTime = wanted
    v.muted = true
    if (playing && v.paused) v.play().catch(playBlocked)
    if (!playing && !v.paused) v.pause()
  }
  for (const [id, v] of overlayVideos.current) {
    if (!overlays.some((el) => el.id === id && el.type === 'video') && !v.paused) v.pause()
  }

  // Audio bed.
  for (const el of sounds) {
    const a = audioEls.current.get(el.id)
    if (a === undefined) continue
    const wanted = (el.trimStart ?? 0) + (playhead - el.startTime)
    if (Math.abs(a.currentTime - wanted) > 0.5 && !a.seeking) a.currentTime = wanted
    a.volume = Math.min(1, el.volume ?? 1)
    if (playing && a.paused) a.play().catch(playBlocked)
    if (!playing && !a.paused) a.pause()
  }
  for (const [id, a] of audioEls.current) {
    if (!sounds.some((el) => el.id === id) && !a.paused) a.pause()
  }

  // ---- export ----------------------------------------------------------------
  const runExport = async (): Promise<void> => {
    if (draft === null || store === null) return
    if (!exportSupported()) {
      setExportState({ ...IDLE_EXPORT, phase: 'error', fraction: 0, error: t('ov.player.exportUnsupported') })
      return
    }
    store.setPlaying(false)
    setSavedExport(false)
    setExportState({ phase: 'recording', fraction: 0 })
    const abort = new AbortController()
    exportAbort.current = abort
    try {
      const out = await exportProject({
        edl: draft,
        resolveSrc,
        durations,
        cuesBySrc,
        signal: abort.signal,
        onProgress: (fraction) => setExportState({ phase: 'recording', fraction }),
      })
      exportBlob.current = out.blob
      const url = URL.createObjectURL(out.blob)
      setExportState({ phase: 'done', fraction: 1, url, size: out.blob.size, ext: out.ext })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const UNDECODABLE = 'export.undecodable:'
      const text = msg === 'export.aborted'
        ? t('ov.player.exportCanceled')
        : msg.startsWith(UNDECODABLE)
          ? t('ov.player.exportUndecodable', {
            assets: msg.slice(UNDECODABLE.length).split(',').filter(Boolean).map(nameForSrc).join(', '),
          })
          : e instanceof ExportError
            ? t(msg === 'export.unsupported' ? 'ov.player.exportUnsupported' : 'ov.player.exportFailed', { error: msg })
            : store.errorText(e)
      setExportState({ phase: 'error', fraction: 0, error: text })
    } finally {
      exportAbort.current = null
    }
  }

  if (editor === null || state === null || store === null) return null

  const projectName = state.projectName
  const selectOverlay = (el: OverlayElement): void => {
    if (draft === null) return
    const track = trackOf(draft, el.id)
    const index = (draft.overlays ?? [])[track]?.elements.findIndex((x) => x.id === el.id) ?? -1
    store.select({ kind: 'overlay', track, index: Math.max(0, index) })
  }

  return (
    <div className="ov-player">
      <div className="ov-player-box" ref={boxRef}>
        {draft === null ? (
          <div className="status">{t('ov.player.noProject')}</div>
        ) : (
          <div
            className="ov-stage"
            style={{ width: fit.w, height: fit.h, background: draft.output.background ?? '#000000' }}
            onDoubleClick={() => store.setPlaying(!state.playing)}
          >
            <StageLayers
              draft={draft}
              scale={fit.scale}
              active={active}
              overlays={overlays}
              sounds={sounds}
              captions={captionNow}
              resolveSrc={resolveSrc}
              videoRef={videoRef}
              overlayVideos={overlayVideos}
              audioEls={audioEls}
              sel={state.sel}
              onSelectOverlay={selectOverlay}
              onMediaError={(code, src) => {
                // MEDIA_ERR_ABORTED (1): the element was torn down (segment
                // switch, panel unmount) — a lifecycle event, not a verdict
                // about the codec. Reporting it painted false alarms.
                if (code === 1) return
                setMediaIssue({ key: 'ov.player.mediaErrSrc', params: { name: nameForSrc(src), code } })
              }}
              onMediaMetadata={(v, trimStart) => {
                // Paint the first frame even while paused (some browsers keep a
                // fresh element black until something seeks it), and clear any
                // stale decode complaint once metadata actually arrives.
                setMediaIssue(null)
                if (v.paused && v.duration > 0) {
                  v.currentTime = Math.min(trimStart + 0.01, Math.max(0, v.duration - 0.02))
                }
              }}
              emptyText={t('ov.player.empty')}
              issueText={mediaIssue !== null ? t(mediaIssue.key, mediaIssue.params) : null}
            />
          </div>
        )}
      </div>

      {draft !== null && (
        <TransportBar
          playing={state.playing}
          onTogglePlay={() => store.setPlaying(!state.playing)}
          playhead={playhead}
          total={total}
          onSeek={(tt) => store.setPlayhead(tt)}
          diagTitle="readyState/networkState/error/currentTime/videoWidth + store verdicts"
          onDiag={() => {
            const v = videoRef.current
            setDiag(JSON.stringify({
              activeSrc: active?.el.src ?? null,
              activeDur: active?.dur ?? null,
              assetUrl: active !== undefined ? resolveSrc(active.el.src) : null,
              video: v === null
                ? null
                : {
                  readyState: v.readyState,
                  networkState: v.networkState,
                  error: v.error === null ? null : { code: v.error.code, message: v.error.message },
                  paused: v.paused,
                  currentTime: v.currentTime,
                  videoWidth: v.videoWidth,
                  videoHeight: v.videoHeight,
                  currentSrc: v.currentSrc,
                },
              playhead: state.playhead,
              playing: state.playing,
              durations: state.durations,
              decodeState: state.decodeState,
              mediaIssue,
            }, null, 2))
          }}
          labels={{
            play: t('ov.player.play'),
            pause: t('ov.player.pause'),
            time: (cur, tot) => t('ov.player.time', { cur, total: tot }),
            diag: t('ov.player.diag'),
          }}
        />
      )}

      {diag !== null && <pre className="ov-json">{diag}</pre>}

      {draft !== null && (
        <ExportBar
          exportState={exportState}
          disabled={total <= 0}
          onExport={() => void runExport()}
          onCancel={() => exportAbort.current?.abort()}
          onSaveToLibrary={() => {
            const blob = exportBlob.current
            if (blob === null) return
            void store
              .uploadBlob(blob, `${projectName || 'openvideo'}-export.${exportState.ext ?? 'webm'}`)
              .then(() => setSavedExport(true))
              .catch(() => {})
          }}
          saved={savedExport}
          downloadName={`${projectName || 'openvideo'}-export.${exportState.ext ?? 'webm'}`}
          labels={{
            export: t('ov.player.export'),
            exporting: (pct) => t('ov.player.exporting', { pct }),
            cancel: t('ov.player.exportCancel'),
            done: (size) => t('ov.player.exportDone', { size }),
            download: t('ov.player.exportDownload'),
            saveToLibrary: t('ov.player.exportSaveToLibrary'),
            failedFallback: t('ov.player.exportFailed', { error: '' }),
          }}
        />
      )}
    </div>
  )
}
