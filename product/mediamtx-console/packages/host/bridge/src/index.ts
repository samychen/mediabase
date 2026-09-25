// @mtxconsole/host-bridge — host plugin: the MediaMTX bridge capability.
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
  SESSION_KINDS,
  SESSION_KICK_ROUTE,
  SESSION_LIST_ROUTE,
  ServerInfoS,
  SessionRowS,
  addressToUrl,
  classifyUpstream,
  parseMetrics,
  toPathRow,
  toRecordingRow,
  toSessionRow,
  type Endpoints,
  type PathRow,
  type SessionKind,
  type SessionRow,
} from '@mtxconsole/protocol'

export const name = 'mediamtx'

export const inject = ['api', 'capabilities', 'tools', 'log'] as const

export interface BridgeConfig {
  /** MediaMTX API base, e.g. http://127.0.0.1:9997 */
  serverUrl?: string
  /** Basic-auth user for the API (MediaMTX `auth*` settings), when enabled. */
  username?: string
  password?: string
  /** Per-request timeout (default 8000 ms). */
  timeoutMs?: number
}

export const Config: Schema<BridgeConfig, BridgeConfig> = z.object({
  serverUrl: z.string().default('http://127.0.0.1:9997').description('MediaMTX API base URL'),
  username: z.string().description('API basic-auth user'),
  password: z.string().description('API basic-auth password'),
  timeoutMs: z.natural().default(8000).description('per-request timeout'),
})

const API_METHODS = [
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
] as const

const TOOL_NAMES = [
  'mediamtx.info',
  'mediamtx.endpoints',
  'mediamtx.paths.list',
  'mediamtx.path.add',
  'mediamtx.path.delete',
  'mediamtx.sessions.kick',
] as const

// ---- wire schemas ------------------------------------------------------------

const PathRowsS = z.object({ paths: z.array(PathRowS).required() })
const PathRowS1 = z.object({ path: PathRowS.required() })
const OkS = z.object({ ok: z.const(true).required() })
const OK: { ok: true } = { ok: true }
const SessionsS = z.object({ sessions: z.array(SessionRowS).required() })
const EndpointsS1 = z.object({ endpoints: EndpointsS.required() })
const ServerInfoS1 = z.object({ info: ServerInfoS.required() })

const kindS = z.union(SESSION_KINDS.map((k) => z.const(k)) as never)

export function apply(ctx: Context, rawConfig: BridgeConfig): void {
  const config = parse(Config, rawConfig ?? {})
  const log = ctx.log.child(name)
  const serverUrl = (config.serverUrl ?? 'http://127.0.0.1:9997').replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? 8000
  const authHeader = config.username !== undefined
    ? `Basic ${Buffer.from(`${config.username}:${config.password ?? ''}`).toString('base64')}`
    : null

  /** Last known server info, for the health payload (no probing in health). */
  let lastVersion: string | null = null

  /** One HTTP call to MediaMTX with the whole error contract in one place. */
  async function mtx<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${serverUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        ...(authHeader !== null ? { headers: { authorization: authHeader } } : {}),
        ...(body !== undefined
          ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(authHeader !== null ? { authorization: authHeader } : {}) } }
          : {}),
      })
    } catch (e) {
      throw new RpcError(RpcCode.UNAVAILABLE, `MediaMTX unreachable at ${serverUrl}: ${(e as Error).message}`, undefined, {
        messageKey: 'mediamtx.unreachable',
        messageParams: { url: serverUrl },
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

  /** The flat global config (122 keys upstream; we pass it through as a dict). */
  const globalConfig = (): Promise<Record<string, unknown>> =>
    mtx<Record<string, unknown>>('GET', '/v3/config/global/get')

  const str = (cfg: Record<string, unknown>, key: string): string | undefined =>
    typeof cfg[key] === 'string' ? (cfg[key] as string) : undefined

  async function deriveEndpoints(): Promise<Endpoints> {
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
    name: 'mediamtx.info',
    description: 'MediaMTX 服务器身份(/v3/info:版本与启动时间)与 API 地址',
    params: z.object({}),
    result: ServerInfoS1,
    handler: async () => {
      const info = await mtx<{ version: string; started: string }>('GET', '/v3/info')
      lastVersion = info.version
      return { info: { version: info.version, started: info.started, apiBase: serverUrl } }
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
    description: '踢掉一个会话(可踢的协议由上游决定;rtmp 不可踢)',
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

  // ---- agent tools -------------------------------------------------------------

  ctx.tools.register({
    name: 'mediamtx.info',
    description: 'MediaMTX server identity: version, start time, API base.',
    execute: async () => (await mtx<{ version: string; started: string }>('GET', '/v3/info')),
  })

  ctx.tools.register({
    name: 'mediamtx.endpoints',
    description: 'Where a viewer connects: absolute webrtc(WHEP)/hls/rtsp/rtmp/srt/metrics/playback URLs derived from the server config.',
    execute: async () => deriveEndpoints(),
  })

  ctx.tools.register({
    name: 'mediamtx.paths.list',
    description: 'List stream paths with normalized runtime state: ready, source, readers, tracks, byte counters.',
    execute: async () => listPaths(),
  })

  ctx.tools.register({
    name: 'mediamtx.path.add',
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
    description: 'Delete a stream path.',
    params: z.object({ name: z.string().min(1).required() }),
    execute: async (args) => {
      await mtx('DELETE', `/v3/config/paths/delete/${encodeURIComponent(String(args.name))}`)
      return { ok: true, name: String(args.name) }
    },
  })

  ctx.tools.register({
    name: 'mediamtx.sessions.kick',
    description: 'Kick one viewer/publisher session by protocol kind and id (ids come from mediamtx.paths.list readers or the sessions panel).',
    params: z.object({
      kind: z.string().description('rtsp|rtsps|hls|webrtc|srt|moq (rtmp cannot be kicked)').required(),
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

  // ---- manifest + health --------------------------------------------------------

  ctx.capabilities.register({
    id: 'mediamtx',
    title: 'MediaMTX 桥',
    description: 'MediaMTX v3 API 的宿主侧代理:路径/配置/会话/指标/录像归一化,凭据不出宿主;媒体流由浏览器直连 WHEP/HLS',
    api: [...API_METHODS],
    tools: [...TOOL_NAMES],
  })

  ctx.api.health(() => ({
    mediamtx: {
      server: serverUrl,
      version: lastVersion,
    },
  }))

  log.info(`MediaMTX API 桥 → ${serverUrl}`)
}
