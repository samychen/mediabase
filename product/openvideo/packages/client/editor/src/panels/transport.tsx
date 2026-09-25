// Transport + export bars: the controls under the stage. Split from the
// player panel so each concern reads on its own — the clock in
// use-master-clock.ts, the frame in stage.tsx, the controls here, and the
// orchestration (state, sync effects, export run) in player.tsx.

import type { ReactElement } from 'react'
import { fmtTime } from '@openvideo/edl'
import { IconActivity, IconDownload, IconPause, IconPlay, IconX } from '../icons.tsx'

export interface ExportState {
  phase: 'idle' | 'recording' | 'done' | 'error'
  fraction: number
  url?: string
  size?: number
  ext?: string
  error?: string
}

export const IDLE_EXPORT: ExportState = { phase: 'idle', fraction: 0 }

export interface TransportBarProps {
  playing: boolean
  onTogglePlay: () => void
  playhead: number
  total: number
  onSeek: (t: number) => void
  diagTitle: string
  onDiag: () => void
  labels: { play: string; pause: string; time: (cur: string, total: string) => string; diag: string }
}

export function TransportBar(p: TransportBarProps): ReactElement {
  return (
    <div className="ov-transport">
      <button onClick={p.onTogglePlay} disabled={p.total <= 0}>
        {p.playing ? <IconPause size={13} /> : <IconPlay size={13} />}
        {p.playing ? p.labels.pause : p.labels.play}
      </button>
      <span className="ov-time">{p.labels.time(fmtTime(p.playhead), fmtTime(p.total))}</span>
      <button className="secondary ov-mini" title={p.diagTitle} onClick={p.onDiag}>
        <IconActivity size={13} />{p.labels.diag}
      </button>
      <input
        className="ov-seek"
        type="range"
        min={0}
        max={Math.max(0.01, p.total)}
        step={0.01}
        value={Math.min(p.playhead, p.total)}
        onChange={(e) => p.onSeek(parseFloat(e.target.value))}
      />
    </div>
  )
}

export interface ExportBarProps {
  exportState: ExportState
  disabled: boolean
  onExport: () => void
  onCancel: () => void
  onSaveToLibrary: () => void
  saved: boolean
  downloadName: string
  labels: {
    export: string
    exporting: (pct: number) => string
    cancel: string
    done: (size: string) => string
    download: string
    saveToLibrary: string
    failedFallback: string
  }
}

export function ExportBar(p: ExportBarProps): ReactElement {
  const s = p.exportState
  return (
    <div className="ov-export">
      <button onClick={p.onExport} disabled={s.phase === 'recording' || p.disabled}>
        <IconDownload size={13} />{p.labels.export}
      </button>
      {s.phase === 'recording' && (
        <>
          <span className="status">{p.labels.exporting(Math.round(s.fraction * 100))}</span>
          <button className="secondary" onClick={p.onCancel}>
            <IconX size={12} />{p.labels.cancel}
          </button>
        </>
      )}
      {s.phase === 'done' && s.url !== undefined && (
        <span className="ov-export-done">
          <span className="status">{p.labels.done(`${((s.size ?? 0) / 1e6).toFixed(1)} MB`)}</span>
          <a href={s.url} download={p.downloadName}>
            <button className="secondary"><IconDownload size={13} />{p.labels.download}</button>
          </a>
          {!p.saved && (
            <button className="secondary" onClick={p.onSaveToLibrary}>
              {p.labels.saveToLibrary}
            </button>
          )}
        </span>
      )}
      {s.phase === 'error' && (
        <span className="status ov-error">{s.error ?? p.labels.failedFallback}</span>
      )}
    </div>
  )
}
