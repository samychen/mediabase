// The header panel: one line that says what just happened, and whether the
// open cut is saved. The header area renders inline in the shell's title row,
// so this stays a single <span> — no layout of its own.

import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useEditor } from '../use-editor.ts'

export function StatusPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useEditor(ctx)
  const { t } = useI18n(ctx)
  if (editor === null) return null
  const { state } = editor

  const status = state.status
  const text = status !== null
    ? t(status.key, status.params)
    : state.saveError !== null
      ? t('ov.timeline.saveError', { error: state.saveError })
      : state.saving
        ? t('ov.timeline.saving')
        : state.dirty
          ? t('ov.timeline.unsaved')
          : state.openId !== null
            ? t('ov.timeline.saved')
            : t('ov.status.none')

  return (
    <span className="ov-status" data-state={state.saveError !== null ? 'error' : state.dirty ? 'dirty' : 'ok'}>
      {state.openId !== null && <span className="ov-status-project">{state.projectName}</span>}
      {text}
    </span>
  )
}
