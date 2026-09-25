// @mtxconsole/protocol — the wire vocabulary between the host bridge and the
// console panels, NORMALIZED.
//
// Clean-room note: everything here was derived from the MediaMTX v1.21 HTTP
// API observed against a running server (MIT project) — no code from any
// third-party console was read or copied. The host owns the normalization:
// upstream shapes (paginated envelopes, per-protocol session variants, the
// 122-key flat global config) are folded into the small stable rows below, so
// an upstream field rename lands in ONE adapter function instead of rippling
// through panels.
//
// Schemas use the repo dialect (@mediabase/schema): fields MediaMTX guarantees
// are required; everything that has shifted across versions is optional.

import { z } from '@mediabase/schema'

// ---- server ----------------------------------------------------------------

export interface ServerInfo {
  version: string
  /** RFC3339 start time, as reported by /v3/info. */
  started: string
  /** The API base the host talks to (echoed for the UI). */
  apiBase: string
}

export const ServerInfoS = z.object({
  version: z.string().required(),
  started: z.string().required(),
  apiBase: z.string().required(),
})

// ---- endpoints (where the BROWSER should connect for media) ------------------

export interface Endpoints {
  api: string
  /** WHEP base: `${webrtc}/<path>/whep` (null = webrtc disabled upstream). */
  webrtc: string | null
  /** HLS base: `${hls}/<path>/index.m3u8`. */
  hls: string | null
  rtsp: string | null
  rtmp: string | null
  srt: string | null
  metrics: string | null
  /** Recording playback server base (needs `playback: yes` upstream). */
  playback: string | null
}

// nullable: `.required()` in this dialect means non-null, so a null-able
// field stays unrequired (same recipe as the openvideo host schemas).
const nullS = z.const(null)

export const EndpointsS = z.object({
  api: z.string().required(),
  webrtc: z.union([z.string(), nullS]),
  hls: z.union([z.string(), nullS]),
  rtsp: z.union([z.string(), nullS]),
  rtmp: z.union([z.string(), nullS]),
  srt: z.union([z.string(), nullS]),
  metrics: z.union([z.string(), nullS]),
  playback: z.union([z.string(), nullS]),
})

/**
 * Turn a MediaMTX address setting into an absolute URL. MediaMTX writes
 * addresses as ":8889" (all interfaces) or "127.0.0.1:8889"; the browser needs
 * a real host — so a bare-port address borrows the API server's hostname, and
 * a loopback address is passed through (the console is a local tool).
 * `disable`/empty → null.
 */
export function addressToUrl(
  raw: string | undefined,
  apiBase: string,
  scheme: 'http' | 'rtsp' | 'rtmp' | 'srt' = 'http',
): string | null {
  const value = (raw ?? '').trim()
  if (value === '' || value === 'disable') return null
  let fallbackHost = '127.0.0.1'
  try {
    fallbackHost = new URL(apiBase).hostname
  } catch {
    // a malformed apiBase must not break endpoint derivation
  }
  const host = value.startsWith(':') ? fallbackHost : value.includes('://') ? null : value.split('/')[0]?.split(':')[0] ?? fallbackHost
  if (value.includes('://')) return value
  const portPart = value.startsWith(':') ? value : `:${value.split(':')[1] ?? ''}`
  return `${scheme}://${host ?? fallbackHost}${portPart}`
}

// ---- paths (streams) ---------------------------------------------------------

export interface TrackRow {
  type: string
  codec: string
  id: string
}

export interface PathRow {
  name: string
  confName: string
  ready: boolean
  /** Publisher description ("rtsp://camera/…", "publisher" for live pushes). */
  source: string | null
  sourceType: string | null
  readers: number
  inboundBytes: number
  outboundBytes: number
  tracks: TrackRow[]
  record: boolean
}

export const PathRowS = z.object({
  name: z.string().required(),
  confName: z.string().required(),
  ready: z.boolean().required(),
  source: z.union([z.string(), nullS]),
  sourceType: z.union([z.string(), nullS]),
  readers: z.natural().required(),
  inboundBytes: z.natural().required(),
  outboundBytes: z.natural().required(),
  tracks: z.array(z.object({
    type: z.string().required(),
    codec: z.string().required(),
    id: z.string().required(),
  })).required(),
  record: z.boolean().required(),
})

/** The path's CONFIG-side facts, merged into the runtime row by the host. */
export interface PathConfFacts {
  record: boolean
  /** The configured static source ('publisher' = waits for a live push). */
  source?: string
}

/**
 * The one adapter that touches the upstream runtime-path shape (observed on
 * v1.21: ready/available/online, tracks2 carries {type,codec,id}). Unknown or
 * missing optional fields degrade, they never throw — a console must render a
 * server it only half-understands.
 *
 * `source` semantics, observed live: the RUNTIME source is only non-null once
 * a source actually connected — a configured-but-unreachable rtsp:// camera
 * still reports null there, while the CONFIG row carries the URL from the
 * moment it is set (default 'publisher'). So the effective source shown to
 * the operator is runtime ?? config, with 'publisher' normalized to null
 * ("waits for a push" is a state, not an address).
 */
export function toPathRow(raw: unknown, conf: PathConfFacts): PathRow | null {
  if (raw === null || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.name !== 'string') return null
  const tracksRaw = Array.isArray(p.tracks2) && p.tracks2.length > 0 ? p.tracks2 : Array.isArray(p.tracks) ? p.tracks : []
  const tracks: TrackRow[] = []
  for (const tr of tracksRaw) {
    if (tr === null || typeof tr !== 'object') continue
    const t = tr as Record<string, unknown>
    tracks.push({
      type: typeof t.type === 'string' ? t.type : '?',
      codec: typeof t.codec === 'string' ? t.codec : (typeof t.type === 'string' ? t.type : '?'),
      id: typeof t.id === 'string' ? t.id : '',
    })
  }
  const runtimeSource = typeof p.source === 'string' ? p.source : null
  const confSource = conf.source !== undefined && conf.source !== '' && conf.source !== 'publisher'
    ? conf.source
    : null
  return {
    name: p.name,
    confName: typeof p.confName === 'string' ? p.confName : p.name,
    ready: p.ready === true,
    source: runtimeSource ?? confSource,
    sourceType: typeof p.sourceType === 'string' ? p.sourceType : null,
    readers: Array.isArray(p.readers) ? p.readers.length : 0,
    inboundBytes: typeof p.inboundBytes === 'number' ? p.inboundBytes : 0,
    outboundBytes: typeof p.outboundBytes === 'number' ? p.outboundBytes : 0,
    tracks,
    record: conf.record,
  }
}

// ---- sessions (viewers/publishers, all protocols) ---------------------------

export type SessionKind = 'rtsp' | 'rtsps' | 'rtmp' | 'rtmps' | 'hls' | 'webrtc' | 'srt' | 'moq'

export const SESSION_KINDS: readonly SessionKind[] = ['rtsp', 'rtsps', 'rtmp', 'rtmps', 'hls', 'webrtc', 'srt', 'moq']

/** Which list route each kind uses (v1.21 registers both flat and nested; the
 * flat legacy routes are the widest common denominator across versions). */
export const SESSION_LIST_ROUTE: Record<SessionKind, string> = {
  rtsp: '/v3/rtspconns/list',
  rtsps: '/v3/rtspssessions/list',
  rtmp: '/v3/rtmpconns/list',
  rtmps: '/v3/rtmpsconns/list',
  hls: '/v3/hlsmuxers/list',
  webrtc: '/v3/webrtcsessions/list',
  srt: '/v3/srtconns/list',
  moq: '/v3/moqsessions/list',
}

export const SESSION_KICK_ROUTE: Record<SessionKind, string | null> = {
  rtsp: '/v3/rtspsessions/kick/',
  rtsps: '/v3/rtspssessions/kick/',
  rtmp: null,
  rtmps: null,
  hls: '/v3/hlssessions/kick/',
  webrtc: '/v3/webrtcsessions/kick/',
  srt: '/v3/srtconns/kick/',
  moq: '/v3/moqsessions/kick/',
}

export interface SessionRow {
  kind: SessionKind
  id: string
  created: string
  remoteAddr: string
  path: string | null
  /** Extra transport detail worth one table cell. */
  detail: string | null
  bytes: number | null
  kickable: boolean
}

export const SessionRowS = z.object({
  kind: z.string().required(),
  id: z.string().required(),
  created: z.string().required(),
  remoteAddr: z.string().required(),
  path: z.union([z.string(), nullS]),
  detail: z.union([z.string(), nullS]),
  bytes: z.union([z.natural(), z.const(null)]),
  kickable: z.boolean().required(),
})

export function toSessionRow(kind: SessionKind, raw: unknown): SessionRow | null {
  if (raw === null || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (typeof s.id !== 'string') return null
  const path = typeof s.path === 'string' ? s.path : null
  const transport = typeof s.transport === 'string' ? s.transport : null
  const state = typeof s.state === 'string' ? s.state : null
  const bytes = typeof s.bytesReceived === 'number'
    ? s.bytesReceived
    : typeof s.bytesSent === 'number' ? s.bytesSent : null
  return {
    kind,
    id: s.id,
    created: typeof s.created === 'string' ? s.created : '',
    remoteAddr: typeof s.remoteAddr === 'string' ? s.remoteAddr : '',
    path,
    detail: [transport, state].filter((v): v is string => v !== null && v !== '').join(' · ') || null,
    bytes,
    kickable: SESSION_KICK_ROUTE[kind] !== null,
  }
}

// ---- metrics (Prometheus text → the handful of series the dashboard shows) ---

export interface PathMetric {
  name: string
  state: string
  readers: number
  inboundBytes: number
  outboundBytes: number
}

export interface MetricsSummary {
  pathsReady: number
  pathsNotReady: number
  totalReaders: number
  perPath: PathMetric[]
}

/** Parse the `paths*` metric families out of a Prometheus text exposition.
 * Tolerant by design: unknown series are skipped, malformed lines ignored. */
export function parseMetrics(text: string): MetricsSummary {
  const states = new Map<string, string>()
  const readers = new Map<string, number>()
  const inbound = new Map<string, number>()
  const outbound = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    const m = /^(\w+)\{([^}]*)\}\s+([0-9.eE+-]+)$/.exec(line.trim())
    if (m === null) continue
    const metric = m[1] ?? ''
    const labelsRaw = m[2] ?? ''
    const value = Number(m[3] ?? '')
    if (!Number.isFinite(value)) continue
    const labels: Record<string, string> = {}
    for (const part of labelsRaw.split(',')) {
      const kv = /^(\w+)="([^"]*)"$/.exec(part.trim())
      if (kv !== null && kv[1] !== undefined && kv[2] !== undefined) labels[kv[1]] = kv[2]
    }
    const name = labels.name
    if (name === undefined) continue
    if (metric === 'paths') states.set(name, labels.state ?? '?')
    else if (metric === 'paths_readers') readers.set(name, value)
    else if (metric === 'paths_inbound_bytes') inbound.set(name, value)
    else if (metric === 'paths_outbound_bytes') outbound.set(name, value)
  }
  const perPath: PathMetric[] = []
  let ready = 0
  let notReady = 0
  let totalReaders = 0
  for (const [name, state] of states) {
    if (state === 'ready') ready += 1
    else notReady += 1
    const r = readers.get(name) ?? 0
    totalReaders += r
    perPath.push({ name, state, readers: r, inboundBytes: inbound.get(name) ?? 0, outboundBytes: outbound.get(name) ?? 0 })
  }
  return { pathsReady: ready, pathsNotReady: notReady, totalReaders, perPath }
}

// ---- recordings --------------------------------------------------------------

export interface RecordingDay {
  day: string
  duration: number
  size: number
  segments: number
}

export interface RecordingRow {
  name: string
  days: RecordingDay[]
}

export function toRecordingRow(raw: unknown): RecordingRow | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string') return null
  const daysRaw = Array.isArray(r.days) ? r.days : []
  const days: RecordingDay[] = []
  for (const d of daysRaw) {
    if (d === null || typeof d !== 'object') continue
    const day = d as Record<string, unknown>
    days.push({
      day: String(day.day ?? ''),
      duration: Number(day.duration ?? 0),
      size: Number(day.size ?? 0),
      segments: Number(day.segments ?? 0),
    })
  }
  return { name: r.name, days }
}

// ---- path config (the writable subset the console exposes) --------------------

export interface PathConfPatch {
  /** Static source to pull ("rtsp://user:pass@host/stream"); empty/'publisher'
   * means the path waits for a live publisher. */
  source?: string
  record?: boolean
}

export const PathConfPatchS = z.object({
  source: z.string().max(2000),
  record: z.boolean(),
})

/** Error mapping for the upstream `{status:"error",error:"…"}` contract. */
export interface UpstreamFailure {
  /** Suggested RPC bucket. */
  kind: 'not_found' | 'invalid' | 'conflict' | 'unavailable'
  detail: string
}

export function classifyUpstream(httpStatus: number, body: unknown): UpstreamFailure {
  const detail = body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : `HTTP ${httpStatus}`
  if (httpStatus === 404) return { kind: 'not_found', detail }
  if (httpStatus === 400) return { kind: 'invalid', detail }
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'unavailable', detail }
  return { kind: 'conflict', detail }
}
