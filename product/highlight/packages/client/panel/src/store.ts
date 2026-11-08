// @vhl/ui-highlight / store.ts — one store behind both panels.
//
// Why a store instead of local state: the control panel submits and the result
// panel renders. Two components holding their own copies of "the current job"
// would drift the moment one polls and the other does not. Here every host call
// lives in ONE place, the polling loop owns its own teardown, and a panel only
// reads a snapshot (useSyncExternalStore).
//
// Every string comes from messages.ts — including validation errors, which are
// localized through ctx.i18n rather than written inline.

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@mediabase/connection'
import type {} from '@mediabase/i18n'

// Wire types: these MIRROR @vhl/host-highlight's public shapes. They are
// redeclared (not imported) so the browser bundle never pulls the host package
// — and therefore node:fs — into the client build.
export interface Segment {
  startSec: number
  endSec: number
  score: number
  signals: Record<string, number>
}

export interface JobView {
  jobId: string
  state: string
  stage: string
  progress: number
  input: string
  output: string
  error: string
  durationSec: number
  fps: number
  segments: Segment[]
  segmentCount: number
  srtPath: string
  reportPath: string
  clipUrl: string
  subtitleUrl: string
  reportUrl: string
}

/**
 * One row of the host's option catalogue. The panel renders THIS, so a knob the
 * engine adds shows up without a client release — and a knob this deployment
 * cannot honour arrives with `available: false` instead of silently doing nothing.
 */
export interface HighlightOption {
  key: string
  type: string
  default: unknown
  min: number | null
  max: number | null
  enum: unknown[] | null
  requires: string
  group: string
  available: boolean
  /** Sub-keys of a `weights` option; null for scalar knobs. */
  fields: Record<string, { field: string; default: number }> | null
}

export interface Media {
  path: string
  durationSec: number
  fps: number
  width: number
  height: number
  hasAudio: boolean
  videoCodec: string
  audioCodec: string
}

export interface Models {
  /**
   * The interpreter that produced this report.
   *
   * `degradedReason` is a fact about an INTERPRETER, not about the machine. A
   * machine with several Pythons usually has OpenCV in one of them, so the
   * panel names the interpreter rather than telling the operator to install
   * OpenCV again.
   */
  interpreter: { executable: string; version: string }
  detector: { kind: string; path: string; present: boolean; license: string }
  face: { available: boolean; license: string }
  clip: { available: boolean; license: string }
  whisper: { available: boolean; license: string }
  runtime: { opencv: boolean; numpy: boolean; onnxruntime: boolean }
  degraded: boolean
  /** Why vision is off (`opencv-missing` / `numpy-missing` / `opencv-import-failed`), '' if healthy. */
  degradedReason: string
}

export interface EngineState {
  running: boolean
  pid: number | null
  restarts: number
  python: string
  script: string
  protocol: number | null
  engine: string | null
  ffmpeg: string | null
}

export interface HighlightState {
  input: string
  topK: number
  clipDurationSec: number
  /** Engine-declared knobs (empty until highlight.options answers). */
  options: HighlightOption[]
  /** Knob values the user changed; only these are sent with a job. */
  values: Record<string, unknown>
  media: Media | null
  job: JobView | null
  /** Absolute, token-bearing URLs for the job's artifacts ('' when absent). */
  clipSrc: string
  subtitleSrc: string
  reportSrc: string
  jobs: JobView[]
  engine: EngineState | null
  models: Models | null
  edlPath: string
  busy: boolean
  error: string | null
}

export interface HighlightStore {
  get(): HighlightState
  subscribe(onChange: () => void): () => void
  patch(next: Partial<HighlightState>): void
  /** Set one engine knob (validated by the host against the same contract). */
  setOption(key: string, value: unknown): void
  probe(): Promise<void>
  start(): Promise<void>
  cancel(): Promise<void>
  /** Adopt an existing job (a row in the job list) as the one under review. */
  select(jobId: string): Promise<void>
  exportEdl(): Promise<void>
  refresh(): Promise<void>
  loadDiagnostics(): Promise<void>
  dispose(): void
}

/** The shape a panel renders before any host call lands (also used as the fallback snapshot). */
export const EMPTY_STATE: HighlightState = {
  input: '',
  topK: 5,
  clipDurationSec: 6,
  options: [],
  // Whisper off by default: transcription dominates the runtime and the UI has a
  // switch for it, so "slow because it transcribed" is never a surprise.
  values: { enableWhisper: false },
  media: null,
  job: null,
  clipSrc: '',
  subtitleSrc: '',
  reportSrc: '',
  jobs: [],
  engine: null,
  models: null,
  edlPath: '',
  busy: false,
  error: null,
}

// `interrupted` is terminal too: it is what the host reports for a job whose
// process died. Leaving it out here would poll a row that can never advance.
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const POLL_MS = 600

export function createHighlightStore(ctx: Context): HighlightStore {
  let state: HighlightState = { ...EMPTY_STATE }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const patch = (next: Partial<HighlightState>): void => {
    state = { ...state, ...next }
    emit()
  }

  const fail = (error: unknown): string => ctx.i18n.errorText(error)

  const call = <T,>(method: string, params?: unknown): Promise<T> => ctx.rpc.call<T>(method, params)

  /** Stop the polling loop; every exit path (terminal state, cancel, dispose) uses it. */
  const stopPolling = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * Turn a host data-plane path into an absolute, token-bearing URL.
   *
   * This MUST happen here and not in a panel: the shell renders components with
   * ITS OWN context (`inject: ['ui','i18n']`), so a component that reads
   * `ctx.net` throws "cannot get property net without inject" and the whole panel
   * falls out to the error boundary. The store closes over the PLUGIN's context,
   * which does inject `net` — the same division openvideo uses.
   */
  const absolute = (path: string): string => {
    if (path === '') return ''
    try {
      return ctx.net.apiUrl(path)
    } catch {
      // No connection service (a host that serves no data plane): the panel
      // falls back to "no clip" instead of blanking the page.
      return ''
    }
  }

  const adopt = (job: JobView): void => {
    patch({
      job,
      clipSrc: absolute(job.clipUrl),
      subtitleSrc: absolute(job.subtitleUrl),
      reportSrc: absolute(job.reportUrl),
    })
    if (TERMINAL.has(job.state)) {
      stopPolling()
      patch({ busy: false })
      void refresh()
      return
    }
    schedule()
  }

  const schedule = (): void => {
    if (disposed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void poll()
    }, POLL_MS)
  }

  const poll = async (): Promise<void> => {
    if (disposed) return
    const current = state.job
    if (current === null) return
    try {
      const job = await call<JobView>('highlight.status', { jobId: current.jobId })
      if (disposed) return
      adopt(job)
    } catch (error) {
      if (disposed) return
      stopPolling()
      patch({ busy: false, error: fail(error) })
    }
  }

  const refresh = async (): Promise<void> => {
    try {
      const jobs = await call<JobView[]>('highlight.jobs.list')
      if (!disposed) patch({ jobs })
    } catch {
      // A list failure is not worth an error banner: the registry is empty
      // after an engine restart, which is normal and reported elsewhere.
    }
  }

  const probe = async (): Promise<void> => {
    const input = state.input.trim()
    if (input === '') {
      patch({ error: ctx.i18n.t('vhl.error.inputRequired') })
      return
    }
    patch({ busy: true, error: null })
    try {
      const media = await call<Media>('highlight.probe', { path: input })
      if (!disposed) patch({ media, busy: false })
    } catch (error) {
      if (!disposed) patch({ busy: false, error: fail(error) })
    }
  }

  const start = async (): Promise<void> => {
    const input = state.input.trim()
    if (input === '') {
      patch({ error: ctx.i18n.t('vhl.error.inputRequired') })
      return
    }
    patch({ busy: true, error: null, edlPath: '' })
    try {
      const job = await call<JobView>('highlight.start', {
        input,
        topK: state.topK,
        clipDurationSec: state.clipDurationSec,
        // Only knobs the user actually set: sending every catalogue default
        // would override the engine's own defaults and make an upgrade a
        // behaviour change.
        options: state.values,
      })
      if (disposed) return
      adopt(job)
      if (TERMINAL.has(job.state)) patch({ busy: false })
      void refresh()
    } catch (error) {
      if (!disposed) patch({ busy: false, error: fail(error) })
    }
  }

  const setOption = (key: string, value: unknown): void => {
    patch({ values: { ...state.values, [key]: value } })
  }

  const cancel = async (): Promise<void> => {
    const current = state.job
    if (current === null) return
    try {
      const job = await call<JobView>('highlight.cancel', { jobId: current.jobId })
      if (disposed) return
      adopt(job)
    } catch (error) {
      if (!disposed) patch({ error: fail(error) })
    }
  }

  /**
   * Adopt a job that this page did not start: after a reload, the list is the
   * only way back to a clip that already exists. The engine's registry is the
   * source of truth, so this is one `status` call — no client-side cache to rot.
   */
  const select = async (jobId: string): Promise<void> => {
    try {
      const job = await call<JobView>('highlight.status', { jobId })
      if (!disposed) patch({ edlPath: '', error: null })
      adopt(job)
    } catch (error) {
      if (!disposed) patch({ error: fail(error) })
    }
  }

  const exportEdl = async (): Promise<void> => {
    const current = state.job
    if (current === null) return
    try {
      const path = await call<string>('highlight.export.edl', { jobId: current.jobId })
      if (!disposed) patch({ edlPath: path, error: null })
    } catch (error) {
      if (!disposed) patch({ error: fail(error) })
    }
  }

  const loadDiagnostics = async (): Promise<void> => {
    try {
      const [engine, models, options] = await Promise.all([
        call<EngineState>('highlight.engine.state'),
        call<Models>('highlight.models'),
        // The catalogue drives the advanced section: no hardcoded knob list in
        // the client, so an engine that gains a knob gains a control.
        call<HighlightOption[]>('highlight.options'),
      ])
      if (!disposed) patch({ engine, models, options })
    } catch {
      // Diagnostics are optional context; their absence must not break the form.
    }
  }

  return {
    get: () => state,
    subscribe(onChange) {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    patch,
    setOption,
    probe,
    start,
    cancel,
    select,
    exportEdl,
    refresh,
    loadDiagnostics,
    dispose() {
      disposed = true
      stopPolling()
      listeners.clear()
    },
  }
}
