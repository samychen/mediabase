// @openvideo/ui-editor — client plugin: the OpenVideo editor panels.
//
// Derived from clawnify/OpenVideo src/client (MIT), rebuilt for this base's
// panel contract: six panels registered into ctx.ui (the shell renders them —
// no shell edit), every string in messages.ts, host calls over ctx.rpc, and
// asset bytes pulled from the capability's data-plane routes. One store behind
// all panels so they cannot hold divergent copies of the cut.

import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type {} from '@mediabase/connection'
import type {} from '@mediabase/i18n'
import type {} from '@mediabase/ui'
import { mainSegments, totalDuration } from '@openvideo/edl'
import { EDITOR_MESSAGES } from './messages.ts'
import { createEditorStore, type EditorStore } from './store.ts'
import { StatusPanel } from './panels/status.tsx'
import { MediaPanel } from './panels/media.tsx'
import { InspectorPanel } from './panels/inspector.tsx'
import { PlayerPanel } from './panels/player.tsx'
import { TimelinePanel } from './panels/timeline.tsx'
import './styles.css'

// The product shell (@openvideo/ui-shell) reads the store contract and borrows
// a few glyphs; re-exported here so it imports ONE package, not deep paths.
export type { AssetProxyInfo, AssetRow, EditorState, EditorStore, ProjectRow, ProjectSummary, Sel } from './store.ts'
export { IconChevronLeft, IconFilm, IconPlus, IconTrash } from './icons.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The OpenVideo editor store (provided by this plugin, shared by its panels). */
    openvideoEditor: EditorStore
  }
}

export const name = 'openvideo-editor'

/** ui/i18n to register into, rpc/net to talk to the host. */
export const inject = ['ui', 'i18n', 'rpc', 'net'] as const

/** Panels may render nothing until the store exists; the registry wants an element. */
const asPanel = (
  component: (props: { ctx: Context }) => ReactElement | null,
): ((props: { ctx: Context }) => ReactElement) => (props) => component(props) ?? <></>

export function apply(ctx: Context): void {
  for (const [locale, messages] of Object.entries(EDITOR_MESSAGES)) {
    ctx.i18n.addMessages(locale, messages)
  }

  const store = createEditorStore(ctx)
  ctx.reflect.provide('openvideoEditor', store)

  // Areas map onto the product shell's four-region grid (rail · player ·
  // inspector · timeline); the projects HOME screen lives in the shell itself.
  ctx.ui.register({ id: 'openvideo.status', title: '', area: 'header', order: 10, component: asPanel(StatusPanel) })
  ctx.ui.register({ id: 'openvideo.media', title: 'Media', titleKey: 'ov.media.title', area: 'sidebar', order: 10, component: asPanel(MediaPanel) })
  ctx.ui.register({ id: 'openvideo.player', title: 'Preview', titleKey: 'ov.player.title', area: 'monitor', order: 10, component: asPanel(PlayerPanel) })
  ctx.ui.register({ id: 'openvideo.inspector', title: 'Inspector', titleKey: 'ov.inspector.title', area: 'right', order: 10, component: asPanel(InspectorPanel) })
  ctx.ui.register({ id: 'openvideo.timeline', title: 'Timeline', titleKey: 'ov.timeline.title', area: 'bottom', order: 10, component: asPanel(TimelinePanel) })

  // The base `view` contract (@mediabase/ui): the capability that produces the
  // shared panel state provides it. While a project is open, sibling panels
  // (any monitor a future capability adds) can read what is being edited
  // without knowing this package.
  ctx.reflect.provide('view', undefined)
  let lastKey = ''
  ctx.effect(() => store.subscribe(() => {
    const s = store.get()
    const key = s.openId === null || s.draft === null
      ? ''
      : `${s.openId}|${s.projectName}|${s.draft.output.width}x${s.draft.output.height}|${s.draft.main.elements.length}`
    if (key === lastKey) return
    lastKey = key
    if (s.draft === null) {
      ctx.reflect.set('view', undefined)
      return
    }
    const duration = totalDuration(mainSegments(s.draft, (src) => s.durations[src]))
    ctx.reflect.set('view', {
      file: s.projectName,
      w: s.draft.output.width,
      h: s.draft.output.height,
      duration,
    })
  }), `${name}: view contract`)

  void store.refresh()
}
