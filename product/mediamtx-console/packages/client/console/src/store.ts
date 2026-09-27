// Console state — one polled snapshot of the server plus the panels' local
// targets (player chain, sync wall, recording browser, server registry,
// config review).
//
// The reference project (analyzed at feature level only) polls every 3s; same
// here. Fast data (paths/sessions/metrics) refreshes every cycle; slow data
// (info/endpoints) every fifth — server identity does not change while you
// watch. Polling pauses while the browser tab is hidden and stops with the
// plugin (ctx.effect cleanup), so a composed-but-closed console costs nothing.
//
// React contract: one immutable snapshot object + subscribe(listener),
// consumed through useSyncExternalStore — the same observable-store shape the
// openvideo editor uses. All panels share ONE store instance provided on the
// context, so they poll the server once, not once per panel.

import type { Endpoints, ManagedServer, MetricsSummary, PathRow, PlaybackEntry, ServerInfo, SessionKind, SessionRow } from '@mtxconsole/protocol'
import type { RpcService } from '@mediabase/connection'
import { SYNC_MAX_SLOTS, type SyncLayout, type SyncSlot } from './sync.ts'

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
  /** A recording CHAIN on the player stage (mutually exclusive with
   * `selected`): consecutive windows of one path; when window `index` ends
   * the player advances to the next — cross-window playback without another
   * click. `label` identifies where the chain started. */
  recording: { playlist: PlaybackEntry[]; index: number; label: string } | null
  /** Recording-browser state (on-demand; NOT part of the polling loop). */
  recPaths: string[]
  recPath: string | null
  recEntries: PlaybackEntry[]
  recLoading: boolean
  recError: string | null
  /** Managed-server registry (M3) + which server every method routes to. */
  servers: ManagedServer[]
  activeServer: string | null
  serversError: string | null
  /** Global-config review state (on-demand; NOT part of the polling loop). */
  cfg: Record<string, unknown> | null
  cfgLoading: boolean
  cfgSaving: boolean
  cfgError: string | null
  /** Synchronized-playback wall (M3): fixed-length grid of recording windows.
   * Declarative state only — the master clock lives in the panel (60fps ticks
   * must not re-emit the snapshot every other panel reads). */
  syncSlots: ReadonlyArray<SyncSlot | null>
  syncLayout: SyncLayout
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
  /** Put a recording chain on the stage (clears any live selection). */
  playRecording(playlist: PlaybackEntry[], index: number, label: string): void
  /** Advance to the chain's next window; past the last one the stage clears. */
  advanceRecording(): void
  /** Jump the chain to another window (the panel owns the in-window seek). */
  seekRecording(index: number): void
  stopRecording(): void
  /** Refresh the list of paths that have recordings. */
  loadRecordingPaths(): Promise<void>
  /** Pick a recorded path and fetch its playable windows. */
  selectRecordingPath(name: string | null): Promise<void>
  /** Refresh the managed-server registry + the active pick. */
  loadServers(): Promise<void>
  /** Route everything to another registered server and drop stale views. */
  switchServer(name: string): Promise<void>
  addServer(entry: { name: string; url: string; username?: string; password?: string; token?: string }): Promise<void>
  /** In-place credential/url rotation (blank credential fields keep). */
  updateServer(entry: { name: string; url?: string; username?: string; password?: string; token?: string }): Promise<void>
  removeServer(name: string): Promise<void>
  /** Fetch the flat global config for review (config panel). */
  loadGlobalConfig(): Promise<void>
  /** Subset-patch the global config, then re-read it (the server normalizes). */
  patchGlobalConfig(values: Record<string, unknown>): Promise<void>
  /** Park a recording window in grid cell `index` (null clears the cell). */
  syncAssign(index: number, slot: SyncSlot | null): void
  syncSetLayout(layout: SyncLayout): void
  syncClear(): void
  refresh(): Promise<void>
}

/** A fresh 9-cell grid — a new array every time (snapshots are immutable). */
function emptySyncSlots(): Array<SyncSlot | null> {
  return Array.from({ length: SYNC_MAX_SLOTS }, () => null)
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
  recording: null,
  recPaths: [],
  recPath: null,
  recEntries: [],
  recLoading: false,
  recError: null,
  servers: [],
  activeServer: null,
  serversError: null,
  cfg: null,
  cfgLoading: false,
  cfgSaving: false,
  cfgError: null,
  syncSlots: emptySyncSlots(),
  syncLayout: 4,
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
      void store.loadServers()
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    select: (name) => emit({ selected: name, recording: null }),
    setPlayMode: (mode) => emit({ playMode: mode }),
    refresh,
    playRecording: (playlist, index, label) => emit({
      recording: playlist.length === 0 ? null : { playlist, index: Math.max(0, Math.min(index, playlist.length - 1)), label },
      selected: null,
    }),
    advanceRecording: () => {
      const rec = snapshot.recording
      if (rec === null) return
      // Past the last window the stage clears — a chain that loops would
      // silently re-fetch the same bytes forever.
      emit({ recording: rec.index + 1 < rec.playlist.length ? { ...rec, index: rec.index + 1 } : null })
    },
    seekRecording: (index) => {
      const rec = snapshot.recording
      if (rec === null) return
      const i = Math.max(0, Math.min(Math.trunc(index), rec.playlist.length - 1))
      if (i === rec.index) return // the panel seeks within the window itself
      emit({ recording: { ...rec, index: i } })
    },
    stopRecording: () => emit({ recording: null }),
    loadRecordingPaths: async () => {
      try {
        const res = await rpc.call<{ recordings: Array<{ name: string }> }>('mediamtx.recordings.list', {})
        const names = res.recordings.map((r) => r.name)
        emit({ recPaths: names })
        // Nothing selected yet and exactly one recorded path — open it
        // straight away; single-camera setups are the common case.
        if (snapshot.recPath === null && names.length === 1) await store.selectRecordingPath(names[0]!)
      } catch {
        // The recordings index is a convenience list — a failed fetch leaves
        // the previous list in place; the entry fetch surfaces real errors.
      }
    },
    selectRecordingPath: async (name) => {
      if (name === null) {
        emit({ recPath: null, recEntries: [], recLoading: false, recError: null })
        return
      }
      emit({ recPath: name, recEntries: [], recLoading: true, recError: null })
      try {
        const res = await rpc.call<{ entries: PlaybackEntry[] }>('mediamtx.playback.list', { name })
        // A late answer for a previously selected path must not overwrite the
        // current selection (the user clicked another path meanwhile).
        if (snapshot.recPath === name) emit({ recEntries: res.entries, recLoading: false })
      } catch (e) {
        if (snapshot.recPath === name) {
          emit({ recLoading: false, recError: e instanceof Error ? e.message : String(e) })
        }
      }
    },
    loadServers: async () => {
      try {
        const res = await rpc.call<{ servers: ManagedServer[]; active: string }>('mediamtx.servers.list', {})
        emit({ servers: res.servers, activeServer: res.active, serversError: null })
      } catch (e) {
        emit({ serversError: e instanceof Error ? e.message : String(e) })
      }
    },
    switchServer: async (name) => {
      const res = await rpc.call<{ active: string }>('mediamtx.servers.switch', { name })
      // A different server makes every cached view a lie: drop the stage,
      // the wall, the recording browser and the config review, then re-poll.
      emit({
        activeServer: res.active,
        selected: null,
        recording: null,
        syncSlots: emptySyncSlots(),
        recPaths: [],
        recPath: null,
        recEntries: [],
        recLoading: false,
        recError: null,
        cfg: null,
        cfgError: null,
        serversError: null,
      })
      await Promise.all([refresh(), store.loadServers()])
    },
    addServer: async (entry) => {
      await rpc.call('mediamtx.servers.add', entry)
      await store.loadServers()
    },
    updateServer: async (entry) => {
      await rpc.call('mediamtx.servers.update', entry)
      await store.loadServers()
    },
    removeServer: async (name) => {
      await rpc.call('mediamtx.servers.remove', { name })
      await store.loadServers()
    },
    loadGlobalConfig: async () => {
      emit({ cfgLoading: true, cfgError: null })
      try {
        const res = await rpc.call<{ config: Record<string, unknown> }>('mediamtx.config.global.get', {})
        emit({ cfg: res.config, cfgLoading: false })
      } catch (e) {
        emit({ cfgLoading: false, cfgError: e instanceof Error ? e.message : String(e) })
      }
    },
    patchGlobalConfig: async (values) => {
      emit({ cfgSaving: true, cfgError: null })
      try {
        await rpc.call('mediamtx.config.global.patch', { values })
        // Re-read after patching: the server normalizes values (and a changed
        // listener address reboots that listener) — the panel must show truth.
        const res = await rpc.call<{ config: Record<string, unknown> }>('mediamtx.config.global.get', {})
        emit({ cfg: res.config, cfgSaving: false })
      } catch (e) {
        emit({ cfgSaving: false, cfgError: e instanceof Error ? e.message : String(e) })
        throw e
      }
    },
    syncAssign: (index, slot) => {
      // Out-of-range writes are dropped, not wrapped: a stale drag from an
      // older tab must not corrupt the grid.
      if (!Number.isInteger(index) || index < 0 || index >= SYNC_MAX_SLOTS) return
      const next = [...snapshot.syncSlots]
      next[index] = slot
      emit({ syncSlots: next })
    },
    syncSetLayout: (layout) => emit({ syncLayout: layout }),
    syncClear: () => emit({ syncSlots: emptySyncSlots() }),
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
