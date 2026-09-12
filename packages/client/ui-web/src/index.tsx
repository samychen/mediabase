// @mediabase/ui-web — client plugin: mounts the React shell.
//
// inject: ['ui'] -> renders <App/> into #root. The shell renders only panels
// registered into ctx.ui, so it stays capability-agnostic: compose the shell
// after your UI capability packages (see apps/web/src/main.tsx) and their panels
// appear without any shell edit. Registration is reactive (ctx.ui.subscribe), so
// panels registered after mount render too.
//
// Branding is CONFIG (`title`), not a hard-coded product name: the base defaults
// to "Mediabase"; a product roster row passes its own title.

import { createRoot } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import { z, type Infer } from '@mediabase/schema'
import type {} from '@mediabase/ui'
import { SHELL_MESSAGES } from './messages.ts'
import { App } from './App.tsx'

export const name = 'ui-web'

/** `ui` to render panels, `i18n` for the shell's own text. */
export const inject = ['ui', 'i18n'] as const

export const Config = z.object({
  /** Window / chrome product name shown in the shell header. */
  title: z.string().default('Mediabase'),
})

export type UiWebConfig = Infer<typeof Config>

export function apply(ctx: Context, config: UiWebConfig): void {
  for (const [locale, messages] of Object.entries(SHELL_MESSAGES)) {
    ctx.i18n.addMessages(locale, messages)
  }

  const el = document.getElementById('root')
  if (!el) throw new Error('#root element missing')
  const root = createRoot(el)
  root.render(<App ctx={ctx} title={config.title} />)
  ctx.effect(() => () => root.unmount(), `${name}: react root`)
}
