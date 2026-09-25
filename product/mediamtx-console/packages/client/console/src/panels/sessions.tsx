// Sessions (bottom area): every viewer/publisher across the eight protocols
// MediaMTX speaks, normalized into one table, with a kick button where the
// server supports it. This is the panel operators open when "who's on my
// stream?" — the host already folded the per-protocol shapes into SessionRow.

import { useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'
import { fmtBytes, shortId } from '../format.ts'
import { IconKick } from '../icons.tsx'

export function SessionsPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const cons = useConsole(ctx)
  const { t } = useI18n(ctx)
  const [feedback, setFeedback] = useState<string | null>(null)
  if (cons === null) return null
  const { store, snap } = cons

  const onKick = (kind: string, id: string): void => {
    void store.kickSession(kind as never, id)
      .then(() => setFeedback(t('sessions.kicked', { id: shortId(id) })))
      .catch((e: unknown) => setFeedback(e instanceof Error ? e.message : String(e)))
  }

  return (
    <section className="mx-sessions">
      <h3 className="mx-h">{t('panel.sessions.title')} ({snap.sessions.length})</h3>
      {feedback !== null && <p className="mx-dim">{feedback}</p>}
      {snap.sessions.length === 0
        ? <p className="mx-dim">{t('sessions.empty')}</p>
        : (
            <table className="mx-table mx-table--dense">
              <thead>
                <tr>
                  <th>kind</th>
                  <th>id</th>
                  <th>path</th>
                  <th>remote</th>
                  <th>detail</th>
                  <th>bytes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {snap.sessions.map((session) => (
                  <tr key={`${session.kind}:${session.id}`}>
                    <td><span className="mx-kind">{session.kind}</span></td>
                    <td className="mx-mono" title={session.id}>{shortId(session.id)}</td>
                    <td>{session.path ?? '—'}</td>
                    <td className="mx-mono">{session.remoteAddr || '—'}</td>
                    <td className="mx-dim">{session.detail ?? '—'}</td>
                    <td>{session.bytes !== null ? fmtBytes(session.bytes) : '—'}</td>
                    <td>
                      {session.kickable && (
                        <button
                          type="button"
                          className="mx-btn mx-btn--icon mx-btn--danger"
                          title={t('sessions.kick')}
                          onClick={() => onKick(session.kind, session.id)}
                        >
                          <IconKick />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </section>
  )
}
