// @xmedia/host-engine — the PRODUCT capability that owns the xmedia-kit
// native process. Everything the base needs is registered HERE, in the
// capability's own package: control-plane methods, agent tools, health, events,
// metrics and the capability manifest. @mediabase/server and @mediabase/ui-web
// name no media concept and were not edited.
//
// Boundary (the base's one layering rule):
//   * control plane (WS /rpc): COMMANDS only — publish.start/stop/status,
//     viewer URLs, the handshake, engine supervision and observability.
//   * media bytes: NEVER through the host. xmedia-kit's TranscodeJob muxes
//     straight to a live RTMP endpoint; MediaMTX serves WHEP/HLS and the
//     browser renders with a native <video>. There is NO data-plane route,
//     no scratch byte exchange, no JPEG snapshot and no Player pipeline.
//
// Wire verbs (publish.*) and their column layouts are owned by the SINGLE-SOURCE
// contract at protocol/contract.json, consumed here via ./protocol and by the C++
// bridge via the generated engine/src/xmedia_protocol.h. Adding product verbs
// does NOT change the protocol version — only a change to hello/ok/err semantics
// would (see @mediabase/engine-client).

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  assertProtocol,
  EngineClient,
  type EngineExitInfo,
} from '@mediabase/engine-client'
import { RpcCode, RpcError } from '@mediabase/rpc'
import { parse, z, type Schema } from '@mediabase/schema'
import type {} from '@mediabase/api'
import type {} from '@mediabase/log'
import type {} from '@mediabase/tools'
import { VERB } from './protocol'
import { Metrics } from './metrics'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** xmedia-kit engine facade (the supervised native process). */
    xmedia: XmediaService
  }
}

export type XmediaJson = Record<string, unknown>
export interface XmediaEvent {
  type: string
  [key: string]: unknown
}
export interface XmediaEngineState {
  running: boolean
  pid: number | null
  restarts: number
  binary: string
  protocol: number | null
  engine: string | null
  /** Whether the engine process engaged its sandbox (--sandbox). */
  sandboxed: boolean
}

/** Snapshot of one async TranscodeJob maintained by the C++ bridge. */
export interface XmediaPublishStatus {
  running: boolean
  done: boolean
  ok: boolean
  progress: number
  input: string
  output: string
  format: string
  error: string
  elapsedMs: number
  sandboxed: boolean
}

/** Where the operator publishes to and where a browser plays from. */
export interface XmediaViewers {
  path: string
  publish: string
  whep: string
  hls: string
}

// `| undefined` is deliberate: the project enables exactOptionalPropertyTypes,
// and the RPC/tool params are decoded as `T | undefined` rather than "absent".
export interface XmediaPublishOptions {
  jobId?: string | undefined
  path?: string | undefined
  output?: string | undefined
  format?: string | undefined
  videoCodec?: string | undefined
  audioCodec?: string | undefined
  realtime?: boolean | undefined
}

export interface XmediaPublishResult extends XmediaPublishStatus {
  /** Correlation id for this task (task-pool key). Opaque to the engine. */
  jobId: string
  viewers: XmediaViewers
  /** Encoder actually requested for this job (diagnostics: a `copy` live job
   *  keeps the source's long GOP and WebRTC viewers will stay black). */
  videoCodec?: string | undefined
}

export interface XmediaService {
  hello(): Promise<{ protocol: number; engine: string }>
  drainEvents(): Promise<XmediaEvent[]>
  publishStart(input: string, options?: XmediaPublishOptions): Promise<XmediaPublishResult>
  publishStop(options?: { jobId?: string | undefined }): Promise<XmediaPublishResult>
  publishStatus(options?: { jobId?: string | undefined }): Promise<XmediaPublishResult>
  viewers(path?: string): XmediaViewers
  engineState(): XmediaEngineState
  metrics(): ReturnType<Metrics['snapshot']>
}

/** Plugin name (stable identity). */
export const name = 'xmedia'

/** Services required before apply() runs. */
export const inject = ['api', 'capabilities', 'tools', 'log'] as const

export interface XmediaEngineConfig {
  /** Executable (or interpreter) that speaks the engine line protocol. */
  binary: string
  /** argv passed to spawn: e.g. [script.mjs] for a Node-based test engine. */
  args: string[]
  /** Per-command timeout; codec init on publish.start can take a moment. */
  callTimeoutMs: number
  autoRestart: boolean
  maxRestarts: number
  restartDelayMs: number
  /** Engage the engine's process sandbox (resource caps + privilege drop,
   *  seccomp on Linux / Seatbelt on macOS). Off by default. */
  sandbox: boolean
  /** MediaMTX RTMP ingest base, e.g. rtmp://127.0.0.1:1935/live. */
  publishBase: string
  /** MediaMTX WHEP (WebRTC egress) base for browsers. */
  whepBase: string
  /** MediaMTX HLS base, used only where native HLS is available. */
  hlsBase: string
  /** Default stream path published by `publish.start`. */
  publishPath: string
  /** Encoder used for LIVE (network) outputs; empty picks a platform default. */
  liveVideoCodec: string
}

/** The endpoint/process config a composition row owns. */
export const Config: Schema<XmediaEngineConfig, XmediaEngineConfig> = z.object({
  binary: z.string().default('xmedia-bridge').description('xmedia-bridge executable'),
  args: z.array(z.string()).default([]).description('extra argv for the child process'),
  callTimeoutMs: z.natural().default(30_000).description('per-command timeout (ms)'),
  autoRestart: z.boolean().default(true).description('restart the child after a crash'),
  maxRestarts: z.natural().default(3).description('restart attempt cap'),
  restartDelayMs: z.natural().default(500).description('delay before restarting (ms)'),
  sandbox: z.boolean().default(false).description('engage the engine process sandbox'),
  // NOTE: no /live suffix by default. MediaMTX derives the path from the WHOLE
  // RTMP URL after host:port, so `rtmp://h:1935/live/key` is path `live/key`
  // while WHEP/HLS are looked up at `/live/key/...`. Keeping the base at the
  // host root makes publish/whep/hls resolve to the SAME path (see
  // viewerUrls()). A custom base WITH a prefix is still supported: its path
  // segment is carried over to the viewer URLs automatically.
  publishBase: z.string().default('rtmp://127.0.0.1:1935')
    .description('MediaMTX RTMP ingest base'),
  whepBase: z.string().default('http://127.0.0.1:8889')
    .description('MediaMTX WHEP base (browser WebRTC egress)'),
  hlsBase: z.string().default('http://127.0.0.1:8888')
    .description('MediaMTX HLS base (native-HLS fallback)'),
  publishPath: z.string().default('xmedia').description('default stream path/name'),
  // A live WebRTC viewer can only start decoding at an IDR. Stream-copying a
  // source with a long GOP (e.g. one I-frame per several seconds, all the rest
  // B/P frames) leaves MediaMTX waiting for a keyframe that may never arrive
  // before the file ends: Chrome reports packets received but framesDecoded=0,
  // i.e. a permanently black <video>. Re-encoding produces a regular IDR
  // cadence. Measured with a 1080p High-profile source: copy -> 0 frames,
  // h264_videotoolbox -> 200 frames / 18 keyframes in ~7 s.
  liveVideoCodec: z.string().default('')
    .description('video encoder for live RTMP outputs; empty = platform default'),
})

/** Control-plane methods this capability registers (kept in one place for the manifest). */
export const API_NAMES = [
  'xmedia.hello',
  'xmedia.events',
  'xmedia.engine.state',
  'xmedia.publish.start',
  'xmedia.publish.stop',
  'xmedia.publish.status',
  'xmedia.publish.viewers',
  'xmedia.metrics',
] as const

/** Tools exposed to the agent / MCP bridge (same verbs, one declaration). */
export const TOOL_NAMES = [
  'xmedia.publish.start',
  'xmedia.publish.stop',
  'xmedia.publish.status',
  'xmedia.publish.viewers',
] as const

/**
 * Param schemas declared ONCE and shared by the control-plane API and the
 * agent/tool surface, so the two descriptions and shapes can never drift.
 */
const PublishStartParamsS = z.object({
  input: z.string().required().description('输入源:文件路径、URL 或 FFmpeg 设备 URI'),
  jobId: z.string().description('任务 ID(任务池键);省略则由宿主生成'),
  path: z.string().description('MediaMTX 流路径(默认 publishPath)'),
  output: z.string().description('覆盖输出(默认 publishBase/<path>;也可给本地文件路径做离线转码)'),
  format: z.string().description('容器格式;网络 URL 必填(rtmp 用 flv)'),
  videoCodec: z.string().description('视频编码器名;实时网络输出默认重编码(macOS h264_videotoolbox / 其他 libx264)以产生规律关键帧,离线文件默认 copy。显式传 copy 可关闭,但长 GOP 片源的 WHEP 会黑屏'),
  audioCodec: z.string().description('音频编码器名或 copy;实时网络输出默认丢弃(WHEP 不支持 AAC),离线文件默认 copy'),
  realtime: z.boolean().description('按媒体时戳实时配速;网络输出默认 true'),
})
/** publish.stop / publish.status / publish.viewers-free verbs that take only an id. */
const JobIdParamsS = z.object({
  jobId: z.string().description('任务 ID;省略时对最近一次任务生效'),
})
const PublishViewersParamsS = z.object({
  path: z.string().description('流路径,默认取组合层 publishPath'),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one JSON column; a malformed engine reply is a coded failure, not a cast. */
function jsonColumn(parts: string[], verb: string): unknown {
  const raw = parts[1]
  if (raw === undefined) {
    throw new RpcError(RpcCode.ENGINE, `xmedia: ${verb} 未返回数据列`)
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new RpcError(RpcCode.ENGINE, `xmedia: ${verb} 返回不是合法 JSON`)
  }
}

function asRecord(value: unknown, verb: string): XmediaJson {
  if (!isRecord(value)) {
    throw new RpcError(RpcCode.ENGINE, `xmedia: ${verb} 返回不是对象`)
  }
  return value
}

/** A tab/newline inside a column would split one reply into two. Never emit one. */
function wire(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ')
}

function trimEnd(value: string): string {
  return value.replace(/\/+$/, '')
}

function sanitizePath(value: string): string {
  // A path is the MediaMTX stream key: no scheme, no leading slash, no query.
  return value.replace(/^\/+/, '').replace(/[?#].*$/, '').trim() || 'xmedia'
}

function isNetworkUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

export function apply(ctx: Context, rawConfig: XmediaEngineConfig): void {
  const config = parse(Config, rawConfig)
  const log = ctx.log.child(name)
  const disposers: Array<() => void> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const metrics = new Metrics()

  let restarts = 0
  let fastDeaths = 0
  let disposed = false
  let helloInfo: { protocol: number; engine: string } | null = null
  // Sandbox engagement, read once from the engine after handshake.
  let sandboxActive = false
  // Task pool: jobId -> viewers + encoder. Lets many jobs run concurrently.
  const jobs = new Map<string, { viewers: XmediaViewers; videoCodec: string }>()
  let lastJobId: string | null = null

  /** MediaMTX path prefix carried by a custom RTMP base (e.g. /live). */
  function publishPrefix(): string {
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(config.publishBase)
    return match ? (match[1] ?? '').replace(/\/+$/, '') : ''
  }

  /**
   * Build the publish + viewer URLs for ONE MediaMTX path. All three MUST agree:
   * MediaMTX derives its path from the whole RTMP URL after host:port, so a
   * base like rtmp://h:1935/live makes the path `live/<key>` and WHEP/HLS must
   * be looked up at /live/<key>/... — otherwise WHEP answers "no stream is
   * available on path '<key>'".
   */
  function viewerUrls(path: string): XmediaViewers {
    const key = sanitizePath(path || config.publishPath)
    const fullPath = [publishPrefix(), key].filter(Boolean).join('/')
    return {
      path: key,
      publish: `${trimEnd(config.publishBase)}/${key}`,
      whep: `${trimEnd(config.whepBase)}/${fullPath}/whep`,
      hls: `${trimEnd(config.hlsBase)}/${fullPath}/index.m3u8`,
    }
  }

  /** Recover the stream key from the job's output so a page reload can restore viewers. */
  function pathForOutput(output: string): string {
    const base = `${trimEnd(config.publishBase)}/`
    if (output.startsWith(base)) return output.slice(base.length)
    return output.split('/').pop() || config.publishPath
  }

  /** Normalise the C++ bridge's publish JSON into a typed status. */
  function asPublishStatus(parts: string[], verb: string): XmediaPublishStatus {
    const raw = asRecord(jsonColumn(parts, verb), verb)
    const str = (key: string): string => typeof raw[key] === 'string' ? raw[key] as string : ''
    const num = (key: string): number => typeof raw[key] === 'number' ? raw[key] as number : 0
    return {
      running: raw.running === true,
      done: raw.done === true,
      ok: raw.ok === true,
      progress: num('progress'),
      input: str('input'),
      output: str('output'),
      format: str('format'),
      error: str('error'),
      elapsedMs: num('elapsedMs'),
      sandboxed: raw.sandboxed === true,
    }
  }

  /** Record a terminal observation once (idempotent) so metrics stay correct. */
  function noteCompletion(status: XmediaPublishStatus, jobId: string): void {
    if (status.done && !status.running) {
      metrics.recordCompletion(jobId, status.ok, status.elapsedMs, status.error || undefined)
    }
  }

  // The sandbox flag becomes an argv passed to the engine. The base client
  // spawns whatever binary+args it is given; we never fork the client.
  const spawnArgs = [...config.args]
  if (config.sandbox) spawnArgs.push('--sandbox')

  const client = new EngineClient(config.binary, {
    args: spawnArgs,
    callTimeoutMs: config.callTimeoutMs,
    // xmedia-kit logs through base/logging to stderr; keep the protocol's
    // stdout clean and route those lines into the host's scoped logger.
    onStderr: (line) => log.debug('[xmedia-kit]', { line }),
    onExit: (info: EngineExitInfo) => {
      if (disposed || info.expected) return
      log.warn('xmedia-kit 引擎进程退出', {
        code: info.code, signal: info.signal, uptimeMs: info.uptimeMs,
      })
      ctx.events.emit('xmedia.engine', {
        phase: 'exit', code: info.code, signal: info.signal, uptimeMs: info.uptimeMs,
      })
      // A binary that dies instantly is broken, not "crashed once": stop the
      // restart loop before it becomes a log flood. This is PRODUCT policy —
      // the neutral EngineClient deliberately leaves the decision up here.
      fastDeaths = info.uptimeMs < 1000 ? fastDeaths + 1 : 0
      if (!config.autoRestart || restarts >= config.maxRestarts || fastDeaths >= 3) {
        if (fastDeaths >= 3) log.error('引擎反复立即退出,停止重启(检查 ENGINE_BIN 与依赖库)')
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (disposed) return
        restarts += 1
        log.info('重启 xmedia-kit 引擎', { attempt: restarts })
        client.restart()
        void handshake()
      }, config.restartDelayMs)
      timers.add(timer)
    },
  })

  /** One handshake: hello → protocol assertion → remember it. Single path for
   *  cold start, restart and the `xmedia.hello` method, so all three agree. */
  async function greet(): Promise<{ protocol: number; engine: string }> {
    const info = await client.hello()
    assertProtocol(info)  // mismatch → CONFLICT, never a mis-parsed column
    helloInfo = info
    return info
  }

  async function handshake(): Promise<void> {
    try {
      const info = await greet()
      log.info('xmedia-kit 引擎握手成功', info)
      ctx.events.emit('xmedia.engine', { phase: 'ready', ...info })
      // The base hello does not carry `sandboxed`; read it from an idle status,
      // which the bridge reports even for an unknown jobId.
      try {
        const idle = await client.callOk([VERB.PUBLISH_STATUS, ''])
        sandboxActive = asPublishStatus(idle, VERB.PUBLISH_STATUS).sandboxed
      } catch {
        sandboxActive = false
      }
    } catch (e) {
      // A missing binary / cold start must NOT stop the host: every call then
      // fails with a coded UNAVAILABLE error that clients can branch on.
      log.debug('xmedia-kit 握手暂不可用', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  void handshake()

  /** One command, one reply; a non-`ok` line becomes a coded ENGINE error. */
  async function call(parts: string[]): Promise<string[]> {
    return client.callOk(parts)
  }

  async function drainEvents(): Promise<XmediaEvent[]> {
    const parsed = jsonColumn(await call([VERB.EVENTS]), VERB.EVENTS)
    const events: XmediaEvent[] = (Array.isArray(parsed) ? parsed : [])
      .filter(isRecord)
      .map((raw) => ({ type: typeof raw.type === 'string' ? raw.type : 'unknown', ...raw }))
    for (const event of events) {
      ctx.events.emit('xmedia.event', event)
      if (event.type === 'PublishDone') {
        const jobId = typeof event.jobId === 'string' ? event.jobId : lastJobId ?? ''
        const ok = event.ok === true
        // elapsedMs is not in the event; derive from the in-memory record.
        const rec = metrics.snapshot().recent.find((r) => r.jobId === jobId)
        metrics.recordCompletion(jobId, ok, rec?.elapsedMs ?? 0, typeof event.error === 'string' ? event.error : undefined)
      }
    }
    return events
  }

  async function publishStart(input: string, options: XmediaPublishOptions = {}): Promise<XmediaPublishResult> {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new RpcError(RpcCode.INVALID_PARAMS, 'xmedia: publish.start 需要非空 input')
    }
    const jobId = options.jobId && options.jobId.trim() ? options.jobId.trim() : randomUUID()
    const viewers = viewerUrls(options.path ?? config.publishPath)
    const output = options.output ?? viewers.publish
    const live = isNetworkUrl(output)
    // A network URL has no extension for FFmpeg to infer a container from.
    const format = options.format ?? (live ? 'flv' : '')
    const realtime = options.realtime ?? live
    // Live outputs are RE-ENCODED by default (see Config.liveVideoCodec): a
    // stream-copied long-GOP source never gives MediaMTX an IDR to start a
    // WebRTC reader on. Offline file jobs keep `copy` — their product is the
    // encoded file, and no browser is waiting on a keyframe.
    const defaultLiveCodec = config.liveVideoCodec ||
      (process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264')
    const videoCodec = options.videoCodec ?? (live ? defaultLiveCodec : 'copy')
    // MediaMTX v1.21's WHEP (WebRTC egress) cannot carry an AAC leg: with one
    // present the WHOLE session is refused ("codecs not supported by client"),
    // measured end to end. Internal acceptance is about the PICTURE, so live
    // outputs drop audio by default, while OFFLINE file jobs keep both legs —
    // the product's main business is the encoded file, not the browser preview.
    // Pass audioCodec explicitly to override (HLS can carry AAC where native).
    const audioCodec = options.audioCodec ?? (live ? '' : 'copy')
    const parts = await call([
      VERB.PUBLISH_START, jobId, wire(input), wire(output), wire(format),
      wire(videoCodec), wire(audioCodec),
      realtime ? '1' : '0',
    ])
    const status = asPublishStatus(parts, VERB.PUBLISH_START)
    metrics.recordStart(jobId, input)
    jobs.set(jobId, { viewers, videoCodec })
    lastJobId = jobId
    ctx.events.emit('xmedia.publish', { phase: 'start', jobId, path: viewers.path, ...status })
    return { ...status, jobId, viewers, videoCodec }
  }

  /**
   * publish.stop and publish.status differ only by the verb they send (and by
   * whether a `stop` phase event is emitted), so they share ONE implementation:
   * resolve the job (empty id = idle pool, which the engine answers neutrally),
   * read the status, bank a terminal observation once, re-attach the viewers
   * from the task-pool entry.
   */
  async function publishControl(
    verb: string,
    options: { jobId?: string | undefined },
    phase?: 'stop',
  ): Promise<XmediaPublishResult> {
    const jobId = options.jobId ?? lastJobId ?? ''
    const status = asPublishStatus(await call([verb, jobId]), verb)
    noteCompletion(status, jobId)
    const entry = jobs.get(jobId)
    if (phase !== undefined) ctx.events.emit('xmedia.publish', { phase, jobId, ...status })
    return {
      ...status,
      jobId,
      viewers: entry?.viewers ?? viewerUrls(pathForOutput(status.output)),
      videoCodec: entry?.videoCodec || undefined,
    }
  }

  const publishStop = (options: { jobId?: string | undefined } = {}): Promise<XmediaPublishResult> =>
    publishControl(VERB.PUBLISH_STOP, options, 'stop')

  const publishStatus = (options: { jobId?: string | undefined } = {}): Promise<XmediaPublishResult> =>
    publishControl(VERB.PUBLISH_STATUS, options)

  const service: XmediaService = {
    hello: greet,
    drainEvents,
    publishStart,
    publishStop,
    publishStatus,
    viewers: (path) => viewerUrls(path ?? config.publishPath),
    engineState: () => ({
      running: client.running,
      pid: client.pid,
      restarts,
      binary: config.binary,
      protocol: helloInfo?.protocol ?? null,
      engine: helloInfo?.engine ?? null,
      sandboxed: sandboxActive,
    }),
    metrics: () => metrics.snapshot(),
  }
  ctx.reflect.provide('xmedia', service)

  // ---- control plane: supervision -------------------------------------------
  disposers.push(ctx.api.register({
    name: 'xmedia.hello',
    description: '引擎线协议握手(协议版本与引擎标识)',
    handler: () => service.hello(),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.events',
    description: '取出并转发引擎累积的事件(线协议严格一问一答,故按需拉取)',
    handler: () => drainEvents(),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.engine.state',
    description: '子进程监督状态(running/pid/重启次数/协议版本/沙箱)',
    handler: () => service.engineState(),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.metrics',
    description: '编码/转码任务的可观测指标(启动数/成功/失败/失败原因/最近窗口)',
    handler: () => service.metrics(),
  }))

  // ---- control plane: encode / publish (the product's main job) --------------
  disposers.push(ctx.api.register({
    name: 'xmedia.publish.viewers',
      description: '返回 MediaMTX 的推流地址与浏览器直连的 WHEP/HLS 播放地址',
      params: PublishViewersParamsS,
      handler: (p) => service.viewers(p.path),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.publish.start',
    description: '启动实时编码/转码推流(默认 RTMP → MediaMTX),返回任务 ID 与观看地址',
      mutates: true,
      params: PublishStartParamsS,
      handler: (p) => publishStart(p.input, {
      jobId: p.jobId,
      path: p.path,
      output: p.output,
      format: p.format,
      videoCodec: p.videoCodec,
      audioCodec: p.audioCodec,
      realtime: p.realtime,
    }),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.publish.stop',
    description: '停止指定编码/推流任务(协作式取消,返回任务状态)',
    mutates: true,
    params: JobIdParamsS,
    handler: (p) => publishStop({ jobId: p.jobId }),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.publish.status',
    description: '查询指定编码/转流任务状态(进度/错误信息/耗时)与观看地址',
    params: JobIdParamsS,
    handler: (p) => publishStatus({ jobId: p.jobId }),
  }))

  // ---- agent / MCP tools -----------------------------------------------------
  const tool = (method: Parameters<typeof ctx.tools.register>[0]): void => {
    disposers.push(ctx.tools.register(method))
  }
  tool({
      name: 'xmedia.publish.viewers',
      description: '查询 MediaMTX 推流地址与 WHEP/HLS 观看地址',
      params: PublishViewersParamsS,
      execute: (a) => service.viewers(a.path === undefined ? undefined : String(a.path)),
  })
  tool({
    name: 'xmedia.publish.start',
    description: '启动实时编码推流(输入源 → RTMP → MediaMTX);返回任务 ID 与观看地址',
      mutates: true,
      params: PublishStartParamsS,
      execute: (a) => publishStart(String(a.input), {
      jobId: a.jobId === undefined ? undefined : String(a.jobId),
      path: a.path === undefined ? undefined : String(a.path),
      output: a.output === undefined ? undefined : String(a.output),
      format: a.format === undefined ? undefined : String(a.format),
      videoCodec: a.videoCodec === undefined ? undefined : String(a.videoCodec),
      audioCodec: a.audioCodec === undefined ? undefined : String(a.audioCodec),
      realtime: a.realtime === undefined ? undefined : Boolean(a.realtime),
    }),
  })
  tool({
    name: 'xmedia.publish.stop', description: '停止指定编码推流任务', mutates: true,
    params: JobIdParamsS,
    execute: (a) => publishStop({ jobId: a.jobId === undefined ? undefined : String(a.jobId) }),
  })
  tool({
    name: 'xmedia.publish.status', description: '查询指定编码推流任务状态与观看地址',
    params: JobIdParamsS,
    execute: (a) => publishStatus({ jobId: a.jobId === undefined ? undefined : String(a.jobId) }),
  })

  // ---- self-description, health, cleanup ------------------------------------
  disposers.push(ctx.capabilities.register({
    id: name,
    title: 'xmedia-kit 原生引擎',
    description: 'C++20 媒体 SDK 作为独立进程;命令走 @mediabase/engine-client 线协议,编码码流直推 MediaMTX,浏览器直连 WHEP/HLS 播放;支持多任务并发与进程沙箱',
    services: ['xmedia'],
    api: [...API_NAMES],
    tools: [...TOOL_NAMES],
    events: ['xmedia.engine', 'xmedia.event', 'xmedia.publish'],
  }))
  disposers.push(ctx.api.health(() => ({
    [name]: { ...service.engineState(), publish: lastJobId ? jobs.get(lastJobId)?.viewers : undefined, metrics: metrics.snapshot() },
  })))

  ctx.effect(() => () => {
    disposed = true
    for (const dispose of disposers) dispose()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    client.dispose()
  }, `${name}: engine`)
}
