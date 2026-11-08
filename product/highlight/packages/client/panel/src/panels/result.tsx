// The result panel (monitor area): play the finished clip, inspect the segments.
//
// The clip is served by the host's data-plane route (`/api/highlight.clip.<job>`)
// with Range support, so the <video> element streams and seeks without the
// control plane carrying a single media byte. Clicking a segment seeks the
// element — the row is a view onto the same artifact, not a second player.

import { useRef } from 'react'
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useHighlight } from '../use-highlight.ts'
import { clipOffsets } from '../timeline.ts'

export function ResultPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useHighlight(ctx)
  const { t } = useI18n(ctx)
  const video = useRef<HTMLVideoElement | null>(null)
  if (editor === null) return null
  const { store, state } = editor
  const job = state.job

  if (job === null) {
    return <div className="vhl-result"><div className="vhl-empty">{t('vhl.result.empty')}</div></div>
  }

  const playable = job.clipUrl !== '' && state.clipSrc !== ''
  // `state.clipSrc` is resolved in the store (plugin ctx); reading ctx.net here
  // would throw, because the shell renders panels with its own context.
  const src = playable ? state.clipSrc : ''
  const offsets = clipOffsets(job.segments)

  const seek = (seconds: number): void => {
    const element = video.current
    if (element === null) return
    element.currentTime = seconds
    void element.play().catch(() => undefined)
  }

  return (
    <div className="vhl-result">
      {/* Title comes from the shell (registered titleKey); this row is the count. */}
      <div className="vhl-head">
        {job.segmentCount > 0 && <span className="badge on">{job.segmentCount}</span>}
      </div>

      <div className="vhl-player">
        {playable
          ? (
            <video ref={video} controls preload="metadata" src={src}>
              {/* The host converts the engine's SRT to WebVTT on the way out, so a
                  plain <track> works in every browser. Chrome rejects SRT. */}
              {state.subtitleSrc !== '' && (
                <track
                  kind="subtitles"
                  src={state.subtitleSrc}
                  srcLang="zh"
                  label={t('vhl.result.subtitlesTrack')}
                  default
                />
              )}
            </video>
          )
          : <div className="vhl-empty">{t('vhl.result.noClip')}</div>}
      </div>

      {job.segments.length > 0 && (
        <div className="vhl-segments">
          <div className="vhl-k">{t('vhl.result.segments')}</div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>in → out</th>
                <th>{t('vhl.result.score')}</th>
                <th>{t('vhl.result.signals')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {job.segments.map((segment, index) => (
                <tr key={`${segment.startSec}-${segment.endSec}-${index}`}>
                  <td>{index + 1}</td>
                  <td>
                    {segment.startSec.toFixed(2)}s → {segment.endSec.toFixed(2)}s
                    <span className="vhl-muted"> ({(segment.endSec - segment.startSec).toFixed(2)}s)</span>
                  </td>
                  <td>{segment.score.toFixed(3)}</td>
                  <td className="vhl-signals">
                    {/* Why this window won: the engine reports every modality's
                        contribution, so the number is auditable, not magic. */}
                    {Object.entries(segment.signals).map(([name, value]) => (
                      <span key={name} className="vhl-chip">{name} {value.toFixed(2)}</span>
                    ))}
                  </td>
                  <td>
                    <button type="button" className="secondary" onClick={() => seek(offsets[index] ?? 0)}>
                      {t('vhl.result.seek')}
                    </button>
                    <span className="vhl-muted"> @{offsets[index]?.toFixed(2) ?? '0.00'}s</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="vhl-actions">
        <button
          type="button"
          className="secondary"
          disabled={job.state !== 'succeeded' || job.segments.length === 0}
          onClick={() => void store.exportEdl()}
        >
          {t('vhl.result.exportEdl')}
        </button>
      </div>

      {state.edlPath !== '' && (
        <div className="vhl-line">
          <span className="vhl-k">{t('vhl.result.edl')}</span>
          <code>{state.edlPath}</code>
        </div>
      )}

      <div className="vhl-artifacts">
        <div className="vhl-k">{t('vhl.result.artifacts')}</div>
        <div className="vhl-line"><span className="vhl-k">{t('vhl.result.clip')}</span><code>{job.output}</code></div>
        {job.reportPath !== '' && (
          <div className="vhl-line">
            <span className="vhl-k">{t('vhl.result.report')}</span>
            <code>{job.reportPath}</code>
            {/* Served as JSON by the host: the panel shows WHY each window won. */}
            {state.reportSrc !== '' && (
              <a href={state.reportSrc} target="_blank" rel="noreferrer">{t('vhl.result.open')}</a>
            )}
          </div>
        )}
        {job.srtPath !== '' && (
          <div className="vhl-line">
            <span className="vhl-k">{t('vhl.result.srt')}</span>
            <code>{job.srtPath}</code>
            {state.subtitleSrc !== '' && (
              <a href={state.subtitleSrc} target="_blank" rel="noreferrer">{t('vhl.result.open')}</a>
            )}
          </div>
        )}
      </div>

      {job.error !== '' && <div className="status vhl-error">{job.error}</div>}
    </div>
  )
}
