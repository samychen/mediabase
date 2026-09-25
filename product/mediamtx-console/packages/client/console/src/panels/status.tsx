// The header panel: server identity at a glance — a dot that says whether the
// bridge reached MediaMTX, and the version once known. The header area renders
// inline in the shell's title row, so this stays a single <span>.

import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'

export function StatusPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const cons = useConsole(ctx)
  const { t } = useI18n(ctx)
  if (cons === null) return null
  const { snap } = cons

  const state = snap.ready ? 'ok' : 'down'
  const text = snap.ready && snap.info !== null
    ? `${t('panel.status.title')} ${snap.info.version}`
    : snap.ready
      ? t('panel.status.title')
      : t('server.unreachable')

  return (
    <span className="mx-status" data-state={state} title={snap.info !== null ? `${t('server.started')} ${new Date(snap.info.started).toLocaleString()}` : snap.error ?? undefined}>
      <span className="mx-status__dot" aria-hidden="true" />
      {text}
    </span>
  )
}
