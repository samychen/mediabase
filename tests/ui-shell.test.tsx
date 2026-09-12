// @vitest-environment jsdom
//
// Shell (<App/>) rendering test — the shell must render whatever ctx.ui holds,
// from ANY capability package, and must re-render panels registered AFTER it
// mounted (the reason ctx.ui carries subscribe/revision at all). No capability
// package is composed here: the panels below stand in for one.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as i18n from '../packages/client/i18n/src/index.ts'
import * as ui from '../packages/client/ui/src/index.ts'
import type { UiService } from '../packages/client/ui/src/index.ts'
import { SHELL_MESSAGES } from '../packages/client/ui-web/src/messages.ts'
import { App } from '../packages/client/ui-web/src/App.tsx'

/** cordis activates a plugin's service on a microtask, so wait one macrotask. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** Stand-in for a capability package's panel component. */
const panel = (text: string) => () => createElement('div', null, text)

declare global {
  // React 18 runs act() only when the environment opts in.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

describe('<App/> shell', () => {
  let container: HTMLDivElement
  let root: Root
  let ctx: Context
  let registry: UiService

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    ctx = new Context()
    // Same order as the real composition: i18n (UI text) before the shell.
    ctx.plugin(i18n, { locale: 'zh-CN' })
    await settle()
    // The shell's own strings are registered by @mediabase/ui-web's plugin; this
    // test renders <App/> directly, so it registers them the same way.
    for (const [locale, messages] of Object.entries(SHELL_MESSAGES)) {
      ctx.i18n.addMessages(locale, messages)
    }
    ctx.plugin(ui)
    await settle()
    const service = ctx.get('ui')
    if (!service) throw new Error('ctx.ui missing')
    registry = service

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root.render(createElement(App, { ctx })) })
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
    await ctx.fiber.dispose()
  })

  it('renders an empty but working shell when no capability registered a panel', () => {
    expect(container.textContent).toContain('Mediabase')
    expect(container.textContent).toContain('未注册任何面板')
  })

  it('renders a panel registered AFTER mount, and drops it on unregister', async () => {
    let unregister = (): void => {}
    await act(async () => {
      unregister = registry.register({ id: 'late', title: '后注册面板', area: 'sidebar', component: panel('LATE-SIDEBAR') })
    })
    expect(container.textContent).toContain('LATE-SIDEBAR')
    expect(container.textContent).toContain('后注册面板')
    expect(container.textContent).not.toContain('未注册任何面板')

    await act(async () => { unregister() })
    expect(container.textContent).not.toContain('LATE-SIDEBAR')
    expect(container.textContent).toContain('未注册任何面板')
  })

  it('renders the header area inside the title row and the monitor area on the right', async () => {
    await act(async () => {
      registry.register({ id: 'badge', title: '', area: 'header', order: 0, component: panel('HEADER-BADGE') })
      registry.register({ id: 'mon', title: '监视区', area: 'monitor', order: 0, component: panel('MONITOR-BODY') })
    })
    expect(container.querySelector('h1')?.textContent).toContain('HEADER-BADGE')
    expect(container.querySelector('.monitor')?.textContent).toContain('MONITOR-BODY')
    // a header panel is chrome, not a sidebar capability
    expect(container.querySelector('.panel')?.textContent).not.toContain('MONITOR-BODY')
  })

  it('orders panels of an area by order, then by registration', async () => {
    await act(async () => {
      registry.register({ id: 'b', title: 'B', area: 'sidebar', order: 20, component: panel('PANEL-B') })
      registry.register({ id: 'a', title: 'A', area: 'sidebar', order: 10, component: panel('PANEL-A') })
    })
    const text = container.textContent ?? ''
    expect(text.indexOf('PANEL-A')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('PANEL-A')).toBeLessThan(text.indexOf('PANEL-B'))
  })
})
