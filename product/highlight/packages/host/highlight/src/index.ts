// @vhl/host-highlight — the PRODUCT capability that owns the highlight engine.
//
// Boundary (the base's one layering rule): this package NEVER touches pixels.
// It supervises a Python sidecar (engine/vhl_bridge.py) over the neutral line
// protocol, exposes the analyze control plane, publishes finished clips on a
// data-plane byte route, and registers the agent tools. @mediabase/server and
// @mediabase/ui-web name no media concept and were not edited.
//
// Why the engine is Python and not in-process: the scoring stack is a Python
// ecosystem (OpenCV, ONNX Runtime, faster-whisper). Crossing a process boundary
// keeps a model crash from taking the host down, keeps LGPL FFmpeg at arm's
// length (CLI invocation in that process), and lets the engine restart without
// losing the control plane.
//
// Durability posture: the engine's job registry is IN MEMORY (a restart forgets
// completed jobs), and so is the host's own Map. `jobs-journal.ts` closes exactly
// that gap — an append-only JSONL file under the product home, replayed at boot
// so "what was I working on" survives a restart. What cannot survive is the work
// itself: a job mid-render when the process died comes back as `interrupted`,
// never as `running`, and the caller decides whether to resubmit.

import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
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
import {
  OPTION_SPECS, PROTOCOL_VERSION, VERB, VERB_NAMES, isKnownVerb, optionKeys, responseField,
  unknownVerbMessage, type VerbName,
} from './protocol.ts'
import { JobJournal } from './jobs-journal.ts'
import { newHistogram, observe, renderMetrics } from './prometheus.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Highlight engine facade (the supervised Python bridge). */
    highlight: HighlightService
  }
}

// --------------------------------------------------------------------------- //
// Wire types (camelCase on the wire, mirrored by engine/vhl_bridge.py)
// --------------------------------------------------------------------------- //

export interface HighlightSegment {
  startSec: number
  endSec: number
  score: number
  signals: Record<string, number>
}

/**
 * Engine states, plus ONE state only the host can produce.
 *
 * `interrupted` is not an engine verdict: it is what the journal reports for a
 * job that was queued or running when this process (or a previous one) died. It
 * is terminal — nothing will ever move it again — and it exists so a client can
 * tell "your job failed" from "the host went away, resubmit if you still want it".
 */
export type HighlightState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface HighlightJob {
  jobId: string
  state: HighlightState | string
  stage: string
  progress: number
  input: string
  output: string
  error: string
  createdAtMs: number
  startedAtMs: number | null
  finishedAtMs: number | null
  durationSec: number
  fps: number
  segments: HighlightSegment[]
  segmentCount: number
  srtPath: string
  reportPath: string
}

/** What the host returns: the engine snapshot plus host-owned artifact URLs. */
export interface HighlightJobView extends HighlightJob {
  /** Data-plane URL for the finished clip ('' until the job succeeds). */
  clipUrl: string
  /** WebVTT rendering of the engine's SRT ('' when the job produced none). */
  subtitleUrl: string
  /** The engine's explainability report (signals per window), as JSON. */
  reportUrl: string
  /**
   * True when this row came from the journal because the engine no longer has
   * it. The clip may still exist and still play; what is gone is the engine's
   * copy of the record. Without this flag a client cannot tell a live snapshot
   * from an archived one, and would poll a row that will never advance.
   */
  fromDisk: boolean
}

/** One row of the engine's option catalogue (what a client is allowed to set). */
export interface HighlightOption {
  key: string
  type: string
  default: unknown
  min: number | null
  max: number | null
  enum: unknown[] | null
  requires: string
  group: string
  /** False when this deployment lacks the model an opt-in needs. */
  available: boolean
  /**
   * Sub-keys when `type === 'weights'` (one composite knob), else null. Carried
   * on the wire so a renderer does not have to know which signals exist.
   */
  fields: Record<string, { field: string; default: number }> | null
}

export interface HighlightMedia {
  path: string
  durationSec: number
  fps: number
  width: number
  height: number
  hasAudio: boolean
  videoCodec: string
  audioCodec: string
}

export interface HighlightEngineState {
  running: boolean
  pid: number | null
  restarts: number
  python: string
  script: string
  protocol: number | null
  engine: string | null
  ffmpeg: string | null
}

export interface HighlightModels {
  detector: { kind: string; path: string; present: boolean; license: string }
  face: { available: boolean; license: string }
  clip: { available: boolean; license: string }
  whisper: { available: boolean; license: string }
  runtime: { opencv: boolean; numpy: boolean; onnxruntime: boolean }
  degraded: boolean
  /**
   * Why vision is off, as a code the panel translates — `opencv-missing` (install
   * it), `numpy-missing` (cv2 is there, its numeric dependency is not),
   * `opencv-import-failed` (both installed, the import dies). '' when not degraded.
   * A code rather than a sentence because the UI owns the wording; and empty rather
   * than a guess when the engine did not say, so an older engine cannot make the
   * panel accuse the wrong cause.
   */
  degradedReason: string
}

export interface HighlightService {
  hello(): Promise<{ protocol: number; engine: string; python: string; ffmpeg: string }>
  state(): HighlightEngineState
  probe(path: string): Promise<HighlightMedia>
  start(input: string, options?: HighlightStartOptions): Promise<HighlightJobView>
  status(jobId?: string | undefined): Promise<HighlightJobView>
  cancel(jobId?: string | undefined): Promise<HighlightJobView>
  list(): Promise<HighlightJobView[]>
  exportEdl(jobId: string, path?: string | undefined): Promise<string>
  models(): Promise<HighlightModels>
  options(): Promise<HighlightOption[]>
  metrics(): HighlightMetrics
}

export interface HighlightStartOptions {
  jobId?: string | undefined
  output?: string | undefined
  topK?: number | undefined
  clipDurationSec?: number | undefined
  /** Any engine option (camelCase keys, see engine/vhl_bridge.py _OPTIONS). */
  options?: Record<string, unknown> | undefined
}

export interface HighlightMetrics {
  jobsStarted: number
  succeeded: number
  failed: number
  cancelled: number
  /** Jobs the host believes are queued or running right now. */
  queueDepth: number
  /** Highlight segments produced by succeeded jobs (monotone within a process). */
  segmentsTotal: number
  /** Mean wall time of terminal jobs observed in this process (ms). */
  avgElapsedMs: number
  /** Rows the journal yielded at boot (0 on a fresh home). */
  restoredJobs: number
  /** Of those, how many were mid-flight and are now reported interrupted. */
  interruptedJobs: number
  recent: Array<{ jobId: string; state: string; elapsedMs: number; segments: number }>
}

/** Plugin name (stable identity). */
export const name = 'highlight'

/** Services required before apply() runs. */
export const inject = ['api', 'capabilities', 'tools', 'log'] as const

export interface HighlightEngineConfig {
  /** Application root: the capability composes its own work directory from it. */
  root: string
  /** Interpreter that runs the bridge (python3 on PATH by default). */
  python: string
  /** The bridge script (defaults to <root>/engine/vhl_bridge.py). */
  script: string
  /** Extra argv passed to the interpreter, before the script path. */
  pythonArgs: string[]
  /** Per-command timeout. analyze.start returns immediately, so this is small. */
  callTimeoutMs: number
  autoRestart: boolean
  maxRestarts: number
  restartDelayMs: number
  /** Where job outputs live; omitted = <root>/work. */
  workDir: string
  /** Artifact directories kept under the work dir (oldest pruned). 0 = keep all. */
  retainJobs: number
  /**
   * The job journal (JSONL). Omitted = `<appPaths.home>/jobs.jsonl`, the product
   * identity home — NOT the work dir: retention prunes the work dir, and history
   * should outlive the artifacts it describes.
   */
  journalFile: string
  /** Serve Prometheus text at /api/metrics (token-gated like the rest of /api/*). */
  metricsRoute: boolean
  /**
   * Queue ceiling handed to the engine (`--max-queue`). The host passes it
   * explicitly instead of relying on the bridge default so the capacity it
   * *reports* is the capacity it *configured* — a metric that guesses is worse
   * than no metric.
   */
  maxQueue: number
}

export const Config: Schema<HighlightEngineConfig, HighlightEngineConfig> = z.object({
  root: z.string().required().description('应用根目录(产物与脚本相对它解析)'),
  python: z.string().default(process.env.VHL_PYTHON ?? 'python3')
    .description('运行引擎桥的 Python 解释器(默认读 VHL_PYTHON,否则 PATH 上的 python3)'),
  script: z.string().default('').description('engine/vhl_bridge.py 路径;空则用 <root>/engine/vhl_bridge.py'),
  pythonArgs: z.array(z.string()).default([]).description('解释器附加参数(如 -u)'),
  callTimeoutMs: z.natural().default(20_000).description('单条命令超时(ms)'),
  autoRestart: z.boolean().default(true).description('引擎崩溃后自动重启'),
  maxRestarts: z.natural().default(3).description('重启次数上限'),
  restartDelayMs: z.natural().default(500).description('重启前等待(ms)'),
  workDir: z.string().default('').description('任务产物目录;空则 <root>/work'),
  retainJobs: z.natural().default(20).description('工作目录保留的任务产物目录数(0=不清理)'),
  journalFile: z.string().default('').description('任务日志(JSONL)路径;空则 <appPaths.home>/jobs.jsonl'),
  metricsRoute: z.boolean().default(true).description('在 /api/metrics 提供 Prometheus 文本指标'),
  maxQueue: z.natural().default(8).description('引擎排队上限(含运行中);超出回 CONFLICT 而不是无限堆积'),
})

/** Control-plane methods this capability registers (one place for the manifest). */
export const API_NAMES = [
  'highlight.hello',
  'highlight.engine.state',
  'highlight.probe',
  'highlight.start',
  'highlight.status',
  'highlight.cancel',
  'highlight.jobs.list',
  'highlight.export.edl',
  'highlight.models',
  'highlight.options',
  'highlight.metrics',
] as const

/** Tools exposed to the agent / MCP bridge (same verbs, one declaration). */
export const TOOL_NAMES = [
  'highlight.probe',
  'highlight.start',
  'highlight.status',
  'highlight.cancel',
  'highlight.export.edl',
] as const

/** Param schemas declared ONCE, shared by the API and the agent surface. */
const StartParamsS = z.object({
  input: z.string().required().description('输入视频的绝对路径'),
  options: z.dict(z.any()).description('引擎选项(clipDurationSec / maxHighlights / keywords / enableWhisper …)'),
  topK: z.natural().description('保留片段数(等价于 options.maxHighlights)'),
  clipDurationSec: z.number().description('单段时长秒(等价于 options.clipDurationSec)'),
  output: z.string().description('成片输出绝对路径;省略则由宿主在作品目录下生成'),
  jobId: z.string().description('任务 ID;省略则由宿主生成'),
})
const JobIdS = z.object({
  jobId: z.string().description('任务 ID;省略时对最近一次任务生效'),
})
const ProbeParamsS = z.object({
  path: z.string().required().description('要探测的媒体绝对路径'),
})
const ExportEdlS = z.object({
  jobId: z.string().required().description('任务 ID'),
  path: z.string().description('EDL 输出路径;省略则与成片同名 .edl'),
})

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RpcError(RpcCode.ENGINE, `highlight: ${what} 返回不是对象`)
  }
  return value
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Parse one JSON payload column; a malformed reply is a coded failure, not a cast. */
function jsonColumn(parts: string[], verb: string, column: string): unknown {
  const raw = parts[responseField(verb, column)]
  if (raw === undefined || raw === '') {
    throw new RpcError(RpcCode.ENGINE, `highlight: ${verb} 未返回 ${column}`)
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new RpcError(RpcCode.ENGINE, `highlight: ${verb} 的 ${column} 不是合法 JSON`)
  }
}

/** A tab/newline inside a column would split one request into two. Never emit one. */
function wire(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ')
}

function asSegment(value: unknown): HighlightSegment | null {
  if (!isRecord(value)) return null
  const startSec = num(value.startSec, Number.NaN)
  const endSec = num(value.endSec, Number.NaN)
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null
  const signals: Record<string, number> = {}
  if (isRecord(value.signals)) {
    for (const [key, raw] of Object.entries(value.signals)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) signals[key] = raw
    }
  }
  return { startSec, endSec, score: num(value.score), signals }
}

function asJob(value: unknown, verb: string): HighlightJob {
  const raw = asRecord(value, verb)
  const segments: HighlightSegment[] = []
  if (Array.isArray(raw.segments)) {
    for (const item of raw.segments) {
      const seg = asSegment(item)
      if (seg !== null) segments.push(seg)
    }
  }
  const jobId = str(raw.jobId)
  if (jobId === '') {
    throw new RpcError(RpcCode.ENGINE, `highlight: ${verb} 返回的任务缺少 jobId`)
  }
  return {
    jobId,
    state: str(raw.state, 'unknown'),
    stage: str(raw.stage, ''),
    progress: num(raw.progress),
    input: str(raw.input),
    output: str(raw.output),
    error: str(raw.error),
    createdAtMs: num(raw.createdAtMs),
    startedAtMs: raw.startedAtMs === null ? null : num(raw.startedAtMs),
    finishedAtMs: raw.finishedAtMs === null ? null : num(raw.finishedAtMs),
    durationSec: num(raw.durationSec),
    fps: num(raw.fps, 25),
    segments,
    segmentCount: num(raw.segmentCount, segments.length),
    srtPath: str(raw.srtPath),
    reportPath: str(raw.reportPath),
  }
}

/**
 * Terminal = nothing will move this row again.
 *
 * `interrupted` belongs here and its absence would be a live bug: a restored job
 * counted as non-terminal keeps queue depth above zero forever, so a host that
 * restarted once would refuse every new job with CONFLICT and never explain why.
 */
function isTerminal(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
}

/** Path containment check for the clip route (no traversal, no symlink games). */
function insideDir(dir: string, file: string): boolean {
  const rel = relative(dir, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Resolve a path through symlinks, or return it unchanged when it does not exist.
 *
 * This is load-bearing on macOS: the engine resolves `/var/…` to
 * `/private/var/…`, so comparing an unresolved work directory with a resolved
 * output would report "outside the work dir" for a perfectly normal job — and
 * the clip would silently lose its playback route.
 */
function resolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function contentTypeOf(file: string): string {
  if (file.endsWith('.mp4')) return 'video/mp4'
  if (file.endsWith('.vtt')) return 'text/vtt; charset=utf-8'
  if (file.endsWith('.srt')) return 'text/plain; charset=utf-8'
  if (file.endsWith('.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.edl')) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

/**
 * SRT → WebVTT.
 *
 * The engine writes SRT because every editor and `ffmpeg -i` understands it. A
 * browser `<track>` does not: Chrome rejects SRT outright. Converting on the way
 * out is ~10 lines and keeps the artifact on disk in the interoperable format,
 * instead of teaching the Python engine a second subtitle dialect.
 */
export function srtToVtt(srt: string): string {
  const blocks: string[] = []
  for (const block of srt.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) continue
    // A bare cue number is legal in SRT and meaningless in VTT; drop it rather
    // than force every renderer to treat it as a cue identifier.
    if (/^\d+$/.test(lines[0]!.trim())) lines.shift()
    if (lines.length === 0) continue
    blocks.push(lines.map((line) => (line.includes('-->') ? line.replace(/,/g, '.') : line)).join('\n'))
  }
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`
}

/**
 * Validate `analyze.start` options against the CONTRACT table.
 *
 * The engine validates the same table (engine/vhl_bridge.py), so this is not a
 * second opinion — it is the same rules answered without a process hop. That
 * matters for two reasons: a typo fails before a job id is burned, and the error
 * carries the available keys, which is the difference between "invalid params"
 * and a fixable message.
 */
export function validateOptions(input: Record<string, unknown>): Record<string, unknown> {
  const unknown = Object.keys(input).filter((key) => !(key in OPTION_SPECS))
  if (unknown.length > 0) {
    throw new RpcError(
      RpcCode.INVALID_PARAMS,
      `highlight: 未知选项 ${unknown.join(', ')}(可用: ${optionKeys().join(', ')})`,
    )
  }
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    const spec = OPTION_SPECS[key]!
    if (spec.type === 'bool') {
      if (typeof raw !== 'boolean') {
        throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: 选项 ${key} 必须是布尔值`)
      }
    } else if (spec.type === 'int') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: 选项 ${key} 必须是整数`)
      }
    } else if (spec.type === 'float') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: 选项 ${key} 必须是数字`)
      }
    } else if (spec.type === 'str') {
      if (typeof raw !== 'string') {
        throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: 选项 ${key} 必须是字符串`)
      }
    } else if (spec.type === 'strs') {
      const ok = typeof raw === 'string' || (Array.isArray(raw) && raw.every((item) => typeof item === 'string'))
      if (!ok) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: 选项 ${key} 必须是字符串数组`)
      }
    } else if (spec.type === 'weights') {
      // A composite knob. The engine normalises these against each other, so the
      // only honest contract is: known signals, each in [0,1], at least one > 0.
      // (All-zero would make the engine silently substitute its defaults — a
      // request that appears applied and changes nothing.)
      const fields = spec.fields ?? {}
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new RpcError(
          RpcCode.INVALID_PARAMS,
          `highlight: 选项 ${key} 必须是对象(子键: ${Object.keys(fields).join(', ')})`,
        )
      }
      let total = 0
      for (const [sub, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!(sub in fields)) {
          throw new RpcError(
            RpcCode.INVALID_PARAMS,
            `highlight: ${key} 没有子键 ${sub}(可用: ${Object.keys(fields).join(', ')})`,
          )
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
          throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: ${key}.${sub} 必须是 0~1 之间的数字`)
        }
        total += value
      }
      if (total <= 0) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: ${key} 至少要有一个信号权重 > 0`)
      }
    }
    if (spec.enum !== undefined && !spec.enum.includes(raw)) {
      throw new RpcError(
        RpcCode.INVALID_PARAMS,
        `highlight: 选项 ${key} 必须是 ${spec.enum.join(' / ')} 之一`,
      )
    }
    if (typeof raw === 'number') {
      if (spec.min !== undefined && raw < spec.min) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: 选项 ${key} 不能小于 ${spec.min}`)
      }
      if (spec.max !== undefined && raw > spec.max) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: 选项 ${key} 不能大于 ${spec.max}`)
      }
    }
    out[key] = raw
  }
  if (typeof out.clipPrompt === 'string' && out.clipPrompt !== '' && out.enableClipGuidance !== true) {
    throw new RpcError(RpcCode.INVALID_PARAMS, 'highlight: clipPrompt 需要同时开启 enableClipGuidance')
  }
  return out
}

// --------------------------------------------------------------------------- //
// Capability
// --------------------------------------------------------------------------- //

export function apply(ctx: Context, rawConfig: HighlightEngineConfig): void {
  const config = parse(Config, rawConfig)
  const log = ctx.log.child(name)
  const disposers: Array<() => void> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const workDir = config.workDir !== '' ? config.workDir : join(config.root, 'work')
  // The product OWNS its work dir: create it at boot so (a) a bad path fails
  // here, naming the row, instead of on the first job, and (b) the resolved
  // form below is the real one — realpath cannot resolve a directory that does
  // not exist yet, and an unresolved root silently breaks clip playback on
  // platforms whose temp dir is a symlink (/var -> /private/var).
  mkdirSync(workDir, { recursive: true })
  /** Work dir as the filesystem reports it (symlinks resolved once). */
  const workRoot = resolved(workDir)

  /** Is this artifact inside the product's own work dir? (both sides resolved) */
  const insideWork = (file: string): boolean => insideDir(workRoot, resolved(file))
  const script = config.script !== '' ? config.script : join(config.root, 'engine', 'vhl_bridge.py')

  const metrics: HighlightMetrics = {
    jobsStarted: 0, succeeded: 0, failed: 0, cancelled: 0, queueDepth: 0, avgElapsedMs: 0,
    segmentsTotal: 0, restoredJobs: 0, interruptedJobs: 0, recent: [],
  }
  /** Wall time of terminal jobs, bucketed for Prometheus (seconds, cumulative). */
  const jobDurations = newHistogram()
  /** Process-level counters that only the exposure format needs (not the JSON API). */
  const appliedAt = Date.now()
  let handshakeFailures = 0
  /**
   * jobId -> last observed snapshot. The host keeps this for three reasons the
   * engine cannot serve: retention (which artifact dirs are ours), queue depth
   * (the engine forgets on restart), and "why did my job vanish" after a restart.
   */
  const knownJobs = new Map<string, HighlightJob>()
  /** `<kind>:<jobId>` -> byte route disposer (bounded, oldest evicted). */
  const artifactRoutes = new Map<string, { dispose: () => void }>()
  const MAX_ARTIFACT_ROUTES = 24

  let restarts = 0
  let fastDeaths = 0
  let disposed = false
  let helloInfo: { protocol: number; engine: string; python: string; ffmpeg: string } | null = null
  let lastJobId: string | null = null

  // ---- job journal --------------------------------------------------------- //
  //
  // Boot order matters here: the journal is opened (and replayed) BEFORE the
  // engine client is constructed, so a job restored as `interrupted` is already
  // in `knownJobs` by the time the first status poll or list could run. Replay
  // never talks to the engine — it answers from disk even when the engine is the
  // thing that just failed to start.
  //
  // Retention is ONE knob: `retainJobs` decides how many artifact directories
  // survive AND how many journal records are kept, because "how many finished
  // jobs do you still care about" was never two questions. The line ceiling is
  // derived (20× the window) so a running job's heartbeats are compacted away
  // long before the file is worth thinking about.
  const appHome = (ctx.get('appPaths') as { home?: string } | undefined)?.home
  const journalFile = config.journalFile !== ''
    ? config.journalFile
    : join(appHome ?? join(homedir(), '.vhl'), 'jobs.jsonl')
  const journal = new JobJournal({
    file: journalFile,
    keep: config.retainJobs,
    maxRecords: config.retainJobs > 0 ? config.retainJobs * 20 : 0,
    onDrop: (reason) => log.warn(reason, { file: journalFile }),
    // A journal that cannot be written is a degraded deployment, not a failed
    // one: the job still runs, and the operator gets one line naming the file.
    onError: (reason) => log.error('任务日志不可用(任务本身不受影响)', { file: journalFile, reason }),
  })
  const restored = journal.replay()
  for (const job of restored.jobs) knownJobs.set(job.jobId, job)
  metrics.restoredJobs = restored.jobs.length
  metrics.interruptedJobs = restored.interrupted
  if (restored.jobs.length > 0) {
    const newest = restored.jobs.reduce((a, b) => (b.createdAtMs > a.createdAtMs ? b : a))
    lastJobId = newest.jobId
    log.info('已从任务日志恢复历史任务', {
      jobs: restored.jobs.length,
      interrupted: restored.interrupted,
      dropped: restored.dropped,
      file: journalFile,
    })
    // A death is worth an event: an operator watching `highlight.job` sees the
    // crash that happened while nothing was listening.
    for (const job of restored.jobs) {
      if (job.state !== 'interrupted') continue
      ctx.events.emit('highlight.job', {
        phase: 'interrupted', jobId: job.jobId, elapsedMs: 0, segments: job.segmentCount, error: job.error,
      })
    }
  }
  refreshQueueDepth()

  const client = new EngineClient(config.python, {
    // The queue ceiling is set HERE, not left to the bridge's default, so the
    // number in the metric, the number in the refusal message and the number the
    // supervisor believes are the same number.
    args: [...config.pythonArgs, script, '--max-queue', String(config.maxQueue)],
    callTimeoutMs: config.callTimeoutMs,
    onStderr: (line) => log.debug('[vhl-bridge]', { line }),
    onExit: (info: EngineExitInfo) => {
      if (disposed || info.expected) return
      log.warn('高光引擎进程退出', { code: info.code, signal: info.signal, uptimeMs: info.uptimeMs })
      ctx.events.emit('highlight.engine', {
        phase: 'exit', code: info.code, signal: info.signal, uptimeMs: info.uptimeMs,
      })
      // A binary that dies instantly is broken, not "crashed once": stop the
      // restart loop before it becomes a log flood. This is PRODUCT policy —
      // the neutral EngineClient deliberately leaves the decision up here.
      fastDeaths = info.uptimeMs < 1000 ? fastDeaths + 1 : 0
      if (!config.autoRestart || restarts >= config.maxRestarts || fastDeaths >= 3) {
        if (fastDeaths >= 3) log.error('引擎反复立即退出,停止重启(检查 VHL_PYTHON 与 engine/vhl_bridge.py)')
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (disposed) return
        restarts += 1
        log.info('重启高光引擎', { attempt: restarts })
        client.restart()
        void handshake()
      }, config.restartDelayMs)
      timers.add(timer)
    },
  })

  /** One command, one reply. Non-`ok` becomes a code the client can branch on. */
  async function call(verb: VerbName, parts: string[] = []): Promise<string[]> {
    // The contract is the HOST's. A verb it does not declare is this side's bug,
    // and the engine is the one component that cannot fix it — so refuse here,
    // with the verb quoted and counted, instead of spending a round trip to be
    // told 未知动词 by a process that has no idea who sent it.
    if (!isKnownVerb(verb)) {
      throw new RpcError(RpcCode.INVALID_PARAMS, unknownVerbMessage(verb), { verb, known: VERB_NAMES })
    }
    const reply = await client.call([verb, ...parts.map(wire)])
    const head = reply[0]
    if (head === 'ok' || head === verb) return reply
    const engineCode = reply[1] ?? 'FAILED'
    const detail = reply.slice(2).join(' ').trim() || '引擎拒绝执行'
    const code = engineCode === 'INVALID_PARAMS'
      ? RpcCode.INVALID_PARAMS
      : engineCode === 'NOT_FOUND'
        ? RpcCode.NOT_FOUND
        : engineCode === 'UNAVAILABLE'
          ? RpcCode.UNAVAILABLE
          : engineCode === 'CONFLICT'
            // Queue full. A distinct code is the point: a client can back off and
            // retry, which it cannot do for a generic ENGINE failure.
            ? RpcCode.CONFLICT
            : RpcCode.ENGINE
    throw new RpcError(code, `highlight: ${detail}`, { verb, engineCode }, {
      messageKey: 'highlight.engineRejected',
      messageParams: { verb, code: engineCode, detail },
    })
  }

  async function greet(): Promise<{ protocol: number; engine: string; python: string; ffmpeg: string }> {
    const info = await client.hello()
    assertProtocol(info) // mismatch → CONFLICT, never a mis-parsed column
    const reply = await client.call(['hello'])
    const full = {
      protocol: info.protocol,
      engine: info.engine,
      python: reply[3] ?? '',
      ffmpeg: reply[4] ?? '',
    }
    helloInfo = full
    return full
  }

  async function handshake(): Promise<void> {
    try {
      const info = await greet()
      log.info('高光引擎握手成功', info)
      ctx.events.emit('highlight.engine', { phase: 'ready', ...info })
    } catch (e) {
      // A missing interpreter or script must NOT stop the host: every call then
      // fails with a coded UNAVAILABLE that a client can branch on. The counter
      // is what makes it visible without reading logs.
      handshakeFailures += 1
      log.debug('高光引擎握手暂不可用', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  void handshake()

  // ---- artifact routes ----------------------------------------------------- //

  function serveBuffer(
    data: Uint8Array,
    contentType: string,
    range?: { start: number; end: number },
  ) {
    const size = data.byteLength
    // `from`/`to` rather than `start`/`end`: the range object already names its
    // bounds `start`/`end`, and a local with the same name reads as a bug even
    // when it is correct (the linter flags it, and it is right to).
    const from = range === undefined ? 0 : Math.max(0, Math.min(range.start, size))
    const to = range === undefined ? size - 1 : Math.max(from, Math.min(range.end, size - 1))
    const body = size === 0 ? new Uint8Array(0) : data.subarray(from, to + 1)
    const headers: Record<string, string> = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'content-length': String(body.byteLength),
    }
    if (range !== undefined) {
      headers['content-range'] = `bytes ${from}-${to}/${size}`
    }
    return { body, headers, totalSize: size }
  }

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

  type ArtifactKind = 'clip' | 'subtitle' | 'report'

  /**
   * Resolve one artifact, or '' when it is absent.
   *
   * Three gates, all of them load-bearing: the path must be non-empty (the
   * engine reports '' for "not produced"), inside the product work dir (a job
   * with a caller-supplied output path elsewhere must not become a file server),
   * and actually present on disk (a job record outlives a deleted artifact; a
   * route for a missing file turns a normal "gone" into a 500 on every seek).
   */
  function artifactPath(job: HighlightJob, kind: ArtifactKind): string {
    const raw = kind === 'clip' ? job.output : kind === 'subtitle' ? job.srtPath : job.reportPath
    if (raw === '' || !insideWork(raw) || !existsSync(raw)) return ''
    return raw
  }

  /**
   * Publish one artifact. The route name carries the job id, so there is no path
   * parameter to traverse with, and the table is BOUNDED: an unbounded route
   * table is a memory leak in a long-running process.
   */
  function ensureArtifactRoute(job: HighlightJob, kind: ArtifactKind): void {
    const key = `${kind}:${job.jobId}`
    if (artifactRoutes.has(key)) return
    const file = artifactPath(job, kind)
    if (file === '') {
      if (kind === 'clip' && job.state === 'succeeded') {
        log.warn('成片不可用于回放(不在作品目录或已被删除)', { jobId: job.jobId, output: job.output })
      }
      return
    }
    const dispose = ctx.api.route({
      name: `highlight.${kind}.${job.jobId}`,
      description: kind === 'clip'
        ? `任务 ${job.jobId} 的高光成片(支持 Range)`
        : kind === 'subtitle'
          ? `任务 ${job.jobId} 的字幕(WebVTT,可直接用作 <track>)`
          : `任务 ${job.jobId} 的可解释性报告(JSON)`,
      handler: (range) => (kind === 'subtitle'
        // Converted per request: a few KB, and it keeps SRT as the on-disk
        // interop format that every editor understands.
        ? serveBuffer(Buffer.from(srtToVtt(readFileSync(file, 'utf8')), 'utf8'), 'text/vtt; charset=utf-8', range)
        : serveFile(file, range)),
    })
    artifactRoutes.set(key, { dispose })
    while (artifactRoutes.size > MAX_ARTIFACT_ROUTES) {
      const oldest = artifactRoutes.keys().next()
      if (oldest.done === true) break
      artifactRoutes.get(oldest.value)?.dispose()
      artifactRoutes.delete(oldest.value)
    }
  }

  function artifactUrl(job: HighlightJob, kind: ArtifactKind): string {
    return artifactPath(job, kind) === '' ? '' : `/api/highlight.${kind}.${job.jobId}`
  }

  function view(job: HighlightJob, fromDisk = false): HighlightJobView {
    for (const kind of ['clip', 'subtitle', 'report'] as const) ensureArtifactRoute(job, kind)
    return {
      ...job,
      clipUrl: artifactUrl(job, 'clip'),
      subtitleUrl: artifactUrl(job, 'subtitle'),
      reportUrl: artifactUrl(job, 'report'),
      fromDisk,
    }
  }

  /** Queue depth as the HOST sees it — the engine forgets on restart, this does not. */
  function refreshQueueDepth(): void {
    let depth = 0
    for (const job of knownJobs.values()) {
      if (job.state === 'queued' || job.state === 'running') depth += 1
    }
    metrics.queueDepth = depth
  }

  /**
   * Keep the work dir bounded: drop the artifact directory of jobs that are both
   * terminal AND beyond the retention window.
   *
   * Deliberately conservative — it only ever removes `<workDir>/<jobId>` for a
   * job id this process started and that resolved inside the work root, so a
   * caller who points `output` somewhere else, or who puts unrelated files in the
   * work dir, is never touched. Boot-time adoption of older directories is NOT
   * done: "delete a directory I found on disk" is not a decision a product should
   * make from a filename pattern alone.
   */
  function pruneWorkDir(): void {
    if (config.retainJobs <= 0) return
    const terminal = [...knownJobs.values()].filter((job) => isTerminal(job.state))
    const excess = terminal.length - config.retainJobs
    if (excess <= 0) return
    const oldest = terminal
      .sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0))
      .slice(0, excess)
    for (const job of oldest) {
      const dir = join(workRoot, job.jobId)
      // Re-check containment on the RESOLVED path: a symlinked job directory
      // would otherwise let `rm -r` escape the work root.
      if (!insideDir(workRoot, resolved(dir))) {
        log.warn('跳过清理:任务目录不在作品目录内', { jobId: job.jobId, dir })
        continue
      }
      try {
        rmSync(resolved(dir), { recursive: true, force: true })
        for (const kind of ['clip', 'subtitle', 'report'] as const) {
          const key = `${kind}:${job.jobId}`
          artifactRoutes.get(key)?.dispose()
          artifactRoutes.delete(key)
        }
        knownJobs.delete(job.jobId)
        // Retention applies to history too: a record whose artifact directory is
        // gone would come back at the next boot pointing at nothing.
        journal.forget(job.jobId)
        log.info('已清理过期任务产物', { jobId: job.jobId, dir })
      } catch (error) {
        log.warn('清理任务产物失败', { jobId: job.jobId, error: String(error) })
      }
    }
    refreshQueueDepth()
  }

  /** Record a terminal observation once (idempotent) so metrics stay correct. */
  function noteCompletion(job: HighlightJob): void {
    knownJobs.set(job.jobId, job)
    // Persist first, count second: if the process dies during an event handler
    // the journal already has the outcome, and the next boot reports it as fact.
    journal.append(job)
    refreshQueueDepth()
    if (!isTerminal(job.state)) return
    if (metrics.recent.some((row) => row.jobId === job.jobId)) return
    const elapsedMs = job.finishedAtMs !== null && job.startedAtMs !== null
      ? job.finishedAtMs - job.startedAtMs
      : 0
    if (job.state === 'succeeded') metrics.succeeded += 1
    else if (job.state === 'cancelled') metrics.cancelled += 1
    else metrics.failed += 1
    // Cancelled jobs have no meaningful duration to report — a 3s cancel says
    // nothing about engine throughput and would skew the histogram's p50 down.
    if (job.state !== 'cancelled') observe(jobDurations, elapsedMs / 1000)
    metrics.segmentsTotal += job.segmentCount
    metrics.recent.unshift({ jobId: job.jobId, state: job.state, elapsedMs, segments: job.segmentCount })
    metrics.recent = metrics.recent.slice(0, 20)
    metrics.avgElapsedMs = Math.round(
      metrics.recent.reduce((sum, row) => sum + row.elapsedMs, 0) / Math.max(1, metrics.recent.length),
    )
    ctx.events.emit('highlight.job', {
      phase: job.state, jobId: job.jobId, elapsedMs, segments: job.segmentCount, error: job.error,
    })
    pruneWorkDir()
  }

  // ---- commands ------------------------------------------------------------ //

  function requireAbsolute(value: string, what: string): string {
    const trimmed = value.trim()
    if (trimmed === '') {
      throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: ${what} 不能为空`)
    }
    if (!isAbsolute(trimmed)) {
      throw new RpcError(RpcCode.INVALID_PARAMS, `highlight: ${what} 必须是绝对路径: ${trimmed}`)
    }
    return trimmed
  }

  /** Record a snapshot (running included) and hand back the wire view. */
  function track(job: HighlightJob, fromDisk = false): HighlightJobView {
    knownJobs.set(job.jobId, job)
    // The journal dedupes by signature, so calling this on every poll writes
    // only when something actually moved.
    journal.append(job)
    refreshQueueDepth()
    return view(job, fromDisk)
  }

  /** Model availability, cached briefly: answering it needs a process round-trip. */
  let modelsCache: { at: number; value: HighlightModels } | null = null

  async function modelsCached(): Promise<HighlightModels> {
    if (modelsCache !== null && Date.now() - modelsCache.at < 30_000) return modelsCache.value
    const value = await models()
    modelsCache = { at: Date.now(), value }
    return value
  }

  function capabilityOf(report: HighlightModels, requires: string): boolean {
    if (requires === 'face') return report.face.available
    if (requires === 'clip') return report.clip.available
    if (requires === 'whisper') return report.whisper.available
    if (requires === 'onnxruntime') return report.runtime.onnxruntime
    if (requires === 'onnx') return report.detector.present
    return true
  }

  /**
   * Refuse an EXPLICIT opt-in to a model this deployment does not have.
   *
   * Defaults are still allowed to degrade silently (enableWhisper defaults to
   * true; a box without faster-whisper simply produces no subtitles). But a
   * client that asks for CLIP guidance and gets a zero signal with no
   * explanation has been lied to — a coded UNAVAILABLE naming the package is the
   * honest answer. The engine enforces the same rule from the same table.
   */
  async function assertRequirements(values: Record<string, unknown>): Promise<void> {
    const required = new Set<string>()
    for (const [key, raw] of Object.entries(values)) {
      const requires = OPTION_SPECS[key]?.requires
      if (requires === undefined) continue
      if (raw === false || raw === '' || raw === null) continue
      required.add(requires)
    }
    if (required.size === 0) return
    let report: HighlightModels
    try {
      report = await modelsCached()
    } catch {
      // The engine is down; the start call itself will fail with the right code.
      return
    }
    for (const requires of required) {
      if (capabilityOf(report, requires)) continue
      throw new RpcError(
        RpcCode.UNAVAILABLE,
        `highlight: 当前部署缺少 ${requires} 能力,无法开启需要它的选项`,
        // The wire key stays `models` — renaming the local must not rename the
        // payload a client already reads.
        { requires, models: report },
        { messageKey: 'highlight.capabilityMissing', messageParams: { requires } },
      )
    }
  }

  /** The engine's option catalogue, so a UI renders what this build supports. */
  async function options(): Promise<HighlightOption[]> {
    const raw = jsonColumn(await call(VERB.OPTIONS_LIST), VERB.OPTIONS_LIST, 'optionsJson')
    if (!Array.isArray(raw)) {
      throw new RpcError(RpcCode.ENGINE, 'highlight: options.list 返回的不是数组')
    }
    const rows: HighlightOption[] = []
    for (const item of raw) {
      if (!isRecord(item)) continue
      const key = str(item.key)
      if (key === '') continue
      rows.push({
        key,
        type: str(item.type, 'str'),
        default: item.default ?? null,
        min: typeof item.min === 'number' ? item.min : null,
        max: typeof item.max === 'number' ? item.max : null,
        enum: Array.isArray(item.enum) ? item.enum : null,
        requires: str(item.requires),
        group: str(item.group, 'analysis'),
        available: item.available !== false,
        fields: isRecord(item.fields) ? item.fields as Record<string, { field: string; default: number }> : null,
      })
    }
    return rows
  }

  async function start(input: string, request: HighlightStartOptions = {}): Promise<HighlightJobView> {
    const source = requireAbsolute(input, 'input')
    const jobId = request.jobId !== undefined && request.jobId.trim() !== ''
      ? request.jobId.trim()
      : randomUUID()
    const output = request.output !== undefined && request.output.trim() !== ''
      ? requireAbsolute(request.output, 'output')
      : join(workDir, jobId, 'highlight.mp4')

    const merged: Record<string, unknown> = { ...(request.options ?? {}) }
    if (request.topK !== undefined) merged.maxHighlights = request.topK
    if (request.clipDurationSec !== undefined) merged.clipDurationSec = request.clipDurationSec
    // Same table, same rules as the engine (see validateOptions): a typo fails
    // here, with the list of valid keys, before a job id is burned.
    const engineOptions = validateOptions(merged)
    await assertRequirements(engineOptions)

    const parts = [jobId, source, output, JSON.stringify(engineOptions)]
    const job = asJob(jsonColumn(await call(VERB.ANALYZE_START, parts), VERB.ANALYZE_START, 'jobJson'), VERB.ANALYZE_START)
    lastJobId = job.jobId
    metrics.jobsStarted += 1
    ctx.events.emit('highlight.job', { phase: 'start', jobId: job.jobId, input: job.input })
    return track(job)
  }

  async function status(jobId?: string | undefined): Promise<HighlightJobView> {
    const id = jobId ?? lastJobId ?? ''
    try {
      const job = asJob(jsonColumn(await call(VERB.ANALYZE_STATUS, [id]), VERB.ANALYZE_STATUS, 'jobJson'), VERB.ANALYZE_STATUS)
      lastJobId = job.jobId
      noteCompletion(job)
      return track(job)
    } catch (error) {
      // The engine forgot (it restarted, or a previous process submitted this
      // job). Answering NOT_FOUND here would be technically true and practically
      // useless: the clip is on disk and the row is in the journal. `fromDisk`
      // is how the caller learns which half answered.
      if (!(error instanceof RpcError) || error.code !== RpcCode.NOT_FOUND) throw error
      const known = knownJobs.get(id)
      if (known === undefined) throw error
      log.debug('任务不在引擎中,改由任务日志回答', { jobId: id, state: known.state })
      return track(known, true)
    }
  }

  async function cancel(jobId?: string | undefined): Promise<HighlightJobView> {
    const id = jobId ?? lastJobId ?? ''
    const job = asJob(jsonColumn(await call(VERB.ANALYZE_CANCEL, [id]), VERB.ANALYZE_CANCEL, 'jobJson'), VERB.ANALYZE_CANCEL)
    noteCompletion(job)
    return track(job)
  }

  /**
   * The job list, engine first and journal behind it.
   *
   * The engine's table is the truth for this process: it is fresher by
   * definition (it is the thing advancing progress). The journal supplies what
   * the engine no longer has — everything from a previous process — so the list
   * is "what this deployment has done", not "what this process happens to
   * remember". Deduped by id, engine row wins, newest first.
   */
  async function list(): Promise<HighlightJobView[]> {
    const rows: HighlightJob[] = []
    let engineAnswered = true
    try {
      const raw = jsonColumn(await call(VERB.JOBS_LIST), VERB.JOBS_LIST, 'jobsJson')
      if (Array.isArray(raw)) {
        for (const item of raw) {
          try {
            rows.push(asJob(item, VERB.JOBS_LIST))
          } catch {
            // A single malformed row must not hide the rest of the list.
          }
        }
      }
    } catch (error) {
      // An engine that will not answer is exactly when the journal earns its
      // keep. Rethrow only when there is nothing at all to show.
      if (knownJobs.size === 0) throw error
      engineAnswered = false
      log.warn('引擎未响应,任务列表改由任务日志提供', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    for (const job of rows) noteCompletion(job)
    const seen = new Set(rows.map((job) => job.jobId))
    const merged = [...rows]
    for (const job of knownJobs.values()) {
      if (!seen.has(job.jobId)) merged.push(job)
    }
    merged.sort((a, b) => b.createdAtMs - a.createdAtMs)
    return merged.map((job) => track(job, !engineAnswered || !seen.has(job.jobId)))
  }

  async function probe(path: string): Promise<HighlightMedia> {
    const target = requireAbsolute(path, 'path')
    const raw = asRecord(jsonColumn(await call(VERB.PROBE, [target]), VERB.PROBE, 'mediaJson'), VERB.PROBE)
    return {
      path: str(raw.path, target),
      durationSec: num(raw.durationSec),
      fps: num(raw.fps, 25),
      width: num(raw.width),
      height: num(raw.height),
      hasAudio: raw.hasAudio === true,
      videoCodec: str(raw.videoCodec),
      audioCodec: str(raw.audioCodec),
    }
  }

  async function exportEdl(jobId: string, path?: string | undefined): Promise<string> {
    if (jobId.trim() === '') {
      throw new RpcError(RpcCode.INVALID_PARAMS, 'highlight: export.edl 需要 jobId')
    }
    const target = path !== undefined && path.trim() !== '' ? requireAbsolute(path, 'path') : ''
    const reply = await call(VERB.EXPORT_EDL, [jobId.trim(), target])
    return reply[1] ?? ''
  }

  async function models(): Promise<HighlightModels> {
    const raw = asRecord(jsonColumn(await call(VERB.MODELS_LIST), VERB.MODELS_LIST, 'modelsJson'), VERB.MODELS_LIST)
    const group = (key: string): Record<string, unknown> => isRecord(raw[key]) ? raw[key] as Record<string, unknown> : {}
    const detector = group('detector')
    const runtime = group('runtime')
    // The reason exists only for a degraded machine: keeping a stale one on a
    // healthy host would let a panel print "install OpenCV" beside "working".
    const degraded = raw.degraded === true
    return {
      detector: {
        kind: str(detector.kind, 'onnx'),
        path: str(detector.path),
        present: detector.present === true,
        license: str(detector.license),
      },
      face: { available: group('face').available === true, license: str(group('face').license) },
      clip: { available: group('clip').available === true, license: str(group('clip').license) },
      whisper: { available: group('whisper').available === true, license: str(group('whisper').license) },
      runtime: {
        opencv: runtime.opencv === true,
        numpy: runtime.numpy === true,
        onnxruntime: runtime.onnxruntime === true,
      },
      degraded,
      degradedReason: degraded ? str(raw.degradedReason) : '',
    }
  }

  const service: HighlightService = {
    hello: greet,
    state: () => ({
      running: client.running,
      pid: client.pid,
      restarts,
      python: config.python,
      script,
      protocol: helloInfo?.protocol ?? null,
      engine: helloInfo?.engine ?? null,
      ffmpeg: helloInfo?.ffmpeg ?? null,
    }),
    probe,
    start,
    status,
    cancel,
    list,
    exportEdl,
    models,
    options,
    metrics: () => ({ ...metrics, recent: [...metrics.recent] }),
  }
  ctx.reflect.provide('highlight', service)

  // ---- control plane ------------------------------------------------------- //

  disposers.push(ctx.api.register({
    name: 'highlight.hello',
    description: '引擎握手(协议版本、引擎标识、Python 与 FFmpeg 版本)',
    handler: () => service.hello(),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.engine.state',
    description: '子进程监督状态(running/pid/重启次数/解释器/脚本/协议版本)',
    handler: () => service.state(),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.probe',
    description: '探测媒体(时长/帧率/分辨率/音轨/编码)',
    params: ProbeParamsS,
    handler: (p) => probe(p.path),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.start',
    description: '提交高光分析任务(立即返回任务快照;结果按 progress 轮询)',
    mutates: true,
    params: StartParamsS,
    handler: (p) => start(p.input, {
      jobId: p.jobId,
      output: p.output,
      topK: p.topK,
      clipDurationSec: p.clipDurationSec,
      options: p.options,
    }),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.status',
    description: '查询任务状态(阶段/进度/片段/产物路径);省略 jobId 取最近一次',
    params: JobIdS,
    handler: (p) => status(p.jobId),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.cancel',
    description: '取消任务(协作式:会终止正在运行的 FFmpeg,不产出半成品)',
    mutates: true,
    params: JobIdS,
    handler: (p) => cancel(p.jobId),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.jobs.list',
    description: '列出任务:引擎当前表 + 任务日志里的历史(宿主重启后仍在,标 fromDisk)',
    handler: () => list(),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.export.edl',
    description: '把任务的片段导出为 CMX3600 EDL(剪辑系统/OpenVideo 可消费)',
    mutates: true,
    params: ExportEdlS,
    handler: (p) => exportEdl(p.jobId, p.path),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.models',
    description: '已装模型与推理运行时(含许可证标识,供 SBOM/合规核对)',
    handler: () => models(),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.options',
    description: '分析选项目录(类型/默认值/范围/依赖能力),供 UI 动态渲染而不写死',
    handler: () => options(),
  }))
  disposers.push(ctx.api.register({
    name: 'highlight.metrics',
    description: '任务可观测指标(启动/成功/失败/取消与最近窗口)',
    handler: () => service.metrics(),
  }))

  // ---- agent / MCP tools --------------------------------------------------- //

  const tool = (method: Parameters<typeof ctx.tools.register>[0]): void => {
    disposers.push(ctx.tools.register(method))
  }
  tool({
    name: 'highlight.probe',
    description: '探测视频时长/帧率/音轨,提交分析前先看它',
    params: ProbeParamsS,
    execute: (a) => probe(String(a.path)),
  })
  tool({
    name: 'highlight.start',
    description: '提交高光分析任务(输入绝对路径;返回任务 ID,再轮询 highlight.status)',
    mutates: true,
    params: StartParamsS,
    execute: (a) => start(String(a.input), {
      jobId: a.jobId === undefined ? undefined : String(a.jobId),
      output: a.output === undefined ? undefined : String(a.output),
      topK: a.topK === undefined ? undefined : Number(a.topK),
      clipDurationSec: a.clipDurationSec === undefined ? undefined : Number(a.clipDurationSec),
      options: isRecord(a.options) ? a.options : undefined,
    }),
  })
  tool({
    name: 'highlight.status',
    description: '查询高光任务状态与片段(阶段/进度/成片路径)',
    params: JobIdS,
    execute: (a) => status(a.jobId === undefined ? undefined : String(a.jobId)),
  })
  tool({
    name: 'highlight.cancel',
    description: '取消高光任务(立即终止正在跑的 FFmpeg)',
    mutates: true,
    params: JobIdS,
    execute: (a) => cancel(a.jobId === undefined ? undefined : String(a.jobId)),
  })
  tool({
    name: 'highlight.export.edl',
    description: '把任务片段导出为 EDL,交给剪辑系统做二次创作',
    mutates: true,
    params: ExportEdlS,
    execute: (a) => exportEdl(String(a.jobId), a.path === undefined ? undefined : String(a.path)),
  })

  // ---- Prometheus exposition ----------------------------------------------- //

  /**
   * `GET /api/metrics` (byte route → `/api/<name>` at the gateway).
   *
   * Deliberately a scrape-time snapshot of in-memory counters only: no engine
   * round-trip, no disk. A monitoring endpoint that blocks behind a wedged child
   * reports nothing exactly when its report matters most.
   */
  if (config.metricsRoute) {
    disposers.push(ctx.api.route({
      name: 'metrics',
      description: 'Prometheus 文本指标(引擎/任务/队列/耗时直方图);抓取只读内存,不做 I/O',
      handler: () => {
        const text = renderMetrics({
          protocol: PROTOCOL_VERSION,
          engine: helloInfo?.engine ?? null,
          processUp: client.running,
          ready: client.running && helloInfo !== null,
          restarts,
          fastDeaths,
          handshakeFailures,
          uptimeSec: Math.round((Date.now() - appliedAt) / 1000),
          jobsStarted: metrics.jobsStarted,
          succeeded: metrics.succeeded,
          failed: metrics.failed,
          cancelled: metrics.cancelled,
          inFlight: metrics.queueDepth,
          queueCapacity: config.maxQueue,
          segmentsTotal: metrics.segmentsTotal,
          durations: jobDurations,
          artifactRoutes: artifactRoutes.size,
          restored: metrics.restoredJobs,
          interrupted: metrics.interruptedJobs,
          // Only after models() has actually run: reporting 0 would assert
          // "fully equipped" about a state nobody measured.
          degraded: modelsCache?.value.degraded ?? null,
        })
        return {
          body: Buffer.from(text, 'utf-8'),
          headers: {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
            'cache-control': 'no-store',
          },
        }
      },
    }))
  }

  // ---- self-description, health, cleanup ----------------------------------- //

  disposers.push(ctx.capabilities.register({
    id: name,
    title: '视频高光引擎',
    description: 'Python 引擎作为独立进程:多模态显著性评分(运动/目标/人脸/零样本文本引导)+ 音频能量 + 场景切分,产出 Top-K 高光成片与 EDL;任务可进度上报、可取消,成片经字节路由回放',
    services: ['highlight'],
    api: [...API_NAMES],
    tools: [...TOOL_NAMES],
    events: ['highlight.engine', 'highlight.job'],
  }))
  disposers.push(ctx.api.health(() => ({
    [name]: {
      ...service.state(),
      protocolExpected: PROTOCOL_VERSION,
      workDir,
      metrics: service.metrics(),
    },
  })))

  ctx.effect(() => () => {
    disposed = true
    for (const dispose of disposers) dispose()
    for (const route of artifactRoutes.values()) route.dispose()
    artifactRoutes.clear()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    client.dispose()
  }, `${name}: engine`)
}
