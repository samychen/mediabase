// Console state — one polled snapshot of the server plus the player target.
//
// The reference project (analyzed at feature level only) polls every 3s; same
// here. Fast data (paths/sessions/metrics) refreshes every cycle; slow data
// (info/endpoints) every fifth — server identity does not change while you
// watch. Polling pauses while the browser tab is hidden and stops with the
// plugin (ctx.effect cleanup), so a composed-but-closed console costs nothing.
//
// React contract: one immutable snapshot object + subscribe(listener),
// consumed through useSyncExternalStore — the same observable-store shape the
// openvideo editor uses. All five panels share ONE store instance provided on
// the context, so they poll the server once, not five times.

import type { Endpoints, MetricsSummary, PathRow, ServerInfo, SessionKind, SessionRow } from '@mtxconsole/protocol'
import type { RpcService } from '@mediabase/connection'

export const POLL_MS = 3000
const SLOW_EVERY = 5

export interface ConsoleSnapshot {
  ready: boolean
  error: string | null
  info: ServerInfo | null
  endpoints: Endpoints | null
  paths: PathRow[]
  sessions: SessionRow[]
  metrics: MetricsSummary | null
  /** The path the player panel should render (null = none selected). */
  selected: string | null
  playMode: 'whep' | 'hls'
  /** Bumped after every successful cycle — panels key transitions off it. */
  generation: number
}

export interface ConsoleStore {
  subscribe(listener: () => void): () => void
  get(): ConsoleSnapshot
  start(): void
  stop(): void
  select(name: string | null): void
  setPlayMode(mode: 'whep' | 'hls'): void
  addPath(name: string, source: string | undefined, record: boolean): Promise<void>
  deletePath(name: string): Promise<void>
  kickSession(kind: SessionKind, id: string): Promise<void>
  refresh(): Promise<void>
}

export const EMPTY_FALLBACK: ConsoleSnapshot = {
  ready: false,
  error: null,
  info: null,
  endpoints: null,
  paths: [],
  sessions: [],
  metrics: null,
  selected: null,
  playMode: 'whep',
  generation: 0,
}

export function createConsoleStore(rpc: RpcService): ConsoleStore {
  let snapshot: ConsoleSnapshot = EMPTY_FALLBACK
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | null = null
  let cycle = 0
  let inflight: Promise<void> | null = null

  function emit(next: Partial<ConsoleSnapshot>): void {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }

  function documentVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  async function refresh(): Promise<void> {
    cycle += 1
    const slowCycle = cycle % SLOW_EVERY === 1
    try {
      const fast = await Promise.all([
        rpc.call<{ paths: PathRow[] }>('mediamtx.paths.list', {}),
        rpc.call<{ sessions: SessionRow[] }>('mediamtx.sessions.list', {}),
        rpc.call<MetricsSummary>('mediamtx.metrics', {}).catch(() => null),
        ...(slowCycle
          ? [
              rpc.call<{ info: ServerInfo }>('mediamtx.info', {}),
              rpc.call<{ endpoints: Endpoints }>('mediamtx.endpoints', {}),
            ]
          : []),
      ])
      emit({
        paths: fast[0]!.paths,
        sessions: fast[1]!.sessions,
        metrics: fast[2] ?? null,
        ...(slowCycle
          ? {
              info: (fast[3] as { info: ServerInfo }).info,
              endpoints: (fast[4] as { endpoints: Endpoints }).endpoints,
            }
          : {}),
        error: null,
        ready: true,
        generation: snapshot.generation + 1,
      })
    } catch (e) {
      emit({ ready: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const store: ConsoleStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => snapshot,
    start() {
      if (timer !== null) return
      timer = setInterval(() => {
        if (documentVisible() && inflight === null) {
          inflight = refresh().finally(() => {
            inflight = null
          })
        }
      }, POLL_MS)
      void refresh()
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    select: (name) => emit({ selected: name }),
    setPlayMode: (mode) => emit({ playMode: mode }),
    refresh,
    addPath: async (name, source, record) => {
      await rpc.call('mediamtx.config.paths.add', {
        name,
        ...(source !== undefined && source.trim() !== '' ? { source: source.trim() } : {}),
        record,
      })
      await refresh()
    },
    deletePath: async (name) => {
      await rpc.call('mediamtx.config.paths.delete', { name })
      if (snapshot.selected === name) emit({ selected: null })
      await refresh()
    },
    kickSession: async (kind, id) => {
      await rpc.call('mediamtx.sessions.kick', { kind, id })
      await refresh()
    },
  }
  return store
}
