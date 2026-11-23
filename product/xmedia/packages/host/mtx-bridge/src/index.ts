// @xmedia/host-mtx-bridge — host plugin: the MediaMTX bridge capability.
//
// WHY A HOST BRIDGE (the browser could talk to MediaMTX directly): the API
// credentials stay on the host (the page never sees them), cross-origin is
// solved once (MediaMTX's API has no CORS for arbitrary origins), and every
// panel/agent/tool consumes ONE normalized vocabulary instead of eight
// per-protocol shapes and a 122-key config blob. Bytes do NOT flow through
// here: live media goes browser ⇄ MediaMTX directly (WHEP/HLS on their own
// ports) — the control plane stays commands-only, as the base demands.
//
// Clean-room: the API surface was derived from a running MediaMTX v1.21 (MIT)
// and its published route table; no third-party console's code was read.

import { existsSync, readFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { parse, z, type Schema } from '@mediabase/schema'
import { RpcCode, RpcError } from '@mediabase/rpc'
// Type-only: registry services are declared by the base packages.
import type {} from '@mediabase/log'
import type {} from '@mediabase/api'
import {
  EndpointsS,
  MetricsSummary,
  PathRowS,
  PlaybackEntryS,
  SESSION_KINDS,
  SESSION_KICK_ROUTE,
  SESSION_LIST_ROUTE,
  ServerInfoS,
  SessionRowS,
  ManagedServerS,
  addressToUrl,
  classifyUpstream,
  parseMetrics,
  parsePlaybackList,
  rewriteOrigin,
  toPathRow,
  toRecordingRow,
  toSessionRow,
  type Endpoints,
  type ManagedServer,
  type PathRow,
  type PlaybackEntry,
  type SessionKind,
  type SessionRow,
} from '@xmedia/mtx-protocol'

export const name = 'mediamtx'

export const inject = ['api', 'capabilities', 'tools', 'log'] as const

export interface BridgeConfig {
  /** MediaMTX API base, e.g. http://127.0.0.1:9997 */
  serverUrl?: string
  /** Name of the env-seeded server in the registry (default "default"). */
  serverName?: string
  /** Basic-auth user for the API (MediaMTX `auth*` settings), when enabled. */
  username?: string
  password?: string
  /** Static bearer token (MediaMTX JWT auth); takes precedence over basic. */
  serverToken?: string
  /** Per-request timeout (default 8000 ms). */
  timeoutMs?: number
  /** Registry file; default `<appPaths.home>/xmedia-mtx-servers.json`. */
  serversFile?: string
  /** MediaMTX binary; empty = probe PATH + the usual local install spots. */
  binary?: string
  /** MediaMTX config file; empty = `<appPaths.root>/mediamtx.yml`. */
  configPath?: string
  /** Spawn the managed MediaMTX process when the host boots (default false). */
  autoStart?: boolean
  /** How long `mediamtx.start` waits for the API to answer after spawn. */
  startTimeoutMs?: number
}

export const Config: Schema<BridgeConfig, BridgeConfig> = z.object({
  serverUrl: z.string().default('http://127.0.0.1:9997').description('MediaMTX API base URL'),
  serverName: z.string().description('name of the env-seeded server (default "default")'),
  username: z.string().description('API basic-auth user'),
  password: z.string().description('API basic-auth password'),
  serverToken: z.string().description('static bearer/JWT for the API; takes precedence over basic'),
  timeoutMs: z.natural().default(8000).description('per-request timeout'),
  serversFile: z.string().description('server-registry JSON path; default <home>/xmedia-mtx-servers.json'),
  binary: z.string().description('MediaMTX binary path; empty = probe PATH + local install spots'),
  configPath: z.string().description('MediaMTX config file; empty = <appPaths.root>/mediamtx.yml'),
  autoStart: z.boolean().default(false).description('spawn the managed MediaMTX process on host boot'),
  startTimeoutMs: z.natural().default(10000).description('wait for the API after spawn (ms)'),
})

const API_METHODS = [
  'mediamtx.status',
  'mediamtx.start',
  'mediamtx.info',
  'mediamtx.endpoints',
  'mediamtx.paths.list',
  'mediamtx.paths.get',
  'mediamtx.config.paths.add',
  'mediamtx.config.paths.patch',
  'mediamtx.config.paths.delete',
  'mediamtx.config.global.get',
  'mediamtx.config.global.patch',
  'mediamtx.sessions.list',
  'mediamtx.sessions.kick',
  'mediamtx.metrics',
  'mediamtx.recordings.list',
  'mediamtx.recordings.get',
  'mediamtx.recordings.deleteAll',
  'mediamtx.playback.list',
  'mediamtx.servers.list',
  'mediamtx.servers.add',
  'mediamtx.servers.update',
  'mediamtx.servers.remove',
  'mediamtx.servers.switch',
] as const

const TOOL_NAMES = [
  'mediamtx.status',
  'mediamtx.info',
  'mediamtx.endpoints',
  'mediamtx.paths.list',
  'mediamtx.path.add',
  'mediamtx.path.delete',
  'mediamtx.sessions.kick',
  'mediamtx.servers.list',
  'mediamtx.servers.switch',
] as const

// ---- wire schemas ------------------------------------------------------------

const PathRowsS = z.object({ paths: z.array(PathRowS).required() })
const PathRowS1 = z.object({ path: PathRowS.required() })
const OkS = z.object({ ok: z.const(true).required() })
const OK: { ok: true } = { ok: true }
const SessionsS = z.object({ sessions: z.array(SessionRowS).required() })
const EndpointsS1 = z.object({ endpoints: EndpointsS.required() })
const ServerInfoS1 = z.object({ info: ServerInfoS.required() })
const ManagedServerS1 = z.object({ server: ManagedServerS.required() })
const ServersListS = z.object({
  servers: z.array(ManagedServerS).required(),
  active: z.string().required(),
})
const ServerActiveS = z.object({ active: z.string().required() })
const NullableStringS = z.union([z.string(), z.const(null)])
const NullableNumberS = z.union([z.number(), z.const(null)])
const MtxProcessStatusS = z.object({
  /** The API answers — the only honest liveness check for a foreign process. */
  online: z.boolean().required(),
  /** A start() is currently waiting for the API to come up. */
  starting: z.boolean().required(),
  /** True when this host owns the running child (false for a manual/external one). */
  managed: z.boolean().required(),
  pid: NullableNumberS,
  api: z.string().required(),
  binary: z.string().required(),
  config: z.string().required(),
  error: NullableStringS,
})
const MtxStatusResultS = z.object({ status: MtxProcessStatusS.required() })

const kindS = z.union(SESSION_KINDS.map((k) => z.const(k)) as never)

export function apply(ctx: Context, rawConfig: BridgeConfig): void {
  const config = parse(Config, rawConfig ?? {})
  const log = ctx.log.child(name)
  const timeoutMs = config.timeoutMs ?? 8000

  // ---- the server registry (M3: one console, several MediaMTX servers) --------
  //
  // The env-seeded server always exists and wins name clashes; servers
  // registered at runtime persist to a JSON file under the host identity's
  // home (the base settings.json pattern — credentials are host-side ONLY,
  // plaintext on disk, never on the wire). The ACTIVE pick persists too, so a
  // restart comes back where the operator left off.

  /** A registered server WITH its credentials (never leaves the host). */
  interface ServerEntry {
    name: string
    url: string
    username?: string
    password?: string
    token?: string
  }

  /** Trim + strip trailing slashes; null when not an absolute http(s) URL. */
  const normalizeUrl = (raw: string): string | null => {
    const trimmed = raw.trim().replace(/\/+$/, '')
    if (trimmed === '') return null
    try {
      const u = new URL(trimmed)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    } catch {
      return null
    }
    return trimmed
  }

  const seedUrl = normalizeUrl(config.serverUrl ?? '') ?? 'http://127.0.0.1:9997'
  const seedName = (config.serverName ?? '').trim() === '' ? 'default' : (config.serverName ?? '').trim()
  const seed: ServerEntry = {
    name: seedName,
    url: seedUrl,
    ...(config.username !== undefined ? { username: config.username, password: config.password ?? '' } : {}),
    ...(config.serverToken !== undefined && config.serverToken !== '' ? { token: config.serverToken } : {}),
  }

  const appHome = (ctx.get('appPaths') as { home?: string } | undefined)?.home
  const registryFile = config.serversFile
    ?? join(appHome ?? join(homedir(), '.xmedia'), 'xmedia-mtx-servers.json')

  /** Best-effort load: a corrupt registry must not stop the host booting. */
  const persisted = ((): { active?: unknown; servers?: unknown } => {
    try {
      const raw = JSON.parse(readFileSync(registryFile, 'utf8')) as unknown
      return raw !== null && typeof raw === 'object' ? raw as { active?: unknown; servers?: unknown } : {}
    } catch {
      return {}
    }
  })()

  const servers: ServerEntry[] = [seed]
  for (const item of Array.isArray(persisted.servers) ? persisted.servers : []) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const nm = typeof raw.name === 'string' ? raw.name.trim() : ''
    const url = typeof raw.url === 'string' ? normalizeUrl(raw.url) : null
    if (nm === '' || url === null || nm === seedName) continue // env seed wins its name
    if (servers.some((s) => s.name === nm)) continue
    servers.push({
      name: nm,
      url,
      ...(typeof raw.username === 'string' && raw.username !== ''
        ? { username: raw.username, password: typeof raw.password === 'string' ? raw.password : '' }
        : {}),
      ...(typeof raw.token === 'string' && raw.token !== '' ? { token: raw.token } : {}),
    })
  }
  let activeName = typeof persisted.active === 'string' && servers.some((s) => s.name === persisted.active)
    ? persisted.active
    : seedName

  /** Last known server info, for the health payload (no probing in health). */
  let lastVersion: string | null = null

  function activeServer(): ServerEntry {
    return servers.find((s) => s.name === activeName) ?? seed
  }

  /** Bearer wins over basic: a JWT-configured server never also sends basic. */
  function authHeaderFor(srv: ServerEntry): string | null {
    if (srv.token !== undefined && srv.token !== '') return `Bearer ${srv.token}`
    if (srv.username !== undefined) return `Basic ${Buffer.from(`${srv.username}:${srv.password ?? ''}`).toString('base64')}`
    return null
  }

  /**
   * Best-effort decode of a JWT's `exp` claim (epoch seconds). NO signature
   * verification — that is the streaming server's job and needs its keys;
   * this is a UX warning so an expiring token is visible before it turns
   * into a mysterious upstream 401.
   */
  function decodeTokenExp(token: string): number | null {
    const parts = token.split('.')
    if (parts.length < 2) return null
    try {
      const json = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')
      const obj = JSON.parse(json) as unknown
      const exp = obj !== null && typeof obj === 'object' ? (obj as { exp?: unknown }).exp : undefined
      return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
    } catch {
      return null
    }
  }

  function publicView(srv: ServerEntry): ManagedServer {
    const bearer = srv.token !== undefined && srv.token !== ''
    return {
      name: srv.name,
      url: srv.url,
      auth: bearer ? 'bearer' : srv.username !== undefined ? 'basic' : 'none',
      expiresAt: bearer ? decodeTokenExp(srv.token ?? '') : null,
    }
  }

  /**
   * WRITE the next registry state first, commit to memory only after the file
   * agrees (the settings-package rule: a failed write must never leave the
   * host reporting state that was not persisted).
   */
  async function persistRegistry(nextServers: ServerEntry[], nextActive: string): Promise<void> {
    try {
      await mkdir(dirname(registryFile), { recursive: true })
      await writeFile(registryFile, JSON.stringify({ active: nextActive, servers: nextServers }, null, 2))
    } catch (e) {
      throw new RpcError(
        RpcCode.INTERNAL,
        `cannot persist the server registry at ${registryFile}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  async function switchActive(nm: string): Promise<string> {
    if (!servers.some((s) => s.name === nm)) {
      throw new RpcError(RpcCode.NOT_FOUND, `no such server: ${nm}`, undefined, {
        messageKey: 'mediamtx.serverUnknown',
        messageParams: { name: nm },
      })
    }
    if (nm !== activeName) {
      await persistRegistry(servers, nm)
      activeName = nm
      // A different server has a different identity; do not report the old one.
      lastVersion = null
      log.info(`active MediaMTX server → ${nm}`)
    }
    return activeName
  }

  /** One HTTP call to the ACTIVE MediaMTX, whole error contract in one place. */
  async function mtx<T>(method: string, path: string, body?: unknown): Promise<T> {
    const srv = activeServer()
    const auth = authHeaderFor(srv)
    const headers: Record<string, string> = {}
    if (auth !== null) headers.authorization = auth
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await fetch(`${srv.url}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      throw new RpcError(RpcCode.UNAVAILABLE, `MediaMTX unreachable at ${srv.url}: ${(e as Error).message}`, undefined, {
        messageKey: 'mediamtx.unreachable',
        messageParams: { url: srv.url },
      })
    }
    const text = await res.text()
    const parsed: unknown = text === '' ? null : JSON.parse(text) as unknown
    if (!res.ok) {
      const failure = classifyUpstream(res.status, parsed)
      const code = failure.kind === 'not_found'
        ? RpcCode.NOT_FOUND
        : failure.kind === 'invalid'
          ? RpcCode.INVALID_PARAMS
          : failure.kind === 'unavailable'
            ? RpcCode.UNAVAILABLE
            : RpcCode.CONFLICT
      throw new RpcError(code, `MediaMTX: ${failure.detail}`, { status: res.status, detail: failure.detail }, {
        messageKey: 'mediamtx.upstream',
        messageParams: { status: String(res.status), detail: failure.detail },
      })
    }
    return parsed as T
  }

  // ---- local MediaMTX process supervision -----------------------------------
  // Every method above talks to WHATEVER server is active (possibly remote).
  // These two are deliberately about the LOCAL process: the acceptance page
  // needs one button that starts the MediaMTX this product ships, plus an
  // honest status light. A foreign/manual MediaMTX is detected through the API
  // probe and is never spawned again or killed by us.

  interface MtxProcessStatus {
    online: boolean
    starting: boolean
    managed: boolean
    pid: number | null
    api: string
    binary: string
    config: string
    error: string | null
  }

  const processPaths = (ctx.get('appPaths') as { root?: string } | undefined) ?? {}
  const resolveBinary = (): string => {
    if (config.binary !== undefined && config.binary !== '') return config.binary
    const candidates = [
      processPaths.root === undefined ? '' : join(processPaths.root, 'mediamtx'),
      join(homedir(), '.local', 'bin', 'mediamtx'),
      '/usr/local/bin/mediamtx',
      '/opt/homebrew/bin/mediamtx',
    ].filter((c) => c !== '')
    for (const c of candidates) if (existsSync(c)) return c
    return 'mediamtx' // PATH fallback; a miss surfaces as a start() error
  }
  const mtxBinary = resolveBinary()
  const mtxConfigFile = config.configPath !== undefined && config.configPath !== ''
    ? config.configPath
    : processPaths.root === undefined ? 'mediamtx.yml' : join(processPaths.root, 'mediamtx.yml')

  let mtxChild: ChildProcess | null = null
  let mtxStarting = false
  let mtxError: string | null = null

  const childAlive = (child: ChildProcess | null): boolean =>
    child !== null && child.exitCode === null && child.signalCode === null

  /** The API answering is the only honest liveness check for a foreign child. */
  const probeOnline = async (): Promise<boolean> => {
    try {
      const srv = activeServer()
      const auth = authHeaderFor(srv)
      const res = await fetch(`${srv.url}/v3/paths/list?itemsPerPage=1`, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(timeoutMs, 2000)),
        headers: auth === null ? {} : { authorization: auth },
      })
      return res.ok
    } catch {
      return false
    }
  }

  const readStatus = async (): Promise<MtxProcessStatus> => {
    const online = await probeOnline()
    if (online) mtxError = null
    return {
      online,
      starting: mtxStarting,
      managed: childAlive(mtxChild),
      pid: childAlive(mtxChild) ? mtxChild?.pid ?? null : null,
      api: activeServer().url,
      binary: mtxBinary,
      config: mtxConfigFile,
      error: mtxError,
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const startProcess = async (): Promise<MtxProcessStatus> => {
    if (mtxStarting) return readStatus()
    // Already up — possibly a manual/external server. Never spawn a second one
    // on the same ports; that is exactly the confusion this button removes.
    if (await probeOnline()) return readStatus()
    if (!existsSync(mtxConfigFile)) {
      throw new RpcError(RpcCode.NOT_FOUND, `MediaMTX config not found: ${mtxConfigFile}`, undefined, {
        messageKey: 'mediamtx.configMissing',
        messageParams: { path: mtxConfigFile },
      })
    }
    mtxStarting = true
    mtxError = null
    try {
      if (!childAlive(mtxChild)) {
        const child = spawn(mtxBinary, [mtxConfigFile], {
          ...(processPaths.root === undefined ? {} : { cwd: processPaths.root }),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        mtxChild = child
        const relay = (chunk: Buffer): void => {
          const line = String(chunk).trimEnd()
          if (line !== '') log.debug('[mediamtx]', { line })
        }
        child.stdout?.on('data', relay)
        child.stderr?.on('data', relay)
        child.on('error', (err) => {
          mtxError = err.message
          mtxChild = null
          log.warn('MediaMTX 进程启动失败', { error: err.message })
        })
        child.on('exit', (code, signal) => {
          if (mtxChild === child) mtxChild = null
          log.warn('MediaMTX 进程退出', { code, signal })
          ctx.events.emit('mediamtx.process', { phase: 'exit', code, signal })
        })
        log.info('MediaMTX 已启动', { binary: mtxBinary, config: mtxConfigFile, pid: child.pid ?? null })
        ctx.events.emit('mediamtx.process', { phase: 'start', pid: child.pid ?? null })
      }
      // Wait for the API, not a fixed sleep: "spawned" does not mean the
      // HTTP/RTMP listeners are accepting connections yet.
      const waitMs = config.startTimeoutMs ?? 10000
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline) {
        await sleep(200)
        if (await probeOnline()) return readStatus()
      }
      mtxError = `MediaMTX API 在 ${waitMs}ms 内未响应: ${activeServer().url}`
      throw new RpcError(RpcCode.UNAVAILABLE, mtxError, undefined, {
        messageKey: 'mediamtx.startTimeout',
        messageParams: { url: activeServer().url },
      })
    } finally {
      mtxStarting = false
    }
  }

  /** The flat global config (122 keys upstream; we pass it through as a dict). */
  const globalConfig = (): Promise<Record<string, unknown>> =>
    mtx<Record<string, unknown>>('GET', '/v3/config/global/get')

  const str = (cfg: Record<string, unknown>, key: string): string | undefined =>
    typeof cfg[key] === 'string' ? (cfg[key] as string) : undefined

  async function deriveEndpoints(): Promise<Endpoints> {
    const serverUrl = activeServer().url
    const cfg = await globalConfig()
    // MediaMTX keeps the ADDRESS defaults even for disabled servers (observed
    // on v1.21: `webrtc: no` still reports webrtcAddress ":8889"), so the
    // enable flag — not the address — decides whether an endpoint exists. An
    // absent flag (older servers) counts as enabled: the address governs.
    const on = (key: string): boolean => cfg[key] !== false
    return {
      api: serverUrl,
      webrtc: on('webrtc') ? addressToUrl(str(cfg, 'webrtcAddress'), serverUrl) : null,
      hls: on('hls') ? addressToUrl(str(cfg, 'hlsAddress'), serverUrl) : null,
      rtsp: on('rtsp') ? addressToUrl(str(cfg, 'rtspAddress'), serverUrl, 'rtsp') : null,
      rtmp: on('rtmp') ? addressToUrl(str(cfg, 'rtmpAddress'), serverUrl, 'rtmp') : null,
      srt: on('srt') ? addressToUrl(str(cfg, 'srtAddress'), serverUrl, 'srt') : null,
      metrics: on('metrics') ? addressToUrl(str(cfg, 'metricsAddress'), serverUrl) : null,
      playback: on('playback') ? addressToUrl(str(cfg, 'playbackAddress'), serverUrl) : null,
    }
  }

  /** Runtime paths + the config's record flags, merged into PathRows. */
  async function listPaths(): Promise<PathRow[]> {
    interface Page { items?: unknown[] }
    const [runtime, confRes] = await Promise.all([
      mtx<Page>('GET', '/v3/paths/list?itemsPerPage=500'),
      mtx<Page>('GET', '/v3/config/paths/list?itemsPerPage=500').catch(() => ({ items: [] })),
    ])
    const confFacts = new Map<string, { record: boolean; source?: string }>()
    for (const item of confRes.items ?? []) {
      if (item !== null && typeof item === 'object') {
        const c = item as Record<string, unknown>
        if (typeof c.name === 'string') {
          confFacts.set(c.name, {
            record: c.record === true,
            ...(typeof c.source === 'string' ? { source: c.source } : {}),
          })
        }
      }
    }
    const rows: PathRow[] = []
    for (const item of runtime.items ?? []) {
      const pathName = (item as { name?: string })?.name ?? ''
      const row = toPathRow(item, confFacts.get(pathName) ?? { record: false })
      if (row !== null) rows.push(row)
    }
    return rows
  }

  async function listSessions(kinds: readonly SessionKind[]): Promise<SessionRow[]> {
    interface Page { items?: unknown[] }
    const results = await Promise.all(kinds.map(async (kind): Promise<SessionRow[]> => {
      try {
        const page = await mtx<Page>('GET', `${SESSION_LIST_ROUTE[kind]}?itemsPerPage=500`)
        return (page.items ?? []).map((item) => toSessionRow(kind, item)).filter((r): r is SessionRow => r !== null)
      } catch {
        // A kind whose server is disabled answers 404 — not an error worth
        // surfacing when the caller asked for "everything".
        return []
      }
    }))
    return results.flat()
  }

  // ---- control plane ----------------------------------------------------------

  ctx.api.register({
    name: 'mediamtx.status',
    description: '本地 MediaMTX 服务状态：API 是否响应、进程 PID、二进制/配置路径与最近错误（探测活动服务器，不代理任何字节）',
    params: z.object({}),
    result: MtxStatusResultS,
    handler: async () => ({ status: await readStatus() }),
  })

  ctx.api.register({
    name: 'mediamtx.start',
    description: '按需启动本地 MediaMTX：先探测 API，已在运行则什么都不做；否则拉起本产品自带的进程并等待 API 就绪',
    mutates: true,
    params: z.object({}),
    result: MtxStatusResultS,
    handler: async () => ({ status: await startProcess() }),
  })

  ctx.api.register({
    name: 'mediamtx.info',
    description: 'MediaMTX 服务器身份(/v3/info:版本与启动时间)与 API 地址',
    params: z.object({}),
    result: ServerInfoS1,
    handler: async () => {
      const info = await mtx<{ version: string; started: string }>('GET', '/v3/info')
      lastVersion = info.version
      return { info: { version: info.version, started: info.started, apiBase: activeServer().url } }
    },
  })

  ctx.api.register({
    name: 'mediamtx.endpoints',
    description: '浏览器该连哪里:从全局配置推导 webrtc(WHEP)/hls/rtsp/rtmp/srt/metrics/playback 的绝对地址',
    params: z.object({}),
    result: EndpointsS1,
    handler: async () => ({ endpoints: await deriveEndpoints() }),
  })

  ctx.api.register({
    name: 'mediamtx.paths.list',
    description: '流路径列表(归一化:就绪态/源/观看者/码率/轨道/录制开关)',
    params: z.object({}),
    result: PathRowsS,
    handler: async () => ({ paths: await listPaths() }),
  })

  ctx.api.register({
    name: 'mediamtx.paths.get',
    description: '单个流路径详情',
    params: z.object({ name: z.string().min(1).required() }),
    result: PathRowS1,
    handler: async (p) => {
      const raw = await mtx<unknown>('GET', `/v3/paths/get/${encodeURIComponent(p.name)}`)
      const row = toPathRow(raw, { record: false })
      if (row === null) throw new RpcError(RpcCode.INTERNAL, 'unexpected path shape from MediaMTX')
      return { path: row }
    },
  })

  ctx.api.register({
    name: 'mediamtx.config.paths.add',
    description: '新建路径;给 source 即拉流源(如 rtsp:// 摄像头),留空则等待推流(publisher)',
    mutates: true,
    params: z.object({
      name: z.string().min(1).max(200).required(),
      source: z.string().max(2000).description('static source URL; omit for a publish-point'),
      record: z.boolean(),
    }),
    result: OkS,
    handler: async (p) => {
      const body: Record<string, unknown> = {}
      if (p.source !== undefined && p.source.trim() !== '') body.source = p.source.trim()
      if (p.record !== undefined) body.record = p.record
      await mtx('POST', `/v3/config/paths/add/${encodeURIComponent(p.name)}`, body)
      log.info(`path added: ${p.name}${body.source !== undefined ? ` ← ${String(body.source)}` : ' (publisher)'}`)
      return OK
    },
  })

  ctx.api.register({
    name: 'mediamtx.config.paths.patch',
    description: '改路径配置(source/record 的子集补丁)',
    mutates: true,
    params: z.object({
      name: z.string().min(1).required(),
      source: z.string().max(2000),
      record: z.boolean(),
    }),
    result: OkS,
    handler: async (p) => {
      const body: Record<string, unknown> = {}
      if (p.source !== undefined) body.source = p.source.trim()
      if (p.record !== undefined) body.record = p.record
      await mtx('PATCH', `/v3/config/paths/patch/${encodeURIComponent(p.name)}`, body)
      return OK
    },
  })

  ctx.api.register({
    name: 'mediamtx.config.paths.delete',
    description: '删除路径',
    mutates: true,
    params: z.object({ name: z.string().min(1).required() }),
    result: OkS,
    handler: async (p) => {
      await mtx('DELETE', `/v3/config/paths/delete/${encodeURIComponent(p.name)}`)
      log.info(`path deleted: ${p.name}`)
      return OK
    },
  })

  ctx.api.register({
    name: 'mediamtx.config.global.get',
    description: '全局配置原样(122 键平面字典;只读审阅用)',
    params: z.object({}),
    result: z.object({ config: z.dict(z.any()).required() }),
    handler: async () => ({ config: await globalConfig() }),
  })

  ctx.api.register({
    name: 'mediamtx.config.global.patch',
    description: '全局配置子集补丁(小心:改监听地址等会立即生效)',
    mutates: true,
    params: z.object({ values: z.dict(z.any()).required() }),
    result: OkS,
    handler: async (p) => {
      await mtx('PATCH', '/v3/config/global/patch', p.values)
      log.warn('global config patched', { keys: Object.keys(p.values) })
      return OK
    },
  })

  ctx.api.register({
    name: 'mediamtx.sessions.list',
    description: '会话列表(八种协议归一化);省略 kind 则聚合全部(被禁用的协议静默跳过)',
    params: z.object({ kind: kindS }),
    result: SessionsS,
    handler: async (p) => ({
      sessions: await listSessions(p.kind !== undefined ? [p.kind as SessionKind] : SESSION_KINDS),
    }),
  })

  ctx.api.register({
    name: 'mediamtx.sessions.kick',
    description: '踢掉一个会话(全部 8 种协议均可踢，含 rtmp 发布者；踢掉发布者会中断该路推流)',
    mutates: true,
    params: z.object({
      kind: kindS.required(),
      id: z.string().min(1).required(),
    }),
    result: OkS,
    handler: async (p) => {
      const route = SESSION_KICK_ROUTE[p.kind as SessionKind]
      if (route === null) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `${p.kind} sessions cannot be kicked`, undefined, {
          messageKey: 'mediamtx.notKickable',
          messageParams: { kind: String(p.kind) },
        })
      }
      await mtx('POST', `${route}${encodeURIComponent(p.id)}`)
      return OK
    },
  })

  ctx.api.register({
    name: 'mediamtx.metrics',
    description: 'Prometheus 指标摘要(就绪/未就绪路径数、观看者、每路径进出字节)',
    params: z.object({}),
    handler: async (): Promise<MetricsSummary> => {
      const endpoints = await deriveEndpoints()
      if (endpoints.metrics === null) {
        throw RpcError.unavailable('metrics are disabled on this MediaMTX server', undefined, {
          messageKey: 'mediamtx.noMetrics',
        })
      }
      let text: string
      try {
        const res = await fetch(`${endpoints.metrics}/metrics`, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        text = await res.text()
      } catch (e) {
        throw new RpcError(RpcCode.UNAVAILABLE, `metrics unreachable: ${(e as Error).message}`, undefined, {
          messageKey: 'mediamtx.unreachable',
          messageParams: { url: `${endpoints.metrics}/metrics` },
        })
      }
      return parseMetrics(text)
    },
  })

  ctx.api.register({
    name: 'mediamtx.recordings.list',
    description: '有录像的路径与天粒度概要',
    params: z.object({}),
    handler: async (): Promise<{ recordings: unknown[] }> => {
      interface Page { items?: unknown[] }
      const page = await mtx<Page>('GET', '/v3/recordings/list?itemsPerPage=500')
      return { recordings: (page.items ?? []).map(toRecordingRow).filter((r) => r !== null) }
    },
  })

  ctx.api.register({
    name: 'mediamtx.recordings.get',
    description: '一个路径的录像天/段明细',
    params: z.object({ name: z.string().min(1).required() }),
    handler: async (p): Promise<{ recording: unknown }> => {
      const raw = await mtx<unknown>('GET', `/v3/recordings/get/${encodeURIComponent(p.name)}`)
      const row = toRecordingRow(raw)
      if (row === null) throw new RpcError(RpcCode.INTERNAL, 'unexpected recording shape from MediaMTX')
      return { recording: row }
    },
  })

  // MediaMTX exposes only per-segment deletion (DELETE
  // /v3/recordings/segments/delete?path=&start=). "Delete everything" is an
  // aggregation of that primitive over every recorded path/segment. The
  // explicit `confirm` literal keeps an accidental RPC from wiping a disk;
  // an optional `path` allows targeted cleanup. Per-segment failures are
  // counted (not thrown) so one busy/already-gone file cannot abort the rest.
  ctx.api.register({
    name: 'mediamtx.recordings.deleteAll',
    description: '一键删除所有录像段（不可恢复；按段逐个聚合 MediaMTX 原语）',
    params: z.object({
      confirm: z.const(true).required().description('must be true — destructive operation'),
      path: z.string().description('仅清理指定 path 的录像（可选）'),
    }),
    result: z.object({
      paths: z.number().required(),
      segments: z.number().required(),
      deleted: z.number().required(),
      failed: z.number().required(),
    }),
    handler: async (p): Promise<{ paths: number; segments: number; deleted: number; failed: number }> => {
      interface Page { items?: Array<{ name?: unknown }> }
      const page = await mtx<Page>('GET', '/v3/recordings/list?itemsPerPage=500')
      const names = (page.items ?? [])
        .map((it) => it?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0 && (p.path === undefined || n === p.path))
      let segments = 0
      let deleted = 0
      let failed = 0
      for (const name of names) {
        interface Rec { segments?: Array<{ start?: unknown }> }
        const rec = await mtx<Rec>('GET', `/v3/recordings/get/${encodeURIComponent(name)}`)
        const starts = (rec.segments ?? [])
          .map((seg) => seg?.start)
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
        segments += starts.length
        for (const start of starts) {
          try {
            const query = new URLSearchParams({ path: name, start })
            await mtx('DELETE', `/v3/recordings/segments/delete?${query.toString()}`)
            deleted += 1
          } catch {
            // A segment can vanish (another cleanup) or be mid-write. Report
            // it in `failed` instead of aborting the whole sweep.
            failed += 1
          }
        }
      }
      return { paths: names.length, segments, deleted, failed }
    },
  })

  ctx.api.register({
    name: 'mediamtx.playback.list',
    description: '一个路径的可回放窗口(playback 服务器 /list,origin 已改写为浏览器可达地址)',
    params: z.object({
      name: z.string().min(1).required(),
      start: z.string().description('RFC3339 下界(可选)'),
      end: z.string().description('RFC3339 上界(可选)'),
    }),
    result: z.object({ entries: z.array(PlaybackEntryS).required() }),
    handler: async (p): Promise<{ entries: PlaybackEntry[] }> => {
      const eps = await deriveEndpoints()
      if (eps.playback === null) {
        throw new RpcError(
          RpcCode.UNAVAILABLE,
          'playback server disabled upstream — set `playback: yes` in mediamtx.yml',
          undefined,
          { messageKey: 'mediamtx.playbackDisabled' },
        )
      }
      const query = new URLSearchParams({ path: p.name })
      if (p.start !== undefined) query.set('start', p.start)
      if (p.end !== undefined) query.set('end', p.end)
      let res: Response
      try {
        const auth = authHeaderFor(activeServer())
        res = await fetch(`${eps.playback}/list?${query.toString()}`, {
          signal: AbortSignal.timeout(timeoutMs),
          ...(auth !== null ? { headers: { authorization: auth } } : {}),
        })
      } catch (e) {
        throw new RpcError(
          RpcCode.UNAVAILABLE,
          `playback server unreachable at ${eps.playback} — set \`playback: yes\` in mediamtx.yml (${(e as Error).message})`,
          undefined,
          { messageKey: 'mediamtx.playbackUnreachable', messageParams: { url: eps.playback } },
        )
      }
      const text = await res.text()
      const parsed: unknown = text === '' ? null : JSON.parse(text) as unknown
      if (!res.ok) {
        const failure = classifyUpstream(res.status, parsed)
        // An empty range is a NORMAL state, not an error: upstream answers 404
        // "no segments found", and 400 "lstat …: no such file or directory"
        // for a path that has never recorded. Both mean: nothing to play yet.
        if (failure.kind === 'not_found' || /no such file|no segments/i.test(failure.detail)) {
          return { entries: [] }
        }
        throw new RpcError(
          failure.kind === 'invalid' ? RpcCode.INVALID_PARAMS : RpcCode.CONFLICT,
          `MediaMTX playback: ${failure.detail}`,
          { status: res.status, detail: failure.detail },
          { messageKey: 'mediamtx.upstream', messageParams: { status: String(res.status), detail: failure.detail } },
        )
      }
      const entries = parsePlaybackList(parsed)
      for (const entry of entries) {
        // Upstream builds the /get URL from the request Host IT saw (the
        // host's view, often 127.0.0.1) — swap in the origin the browser uses.
        if (entry.url !== '') entry.url = rewriteOrigin(entry.url, eps.playback) ?? entry.url
      }
      return { entries }
    },
  })

  ctx.api.register({
    name: 'mediamtx.servers.list',
    description: '托管的 MediaMTX 服务器注册表(名称/地址/认证方式——凭据不过线)与当前活动服务器',
    params: z.object({}),
    result: ServersListS,
    handler: async () => ({ servers: servers.map(publicView), active: activeName }),
  })

  ctx.api.register({
    name: 'mediamtx.servers.add',
    description: '登记一个 MediaMTX 服务器(凭据只存宿主侧文件,永不出线;token 优先于 basic)',
    mutates: true,
    params: z.object({
      name: z.string().min(1).max(64).required().description('unique registry name'),
      url: z.string().min(1).max(2000).required().description('API base, e.g. http://192.168.1.10:9997'),
      username: z.string().max(200).description('basic-auth user'),
      password: z.string().max(200).description('basic-auth password'),
      token: z.string().max(4000).description('static bearer/JWT; takes precedence over basic'),
    }),
    result: ManagedServerS1,
    handler: async (p) => {
      const nm = p.name.trim()
      if (nm === '') {
        throw new RpcError(RpcCode.INVALID_PARAMS, 'server name must not be blank', undefined, {
          messageKey: 'mediamtx.serverBadName',
        })
      }
      const url = normalizeUrl(p.url)
      if (url === null) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `not an absolute http(s) URL: ${p.url}`, undefined, {
          messageKey: 'mediamtx.serverBadUrl',
          messageParams: { url: p.url },
        })
      }
      if (servers.some((srv) => srv.name === nm)) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `server already registered: ${nm}`, undefined, {
          messageKey: 'mediamtx.serverExists',
          messageParams: { name: nm },
        })
      }
      const entry: ServerEntry = {
        name: nm,
        url,
        ...(p.username !== undefined && p.username !== '' ? { username: p.username, password: p.password ?? '' } : {}),
        ...(p.token !== undefined && p.token !== '' ? { token: p.token } : {}),
      }
      const next = [...servers, entry]
      await persistRegistry(next, activeName) // write first, commit after
      servers.length = 0
      servers.push(...next)
      log.info(`server registered: ${nm} → ${url}`)
      return { server: publicView(entry) }
    },
  })

  ctx.api.register({
    name: 'mediamtx.servers.update',
    description: '就地更新一个已登记的服务器(轮换 token/改地址,免「切走-移除-重登记」):给出的字段替换、省略的字段保持、空字符串凭据=清除;活动服务器也可更新',
    mutates: true,
    params: z.object({
      name: z.string().min(1).required().description('which registered server to update'),
      url: z.string().max(2000).description('new API base; omit to keep'),
      username: z.string().max(200).description('basic-auth user; empty string clears basic auth'),
      password: z.string().max(200),
      token: z.string().max(4000).description('new bearer/JWT; empty string clears the token'),
    }),
    result: ManagedServerS1,
    handler: async (p) => {
      const idx = servers.findIndex((srv) => srv.name === p.name)
      if (idx < 0) {
        throw new RpcError(RpcCode.NOT_FOUND, `no such server: ${p.name}`, undefined, {
          messageKey: 'mediamtx.serverUnknown',
          messageParams: { name: p.name },
        })
      }
      const cur = servers[idx]!
      let url = cur.url
      if (p.url !== undefined) {
        const normalized = normalizeUrl(p.url)
        if (normalized === null) {
          throw new RpcError(RpcCode.INVALID_PARAMS, `not an absolute http(s) URL: ${p.url}`, undefined, {
            messageKey: 'mediamtx.serverBadUrl',
            messageParams: { url: p.url },
          })
        }
        url = normalized
      }
      // Field rules: OMITTED keeps, '' clears a credential, anything else sets.
      const nextEntry: ServerEntry = { name: cur.name, url }
      if (p.username !== undefined) {
        if (p.username !== '') {
          nextEntry.username = p.username
          nextEntry.password = p.password ?? cur.password ?? ''
        }
      } else if (cur.username !== undefined) {
        nextEntry.username = cur.username
        if (cur.password !== undefined) nextEntry.password = cur.password
      }
      if (p.password !== undefined && p.password !== '' && nextEntry.username !== undefined) {
        nextEntry.password = p.password
      }
      if (p.token !== undefined) {
        if (p.token !== '') nextEntry.token = p.token
      } else if (cur.token !== undefined) {
        nextEntry.token = cur.token
      }
      const next = [...servers]
      next[idx] = nextEntry
      await persistRegistry(next, activeName) // write first, commit after
      servers.length = 0
      servers.push(...next)
      // A new url on the ACTIVE server means a new identity: forget its version.
      if (url !== cur.url && p.name === activeName) lastVersion = null
      log.info(`server updated: ${p.name}${url !== cur.url ? ` → ${url}` : ''}`)
      return { server: publicView(nextEntry) }
    },
  })

  ctx.api.register({
    name: 'mediamtx.servers.remove',
    description: '移除一个已登记的服务器(活动服务器不可移除——先切走)',
    mutates: true,
    params: z.object({ name: z.string().min(1).required() }),
    result: OkS,
    handler: async (p) => {
      if (!servers.some((srv) => srv.name === p.name)) {
        throw new RpcError(RpcCode.NOT_FOUND, `no such server: ${p.name}`, undefined, {
          messageKey: 'mediamtx.serverUnknown',
          messageParams: { name: p.name },
        })
      }
      if (p.name === activeName) {
        throw new RpcError(RpcCode.CONFLICT, `cannot remove the ACTIVE server: ${p.name} — switch away first`, undefined, {
          messageKey: 'mediamtx.serverActive',
          messageParams: { name: p.name },
        })
      }
      const next = servers.filter((srv) => srv.name !== p.name)
      await persistRegistry(next, activeName)
      servers.length = 0
      servers.push(...next)
      log.info(`server removed: ${p.name}`)
      return OK
    },
  })

  ctx.api.register({
    name: 'mediamtx.servers.switch',
    description: '切换活动服务器:其后每个方法都路由到它(面板应刷新各自的视图)',
    mutates: true,
    params: z.object({ name: z.string().min(1).required() }),
    result: ServerActiveS,
    handler: async (p) => ({ active: await switchActive(p.name) }),
  })

  // ---- agent tools -------------------------------------------------------------

  ctx.tools.register({
    name: 'mediamtx.status',
    mutates: false,
    description: 'Check the local MediaMTX service: is its API answering, is the process owned by this host, and what binary/config would be started.',
    execute: async () => readStatus(),
  })

  ctx.tools.register({
    name: 'mediamtx.start',
    mutates: true,
    description: 'Start the local MediaMTX service on demand. Idempotent: reports the current state when it is already running.',
    execute: async () => startProcess(),
  })

  ctx.tools.register({
    name: 'mediamtx.info',
    mutates: false,
    description: 'MediaMTX server identity: version, start time, API base.',
    execute: async () => (await mtx<{ version: string; started: string }>('GET', '/v3/info')),
  })

  ctx.tools.register({
    name: 'mediamtx.endpoints',
    mutates: false,
    description: 'Where a viewer connects: absolute webrtc(WHEP)/hls/rtsp/rtmp/srt/metrics/playback URLs derived from the server config.',
    execute: async () => deriveEndpoints(),
  })

  ctx.tools.register({
    name: 'mediamtx.paths.list',
    mutates: false,
    description: 'List stream paths with normalized runtime state: ready, source, readers, tracks, byte counters.',
    execute: async () => listPaths(),
  })

  ctx.tools.register({
    name: 'mediamtx.path.add',
    mutates: true,
    description: 'Create a stream path. Give `source` (e.g. an rtsp:// camera URL) to make the server PULL it; omit source to create a publish-point that waits for a live push. This is how a camera goes on air.',
    params: z.object({
      name: z.string().min(1).max(200).description('path name, e.g. cam3').required(),
      source: z.string().max(2000).description('static source URL; omit for a publish-point'),
      record: z.boolean().description('record this path to disk'),
    }),
    execute: async (args) => {
      const body: Record<string, unknown> = {}
      if (args.source !== undefined) body.source = String(args.source)
      if (args.record !== undefined) body.record = args.record === true
      await mtx('POST', `/v3/config/paths/add/${encodeURIComponent(String(args.name))}`, body)
      return { ok: true, name: String(args.name) }
    },
  })

  ctx.tools.register({
    name: 'mediamtx.path.delete',
    mutates: true,
    description: 'Delete a stream path.',
    params: z.object({ name: z.string().min(1).required() }),
    execute: async (args) => {
      await mtx('DELETE', `/v3/config/paths/delete/${encodeURIComponent(String(args.name))}`)
      return { ok: true, name: String(args.name) }
    },
  })

  ctx.tools.register({
    name: 'mediamtx.sessions.kick',
    mutates: true,
    description: 'Kick one viewer/publisher session by protocol kind and id (all eight protocols including rtmp; ids come from the sessions panel).',
    params: z.object({
      kind: z.string().description('rtsp|rtsps|rtmp|rtmps|hls|webrtc|srt|moq (all kickable; kicking rtmp stops that publish)').required(),
      id: z.string().required(),
    }),
    execute: async (args) => {
      const kind = String(args.kind) as SessionKind
      const route = SESSION_KICK_ROUTE[kind]
      if (route === undefined || route === null) throw new RpcError(RpcCode.INVALID_PARAMS, `${kind} sessions cannot be kicked`)
      await mtx('POST', `${route}${encodeURIComponent(String(args.id))}`)
      return { ok: true }
    },
  })

  ctx.tools.register({
    name: 'mediamtx.servers.list',
    mutates: false,
    description: 'List the managed MediaMTX servers (name, api url, auth kind — never credentials) and which one is ACTIVE. Every other tool routes to the active one.',
    execute: async () => ({ servers: servers.map(publicView), active: activeName }),
  })

  ctx.tools.register({
    name: 'mediamtx.servers.switch',
    mutates: true,
    description: 'Switch which managed MediaMTX server the console talks to (names come from mediamtx.servers.list). Registration/removal of servers is operator-only RPC, not a tool: credentials are not model input.',
    params: z.object({ name: z.string().min(1).required() }),
    execute: async (args) => ({ active: await switchActive(String(args.name)) }),
  })

  // ---- manifest + health --------------------------------------------------------

  ctx.capabilities.register({
    id: 'mediamtx',
    title: 'MediaMTX 桥',
    description: 'MediaMTX v3 API 的宿主侧代理:路径/配置/会话/指标/录像归一化,凭据不出宿主;媒体流由浏览器直连 WHEP/HLS',
    api: [...API_METHODS],
    tools: [...TOOL_NAMES],
    events: ['mediamtx.process'],
  })

  ctx.api.health(() => ({
    mediamtx: {
      server: activeServer().url,
      name: activeName,
      registered: servers.length,
      version: lastVersion,
      // Synchronous facts only: health must never probe the network.
      local: {
        binary: mtxBinary,
        config: mtxConfigFile,
        managed: childAlive(mtxChild),
        pid: childAlive(mtxChild) ? mtxChild?.pid ?? null : null,
      },
    },
  }))

  if (config.autoStart) {
    void startProcess().catch((e: unknown) => log.warn('MediaMTX 自动启动失败', { error: e instanceof Error ? e.message : String(e) }))
  }
  ctx.effect(() => () => {
    if (childAlive(mtxChild)) mtxChild?.kill('SIGTERM')
    mtxChild = null
  }, `${name}: mediamtx process`)

  log.info(`MediaMTX API 桥 → ${activeServer().url}(注册表 ${servers.length} 台,活动:${activeName};${registryFile})`)
}
