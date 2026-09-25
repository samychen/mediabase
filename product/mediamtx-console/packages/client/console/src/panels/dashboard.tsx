// Dashboard: server identity, the listener map (where ingest/playback live),
// and the metrics tiles. Read-only — the actions live in the streams and
// sessions panels, right next to the rows they affect.

import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'
import { fmtBytes } from '../format.ts'

export function DashboardPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const cons = useConsole(ctx)
  const { t } = useI18n(ctx)
  if (cons === null) return null
  const { snap } = cons

  const endpoints = snap.endpoints
  const metrics = snap.metrics
  const traffic = metrics !== null
    ? metrics.perPath.reduce((acc, p) => ({ in: acc.in + p.inboundBytes, out: acc.out + p.outboundBytes }), { in: 0, out: 0 })
    : null

  const listeners: Array<[string, string | null]> = endpoints !== null
    ? [
        ['WebRTC (WHEP)', endpoints.webrtc],
        ['HLS', endpoints.hls],
        ['RTSP', endpoints.rtsp],
        ['RTMP', endpoints.rtmp],
        ['SRT', endpoints.srt],
        ['Metrics', endpoints.metrics],
        ['Playback', endpoints.playback],
      ]
    : []

  return (
    <section className="mx-dashboard">
      <div className="mx-cards">
        <div className="mx-card">
          <span className="mx-card__label">{t('server.version')}</span>
          <span className="mx-card__value">{snap.info?.version ?? '—'}</span>
          {snap.info !== null && (
            <span className="mx-card__sub">{t('server.started')} {new Date(snap.info.started).toLocaleString()}</span>
          )}
        </div>
        <div className="mx-card">
          <span className="mx-card__label">{t('metrics.ready')}</span>
          <span className="mx-card__value" data-state="ok">{metrics?.pathsReady ?? 0}</span>
          <span className="mx-card__sub">{t('metrics.notReady')}: {metrics?.pathsNotReady ?? 0}</span>
        </div>
        <div className="mx-card">
          <span className="mx-card__label">{t('metrics.readers')}</span>
          <span className="mx-card__value">{metrics?.totalReaders ?? 0}</span>
        </div>
        <div className="mx-card">
          <span className="mx-card__label">{t('metrics.traffic')}</span>
          <span className="mx-card__value mx-card__value--sm">
            {traffic !== null ? `↓ ${fmtBytes(traffic.in)} · ↑ ${fmtBytes(traffic.out)}` : '—'}
          </span>
        </div>
      </div>

      <h3 className="mx-h">{t('server.listeners')}</h3>
      <table className="mx-table">
        <tbody>
          {listeners.map(([label, url]) => (
            <tr key={label}>
              <td className="mx-table__label">{label}</td>
              <td>
                {url !== null
                  ? <code className="mx-mono">{url}</code>
                  : <span className="mx-dim">disable</span>}
              </td>
            </tr>
          ))}
          <tr>
            <td className="mx-table__label">API</td>
            <td>{snap.info !== null ? <code className="mx-mono">{snap.info.apiBase}</code> : '—'}</td>
          </tr>
        </tbody>
      </table>

      {!snap.ready && snap.error !== null && (
        <p className="mx-error">{t('common.error', { detail: snap.error })}</p>
      )}
    </section>
  )
}
