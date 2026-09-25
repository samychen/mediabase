// The editor store: ONE observable state behind every panel, so projects /
// media / player / timeline / inspector cannot hold divergent copies.
//
// Contracts it keeps:
//   - the draft EDL is the local truth while editing; saves are debounced to
//     `openvideo.projects.update` (the host validates; a refusal surfaces with
//     its JSON pointer instead of silently dropping the edit),
//   - undo/redo are whole-document snapshots: one gesture, one step (structural
//     edits push; field tweaks coalesce into the previous step),
//   - "Ask for a change" goes through the BASE agent (`agent.run`): the prompt
//     carries the project id and the cut as a short list (describeEdl), and the
//     model acts through the checked `openvideo.*` tools — the same operations
//     the timeline buttons use, so an instruction is always a valid document.

import type { Context } from '@deepseek-ai/cordis'
import type { AgentResult } from '@mediabase/protocol'
import {
  captionTimeline,
  describeEdl,
  mainSegments,
  parseVtt,
  rid,
  splitClip,
  totalDuration,
  type Cue,
  type Edl,
  type MainElement,
} from '@openvideo/edl'
// Type-only imports: the services this store consumes are declared by the
// base client packages (rpc/net by @mediabase/connection, i18n by
// @mediabase/i18n); the store never mounts them itself.
import type {} from '@mediabase/connection'
import type {} from '@mediabase/i18n'

// ---- wire shapes (mirror @openvideo/host-media's result schemas) ------------

export interface AssetProxyInfo {
  status: 'none' | 'queued' | 'running' | 'ready' | 'failed'
  target: 'webm' | 'mp4' | null
  progress: number | null
  error: string | null
}

export interface AssetRow {
  id: string
  key: string
  name: string
  contentType: string
  size: number
  createdAt: string
  duration: number | null
  hasTranscript: boolean
  /** Live proxy facet from the host (absent on hosts predating proxies). */
  proxy?: AssetProxyInfo
}

export interface ProjectSummary {
  id: string
  name: string
  brief: string
  createdAt: string
  updatedAt: string
  coverAsset: string | null
  coverAt: number | null
}

export interface ProjectRow extends ProjectSummary {
  edl: Edl
}

export type Sel =
  | { kind: 'main'; index: number }
  | { kind: 'overlay'; track: number; index: number }
  | { kind: 'audio'; track: number; index: number }
  | null

export interface EditorState {
  assets: AssetRow[]
  projects: ProjectSummary[]
  openId: string | null
  projectName: string
  projectBrief: string
  /** The document being edited (null until a project is open). */
  draft: Edl | null
  /** The last document the host accepted (null = never saved). */
  savedEdl: Edl | null
  dirty: boolean
  saving: boolean
  saveError: string | null
  sel: Sel
  playhead: number
  playing: boolean
  /** Probed source durations in seconds, keyed by the full src ("asset:<id>"). */
  durations: Record<string, number>
  ask: { busy: boolean; answer: string | null; error: string | null }
  /** Per-asset decode verdict from a real probe ('fail' = container parsed,
    * stream undecodable in THIS browser). Shared by media list, timeline and
    * inspector so one lie cannot hide behind three panels. */
  decodeState: Record<string, 'ok' | 'fail'>
  /** Base URL of the host's Range-aware assets sidecar (null = old host or
    * unreachable; assetUrl then falls back to the gateway route). */
  assetsBase: string | null
  /** One-line status of the last gesture (an i18n key + params). */
  status: { key: string; params?: Record<string, string | number> } | null
  undoDepth: number
  redoDepth: number
}

export interface EditorStore {
  get(): EditorState
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  openProject(id: string): Promise<void>
  closeProject(): void
  createProject(name: string): Promise<void>
  removeProject(id: string): Promise<void>
  renameProject(name: string): Promise<void>
  setBrief(brief: string): Promise<void>
  /** A local edit: one undo step unless `coalesce` folds it into the last one. */
  setDraft(fn: (draft: Edl) => void, coalesce?: boolean): void
  saveNow(): Promise<void>
  undo(): void
  redo(): void
  select(sel: Sel): void
  setPlayhead(t: number): void
  setPlaying(playing: boolean): void
  /** One checked operation on the host; replaces the draft with what it saved. */
  runOp(op: string, args: Record<string, unknown>): Promise<string>
  /** "Ask for a change": the base agent over the openvideo tools. */
  ask(instruction: string): Promise<void>
  uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<AssetRow>
  uploadBlob(blob: Blob, name: string, onProgress?: (fraction: number) => void): Promise<AssetRow>
  importPath(path: string): Promise<void>
  /** Download a network media URL into the library (host-side fetch). */
  fetchUrl(url: string, name?: string): Promise<void>
  removeAsset(id: string): Promise<void>
  probeDuration(id: string, duration: number): Promise<void>
  attachTranscript(id: string, vtt: string): Promise<void>
  /** Transcript cues per src, fetched on demand (captions). */
  transcriptFor(src: string): Promise<Cue[] | null>
  addAssetToMain(asset: AssetRow): void
  addAssetToAudio(asset: AssetRow): void
  /** Split the main clip under the playhead; returns what happened (i18n key params). */
  splitAtPlayhead(): boolean
  assetUrl(id: string): string
  /** What a media element should load for an EDL src: the proxy when the
    * original is undecodable here and a proxy is ready; the asset otherwise;
    * https/data pass through; anything else null. ONE seam for preview/export. */
  playUrlFor(src: string): string | null
  /** Ask the host to transcode a browser-friendly proxy (target picked from
    * what THIS browser decodes); starts polling while jobs run. */
  ensureProxy(id: string): Promise<void>
  cancelProxy(id: string): Promise<void>
  errorText(e: unknown): string
  /** A status line for one gesture (rendered through ctx.i18n by panels). */
  flash(key: string, params?: Record<string, string | number>): void
}

const initialState: EditorState = {
  assets: [],
  projects: [],
  openId: null,
  projectName: '',
  projectBrief: '',
  draft: null,
  savedEdl: null,
  dirty: false,
  saving: false,
  saveError: null,
  sel: null,
  playhead: 0,
  playing: false,
  durations: {},
  ask: { busy: false, answer: null, error: null },
  decodeState: {},
  assetsBase: null,
  status: null,
  undoDepth: 0,
  redoDepth: 0,
}

/** base64 of one byte slice, without blowing the argument stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

const SAVE_DEBOUNCE_MS = 700

export function createEditorStore(ctx: Context): EditorStore {
  let state: EditorState = initialState
  const listeners = new Set<() => void>()
  const past: Edl[] = []
  const future: Edl[] = []
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let statusTimer: ReturnType<typeof setTimeout> | null = null

  const set = (patch: Partial<EditorState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const call = <T>(method: string, params?: unknown): Promise<T> => ctx.rpc.call<T>(method, params)

  const fail = (e: unknown): string => ctx.i18n.errorText(e)

  /** Replace the draft with a host-saved document, as ONE undo step. */
  const adopt = (edl: Edl): void => {
    if (state.draft !== null) past.push(structuredClone(state.draft))
    future.length = 0
    set({
      draft: structuredClone(edl),
      savedEdl: structuredClone(edl),
      dirty: false,
      saveError: null,
      undoDepth: past.length,
      redoDepth: 0,
    })
    ensureUrlDurations()
  }

  const scheduleSave = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  async function saveNow(): Promise<void> {
    const { openId, draft, dirty, saving } = state
    if (openId === null || draft === null || !dirty || saving) return
    set({ saving: true, saveError: null })
    try {
      const out = await call<{ project: ProjectRow }>('openvideo.projects.update', { id: openId, edl: draft })
      // A newer local edit may have landed while the save was in flight; only
      // clear `dirty` when the draft is still the one that was sent.
      const unchanged = JSON.stringify(state.draft) === JSON.stringify(draft)
      set({
        savedEdl: structuredClone(out.project.edl),
        saving: false,
        ...(unchanged ? { dirty: false } : {}),
      })
    } catch (e) {
      set({ saving: false, saveError: fail(e) })
    }
  }

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const schedulePoll = (): void => {
    if (pollTimer !== null) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      void store.refresh()
    }, 2000)
  }

  const store: EditorStore = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async refresh() {
      try {
        const endpoint = await call<{ base: string }>('openvideo.assets.endpoint').catch(() => null)
        if (endpoint !== null && endpoint.base !== state.assetsBase) set({ assetsBase: endpoint.base })
        const [assets, projects] = await Promise.all([
          call<{ assets: AssetRow[] }>('openvideo.assets.list'),
          call<{ projects: ProjectSummary[] }>('openvideo.projects.list'),
        ])
        // Durations the HOST already knows (measured at upload, or backfilled
        // by an earlier probe) must seed the client map too — probing only the
        // unknown ones left `durations` empty for every uploaded asset, clips
        // computed to zero length, and the player rendered no element at all.
        const known: Record<string, number> = {}
        for (const asset of assets.assets) {
          if (asset.duration !== null) known[`asset:${asset.id}`] = asset.duration
        }
        set({
          assets: assets.assets,
          projects: projects.projects,
          durations: { ...state.durations, ...known },
        })
        // A running proxy job is the only reason to poll: refresh again shortly
        // so progress/ready land in the rows without a manual reload.
        if (assets.assets.some((a) => a.proxy?.status === 'running' || a.proxy?.status === 'queued')) {
          schedulePoll()
        }
        // Probe what the library does not know yet (the player needs it to
        // place segments; the host backfills so an agent sees it too), and ask
        // this browser whether it can DECODE each video at all.
        for (const asset of assets.assets) {
          if (asset.contentType.startsWith('video/')) probeAsset(asset)
          if (asset.duration !== null || !asset.contentType.startsWith('video/')) continue
          void probeAssetDuration(asset)
        }
      } catch (e) {
        store.flash('ov.status.refreshFailed', { error: fail(e) })
      }
    },

    async openProject(id) {
      try {
        const { project } = await call<{ project: ProjectRow }>('openvideo.projects.get', { id })
        past.length = 0
        future.length = 0
        set({
          openId: project.id,
          projectName: project.name,
          projectBrief: project.brief,
          sel: null,
          playhead: 0,
          playing: false,
          ask: { busy: false, answer: null, error: null },
          undoDepth: 0,
          redoDepth: 0,
        })
        adopt(project.edl)
        past.length = 0
        set({ undoDepth: 0 })
      } catch (e) {
        store.flash('ov.status.openFailed', { error: fail(e) })
      }
    },

    closeProject() {
      if (saveTimer !== null) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      past.length = 0
      future.length = 0
      set({
        openId: null,
        projectName: '',
        projectBrief: '',
        draft: null,
        savedEdl: null,
        dirty: false,
        saving: false,
        saveError: null,
        sel: null,
        playhead: 0,
        playing: false,
        undoDepth: 0,
        redoDepth: 0,
      })
    },

    async createProject(name) {
      try {
        const { project } = await call<{ project: ProjectRow }>('openvideo.projects.create', { name })
        await store.refresh()
        await store.openProject(project.id)
      } catch (e) {
        store.flash('ov.status.createFailed', { error: fail(e) })
      }
    },

    async removeProject(id) {
      try {
        await call('openvideo.projects.remove', { id })
        if (state.openId === id) store.closeProject()
        await store.refresh()
        store.flash('ov.status.projectRemoved')
      } catch (e) {
        store.flash('ov.status.removeFailed', { error: fail(e) })
      }
    },

    async renameProject(name) {
      const { openId } = state
      if (openId === null) return
      try {
        const { project } = await call<{ project: ProjectRow }>('openvideo.projects.update', { id: openId, name })
        set({ projectName: project.name })
        await store.refresh()
      } catch (e) {
        store.flash('ov.status.renameFailed', { error: fail(e) })
      }
    },

    async setBrief(brief) {
      const { openId } = state
      if (openId === null) return
      set({ projectBrief: brief })
      try {
        await call('openvideo.projects.update', { id: openId, brief })
      } catch (e) {
        store.flash('ov.status.briefFailed', { error: fail(e) })
      }
    },

    setDraft(fn, coalesce) {
      const { draft } = state
      if (draft === null) return
      const next = structuredClone(draft)
      fn(next)
      if (coalesce !== true) {
        past.push(draft)
        future.length = 0
      }
      set({ draft: next, dirty: true, undoDepth: past.length, redoDepth: future.length })
      ensureUrlDurations()
      scheduleSave()
    },

    saveNow,

    undo() {
      const prev = past.pop()
      if (prev === undefined || state.draft === null) return
      future.push(state.draft)
      set({ draft: prev, dirty: true, undoDepth: past.length, redoDepth: future.length })
      scheduleSave()
    },

    redo() {
      const next = future.pop()
      if (next === undefined || state.draft === null) return
      past.push(state.draft)
      set({ draft: next, dirty: true, undoDepth: past.length, redoDepth: future.length })
      ensureUrlDurations()
      scheduleSave()
    },

    select(sel) {
      set({ sel })
    },

    setPlayhead(t) {
      set({ playhead: Math.max(0, t) })
    },

    setPlaying(playing) {
      set({ playing })
    },

    async runOp(op, args) {
      const { openId } = state
      if (openId === null) return ''
      try {
        const out = await call<{ project: ProjectRow; said: string }>('openvideo.projects.op', { id: openId, op, args })
        adopt(out.project.edl)
        await store.refresh()
        return out.said
      } catch (e) {
        const text = fail(e)
        store.flash('ov.status.opFailed', { op, error: text })
        throw e
      }
    },

    async ask(instruction) {
      const { openId, draft, assets, projectBrief } = state
      if (openId === null || draft === null) return
      set({ ask: { busy: true, answer: null, error: null } })
      try {
        const names = new Map<string, string>()
        for (const asset of assets) names.set(`asset:${asset.id}`, asset.name)
        const prompt = [
          `你正在剪一个视频项目(id: ${openId})。`,
          projectBrief.trim() === '' ? '' : `项目意图: ${projectBrief.trim()}`,
          '当前剪辑:',
          describeEdl(draft, names),
          '',
          `用户要求: ${instruction}`,
          '',
          '用 openvideo_* 工具修改这个项目(工具直接生效并保存)。素材列表用 openvideo_assets_list 查。',
          '时间以秒计;主轨位置就是播放顺序;文字时间是成片时间轴上的。完成后用一句话说明改了什么。',
        ].filter((line) => line !== null).join('\n')
        const result = await call<AgentResult>('agent.run', { prompt, maxSteps: 10 })
        const { project } = await call<{ project: ProjectRow }>('openvideo.projects.get', { id: openId })
        adopt(project.edl)
        const steps = result.steps.map((s) => s.name).join(', ')
        set({
          ask: {
            busy: false,
            answer: result.ok ? `${result.answer}${steps === '' ? '' : ` [${steps}]`}` : result.answer,
            error: null,
          },
        })
        await store.refresh()
      } catch (e) {
        set({ ask: { busy: false, answer: null, error: fail(e) } })
      }
    },

    async uploadFile(file, onProgress) {
      return store.uploadBlob(file, file.name, onProgress)
    },

    async uploadBlob(blob, name, onProgress) {
      const contentType = blob.type === '' ? 'application/octet-stream' : blob.type
      // Probe the duration client-side before the upload when it is media the
      // browser can read (the library ships it to agents right away).
      const duration = await probeBlobDuration(blob, contentType).catch(() => null)
      const { uploadId, chunkBytes } = await call<{ uploadId: string; chunkBytes: number }>(
        'openvideo.assets.upload.begin',
        {
          name,
          size: blob.size,
          contentType,
          ...(duration !== null ? { duration } : {}),
        },
      )
      try {
        const buffer = new Uint8Array(await blob.arrayBuffer())
        let index = 0
        for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
          const slice = buffer.subarray(offset, offset + chunkBytes)
          await call('openvideo.assets.upload.chunk', { uploadId, index, data: toBase64(slice) })
          index += 1
          onProgress?.(Math.min(1, (offset + slice.length) / buffer.length))
        }
        const { asset } = await call<{ asset: AssetRow }>('openvideo.assets.upload.end', { uploadId })
        await store.refresh()
        store.flash('ov.status.uploaded', { name: asset.name })
        return asset
      } catch (e) {
        await call('openvideo.assets.upload.cancel', { uploadId }).catch(() => {})
        store.flash('ov.status.uploadFailed', { error: fail(e) })
        throw e
      }
    },

    async importPath(path) {
      try {
        await call('openvideo.assets.import', { path })
        await store.refresh()
        store.flash('ov.status.imported', { path })
      } catch (e) {
        store.flash('ov.status.importFailed', { error: fail(e) })
      }
    },

    async fetchUrl(url, name) {
      const short = url.length > 48 ? `${url.slice(0, 45)}…` : url
      store.flash('ov.status.fetchStarted', { url: short })
      try {
        const { asset } = await call<{ asset: AssetRow }>('openvideo.assets.fetch', {
          url,
          ...(name !== undefined && name.trim() !== '' ? { name: name.trim() } : {}),
        })
        await store.refresh()
        store.flash('ov.status.fetched', { name: asset.name })
      } catch (e) {
        store.flash('ov.status.fetchFailed', { error: fail(e) })
      }
    },

    async removeAsset(id) {
      try {
        await call('openvideo.assets.remove', { id })
        await store.refresh()
        store.flash('ov.status.assetRemoved')
      } catch (e) {
        store.flash('ov.status.assetRemoveFailed', { error: fail(e) })
      }
    },

    async probeDuration(id, duration) {
      try {
        await call('openvideo.assets.probe', { id, duration })
        set({ durations: { ...state.durations, [`asset:${id}`]: duration } })
      } catch {
        // A failed backfill only costs the agent a guess; never bother the user.
      }
    },

    async attachTranscript(id, vtt) {
      try {
        await call('openvideo.assets.transcript.set', { id, vtt })
        await store.refresh()
        store.flash('ov.status.transcriptAttached')
      } catch (e) {
        store.flash('ov.status.transcriptFailed', { error: fail(e) })
      }
    },

    async transcriptFor(src) {
      if (!src.startsWith('asset:')) return null
      try {
        const out = await call<{ status: string; vtt?: string }>('openvideo.assets.transcript', { id: src.slice(6) })
        return out.status === 'ready' && out.vtt !== undefined ? parseVtt(out.vtt) : null
      } catch {
        return null
      }
    },

    addAssetToMain(asset) {
      const kind = asset.contentType.startsWith('image/') ? 'image' : 'video'
      store.setDraft((d) => {
        const el: MainElement = kind === 'image'
          ? { id: rid(), type: 'image', src: `asset:${asset.id}`, duration: 3 }
          : { id: rid(), type: 'video', src: `asset:${asset.id}` }
        d.main.elements.push(el)
      })
      set({ sel: { kind: 'main', index: (state.draft?.main.elements.length ?? 1) - 1 } })
      store.flash('ov.status.addedToMain', { name: asset.name })
    },

    addAssetToAudio(asset) {
      store.setDraft((d) => {
        d.audio = d.audio ?? []
        if (d.audio.length === 0) d.audio.push({ id: rid(), elements: [] })
        d.audio[0]!.elements.push({
          id: rid(),
          type: 'audio',
          src: `asset:${asset.id}`,
          startTime: 0,
          volume: 1,
        })
      })
      store.flash('ov.status.addedToAudio', { name: asset.name })
    },

    splitAtPlayhead() {
      const { draft, playhead, durations } = state
      if (draft === null) return false
      const segments = mainSegments(draft, (src) => durations[src])
      const active = segments.find((s) => playhead >= s.start && playhead < s.start + s.dur)
      if (active === undefined || active.dur <= 0) return false
      const at = playhead - active.start
      if (at <= 0.05 || at >= active.dur - 0.05) return false
      store.setDraft((d) => {
        const clip = d.main.elements[active.i]
        if (clip === undefined) return
        const halves = splitClip(clip, at, active.dur, rid())
        if (halves === null) return
        d.main.elements.splice(active.i, 1, ...halves)
      })
      set({ sel: { kind: 'main', index: active.i } })
      return true
    },

    assetUrl(id) {
      // Media elements need a SEEKABLE response: the sidecar speaks Range/206,
      // the gateway route answers whole bodies (fine for small pulls only).
      if (state.assetsBase !== null) return `${state.assetsBase}/asset/${id}`
      // apiUrl ONLY appends the token — the full `/api/…` path is the caller's
      // job (a bare route name resolves relative to the page and hits the SPA
      // fallback: HTML where the media element expects bytes).
      return ctx.net.apiUrl(`/api/openvideo.asset.${id}`)
    },

    playUrlFor(src) {
      if (src.startsWith('https://') || src.startsWith('data:')) return src
      if (!src.startsWith('asset:')) return null
      const id = src.slice(6)
      const asset = state.assets.find((a) => a.id === id)
      // The proxy exists for browsers that cannot decode the original; when it
      // is ready, it IS the playable truth (proxies need the sidecar: they are
      // served by the same Range-aware byte plane).
      if (asset?.proxy?.status === 'ready' && state.assetsBase !== null) {
        return `${state.assetsBase}/proxy/${id}`
      }
      return store.assetUrl(id)
    },

    async ensureProxy(id) {
      // Pick what THIS browser actually decodes: vp9/opus webm is universal;
      // fall back to h264/aac mp4, and to webm when neither claims support.
      const probe = document.createElement('video')
      const target = probe.canPlayType('video/webm; codecs="vp9,opus"') !== ''
        ? 'webm'
        : probe.canPlayType('video/mp4; codecs="avc1.42E032,mp4a.40.2"') !== ''
          ? 'mp4'
          : 'webm'
      try {
        await call('openvideo.proxy.ensure', { id, target })
        store.flash('ov.status.proxyStarted', { name: state.assets.find((a) => a.id === id)?.name ?? id })
        await store.refresh()
      } catch (e) {
        store.flash('ov.status.proxyFailed', { error: fail(e) })
      }
    },

    async cancelProxy(id) {
      try {
        await call('openvideo.proxy.cancel', { id })
        await store.refresh()
      } catch (e) {
        store.flash('ov.status.proxyFailed', { error: fail(e) })
      }
    },

    errorText: (e) => fail(e),

    flash(key, params) {
      set({ status: params === undefined ? { key } : { key, params } })
      if (statusTimer !== null) clearTimeout(statusTimer)
      statusTimer = setTimeout(() => {
        statusTimer = null
        set({ status: null })
      }, 6000)
    },
  }

  /** Read a media blob's duration in the browser before it is uploaded. */
  function probeBlobDuration(blob: Blob, contentType: string): Promise<number | null> {
    if (!contentType.startsWith('video/') && !contentType.startsWith('audio/')) return Promise.resolve(null)
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob)
      const el = document.createElement(contentType.startsWith('audio/') ? 'audio' : 'video')
      const done = (value: number | null): void => {
        URL.revokeObjectURL(url)
        el.removeAttribute('src')
        resolve(value)
      }
      el.preload = 'metadata'
      el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null)
      el.onerror = () => done(null)
      el.src = url
    })
  }

  /**
   * Decode probe: preload MUST be auto (with 'metadata' the element stops at
   * HAVE_METADATA and loadeddata never fires — every asset would time out
   * into a false 'fail'), a metadata-only load is forced to fetch a frame by
   * seeking, and MEDIA_ERR_ABORTED (our own teardown) is not a verdict.
   */
  function probeAsset(asset: AssetRow): void {
    if (typeof document === 'undefined') return
    if (state.decodeState[asset.id] !== undefined) return
    const v = document.createElement('video')
    v.preload = 'auto'
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const finish = (result: 'ok' | 'fail'): void => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      ctrl.abort()
      v.removeAttribute('src')
      set({ decodeState: { ...state.decodeState, [asset.id]: result } })
    }
    timer = setTimeout(() => finish('fail'), 6000)
    v.addEventListener('loadeddata', () => finish('ok'), { signal: ctrl.signal })
    v.addEventListener('canplay', () => finish('ok'), { signal: ctrl.signal })
    v.addEventListener('loadedmetadata', () => {
      if (v.readyState < 2 && v.duration > 0) {
        v.currentTime = Math.min(0.1, Math.max(0, v.duration - 0.05))
      }
    }, { signal: ctrl.signal })
    v.addEventListener('error', () => {
      if ((v.error?.code ?? 0) === 1) return
      finish('fail')
    }, { signal: ctrl.signal })
    // Same seam as playback (sidecar when available, full /api/ path else) —
    // a bare route name resolves against the page and returns HTML.
    v.src = store.assetUrl(asset.id)
  }

  /**
   * Direct `https://` sources in the draft have no library row, so nothing
   * else would ever learn their length — and a zero-length segment renders no
   * element at all. Probe them here (once per src per session) and cancel the
   * download the moment metadata lands.
   */
  const urlProbeAttempted = new Set<string>()
  function ensureUrlDurations(): void {
    const d = state.draft
    if (d === null || typeof document === 'undefined') return
    const srcs = new Set<string>()
    for (const el of d.main.elements) srcs.add(el.src)
    for (const tr of d.overlays ?? []) for (const el of tr.elements) if ('src' in el) srcs.add(el.src)
    for (const tr of d.audio ?? []) for (const el of tr.elements) srcs.add(el.src)
    for (const src of srcs) {
      if (!src.startsWith('https://')) continue
      if (state.durations[src] !== undefined || urlProbeAttempted.has(src)) continue
      urlProbeAttempted.add(src)
      const el = document.createElement('video')
      let done = false
      const finish = (duration: number | null): void => {
        if (done) return
        done = true
        el.onloadedmetadata = null
        el.onerror = null
        el.removeAttribute('src')
        if (duration !== null) set({ durations: { ...state.durations, [src]: duration } })
      }
      el.preload = 'auto'
      el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null)
      el.onerror = () => finish(null)
      setTimeout(() => finish(null), 8000)
      el.src = src
    }
  }

  /**
   * Backfill one asset's duration and tell the host (self-healing library).
   * Cancel the fetch the moment metadata lands: with a 250 MB source a
   * never-cancelled probe would drag the whole file in just to read a number
   * that sits in the first kilobytes.
   */
  function probeAssetDuration(asset: AssetRow): Promise<void> {
    return new Promise((resolve) => {
      const el = document.createElement('video')
      let done = false
      const finish = (duration: number | null): void => {
        if (done) return
        done = true
        el.onloadedmetadata = null
        el.onerror = null
        el.removeAttribute('src')
        if (duration !== null) {
          set({ durations: { ...state.durations, [`asset:${asset.id}`]: duration } })
          void store.probeDuration(asset.id, duration)
        }
        resolve()
      }
      el.preload = 'auto'
      el.onloadedmetadata = () => {
        finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null)
      }
      el.onerror = () => finish(null)
      setTimeout(() => finish(null), 8000)
      el.src = store.assetUrl(asset.id)
    })
  }

  return store
}

/** Total length of the current draft (0 when nothing is open). */
export function draftDuration(state: EditorState): number {
  if (state.draft === null) return 0
  return totalDuration(mainSegments(state.draft, (src) => state.durations[src]))
}

/** Caption lines over the finished video, from per-src cues. */
export function captionLines(edl: Edl, cuesBySrc: Map<string, Cue[]>, durations: Record<string, number>) {
  if (edl.captions === undefined || !edl.captions.enabled) return []
  const segments = mainSegments(edl, (src) => durations[src])
  const clips = segments
    .filter((s) => s.el.type === 'video')
    .map((s) => ({ src: s.el.src, start: s.start, dur: s.dur, trimStart: s.el.trimStart ?? 0 }))
  return captionTimeline(clips, cuesBySrc, edl.captions.style.maxChars)
}
