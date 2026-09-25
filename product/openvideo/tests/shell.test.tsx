// @vitest-environment jsdom
// The product shell: projects home when nothing is open, the four-region
// editor grid when a project is — panels flowing in from ctx.ui by area, the
// store seam from @openvideo/ui-editor driving which screen shows.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as i18n from '../../../packages/client/i18n/src/index.ts'
import * as ui from '../../../packages/client/ui/src/index.ts'
import * as editor from '../packages/client/editor/src/index.tsx'
import * as shell from '../packages/client/shell/src/index.tsx'
import type { EditorStore } from '../packages/client/editor/src/store.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('the openvideo shell', () => {
  let ctx: Context
  let root: HTMLDivElement
  let handlers: Record<string, unknown>

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
    ctx = new Context()
    handlers = {
      'openvideo.assets.list': { assets: [] },
      'openvideo.projects.list': { projects: [] },
    }
    ctx.plugin(i18n, { locale: 'zh-CN' })
    await settle()
    ctx.plugin(ui)
    await settle()
    ctx.reflect.provide('rpc', {
      call: async (method: string): Promise<unknown> => {
        if (method in handlers) return structuredClone(handlers[method])
        throw Object.assign(new Error(`no stub for ${method}`), { code: -32601 })
      },
      connected: () => true,
      handshake: () => ({ client: 1, host: 1, compatible: true }),
    })
    ctx.reflect.provide('net', {
      apiUrl: (path: string) => path,
      wsUrl: (path: string) => `ws://localhost/${path}`,
      token: () => null,
      host: () => 'http://localhost',
    })
    ctx.plugin(editor)
    await settle()

    root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    await act(async () => {
      ctx.plugin(shell, { title: 'OpenVideo' })
      await settle()
    })
  })

  afterEach(async () => {
    root.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
    await ctx.fiber.dispose()
  })

  it('shows the projects home with the empty state OUTSIDE any card', () => {
    const text = document.body.textContent ?? ''
    expect(text).toContain('OpenVideo')
    expect(text).toContain('还没有项目')
    expect(text).toContain('新建')
    expect(document.querySelector('.ovs-home')).not.toBeNull()
    expect(document.querySelector('.ovs-grid')).toBeNull()
    expect(document.querySelector('.ovs-empty')).not.toBeNull()
  })

  it('lists project cards from the store and switches to the editor grid on open', async () => {
    handlers['openvideo.projects.list'] = {
      projects: [{
        id: 'p1', name: '第一剪', brief: '', createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z', coverAsset: null, coverAt: null,
      }],
    }
    handlers['openvideo.projects.get'] = {
      project: {
        id: 'p1', name: '第一剪', brief: '', createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z', coverAsset: null, coverAt: null,
        edl: { version: 1, output: { width: 1280, height: 720, fps: 30 }, main: { elements: [] }, overlays: [], audio: [] },
      },
    }
    const store = ctx.get('openvideoEditor') as EditorStore
    await act(async () => {
      await store.refresh()
      await settle()
    })
    expect(document.querySelector('.ovs-card')).not.toBeNull()
    expect(document.body.textContent).toContain('第一剪')

    await act(async () => {
      await store.openProject('p1')
      await settle()
    })
    expect(document.querySelector('.ovs-grid')).not.toBeNull()
    expect(document.querySelector('.ovs-left')).not.toBeNull()
    expect(document.querySelector('.ovs-center')).not.toBeNull()
    expect(document.querySelector('.ovs-right')).not.toBeNull()
    expect(document.querySelector('.ovs-bottom')).not.toBeNull()
    // panels landed in their panes: media rail left, timeline bottom
    expect(document.querySelector('.ovs-left')?.textContent).toContain('媒体库')
    expect(document.querySelector('.ovs-bottom')?.textContent).toContain('时间线')
    // the back button returns home
    await act(async () => {
      store.closeProject()
      await settle()
    })
    expect(document.querySelector('.ovs-home')).not.toBeNull()
  })
})
