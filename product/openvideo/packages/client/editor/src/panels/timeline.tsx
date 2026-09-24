// Timeline panel (monitor): the cut, laid out on one output clock.
//
// The main track is chips in play order (the sequence IS the array); overlay
// and audio tracks float by startTime. Every gesture is a pure transform over
// the draft — the structural ones go through the SAME checked operations an
// agent calls (`applyOp` from @openvideo/edl), so a button and a sentence
// produce identical documents. Saves are the store's debounced update.

import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { applyOp, fmtTime, mainSegments, rid, splitClip, totalDuration } from '@openvideo/edl'
import { useEditor } from '../use-editor.ts'

const MIN_PPS = 8
const MAX_PPS = 400

export function TimelinePanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useEditor(ctx)
  const { t } = useI18n(ctx)
  const [pps, setPps] = useState(48)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [textForm, setTextForm] = useState<{ open: boolean; text: string; start: string; seconds: string }>({
    open: false,
    text: '',
    start: '0',
    seconds: '3',
  })
  const [audioPicker, setAudioPicker] = useState(false)

  if (editor === null) return null
  const { store, state } = editor
  const draft = state.draft
  const assets = state.assets

  const segments = useMemo(
    () => (draft === null ? [] : mainSegments(draft, (src) => state.durations[src])),
    [draft, state.durations],
  )
  const total = totalDuration(segments)
  const laneWidth = Math.max((total + 5) * pps, 300)

  const nameOf = (src: string): string => {
    if (!src.startsWith('asset:')) return src
    return assets.find((a) => a.id === src.slice(6))?.name ?? src.slice(6, 12)
  }

  if (draft === null) return <div className="ov-timeline"><div className="status">{t('ov.inspector.noProject')}</div></div>

  const seekFromEvent = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    store.setPlayhead(Math.max(0, (e.clientX - rect.left) / pps))
  }

  const addText = (): void => {
    const start = Number(textForm.start) || 0
    const seconds = Number(textForm.seconds) || 3
    if (textForm.text.trim() === '') return
    store.setDraft((d) => {
      applyOp(d, 'add_text', { text: textForm.text, start, seconds })
    })
    setTextForm({ open: false, text: '', start: String(Math.round((start + seconds) * 10) / 10), seconds: '3' })
  }

  return (
    <div className="ov-timeline">
      <div className="ov-toolbar">
        <button className="secondary ov-mini" title={t('ov.timeline.zoomOut')} onClick={() => setPps((p) => Math.max(MIN_PPS, Math.round(p / 1.4)))}>−</button>
        <button className="secondary ov-mini" title={t('ov.timeline.zoomIn')} onClick={() => setPps((p) => Math.min(MAX_PPS, Math.round(p * 1.4)))}>＋</button>
        <button
          className="secondary"
          title={t('ov.timeline.split')}
          onClick={() => {
            if (!store.splitAtPlayhead()) store.flash('ov.status.splitFailed')
          }}
        >
          ✂ {t('ov.timeline.split')}
        </button>
        <button className="secondary" disabled={state.undoDepth === 0} onClick={() => store.undo()}>↩ {t('ov.timeline.undo')}</button>
        <button className="secondary" disabled={state.redoDepth === 0} onClick={() => store.redo()}>↪ {t('ov.timeline.redo')}</button>
        <button className="secondary" disabled={!state.dirty || state.saving} onClick={() => void store.saveNow()}>
          {t('ov.timeline.save')}
        </button>
        <span className="ov-save-state">
          {state.saveError !== null
            ? <span className="ov-error">{t('ov.timeline.saveError', { error: state.saveError })}</span>
            : state.saving
              ? t('ov.timeline.saving')
              : state.dirty
                ? t('ov.timeline.unsaved')
                : t('ov.timeline.saved')}
        </span>
      </div>

      <div className="ov-lanes">
        {/* ruler: click to seek */}
        <div className="ov-lane ov-ruler">
          <div className="ov-lane-label">{fmtTime(total)}</div>
          <div className="ov-lane-content" style={{ width: laneWidth }} onClick={seekFromEvent}>
            <div className="ov-playhead" style={{ left: state.playhead * pps }} />
          </div>
        </div>

        {/* main track */}
        <div className="ov-lane">
          <div className="ov-lane-label">{t('ov.timeline.main')}</div>
          <div
            className="ov-lane-content"
            style={{ width: laneWidth }}
            onClick={seekFromEvent}
          >
            {segments.map((seg) => {
              const el = seg.el
              const selected = state.sel?.kind === 'main' && state.sel.index === seg.i
              const width = Math.max(seg.dur * pps, 26)
              return (
                <div
                  key={el.id}
                  className={selected ? 'ov-chip ov-chip-main ov-chip-selected' : 'ov-chip ov-chip-main'}
                  style={{ left: seg.start * pps, width }}
                  draggable
                  onDragStart={() => setDragIndex(seg.i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const from = dragIndex
                    setDragIndex(null)
                    if (from === null || from === seg.i) return
                    store.setDraft((d) => {
                      applyOp(d, 'move_clip', { clip: from, to: seg.i })
                    })
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    store.select({ kind: 'main', index: seg.i })
                  }}
                >
                  <span className="ov-chip-name" title={nameOf(el.src)}>{nameOf(el.src)}</span>
                  <span className="ov-chip-sub">
                    {seg.dur > 0 ? `${seg.dur.toFixed(1)}s` : t('ov.timeline.clipUnknown')}
                  </span>
                  <span className="ov-chip-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="ov-mini"
                      title={t('ov.timeline.moveLeft')}
                      disabled={seg.i === 0}
                      onClick={() => store.setDraft((d) => { applyOp(d, 'move_clip', { clip: seg.i, to: seg.i - 1 }) })}
                    >
                      ◀
                    </button>
                    <button
                      className="ov-mini"
                      title={t('ov.timeline.split')}
                      onClick={() => {
                        store.setPlayhead(seg.start + seg.dur / 2)
                        const at = seg.dur / 2
                        store.setDraft((d) => {
                          const clip = d.main.elements[seg.i]
                          if (clip === undefined) return
                          const halves = splitClip(clip, at, seg.dur, rid())
                          if (halves !== null) d.main.elements.splice(seg.i, 1, ...halves)
                        })
                      }}
                    >
                      ✂
                    </button>
                    <button
                      className="ov-mini"
                      title={t('ov.timeline.moveRight')}
                      disabled={seg.i === draft.main.elements.length - 1}
                      onClick={() => store.setDraft((d) => { applyOp(d, 'move_clip', { clip: seg.i, to: seg.i + 1 }) })}
                    >
                      ▶
                    </button>
                    <button
                      className="ov-mini ov-mini-danger"
                      title={t('ov.timeline.delete')}
                      onClick={() => store.setDraft((d) => { applyOp(d, 'delete_clip', { clip: seg.i }) })}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              )
            })}
            <div className="ov-playhead" style={{ left: state.playhead * pps }} />
          </div>
        </div>

        {/* overlay tracks */}
        {(draft.overlays ?? []).map((track, ti) => (
          <div className="ov-lane" key={track.id}>
            <div className="ov-lane-label">
              {t('ov.timeline.overlays')}
              <button
                className="ov-mini"
                title={track.hidden === true ? t('ov.timeline.showTrack') : t('ov.timeline.hideTrack')}
                onClick={() => store.setDraft((d) => {
                  const target = d.overlays?.[ti]
                  if (target !== undefined) target.hidden = target.hidden !== true
                })}
              >
                {track.hidden === true ? '◌' : '●'}
              </button>
            </div>
            <div className="ov-lane-content" style={{ width: laneWidth, opacity: track.hidden === true ? 0.4 : 1 }} onClick={seekFromEvent}>
              {track.elements.map((el, ei) => {
                const selected = state.sel?.kind === 'overlay' && state.sel.track === ti && state.sel.index === ei
                return (
                  <div
                    key={el.id}
                    className={selected ? 'ov-chip ov-chip-overlay ov-chip-selected' : 'ov-chip ov-chip-overlay'}
                    style={{ left: el.startTime * pps, width: Math.max(el.duration * pps, 26) }}
                    onClick={(e) => {
                      e.stopPropagation()
                      store.select({ kind: 'overlay', track: ti, index: ei })
                    }}
                  >
                    <span className="ov-chip-name">
                      {el.type === 'text' ? `“${el.text.slice(0, 24)}”` : `${el.type === 'image' ? '🖼' : '🎬'} ${nameOf(el.src)}`}
                    </span>
                    <span className="ov-chip-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="ov-mini ov-mini-danger"
                        title={t('ov.timeline.delete')}
                        onClick={() => store.setDraft((d) => {
                          d.overlays?.[ti]?.elements.splice(ei, 1)
                        })}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                )
              })}
              <div className="ov-playhead" style={{ left: state.playhead * pps }} />
            </div>
          </div>
        ))}

        {/* audio tracks */}
        {(draft.audio ?? []).map((track, ti) => (
          <div className="ov-lane" key={track.id}>
            <div className="ov-lane-label">
              {t('ov.timeline.audio')}
              <button
                className="ov-mini"
                title={track.muted === true ? t('ov.timeline.unmuteTrack') : t('ov.timeline.muteTrack')}
                onClick={() => store.setDraft((d) => {
                  const target = d.audio?.[ti]
                  if (target !== undefined) target.muted = target.muted !== true
                })}
              >
                {track.muted === true ? '🔇' : '🔊'}
              </button>
            </div>
            <div className="ov-lane-content" style={{ width: laneWidth, opacity: track.muted === true ? 0.4 : 1 }} onClick={seekFromEvent}>
              {track.elements.map((el, ei) => {
                const selected = state.sel?.kind === 'audio' && state.sel.track === ti && state.sel.index === ei
                const dur = el.duration ?? Math.max(0, (state.durations[el.src] ?? 0) - (el.trimStart ?? 0))
                return (
                  <div
                    key={el.id}
                    className={selected ? 'ov-chip ov-chip-audio ov-chip-selected' : 'ov-chip ov-chip-audio'}
                    style={{ left: el.startTime * pps, width: Math.max(dur * pps, 26) }}
                    onClick={(e) => {
                      e.stopPropagation()
                      store.select({ kind: 'audio', track: ti, index: ei })
                    }}
                  >
                    <span className="ov-chip-name">♪ {nameOf(el.src)}</span>
                    <span className="ov-chip-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="ov-mini ov-mini-danger"
                        title={t('ov.timeline.delete')}
                        onClick={() => store.setDraft((d) => {
                          d.audio?.[ti]?.elements.splice(ei, 1)
                        })}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                )
              })}
              <div className="ov-playhead" style={{ left: state.playhead * pps }} />
            </div>
          </div>
        ))}
      </div>

      <div className="ov-toolbar">
        <button className="secondary" onClick={() => setTextForm((f) => ({ ...f, open: !f.open }))}>＋ {t('ov.timeline.addText')}</button>
        <button className="secondary" onClick={() => setAudioPicker((v) => !v)}>＋ {t('ov.timeline.addAudio')}</button>
      </div>

      {textForm.open && (
        <div className="ov-form">
          <label>
            {t('ov.timeline.textLabel')}
            <input type="text" value={textForm.text} onChange={(e) => setTextForm((f) => ({ ...f, text: e.target.value }))} />
          </label>
          <label>
            {t('ov.timeline.textStart')}
            <input type="number" min="0" step="0.1" value={textForm.start} onChange={(e) => setTextForm((f) => ({ ...f, start: e.target.value }))} />
          </label>
          <label>
            {t('ov.timeline.textSeconds')}
            <input type="number" min="0.05" step="0.1" value={textForm.seconds} onChange={(e) => setTextForm((f) => ({ ...f, seconds: e.target.value }))} />
          </label>
          <div className="ov-row">
            <button onClick={addText} disabled={textForm.text.trim() === ''}>{t('ov.timeline.confirm')}</button>
            <button className="secondary" onClick={() => setTextForm((f) => ({ ...f, open: false }))}>{t('ov.timeline.cancel')}</button>
          </div>
        </div>
      )}

      {audioPicker && (
        <div className="ov-form">
          {assets.filter((a) => a.contentType.startsWith('audio/')).length === 0 && (
            <div className="status">{t('ov.media.empty')}</div>
          )}
          {assets.filter((a) => a.contentType.startsWith('audio/')).map((asset) => (
            <button
              key={asset.id}
              className="secondary ov-row-button"
              onClick={() => {
                store.addAssetToAudio(asset)
                setAudioPicker(false)
              }}
            >
              ♪ {asset.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
