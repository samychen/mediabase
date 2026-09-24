// @vitest-environment jsdom
// The editor as the shell sees it: mount the REAL i18n/ui registries and the
// editor plugin on one cordis context (rpc/net stubbed — no host here), render
// <App/>, and assert the panels, their translated headings and the store seam.
// A component that throws on mount, a missing i18n key, or a panel registered
// into the wrong area fails here instead of in a browser.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as i18n from '../../../packages/client/i18n/src/index.ts'
import * as ui from '../../../packages/client/ui/src/index.ts'
import { App } from '../../../packages/client/ui-web/src/App.tsx'
import * as editor from '../packages/client/editor/src/index.tsx'
import { SHELL_MESSAGES } from '../../../packages/client/ui-web/src/messages.ts'
import type { EditorStore } from '../packages/client/editor/src/store.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/** cordis activates a plugin's service on a microtask, so wait one macrotask. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** The player measures its pane with a ResizeObserver; jsdom has none. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function stubRpc(handlers: Record<string, unknown>) {
  return {
    call: async (method: string): Promise<unknown> => {
      if (method in handlers) return structuredClone(handlers[method])
      throw Object.assign(new Error(`no stub for ${method}`), { code: -32601 })
    },
    connected: () => true,
    handshake: () => ({ client: 1, host: 1, compatible: true }),
  }
}

describe('the openvideo editor in the shell', () => {
  let container: HTMLDivElement
  let root: Root
  let ctx: Context
  let handlers: Record<string, unknown>

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
    ctx = new Context()
    ctx.plugin(i18n, { locale: 'zh-CN' })
    await settle()
    ctx.plugin(ui)
    await settle()
    // The shell's own strings (the base test registers them the same way,
    // because it renders <App/> directly instead of mounting the shell plugin).
    for (const [locale, messages] of Object.entries(SHELL_MESSAGES)) {
      ctx.i18n.addMessages(locale, messages)
    }
    // The connection package's two services the editor consumes; `handlers`
    // stays mutable so a test can teach the stub new answers as it goes.
    handlers = {
      'openvideo.assets.list': { assets: [] },
      'openvideo.projects.list': { projects: [] },
    }
    ctx.reflect.provide('rpc', stubRpc(handlers))
    ctx.reflect.provide('net', {
      apiUrl: (path: string) => `/api/${path}`,
      wsUrl: (path: string) => `ws://localhost/${path}`,
      token: () => null,
      host: () => 'http://localhost',
    })
    ctx.plugin(editor)
    await settle()

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root.render(createElement(App, { ctx, title: 'OpenVideo' })) })
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
    await ctx.fiber.dispose()
  })

  it('registers its six panels into the right areas', () => {
    const registry = ctx.get('ui')!
    const ids = (area: 'header' | 'sidebar' | 'monitor'): string[] => registry.list(area).map((p) => p.id)
    expect(ids('header')).toContain('openvideo.status')
    expect(ids('sidebar')).toEqual(['openvideo.projects', 'openvideo.media', 'openvideo.inspector'])
    expect(ids('monitor')).toEqual(['openvideo.player', 'openvideo.timeline'])
  })

  it('renders the translated chrome in the shell', () => {
    const text = container.textContent ?? ''
    expect(text).toContain('OpenVideo')
    expect(text).toContain('项目')      // projects panel heading (zh-CN)
    expect(text).toContain('媒体库')    // media panel heading
    expect(text).toContain('检查器')    // inspector heading
    expect(text).toContain('时间线')    // timeline heading
    expect(text).toContain('就绪')      // status with nothing open
    // empty-state copy, not a crash
    expect(text).toContain('还没有项目')
    expect(text).not.toContain('渲染失败')
  })

  it('provides the store on the context seam the panels read', () => {
    const store = ctx.get('openvideoEditor') as EditorStore | undefined
    expect(store).toBeDefined()
    expect(store?.get().assets).toEqual([])
    // the base `view` contract is provided (undefined until a project opens)
    expect('view' in ctx).toBe(true)
    expect(ctx.get('view')).toBeUndefined()
  })

  it('renders an opened project: the draft, the view contract, and no empty state', async () => {
    const store = ctx.get('openvideoEditor') as EditorStore
    handlers['openvideo.projects.get'] = {
      project: {
        id: 'p1',
        name: '开场剪辑',
        brief: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        coverAsset: null,
        coverAt: null,
        edl: {
          version: 1,
          output: { width: 1280, height: 720, fps: 30 },
          main: { elements: [] },
          overlays: [],
          audio: [],
        },
      },
    }
    await act(async () => {
      await store.openProject('p1')
      await settle()
    })
    const text = container.textContent ?? ''
    expect(text).toContain('开场剪辑')
    // the inspector now shows the project settings + the plain-JSON document
    expect(text).toContain('"version": 1')
    // the base `view` contract now carries the open project
    const view = ctx.get('view') as { file: string; w: number; h: number } | undefined
    expect(view).toMatchObject({ file: '开场剪辑', w: 1280, h: 720 })
  })
})
