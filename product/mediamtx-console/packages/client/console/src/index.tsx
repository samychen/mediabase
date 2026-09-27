// @mtxconsole/ui-console — client plugin: the MediaMTX console panels.
//
// Clean-room: features were derived from MediaMTX's own API surface (observed
// against a running v1.21 server, MIT) and from the reference project's README
// at requirements level only — no code was read or copied. Panels follow this
// repo's contract: registered into ctx.ui (the shell renders them — no shell
// edit), every string in messages.ts, host calls over ctx.rpc, and ONE shared
// store so seven panels poll the server once.

import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
// Type-only: rpc is declared by @mediabase/connection, panels by @mediabase/ui.
import type {} from '@mediabase/connection'
import type {} from '@mediabase/i18n'
import type {} from '@mediabase/ui'
import { messages } from './messages.ts'
import { createConsoleStore, type ConsoleStore } from './store.ts'
import { StatusPanel } from './panels/status.tsx'
import { DashboardPanel } from './panels/dashboard.tsx'
import { StreamsPanel } from './panels/streams.tsx'
import { PlayerPanel } from './panels/player.tsx'
import { SyncPanel } from './panels/sync.tsx'
import { SessionsPanel } from './panels/sessions.tsx'
import { RecordingsPanel } from './panels/recordings.tsx'
import './styles.css'

export type { ConsoleSnapshot, ConsoleStore } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The console store (provided by this plugin, shared by its panels). */
    mtxConsole: ConsoleStore
  }
}

export const name = 'mediamtx-console'

/** ui/i18n to register into, rpc to talk to the host bridge. */
export const inject = ['ui', 'i18n', 'rpc'] as const

/** Panels may render nothing until the store exists; the registry wants an element. */
const asPanel = (
  component: (props: { ctx: Context }) => ReactElement | null,
): ((props: { ctx: Context }) => ReactElement) => (props) => component(props) ?? <></>

export function apply(ctx: Context): void {
  for (const [locale, table] of Object.entries(messages)) {
    ctx.i18n.addMessages(locale, table)
  }

  const store = createConsoleStore(ctx.rpc)
  ctx.reflect.provide('mtxConsole', store)

  // The poll loop is a side effect with a lifetime: it stops with the plugin.
  ctx.effect(() => {
    store.start()
    return () => store.stop()
  }, 'mtx-console-poll')

  // Areas: identity in the header, server overview + preview + the sync wall
  // on the monitor (dashboard, player, sync playback top to bottom), the
  // roster in the sidebar, recordings in the right column, sessions in the
  // bottom drawer.
  ctx.ui.register({ id: 'mtx.status', title: '', area: 'header', order: 10, component: asPanel(StatusPanel) })
  ctx.ui.register({ id: 'mtx.dashboard', title: 'Dashboard', titleKey: 'panel.dashboard.title', area: 'monitor', order: 10, component: asPanel(DashboardPanel) })
  ctx.ui.register({ id: 'mtx.player', title: 'Player', titleKey: 'panel.player.title', area: 'monitor', order: 20, component: asPanel(PlayerPanel) })
  ctx.ui.register({ id: 'mtx.sync', title: 'Sync playback', titleKey: 'panel.sync.title', area: 'monitor', order: 30, component: asPanel(SyncPanel) })
  ctx.ui.register({ id: 'mtx.streams', title: 'Streams', titleKey: 'panel.streams.title', area: 'sidebar', order: 10, component: asPanel(StreamsPanel) })
  ctx.ui.register({ id: 'mtx.recordings', title: 'Recordings', titleKey: 'panel.recordings.title', area: 'right', order: 10, component: asPanel(RecordingsPanel) })
  ctx.ui.register({ id: 'mtx.sessions', title: 'Sessions', titleKey: 'panel.sessions.title', area: 'bottom', order: 10, component: asPanel(SessionsPanel) })
}
