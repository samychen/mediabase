// @vhl/ui-highlight — client plugin: the two highlight panels.
//
// Registered into ctx.ui (the shell renders them — no shell edit), every string
// in messages.ts, host calls over ctx.rpc, the clip fetched from the host's
// data-plane route through ctx.net (token included). One store behind both
// panels, so the control form and the result view can never disagree about
// which job is current.

import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type {} from '@mediabase/connection'
import type {} from '@mediabase/i18n'
import type {} from '@mediabase/ui'
import { HIGHLIGHT_MESSAGES } from './messages.ts'
import { createHighlightStore, type HighlightStore } from './store.ts'
import { ControlPanel } from './panels/control.tsx'
import { ResultPanel } from './panels/result.tsx'
import './styles.css'

export type { HighlightState, HighlightStore, JobView, Media, Models, Segment } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The VHL store (provided by this plugin, shared by its panels). */
    highlightEditor: HighlightStore
  }
}

export const name = 'vhl-highlight'

/** ui/i18n to register into, rpc/net to talk to the host. */
export const inject = ['ui', 'i18n', 'rpc', 'net'] as const

/** Panels may render nothing until the store exists; the registry wants an element. */
const asPanel = (
  component: (props: { ctx: Context }) => ReactElement | null,
): ((props: { ctx: Context }) => ReactElement) => (props) => component(props) ?? <></>

export function apply(ctx: Context): void {
  for (const [locale, messages] of Object.entries(HIGHLIGHT_MESSAGES)) {
    ctx.i18n.addMessages(locale, messages)
  }

  const store = createHighlightStore(ctx)
  ctx.reflect.provide('highlightEditor', store)

  ctx.ui.register({
    id: 'vhl.control',
    title: 'Highlights',
    titleKey: 'vhl.control.title',
    area: 'sidebar',
    order: 10,
    component: asPanel(ControlPanel),
  })
  ctx.ui.register({
    id: 'vhl.result',
    title: 'Segments',
    titleKey: 'vhl.result.title',
    area: 'monitor',
    order: 10,
    component: asPanel(ResultPanel),
  })

  ctx.effect(() => () => store.dispose(), `${name}: store`)

  // First paint: the registry may already hold jobs from an earlier session in
  // this process, and the engine diagnostics tell the form whether a model
  // stack is present. Both are best-effort — the form works without them.
  void store.refresh()
  void store.loadDiagnostics()
}
