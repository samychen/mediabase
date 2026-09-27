// Recordings (right area): browse what the server recorded and put a window
// on the player stage. Data flow: `mediamtx.recordings.list` (API server)
// yields the recorded paths; `mediamtx.playback.list` (playback server, via
// the host bridge) yields the playable windows with browser-reachable URLs;
// playback itself is browser ⇄ playback server directly (MSE, see mse.ts) —
// media bytes never touch the host, exactly like WHEP/HLS.

import { useEffect, type DragEvent as ReactDragEvent, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'
import { fmtClock, fmtDay, fmtDur } from '../format.ts'
import { IconGrid, IconHistory, IconPlay } from '../icons.tsx'
import { encodeSyncPayload, firstFreeSlot } from '../sync.ts'
import type { PlaybackEntry } from '@mtxconsole/protocol'

export function RecordingsPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const cons = useConsole(ctx)
  const { t } = useI18n(ctx)
  const store = cons?.store ?? null
  const snap = cons?.snap ?? null

  // Load the recorded-path index once per store (it grows only when a new
  // recording appears — the refresh button re-pulls it on demand).
  useEffect(() => {
    if (store !== null) void store.loadRecordingPaths()
  }, [store])

  if (cons === null || store === null || snap === null) return null

  // Play means "from here": the clicked window plus every window after it
  // form the chain the stage auto-advances through (M3 cross-window playback).
  const onPlay = (entry: PlaybackEntry): void => {
    if (entry.url === '') return
    const at = snap.recEntries.indexOf(entry)
    const playlist = snap.recEntries.slice(at < 0 ? 0 : at).filter((e) => e.url !== '')
    if (playlist.length === 0) return
    const label = `${snap.recPath ?? '?'} · ${fmtClock(entry.startIso)} · ${fmtDur(entry.durationSeconds)}`
    store.playRecording(playlist, 0, label)
  }

  // Park a CHAIN on the sync wall (M4): the clicked window plus every window
  // after it — same "from here" semantics as the main stage. First empty
  // cell; a full wall cycles back to cell 0 (a review wall replaces).
  const chainFrom = (entry: PlaybackEntry): PlaybackEntry[] => {
    const at = snap.recEntries.indexOf(entry)
    return snap.recEntries.slice(at < 0 ? 0 : at).filter((e) => e.url !== '')
  }

  const onAddSync = (entry: PlaybackEntry): void => {
    if (entry.url === '' || snap.recPath === null) return
    const entries = chainFrom(entry)
    if (entries.length === 0) return
    const free = firstFreeSlot(snap.syncSlots, snap.syncLayout)
    store.syncAssign(free >= 0 ? free : 0, { path: snap.recPath, entries })
  }

  const onDragStart = (e: ReactDragEvent, entry: PlaybackEntry): void => {
    if (entry.url === '' || snap.recPath === null) {
      e.preventDefault()
      return
    }
    const entries = chainFrom(entry)
    if (entries.length === 0) {
      e.preventDefault()
      return
    }
    e.dataTransfer.setData('text/plain', encodeSyncPayload({ path: snap.recPath, entries }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const groups = new Map<string, PlaybackEntry[]>()
  for (const entry of snap.recEntries) {
    const day = fmtDay(entry.startIso)
    const bucket = groups.get(day)
    if (bucket === undefined) groups.set(day, [entry])
    else bucket.push(entry)
  }

  return (
    <section className="mx-recordings">
      <h3 className="mx-h"><IconHistory /> {t('panel.recordings.title')}</h3>
      <div className="mx-recordings__bar">
        <select
          className="mx-select"
          value={snap.recPath ?? ''}
          onChange={(e) => void store.selectRecordingPath(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{t('recordings.pick')}</option>
          {snap.recPaths.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button
          type="button"
          className="mx-btn"
          onClick={() => {
            void store.loadRecordingPaths()
            if (snap.recPath !== null) void store.selectRecordingPath(snap.recPath)
          }}
        >
          {t('common.refresh')}
        </button>
      </div>
      {snap.recLoading && <p className="mx-dim">{t('common.loading')}</p>}
      {snap.recError !== null && <p className="mx-error">{t('common.error', { detail: snap.recError })}</p>}
      {!snap.recLoading && snap.recError === null && (
        snap.recPaths.length === 0
          ? <p className="mx-dim">{t('recordings.noPaths')}</p>
          : snap.recPath === null
            ? <p className="mx-dim">{t('recordings.pick')}</p>
            : snap.recEntries.length === 0
              ? <p className="mx-dim">{t('recordings.empty')}</p>
              : (
                  <div className="mx-recordings__days">
                    {[...groups.entries()].map(([day, entries]) => (
                      <div key={day} className="mx-recordings__day">
                        <h4 className="mx-recordings__day-title">{day}</h4>
                        <ul className="mx-list">
                          {entries.map((entry) => (
                            <li
                              key={entry.startIso}
                              className="mx-row"
                              draggable={entry.url !== ''}
                              onDragStart={(e) => onDragStart(e, entry)}
                            >
                              <span className="mx-mono">{fmtClock(entry.startIso)}</span>
                              <span className="mx-dim">{fmtDur(entry.durationSeconds)}</span>
                              <button
                                type="button"
                                className="mx-btn mx-btn--icon"
                                title={t('sync.addToSync')}
                                disabled={entry.url === ''}
                                onClick={() => onAddSync(entry)}
                              >
                                <IconGrid />
                              </button>
                              <button
                                type="button"
                                className="mx-btn mx-btn--icon"
                                title={t('recordings.playChain')}
                                disabled={entry.url === ''}
                                onClick={() => onPlay(entry)}
                              >
                                <IconPlay />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )
      )}
    </section>
  )
}
