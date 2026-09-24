// @vitest-environment jsdom
// The editor store without a browser or a host: the rpc/net/i18n seams are
// stubbed, and what is under test is the store's own contract — chunked
// upload math, the debounced save, whole-document undo steps, the adoption of
// host-saved documents, and the prompt "Ask for a change" hands the agent.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { starterEdl, type Edl } from '../packages/edl/src/index.ts'
import { createEditorStore, type AssetRow, type EditorStore, type ProjectRow } from '../packages/client/editor/src/store.ts'

type Call = { method: string; params: unknown }

interface Stub {
  ctx: Context
  calls: Call[]
  reply: (method: string, result: unknown) => void
}

function stubContext(): Stub {
  const calls: Call[] = []
  const replies = new Map<string, unknown>()
  const ctx = {
    rpc: {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params })
        if (!replies.has(method)) throw Object.assign(new Error(`no stub for ${method}`), { code: -32601 })
        return structuredClone(replies.get(method))
      },
    },
    // Faithful to @mediabase/connection: apiUrl ONLY appends the token — it
    // does not prepend `/api/`. A stub that "helpfully" added the prefix hid
    // the bare-route-name bug for four rounds.
    net: { apiUrl: (path: string) => path },
    i18n: { errorText: (e: unknown) => `[stub] ${(e as Error).message}` },
  } as unknown as Context
  return {
    ctx,
    calls,
    reply: (method, result) => {
      replies.set(method, result)
    },
  }
}

const asset = (over: Partial<AssetRow> = {}): AssetRow => ({
  id: 'aaaaaaaaaaaaaaaa',
  key: 'aaaaaaaaaaaaaaaa.mp4',
  name: 'clip.mp4',
  contentType: 'video/mp4',
  size: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  duration: 8,
  hasTranscript: false,
  ...over,
})

const project = (edl: Edl, over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: 'p1',
  name: '测试项目',
  brief: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  coverAsset: null,
  coverAt: null,
  edl,
  ...over,
})

let stub: Stub
let store: EditorStore

beforeEach(() => {
  stub = stubContext()
  store = createEditorStore(stub.ctx)
  stub.reply('openvideo.assets.list', { assets: [asset()] })
  stub.reply('openvideo.projects.list', { projects: [] })
})

describe('editor store: basics', () => {
  it('refresh loads the library and the shelf', async () => {
    stub.reply('openvideo.projects.list', { projects: [{ ...project(starterEdl()), edl: undefined }] })
    await store.refresh()
    const state = store.get()
    expect(state.assets).toHaveLength(1)
    expect(state.projects).toHaveLength(1)
  })

  it('asset URLs are full /api/ paths (a bare route name would hit the SPA fallback)', () => {
    expect(store.assetUrl('aaaaaaaaaaaaaaaa')).toBe('/api/openvideo.asset.aaaaaaaaaaaaaaaa')
  })

  it('refresh seeds durations from what the host already knows', async () => {
    // the default stub asset has duration 8 — probing is skipped for it, so
    // the client map must come from the row itself or segments stay zero-length
    stub.reply('openvideo.assets.endpoint', { base: 'http://127.0.0.1:3095', port: 3095 })
    await store.refresh()
    expect(store.get().durations['asset:aaaaaaaaaaaaaaaa']).toBe(8)
    // with a sidecar the asset URL points at it (Range-aware)
    expect(store.assetUrl('aaaaaaaaaaaaaaaa')).toBe('http://127.0.0.1:3095/asset/aaaaaaaaaaaaaaaa')
  })

  it('opens a project into the draft and adopts host-saved documents as one undo step', async () => {
    const edl = starterEdl()
    stub.reply('openvideo.projects.get', { project: project(edl) })
    await store.openProject('p1')
    expect(store.get().draft).toEqual(edl)
    expect(store.get().undoDepth).toBe(0)

    store.setDraft((d) => {
      d.main.elements.push({ id: 'x', type: 'image', src: 'asset:aaaaaaaaaaaaaaaa', duration: 2 })
    })
    expect(store.get().draft?.main.elements).toHaveLength(1)
    expect(store.get().undoDepth).toBe(1)
    expect(store.get().dirty).toBe(true)

    store.undo()
    expect(store.get().draft?.main.elements).toHaveLength(0)
    store.redo()
    expect(store.get().draft?.main.elements).toHaveLength(1)
  })

  it('saves the draft, debounced, and reports a refusal with its text', async () => {
    vi.useFakeTimers()
    try {
      stub.reply('openvideo.projects.get', { project: project(starterEdl()) })
      await store.openProject('p1')
      stub.reply('openvideo.projects.update', { project: project(starterEdl()) })
      store.setDraft((d) => {
        d.output.fps = 60
      })
      expect(stub.calls.filter((c) => c.method === 'openvideo.projects.update')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(900)
      const saves = stub.calls.filter((c) => c.method === 'openvideo.projects.update')
      expect(saves).toHaveLength(1)
      expect((saves[0]!.params as { id: string }).id).toBe('p1')
      expect(store.get().dirty).toBe(false)

      // a failing save keeps the draft dirty and surfaces the error text
      stub.reply('openvideo.projects.update', null)
      ;(stub.ctx.rpc as { call: (m: string, p?: unknown) => Promise<unknown> }).call = async () => {
        throw Object.assign(new Error('EDL invalid'), { code: -32602 })
      }
      store.setDraft((d) => {
        d.output.fps = 24
      })
      await vi.advanceTimersByTimeAsync(900)
      expect(store.get().dirty).toBe(true)
      expect(store.get().saveError).toContain('EDL invalid')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('editor store: proxy seam', () => {
  it('playUrlFor prefers a ready proxy on the sidecar, passes URLs through', async () => {
    stub.reply('openvideo.assets.endpoint', { base: 'http://127.0.0.1:3095', port: 3095 })
    stub.reply('openvideo.assets.list', {
      assets: [asset({ proxy: { status: 'ready', target: 'webm', progress: 1, error: null } })],
    })
    await store.refresh()
    expect(store.playUrlFor('asset:aaaaaaaaaaaaaaaa')).toBe('http://127.0.0.1:3095/proxy/aaaaaaaaaaaaaaaa')
    expect(store.playUrlFor('https://example.com/x.mp4')).toBe('https://example.com/x.mp4')
    // without a ready proxy it is the plain asset URL (sidecar-first)
    stub.reply('openvideo.assets.list', { assets: [asset()] })
    await store.refresh()
    expect(store.playUrlFor('asset:aaaaaaaaaaaaaaaa')).toBe('http://127.0.0.1:3095/asset/aaaaaaaaaaaaaaaa')
  })
})

describe('editor store: uploads', () => {
  it('chunks a blob in order and finishes with the new asset', async () => {
    stub.reply('openvideo.assets.upload.begin', { uploadId: 'u1', chunkBytes: 8 })
    stub.reply('openvideo.assets.upload.chunk', { received: 0 })
    stub.reply('openvideo.assets.upload.end', { asset: asset({ name: 'note.txt', contentType: 'text/plain' }) })

    const blob = new Blob(['0123456789abcdef01234'], { type: 'text/plain' }) // 21 bytes → 3 chunks
    const seen: number[] = []
    const out = await store.uploadBlob(blob, 'note.txt', (f) => seen.push(Math.round(f * 100)))
    expect(out.name).toBe('note.txt')

    const chunks = stub.calls.filter((c) => c.method === 'openvideo.assets.upload.chunk')
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => (c.params as { index: number }).index)).toEqual([0, 1, 2])
    // base64 of the exact slices, in order
    const datas = chunks.map((c) => Buffer.from((c.params as { data: string }).data, 'base64').toString())
    expect(datas.join('')).toBe('0123456789abcdef01234')
    expect(seen.at(-1)).toBe(100)
  })
})

describe('editor store: ask for a change', () => {
  it('hands the agent the project, the cut as a list, and adopts what it saved', async () => {
    await store.refresh() // the library names the clips in the prompt
    const edl = starterEdl()
    edl.main.elements.push({ id: 'a', type: 'video', src: 'asset:aaaaaaaaaaaaaaaa', duration: 8 })
    stub.reply('openvideo.projects.get', { project: project(edl) })
    await store.openProject('p1')

    const edited = structuredClone(edl)
    edited.main.elements[0]!.duration = 5
    stub.reply('agent.run', { ok: true, answer: '剪短了开头', steps: [{ name: 'openvideo_trim_clip' }] })
    // the host answers the re-read with what the agent saved
    stub.reply('openvideo.projects.get', { project: project(edited) })

    await store.ask('把开头剪短到 5 秒')
    const askCall = stub.calls.find((c) => c.method === 'agent.run')!
    const prompt = (askCall.params as { prompt: string }).prompt
    expect(prompt).toContain('p1')
    expect(prompt).toContain('把开头剪短到 5 秒')
    expect(prompt).toContain('clip 0: "clip.mp4"')
    expect(prompt).toContain('openvideo_')
    expect(store.get().draft?.main.elements[0]).toMatchObject({ duration: 5 })
    expect(store.get().ask.answer).toContain('剪短了开头')
    expect(store.get().undoDepth).toBe(1) // one instruction, one undo
  })
})
