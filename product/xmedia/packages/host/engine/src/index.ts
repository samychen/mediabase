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
// Wire verbs (publish.*, bake.*) and their column layouts are owned by the
// SINGLE-SOURCE contract at protocol/contract.json, consumed here via ./protocol
// and by the C++ bridge via the generated engine/src/xmedia_protocol.h. Adding
// product verbs does NOT change the protocol version — only a change to
// hello/ok/err semantics would (see @mediabase/engine-client).
//
// bake.* is the ONE data-plane exception this product makes: the offline bake
// produces a finished MP4 FILE, and `xmedia.bake.<jobId>` serves it back as a
// pull route (200 + Range 206). Publishing still never touches the host —
// RTMP goes straight from xmedia-kit to MediaMTX.

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
const execFileAsync = (cmd: string, args: string[], opts?: Record<string, unknown>) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, opts as any, (err, stdout) => err ? reject(err) : resolve(String(stdout)))
})
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs'
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
import { Metrics, type MetricsSnapshot } from './metrics'

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
  /** mtime of the engine binary on disk (null when unreadable). */
  binaryMtimeMs: number | null
  /** When the CURRENT child process was spawned (not the host process). */
  engineStartedAtMs: number
  /**
   * The binary was rebuilt AFTER the running child started. Publishing through
   * it would exercise stale code (e.g. a fixed muxer that is not loaded yet).
   */
  binaryStale: boolean
}

/** Snapshot of one async TranscodeJob maintained by the C++ bridge. */
export interface XmediaPublishStatus {
  running: boolean
  done: boolean
  ok: boolean
  /** Cooperative pause: the worker parks at the next packet boundary. */
  paused: boolean
  progress: number
  input: string
  output: string
  format: string
  error: string
  elapsedMs: number
  sandboxed: boolean
  /** Echoed by the bridge on every reply; publish.list rows carry it per row. */
  jobId?: string | undefined
}

/** One row of `xmedia.publish.jobs` — the whole task pool in one snapshot. */
export type XmediaJobRow = XmediaPublishStatus & { jobId: string }

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

/** Snapshot of one offline bake job (HTML → MP4) maintained by the bridge. */
export interface XmediaBakeStatus {
  kind: 'bake'
  running: boolean
  done: boolean
  ok: boolean
  cancelled: boolean
  progress: number
  stage: string
  html: string
  output: string
  error: string
  exitCode: number
  elapsedMs: number
}

export interface XmediaBakeOptions {
  jobId?: string | undefined
  seconds?: number | undefined
  fps?: number | undefined
  width?: number | undefined
  height?: number | undefined
  codec?: string | undefined
  clock?: 'virtual_time' | 'seek' | 'live' | undefined
  chunks?: number | undefined
  /** Page data injected through the window.update contract (stringified onto
   *  the wire; the bridge passes it to the bake child verbatim). */
  data?: Record<string, unknown> | undefined
  /** HyperFrames unit contract: data-start/duration/end are SECONDS. */
  hfSeconds?: boolean | undefined
  /** Mix the page's audio/media elements into an AAC track (default on). */
  audio?: boolean | undefined
}

export interface XmediaBakeResult extends XmediaBakeStatus {
  jobId: string
  /** Pull route for the finished MP4 ('' until the file exists on disk). */
  url: string
}

export interface XmediaService {
  hello(): Promise<{ protocol: number; engine: string }>
  drainEvents(): Promise<XmediaEvent[]>
  publishStart(input: string, options?: XmediaPublishOptions): Promise<XmediaPublishResult>
  publishStop(options?: { jobId?: string | undefined }): Promise<XmediaPublishResult>
  publishStatus(options?: { jobId?: string | undefined }): Promise<XmediaPublishResult>
  publishPause(options?: { jobId?: string | undefined }): Promise<XmediaPublishResult>
  publishResume(options?: { jobId?: string | undefined }): Promise<XmediaPublishResult>
  publishJobs(): Promise<XmediaJobRow[]>
  bakeStart(htmlPath: string, output: string, options?: XmediaBakeOptions): Promise<XmediaBakeResult>
  bakeStatus(options?: { jobId?: string | undefined }): Promise<XmediaBakeResult>
  bakeCancel(options?: { jobId?: string | undefined }): Promise<XmediaBakeResult>
  viewers(path?: string): XmediaViewers
  engineState(): XmediaEngineState
  metrics(): MetricsSnapshot & { bake: MetricsSnapshot }
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
  /** Encoder used for LIVE (network) outputs; empty = libx264 on all platforms. */
  liveVideoCodec: string
  /** xmedia-bake executable for the offline HTML→MP4 pipeline. Empty lets the
   *  bridge probe a sibling of its own binary (macOS: the assembled .app). A
   *  missing binary surfaces as a coded bake.start failure — never a lie. */
  bakeBinary: string
  /** Serve finished bake outputs through the `xmedia.bake.<jobId>` pull route. */
  bakeRoute: boolean
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
  bakeBinary: z.string().default('')
    .description('xmedia-bake 可执行文件;空 = 由引擎探测自身同级目录(macOS 为 .app bundle 内)'),
  bakeRoute: z.boolean().default(true)
    .description('烘焙成片经 /api/xmedia.bake.<jobId> 拉取路由对外提供(200+Range)'),
})

/** Control-plane methods this capability registers (kept in one place for the manifest). */
export const API_NAMES = [
  'xmedia.hello',
  'xmedia.events',
  'xmedia.engine.state',
  'xmedia.publish.start',
  'xmedia.publish.stop',
  'xmedia.publish.status',
  'xmedia.publish.pause',
  'xmedia.publish.resume',
  'xmedia.publish.jobs',
  'xmedia.publish.viewers',
  'xmedia.bake.start',
  'xmedia.bake.status',
  'xmedia.bake.cancel',
  'xmedia.metrics',
] as const

/** Tools exposed to the agent / MCP bridge (same verbs, one declaration). */
export const TOOL_NAMES = [
  'xmedia.publish.start',
  'xmedia.publish.stop',
  'xmedia.publish.status',
  'xmedia.publish.pause',
  'xmedia.publish.resume',
  'xmedia.publish.jobs',
  'xmedia.publish.viewers',
  'xmedia.bake.start',
  'xmedia.bake.status',
  'xmedia.bake.cancel',
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
/** bake.start 的可选旋钮收敛为一个宿主校验过的对象;非法值在建任务前拒绝。 */
const BakeStartParamsS = z.object({
  htmlPath: z.string().required().description('页面:本地 HTML 绝对路径或 file:///https:// URL;file:// 页面的脚本子资源必须内联(OSR 对相对 file:// 脚本渲染黑屏)'),
  output: z.string().required().description('输出 MP4 绝对路径(引擎直接写该文件;取消/失败不留半成品)'),
  jobId: z.string().description('任务 ID;省略则由宿主生成'),
  seconds: z.number().min(0.2).max(3600).description('时长(秒,整数效果由引擎取整);默认 1'),
  fps: z.number().min(1).max(120).description('帧率;默认 10'),
  width: z.number().min(16).max(4096).description('宽度;默认 320'),
  height: z.number().min(16).max(4096).description('高度;默认 240'),
  codec: z.string().description('视频编码器名(avcodec 编码器名,如 libx264/h264_videotoolbox);默认 macOS h264_videotoolbox / 其他 libx264'),
  clock: z.union([z.const('virtual_time'), z.const('seek'), z.const('live')])
    .description('烘焙时钟;默认按页面来源选择——本地页 virtual_time(VT 确定性),远程 URL live(VT 会冻结 CEF 网络栈,远程页永远加载不完)'),
  chunks: z.number().min(1).max(64).description('分块数;每块独立编码后无损拼接'),
  data: z.dict(z.any()).description('页面数据注入(window.update 契约;首帧后注入一次)'),
  hfSeconds: z.boolean().description('HyperFrames 秒制时序(data-start/duration 单位为秒)'),
  audio: z.boolean().description('混入页面音频元素为 AAC 轨;默认 true'),
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
  let engineStartedAtMs = Date.now()
  let helloInfo: { protocol: number; engine: string } | null = null
  // Sandbox engagement, read once from the engine after handshake.
  let sandboxActive = false
  // Task pool: jobId -> viewers + encoder. Lets many jobs run concurrently.
  const jobs = new Map<string, { viewers: XmediaViewers; videoCodec: string }>()
  let lastJobId: string | null = null
  // Bake jobs: jobId -> output path (the route is registered lazily, once the
  // file actually exists). bakeMetrics is a SEPARATE collector so a bake job
  // and a publish job never blur each other's counters.
  const bakeMetrics = new Metrics()
  const bakes = new Map<string, { output: string }>()
  let lastBakeId: string | null = null
  const bakeRoutes = new Map<string, { dispose: () => void }>()
  const MAX_BAKE_ROUTES = 24

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

  /** Normalise one parsed publish JSON record into a typed status. */
  function asPublishStatusRaw(raw: Record<string, unknown>): XmediaPublishStatus {
    const str = (key: string): string => typeof raw[key] === 'string' ? raw[key] as string : ''
    const num = (key: string): number => typeof raw[key] === 'number' ? raw[key] as number : 0
    return {
      running: raw.running === true,
      done: raw.done === true,
      ok: raw.ok === true,
      paused: raw.paused === true,
      progress: num('progress'),
      input: str('input'),
      output: str('output'),
      format: str('format'),
      error: str('error'),
      elapsedMs: num('elapsedMs'),
      sandboxed: raw.sandboxed === true,
      jobId: str('jobId') || undefined,
    }
  }

  function asPublishStatus(parts: string[], verb: string): XmediaPublishStatus {
    return asPublishStatusRaw(asRecord(jsonColumn(parts, verb), verb))
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
        engineStartedAtMs = Date.now()
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
      if (event.type === 'BakeProgress') {
        ctx.events.emit('xmedia.bake', { phase: 'progress', ...event })
      }
      // Pause transitions reach subscribers the same way stop does; the monitor
      // UI mostly polls publish.jobs, these serve event-driven consumers.
      if (event.type === 'PublishPaused') {
        ctx.events.emit('xmedia.publish', { phase: 'paused', ...event })
      }
      if (event.type === 'PublishResumed') {
        ctx.events.emit('xmedia.publish', { phase: 'resumed', ...event })
      }
      if (event.type === 'BakeDone') {
        const jobId = typeof event.jobId === 'string' ? event.jobId : ''
        const ok = event.ok === true
        const rec = bakeMetrics.snapshot().recent.find((r) => r.jobId === jobId)
        bakeMetrics.recordCompletion(jobId, ok, rec?.elapsedMs ?? 0,
          typeof event.error === 'string' ? event.error : undefined)
        ctx.events.emit('xmedia.bake', { phase: 'done', ...event })
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
    // Live default is libx264 on EVERY platform, including macOS. The old
    // macOS default (h264_videotoolbox) writes Annex-B packets with in-band
    // SPS/PPS that FFmpeg's FLV/RTMP muxer rejects mid-stream: a real
    // 1080p60 file dies with "writing a re-encoded video packet failed"
    // consistently at ~60-68s (reproduced 3x), which surfaces to the user as
    // "推流十秒多就断了". libx264 ran the same source past that point with no
    // error. VideoToolbox stays opt-in via XMEDIA_LIVE_VCODEC / videoCodec.
    const defaultLiveCodec = config.liveVideoCodec || 'libx264'
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
    phase?: 'stop' | 'paused' | 'resumed',
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

  // Pause/resume share publishControl: same id resolution, same status parse,
  // same viewers re-attach — only the verb and the phase event differ. Both are
  // idempotent at the bridge (a paused/finished/unknown id just answers its
  // snapshot), so the host adds no extra state of its own.
  const publishPause = (options: { jobId?: string | undefined } = {}): Promise<XmediaPublishResult> =>
    publishControl(VERB.PUBLISH_PAUSE, options, 'paused')

  const publishResume = (options: { jobId?: string | undefined } = {}): Promise<XmediaPublishResult> =>
    publishControl(VERB.PUBLISH_RESUME, options, 'resumed')

  /** The whole task pool as one snapshot — the monitor UI's data source. */
  async function publishJobs(): Promise<XmediaJobRow[]> {
    const parsed = jsonColumn(await call([VERB.PUBLISH_LIST]), VERB.PUBLISH_LIST)
    if (!Array.isArray(parsed)) {
      throw new RpcError(RpcCode.ENGINE, 'xmedia: publish.list 返回不是数组')
    }
    return parsed.filter(isRecord).map((raw, i) => {
      if (typeof raw.jobId !== 'string' || raw.jobId === '') {
        throw new RpcError(RpcCode.ENGINE, `xmedia: publish.list[${i}] 缺少 jobId`)
      }
      return { ...asPublishStatusRaw(raw), jobId: raw.jobId }
    })
  }

  // ---- bake: offline HTML→MP4 (the ONE pull-route exception this product
  // makes — see the file header). The bridge spawns a one-shot xmedia-bake
  // child per job; this side validates knobs, banks metrics, and serves the
  // finished file back. ----------------------------------------------------------------

  function contentTypeOf(file: string): string {
    return file.endsWith('.mp4') || file.endsWith('.m4v') ? 'video/mp4'
      : file.endsWith('.webm') ? 'video/webm'
      : file.endsWith('.mkv') ? 'video/x-matroska'
      : 'application/octet-stream'
  }

  /** Range-aware file server (200 + `content-range` 206 on request). */
  function serveFile(file: string, range?: { start: number; end: number }) {
    const size = statSync(file).size
    const from = range === undefined ? 0 : Math.max(0, Math.min(range.start, size))
    const to = range === undefined ? size - 1 : Math.max(from, Math.min(range.end, size - 1))
    const length = size === 0 ? 0 : to - from + 1
    const body = new Uint8Array(length)
    if (length > 0) {
      const fd = openSync(file, 'r')
      try {
        readSync(fd, body, 0, length, from)
      } finally {
        closeSync(fd)
      }
    }
    const headers: Record<string, string> = {
      'content-type': contentTypeOf(file),
      'accept-ranges': 'bytes',
      'content-length': String(length),
    }
    if (range !== undefined) {
      headers['content-range'] = `bytes ${from}-${to}/${size}`
    }
    return { body, headers, totalSize: size }
  }

  /**
   * Publish the finished bake output. The route name carries the job id (no
   * path parameter to traverse with) and the table is BOUNDED — an unbounded
   * route table in a long-running host is a memory leak. The file gate is
   * existence: a route for a file the child removed (cancel/failure) would
   * turn every seek into a 500.
   */
  function ensureBakeRoute(jobId: string, output: string): string {
    if (!config.bakeRoute || output === '' || !existsSync(output)) return ''
    if (bakeRoutes.has(jobId)) return `/api/xmedia.bake.${jobId}`
    const dispose = ctx.api.route({
      name: `xmedia.bake.${jobId}`,
      description: `烘焙任务 ${jobId} 的成片(支持 Range)`,
      handler: (range) => serveFile(output, range),
    })
    bakeRoutes.set(jobId, { dispose })
    while (bakeRoutes.size > MAX_BAKE_ROUTES) {
      const oldest = bakeRoutes.keys().next()
      if (oldest.done === true) break
      bakeRoutes.get(oldest.value)?.dispose()
      bakeRoutes.delete(oldest.value)
    }
    return `/api/xmedia.bake.${jobId}`
  }

  /** Normalise the bridge's bake JSON into a typed status. */
  function asBakeStatus(parts: string[], verb: string): XmediaBakeStatus {
    const raw = asRecord(jsonColumn(parts, verb), verb)
    const str = (key: string): string => typeof raw[key] === 'string' ? raw[key] as string : ''
    const num = (key: string): number => typeof raw[key] === 'number' ? raw[key] as number : 0
    return {
      kind: 'bake',
      running: raw.running === true,
      done: raw.done === true,
      ok: raw.ok === true,
      cancelled: raw.cancelled === true,
      progress: num('progress'),
      stage: str('stage'),
      html: str('html'),
      output: str('output'),
      error: str('error'),
      exitCode: num('exitCode'),
      elapsedMs: num('elapsedMs'),
    }
  }

  async function bakeStart(
    htmlPath: string,
    output: string,
    options: XmediaBakeOptions = {},
  ): Promise<XmediaBakeResult> {
    if (typeof htmlPath !== 'string' || htmlPath.trim() === '') {
      throw new RpcError(RpcCode.INVALID_PARAMS, 'xmedia: bake.start 需要非空 htmlPath')
    }
    if (typeof output !== 'string' || !output.startsWith('/') || output.endsWith('/')) {
      throw new RpcError(RpcCode.INVALID_PARAMS, 'xmedia: bake.start 需要本地输出文件的绝对路径')
    }
    const jobId = options.jobId && options.jobId.trim() ? options.jobId.trim() : randomUUID()
    // The kit's encoder lookup is avcodec_find_encoder_by_name — it wants the
    // ENCODER name (libx264 / h264_videotoolbox), not the codec name ("h264"
    // is not an encoder name and resolves to nothing). Same platform default
    // as the live publish path.
    const codec = options.codec ??
      (process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264')
    // Clock default follows the page's origin: VirtualTime freezes CEF's
    // network-service timers, so a REMOTE page never finishes its TLS
    // handshake under VT (measured: SSL handshake failed / net_error -100 →
    // no first frame in 30s). Remote pages bake with the live wall clock;
    // local pages keep the deterministic VT default.
    const remotePage = /^[a-z][a-z0-9+.-]*:\/\//i.test(htmlPath) &&
      !htmlPath.startsWith('file://')
    const clock = options.clock ?? (remotePage ? 'live' : undefined)
    const optionsJson = JSON.stringify({
      seconds: options.seconds,
      fps: options.fps,
      width: options.width,
      height: options.height,
      codec,
      clock,
      chunks: options.chunks,
      // The bridge extracts `data` as a JSON STRING: double-stringify. A
      // nested object would be invisible to the bridge's minimal extractor.
      data: options.data === undefined ? '' : JSON.stringify(options.data),
      hfSeconds: options.hfSeconds,
      audio: options.audio,
      // Host-injected deployment knob — callers never pass it.
      bakeBin: config.bakeBinary,
    })
    const parts = await call([
      VERB.BAKE_START, jobId, wire(htmlPath), wire(output), wire(optionsJson),
    ])
    const status = asBakeStatus(parts, VERB.BAKE_START)
    bakeMetrics.recordStart(jobId, htmlPath)
    bakes.set(jobId, { output })
    lastBakeId = jobId
    ctx.events.emit('xmedia.bake', { phase: 'start', jobId, ...status })
    return { ...status, jobId, url: '' }
  }

  /** bake.status / bake.cancel share one shape; cancel emits its phase event. */
  async function bakeControl(
    verb: string,
    options: { jobId?: string | undefined },
    phase?: 'cancel',
  ): Promise<XmediaBakeResult> {
    const jobId = options.jobId ?? lastBakeId ?? ''
    const status = asBakeStatus(await call([verb, jobId]), verb)
    if (status.done && !status.running) {
      bakeMetrics.recordCompletion(jobId, status.ok, status.elapsedMs, status.error || undefined)
    }
    const url = status.done && status.ok
      ? ensureBakeRoute(jobId, status.output || bakes.get(jobId)?.output || '')
      : ''
    if (phase !== undefined) ctx.events.emit('xmedia.bake', { phase, jobId, ...status })
    return { ...status, jobId, url }
  }

  const bakeStatusFn = (options: { jobId?: string | undefined } = {}): Promise<XmediaBakeResult> =>
    bakeControl(VERB.BAKE_STATUS, options)

  const bakeCancelFn = (options: { jobId?: string | undefined } = {}): Promise<XmediaBakeResult> =>
    bakeControl(VERB.BAKE_CANCEL, options, 'cancel')

  // 原生文件选择对话框：浏览器无法获取完整文件路径，由宿主进程代开系统对话框。
  async function pickFile(): Promise<string> {
    if (process.platform === 'darwin') {
      try {
        const result = await execFileAsync('osascript', [
          '-e', 'POSIX path of (choose file with prompt "选择要推流的本地文件")',
        ], { encoding: 'utf8', timeout: 60000 })
        return String(result || '').trim()
      } catch {
        return ''
      }
    }
    // Linux: zenity
    if (process.platform === 'linux') {
      try {
        const result = await execFileAsync('zenity', ['--file-selection', '--title=选择要推流的本地文件'], {
          encoding: 'utf8', timeout: 60000,
        })
        return String(result || '').trim()
      } catch {
        return ''
      }
    }
    return ''
  }

  const service: XmediaService = {
    hello: greet,
    drainEvents,
    publishStart,
    publishStop,
    publishStatus,
    publishPause,
    publishResume,
    publishJobs,
    bakeStart,
    bakeStatus: bakeStatusFn,
    bakeCancel: bakeCancelFn,
    viewers: (path) => viewerUrls(path ?? config.publishPath),
    engineState: () => {
      let binaryMtimeMs: number | null = null
      try {
        binaryMtimeMs = statSync(config.binary).mtimeMs
      } catch {
        // Missing/unreadable binary is reported honestly as null; never guess.
      }
      return {
        running: client.running,
        pid: client.pid,
        restarts,
        binary: config.binary,
        protocol: helloInfo?.protocol ?? null,
        engine: helloInfo?.engine ?? null,
        sandboxed: sandboxActive,
        binaryMtimeMs,
        engineStartedAtMs,
        // 1s tolerance: filesystem timestamp granularity and process startup
        // must not produce a false "stale" warning on a fresh restart.
        binaryStale: binaryMtimeMs !== null && binaryMtimeMs > engineStartedAtMs + 1000,
      }
    },
    metrics: () => ({ ...metrics.snapshot(), bake: bakeMetrics.snapshot() }),
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
  disposers.push(ctx.api.register({
    name: 'xmedia.publish.pause',
    description: '暂停指定转码任务(协作式:worker 在下一个包边界挂起;幂等)',
    mutates: true,
    params: JobIdParamsS,
    handler: (p) => publishPause({ jobId: p.jobId }),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.publish.resume',
    description: '恢复已暂停的转码任务(幂等)',
    mutates: true,
    params: JobIdParamsS,
    handler: (p) => publishResume({ jobId: p.jobId }),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.publish.jobs',
    description: '整个任务池的快照(每个任务的进度/状态/暂停标志/耗时;监控 UI 的数据源)',
    handler: () => publishJobs(),
  }))

  disposers.push(ctx.api.register({
    name: 'xmedia.files.pick',
    description: '打开系统文件选择对话框，返回选中的文件完整路径（用于本地文件推流）',
    mutates: false,
    handler: async () => ({ path: await pickFile() }),
  }))

  // ---- control plane: offline bake (HTML → MP4) -------------------------------
  disposers.push(ctx.api.register({
    name: 'xmedia.bake.start',
    description: '启动离线烘焙:HyperFrames 对齐页面经 CEF 离屏渲染合成为 MP4 成片(确定性时钟)',
    mutates: true,
    params: BakeStartParamsS,
    handler: (p) => bakeStart(p.htmlPath, p.output, {
      jobId: p.jobId,
      seconds: p.seconds,
      fps: p.fps,
      width: p.width,
      height: p.height,
      codec: p.codec,
      clock: p.clock,
      chunks: p.chunks,
      data: p.data,
      hfSeconds: p.hfSeconds,
      audio: p.audio,
    }),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.bake.status',
    description: '查询烘焙任务状态(阶段/进度/输出路径/成片拉取路由)',
    params: JobIdParamsS,
    handler: (p) => bakeStatusFn({ jobId: p.jobId }),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.bake.cancel',
    description: '取消烘焙任务(SIGTERM 协作式,子进程清理半成品)',
    mutates: true,
    params: JobIdParamsS,
    handler: (p) => bakeCancelFn({ jobId: p.jobId }),
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
  tool({
    name: 'xmedia.publish.pause', description: '暂停指定转码任务(协作式包边界挂起)', mutates: true,
    params: JobIdParamsS,
    execute: (a) => publishPause({ jobId: a.jobId === undefined ? undefined : String(a.jobId) }),
  })
  tool({
    name: 'xmedia.publish.resume', description: '恢复已暂停的转码任务', mutates: true,
    params: JobIdParamsS,
    execute: (a) => publishResume({ jobId: a.jobId === undefined ? undefined : String(a.jobId) }),
  })
  tool({
    name: 'xmedia.publish.jobs', description: '任务池快照:全部并发转码任务的进度/状态/暂停标志/耗时',
    params: z.object({}),
    execute: () => publishJobs(),
  })
  tool({
    name: 'xmedia.files.pick', description: '打开系统文件选择对话框，返回选中文件的完整路径',
    params: z.object({}),
    execute: async () => ({ path: await pickFile() }),
  })
  tool({
    name: 'xmedia.bake.start',
    description: '离线烘焙:HyperFrames 对齐 HTML 页面 → CEF 离屏渲染 → MP4 成片(输出为本地文件,完成后经 /api/xmedia.bake.<jobId> 拉取)',
    mutates: true,
    params: BakeStartParamsS,
    execute: (a) => bakeStart(String(a.htmlPath), String(a.output), {
      jobId: a.jobId === undefined ? undefined : String(a.jobId),
      seconds: a.seconds === undefined ? undefined : Number(a.seconds),
      fps: a.fps === undefined ? undefined : Number(a.fps),
      width: a.width === undefined ? undefined : Number(a.width),
      height: a.height === undefined ? undefined : Number(a.height),
      codec: a.codec === undefined ? undefined : String(a.codec),
      clock: a.clock === undefined ? undefined : String(a.clock) as XmediaBakeOptions['clock'],
      chunks: a.chunks === undefined ? undefined : Number(a.chunks),
      data: isRecord(a.data) ? a.data : undefined,
      hfSeconds: a.hfSeconds === undefined ? undefined : Boolean(a.hfSeconds),
      audio: a.audio === undefined ? undefined : Boolean(a.audio),
    }),
  })
  tool({
    name: 'xmedia.bake.status', description: '查询烘焙任务状态(阶段/进度/成片路由)',
    params: JobIdParamsS,
    execute: (a) => bakeStatusFn({ jobId: a.jobId === undefined ? undefined : String(a.jobId) }),
  })
  tool({
    name: 'xmedia.bake.cancel', description: '取消烘焙任务(协作式,清理半成品)',
    mutates: true,
    params: JobIdParamsS,
    execute: (a) => bakeCancelFn({ jobId: a.jobId === undefined ? undefined : String(a.jobId) }),
  })

  // ---- self-description, health, cleanup ------------------------------------
  disposers.push(ctx.capabilities.register({
    id: name,
    title: 'xmedia-kit 原生引擎',
    description: 'C++20 媒体 SDK 作为独立进程;命令走 @mediabase/engine-client 线协议,编码码流直推 MediaMTX,浏览器直连 WHEP/HLS 播放;离线烘焙(HyperFrames 对齐 HTML→MP4)经 xmedia-bake 子进程执行,成片经拉取路由取回;支持多任务并发与进程沙箱',
    services: ['xmedia'],
    api: [...API_NAMES],
    tools: [...TOOL_NAMES],
    events: ['xmedia.engine', 'xmedia.event', 'xmedia.publish', 'xmedia.bake'],
  }))
  disposers.push(ctx.api.health(() => ({
    [name]: {
      ...service.engineState(),
      publish: lastJobId ? jobs.get(lastJobId)?.viewers : undefined,
      bake: lastBakeId ? { jobId: lastBakeId, output: bakes.get(lastBakeId)?.output } : undefined,
      metrics: service.metrics(),
    },
  })))

  ctx.effect(() => () => {
    disposed = true
    for (const dispose of disposers) dispose()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    client.dispose()
  }, `${name}: engine`)
}
