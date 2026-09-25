// @openvideo/ui-shell — client plugin: mounts the PRODUCT shell (projects
// home + four-pane editor grid) into #root.
//
// The roster's shell slot is DATA (the bundle manifest names it), so the
// product ships its own shell without the base knowing: same contract as
// @mediabase/ui-web — inject ['ui','i18n'], render whatever ctx.ui holds by
// area, brand through row config (`title`) — just an editor-shaped layout
// derived from the upstream app (MIT, attributed in App.tsx/styles.css).

import { createRoot } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import { parse, z, type Schema } from '@mediabase/schema'
import type {} from '@mediabase/i18n'
import type {} from '@mediabase/ui'
import { SHELL_MESSAGES } from './messages.ts'
import { Shell } from './App.tsx'

export const name = 'ui-shell'

/** `ui` for the panel registry, `i18n` for the shell's own text. */
export const inject = ['ui', 'i18n'] as const

export interface UiShellConfig {
  /** Product name shown in the top bar. */
  title?: string
}

export const Config: Schema<UiShellConfig, UiShellConfig> = z.object({
  title: z.string().default('OpenVideo'),
})

export function apply(ctx: Context, rawConfig: UiShellConfig): void {
  const config = parse(Config, rawConfig ?? {})
  for (const [locale, messages] of Object.entries(SHELL_MESSAGES)) {
    ctx.i18n.addMessages(locale, messages)
  }

  const el = document.getElementById('root')
  if (el === null) throw new Error('#root element missing')
  const root = createRoot(el)
  root.render(<Shell ctx={ctx} title={config.title ?? 'OpenVideo'} />)
  ctx.effect(() => () => root.unmount(), `${name}: react root`)
}
