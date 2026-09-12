// @mediabase/ui-web — client plugin: mounts the React shell.
//
// inject: ['ui'] -> renders <App/> into #root. The shell renders only panels
// registered into ctx.ui, so it stays capability-agnostic: compose the shell
// after your UI capability packages (see apps/web/src/main.tsx) and their panels
// appear without any shell edit. Registration is reactive (ctx.ui.subscribe), so
// panels registered after mount render too.

import { createRoot } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@mediabase/ui'
import { SHELL_MESSAGES } from './messages.ts'
import { App } from './App.tsx'

export const name = 'ui-web'

/** `ui` to render panels, `i18n` for the shell's own text. */
export const inject = ['ui', 'i18n'] as const

export function apply(ctx: Context): void {
  for (const [locale, messages] of Object.entries(SHELL_MESSAGES)) {
    ctx.i18n.addMessages(locale, messages)
  }

  const el = document.getElementById('root')
  if (!el) throw new Error('#root element missing')
  const root = createRoot(el)
  root.render(<App ctx={ctx} />)
  ctx.effect(() => () => root.unmount(), `${name}: react root`)
}
