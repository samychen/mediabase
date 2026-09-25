// Streams sidebar: the path roster with live state, plus the one form that
// makes this console a director's tool — add a pull source (a camera URL) and
// MediaMTX starts ingesting it immediately; delete takes it off air.

import { useState, type FormEvent, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'
import { fmtBytes, tracksSummary } from '../format.ts'
import { IconPlay, IconPlus, IconTrash } from '../icons.tsx'

export function StreamsPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const cons = useConsole(ctx)
  const { t } = useI18n(ctx)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [record, setRecord] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  if (cons === null) return null
  const { store, snap } = cons

  const onAdd = (event: FormEvent): void => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '' || busy) return
    setBusy(true)
    setFeedback(null)
    void store.addPath(trimmed, source === '' ? undefined : source, record)
      .then(() => {
        setFeedback({ kind: 'ok', text: t('stream.added', { name: trimmed }) })
        setName('')
        setSource('')
        setRecord(false)
      })
      .catch((e: unknown) => setFeedback({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false))
  }

  const onDelete = (pathName: string): void => {
    void store.deletePath(pathName)
      .then(() => setFeedback({ kind: 'ok', text: t('stream.deleted', { name: pathName }) }))
      .catch((e: unknown) => setFeedback({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
  }

  return (
    <section className="mx-streams">
      <form className="mx-form" onSubmit={onAdd}>
        <h3 className="mx-h">{t('stream.add')}</h3>
        <label className="mx-field">
          <span>{t('stream.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="cam3" required />
        </label>
        <label className="mx-field">
          <span>{t('stream.source')}</span>
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder={t('stream.sourcePlaceholder')} />
        </label>
        <label className="mx-check">
          <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
          <span>{t('stream.record')}</span>
        </label>
        <button type="submit" className="mx-btn mx-btn--primary" disabled={busy || name.trim() === ''}>
          <IconPlus /> {t('stream.add')}
        </button>
        <p className="mx-hint">{t('stream.add.hint')}</p>
        {feedback !== null && (
          <p className={feedback.kind === 'ok' ? 'mx-ok' : 'mx-error'}>{feedback.text}</p>
        )}
      </form>

      <h3 className="mx-h">{t('panel.streams.title')} ({snap.paths.length})</h3>
      {snap.paths.length === 0 && <p className="mx-dim">{t('stream.empty')}</p>}
      <ul className="mx-list">
        {snap.paths.map((path) => (
          <li
            key={path.name}
            className="mx-row"
            data-selected={snap.selected === path.name ? 'true' : undefined}
          >
            <button
              type="button"
              className="mx-row__main"
              onClick={() => store.select(path.name)}
              title={path.source ?? undefined}
            >
              <span className="mx-row__name">{path.name}</span>
              <span className="mx-badge" data-state={path.ready ? 'ready' : 'idle'}>
                {path.ready ? t('stream.state.ready') : t('stream.state.idle')}
              </span>
              <span className="mx-row__meta">
                {t('stream.viewers')} {path.readers} · {tracksSummary(path.tracks)}
                {path.ready && ` · ↓${fmtBytes(path.inboundBytes)} ↑${fmtBytes(path.outboundBytes)}`}
                {path.record && ' · REC'}
              </span>
            </button>
            <span className="mx-row__actions">
              <button
                type="button"
                className="mx-btn mx-btn--icon"
                title={t('stream.play')}
                disabled={!path.ready}
                onClick={() => store.select(path.name)}
              >
                <IconPlay />
              </button>
              <button
                type="button"
                className="mx-btn mx-btn--icon mx-btn--danger"
                title={t('stream.delete')}
                onClick={() => onDelete(path.name)}
              >
                <IconTrash />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
