// product/highlight / tests/support/fake-bridge.mjs — a Node implementation of
// the vhl-bridge line protocol.
//
// It exists so the TS suites (and a CI without Python/FFmpeg) can exercise the
// whole host surface: the capability, the control plane, the agent tools and the
// clip byte route. It is a TEST DOUBLE, not a second product: the verbs and
// columns mirror protocol/contract.json, and `verify.mjs` fails when they drift.
//
// It deliberately does NOT compute highlights — it fabricates two segments after
// a short delay, which is enough to prove start → running → succeeded → export.
//
// Fault injection (env):
//   FAKE_BRIDGE_MODE=crash    exit(7) right after the first hello
//   FAKE_BRIDGE_MODE=silent   never reply (timeout path)
//
// Wire: one tab-separated request line in, exactly one reply line out, FIFO.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MODE = process.env.FAKE_BRIDGE_MODE ?? ''
const SANDBOXED = process.argv.includes('--sandbox')
const say = (line) => process.stdout.write(`${line}\n`)
const json = (value) => JSON.stringify(value)
const wire = (value) => String(value).replace(/[\t\r\n]/g, ' ')
const JOBS = new Map()
const JOB_MS = Number(process.env.FAKE_BRIDGE_JOB_MS ?? 900)

/**
 * Queue ceiling, resolved the way the real bridge resolves it: `--max-queue`
 * (which the host passes from ITS config) wins over the env default, so a test
 * that turns the knob on the host does not have to know about this file.
 */
function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? null : process.argv[index + 1] ?? null
}
const MAX_QUEUE = Number(argValue('--max-queue') ?? process.env.FAKE_BRIDGE_MAX_QUEUE ?? 0)

// The knob table is READ from the contract, not copied: a double with its own
// stale list of options would let a typo pass in tests and fail in production.
const CONTRACT = JSON.parse(readFileSync(new URL('../../protocol/contract.json', import.meta.url), 'utf8'))
const OPTION_META = Object.fromEntries(
  Object.entries(CONTRACT.options ?? {}).filter(([key]) => key !== 'comment'),
)
const OPTION_KEYS = Object.keys(OPTION_META)

/** Everything the real bridge produces next to the clip, so routes are testable. */
function writeArtifacts(job) {
  if (job.written === true) return
  job.written = true
  mkdirSync(dirname(job.output), { recursive: true })
  writeFileSync(job.output, Buffer.alloc(2048, 7))
  const srt = `${job.output}.srt`
  writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,000\nfake cue\n')
  job.srtPath = srt
  const report = job.output.replace(/\.[^./]+$/, '') + '_timeline.json'
  writeFileSync(report, json({
    engine: 'fake-engine/1.0.0',
    input_video: job.input,
    output_video: job.output,
    // Same payload keys as highlight_core.pipeline, so a consumer (and the
    // verification script) reads one shape in both engine modes.
    selected_highlights: job.segments,
    timeline_series: [],
    config: job.options,
  }))
  job.reportPath = report
}


function jobView(job) {
  const elapsed = Date.now() - job.startedAt
  if (job.state === 'running' && elapsed >= JOB_MS) {
    job.state = 'succeeded'
    job.stage = 'done'
    job.progress = 1
    job.finishedAt = Date.now()
    job.segments = [
      { startSec: 4, endSec: 10, score: 0.91, signals: { audioRms: 0.9, motion: 0.8 } },
      { startSec: 22.5, endSec: 28.5, score: 0.72, signals: { audioRms: 0.7, motion: 0.6 } },
    ]
    writeArtifacts(job)
  }
  return {
    jobId: job.jobId,
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    input: job.input,
    output: job.output,
    error: job.error,
    createdAtMs: job.createdAt,
    startedAtMs: job.startedAt,
    finishedAtMs: job.finishedAt,
    durationSec: 120,
    fps: 25,
    segments: job.segments,
    segmentCount: job.segments.length,
    srtPath: job.srtPath ?? '',
    reportPath: job.state === 'succeeded' ? (job.reportPath ?? '') : '',
    sandboxed: SANDBOXED,
  }
}

/** Same rules as engine/vhl_bridge.py, from the same contract table. */
function validateOptions(options) {
  const seen = {}
  for (const [key, value] of Object.entries(options)) {
    const spec = OPTION_META[key]
    if (spec === undefined) return { error: `未知选项: ${key}` }
    if (spec.enum !== undefined && !spec.enum.includes(value)) return { error: `选项 ${key} 取值非法` }
    if (spec.type === 'weights') {
      // Mirrored rule, not a stylistic one: a double that accepts a sub-key the
      // engine refuses lets a host regression pass CI and fail in production.
      const fields = spec.fields ?? {}
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { error: `选项 ${key} 需要对象` }
      }
      let total = 0
      for (const [sub, raw] of Object.entries(value)) {
        if (!(sub in fields)) return { error: `选项 ${key} 没有子键 ${sub}` }
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
          return { error: `${key}.${sub} 必须在 0~1 之间` }
        }
        total += raw
      }
      if (total <= 0) return { error: `${key} 至少要有一个信号权重 > 0` }
    }
    if (typeof value === 'number') {
      if (spec.min !== undefined && value < spec.min) return { error: `选项 ${key} 小于 ${spec.min}` }
      if (spec.max !== undefined && value > spec.max) return { error: `选项 ${key} 大于 ${spec.max}` }
    }
    seen[key] = value
  }
  if (typeof seen.clipPrompt === 'string' && seen.clipPrompt !== '' && seen.enableClipGuidance !== true) {
    return { error: 'clipPrompt 需要同时开启 enableClipGuidance' }
  }
  for (const [key, value] of Object.entries(seen)) {
    if (OPTION_META[key].requires !== undefined && value !== false && value !== '') {
      return { error: `选项 ${key} 需要的模型未安装`, code: 'UNAVAILABLE' }
    }
  }
  return { options: seen }
}

function startJob(jobId, input, output, optionsJson) {
  let options = {}
  try {
    options = optionsJson === '' ? {} : JSON.parse(optionsJson)
  } catch {
    return ['err', 'INVALID_PARAMS', 'optionsJson 不是合法 JSON']
  }
  const checked = validateOptions(options)
  if (checked.error !== undefined) return ['err', checked.code ?? 'INVALID_PARAMS', checked.error]
  if (MAX_QUEUE > 0) {
    const active = [...JOBS.values()].filter((job) => job.state === 'queued' || job.state === 'running')
    if (active.length >= MAX_QUEUE) {
      return ['err', 'CONFLICT', `队列已满(${active.length}/${MAX_QUEUE})`]
    }
  }
  const id = jobId === '' ? `fake-${JOBS.size + 1}` : jobId
  const job = {
    jobId: id, input, output, options,
    state: 'running', stage: 'vision', progress: 0.35,
    error: '', createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, segments: [],
  }
  JOBS.set(id, job)
  return ['ok', json(jobView(job))]
}

function findJob(jobId) {
  const id = jobId === '' ? [...JOBS.keys()].pop() : jobId
  return JOBS.get(id ?? '')
}

/** HH:MM:SS:FF — same arithmetic as the real bridge, so the EDL is comparable. */
function timecode(seconds, fps) {
  const rate = fps > 0 ? fps : 25
  const totalFrames = Math.round(Math.max(0, seconds) * rate)
  const framesPerHour = Math.round(rate * 3600)
  const hours = Math.floor(totalFrames / framesPerHour)
  let rest = totalFrames % framesPerHour
  const minutes = Math.floor(rest / Math.round(rate * 60))
  rest %= Math.round(rate * 60)
  const secs = Math.floor(rest / Math.round(rate))
  const frames = rest % Math.round(rate)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}:${pad(frames)}`
}

/** CMX3600 the way engine/vhl_bridge.py renders it (source TC + cumulative record TC). */
function renderEdl(job) {
  const fps = jobView(job).fps
  const lines = [
    'TITLE: VHL HIGHLIGHTS',
    'FCM: NON-DROP FRAME',
    `* SOURCE: ${job.input}`,
    '* ENGINE: fake-engine 1.0.0',
    '',
  ]
  let record = 0
  job.segments.forEach((seg, index) => {
    const duration = Math.max(0, seg.endSec - seg.startSec)
    lines.push(
      `${String(index + 1).padStart(3, '0')}  AX       V     C        ` +
      `${timecode(seg.startSec, fps)} ${timecode(seg.endSec, fps)} ` +
      `${timecode(record, fps)} ${timecode(record + duration, fps)}`,
    )
    record += duration
  })
  return `${lines.join('\n')}\n`
}

function handle(verb, args) {
  if (MODE === 'silent') return null
  switch (verb) {
    case 'hello':
      return ['hello', '1', 'fake-engine/1.0.0', '3.13.0', 'fake-ffmpeg 7.1']
    case 'ping':
      return ['ping', 'pong']
    case 'probe': {
      const path = args[0] ?? ''
      if (path === '') return ['err', 'INVALID_PARAMS', 'probe 需要文件路径']
      if (path === '/missing.mp4') return ['err', 'NOT_FOUND', `文件不存在: ${path}`]
      return ['ok', json({
        path, durationSec: 120, fps: 25, width: 1920, height: 1080,
        hasAudio: true, videoCodec: 'h264', audioCodec: 'aac',
      })]
    }
    case 'analyze.start':
      return startJob(args[0] ?? '', args[1] ?? '', args[2] ?? '', args[3] ?? '')
    case 'analyze.status': {
      const job = findJob(args[0] ?? '')
      if (job === undefined) return ['err', 'NOT_FOUND', `未知任务: ${args[0] ?? ''}`]
      return ['ok', json(jobView(job))]
    }
    case 'analyze.cancel': {
      const job = findJob(args[0] ?? '')
      if (job === undefined) return ['err', 'NOT_FOUND', `未知任务: ${args[0] ?? ''}`]
      if (job.state === 'running') {
        job.state = 'cancelled'
        job.stage = 'cancelled'
        job.error = '任务已取消'
        job.finishedAt = Date.now()
      }
      return ['ok', json(jobView(job))]
    }
    case 'jobs.list':
      return ['ok', json([...JOBS.values()].map(jobView))]
    case 'export.edl': {
      const job = findJob(args[0] ?? '')
      if (job === undefined) return ['err', 'NOT_FOUND', `未知任务: ${args[0] ?? ''}`]
      const view = jobView(job)
      if (view.state !== 'succeeded') return ['err', 'INVALID_PARAMS', '任务尚无可导出片段']
      const path = args[1] !== '' && args[1] !== undefined ? args[1] : `${job.output}.edl`
      // The real bridge creates the parent directory before writing; a double
      // that throws ENOENT here would crash the subprocess and surface as a
      // phantom "engine died" in the host instead of a wire reply.
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, renderEdl(job))
      return ['ok', path]
    }
    case 'options.list':
      // Availability mirrors this double's models.list (nothing installed), so
      // the host's "explicit opt-in to a missing model" rule is exercised too.
      return ['ok', json(Object.entries(OPTION_META).map(([key, spec]) => ({
        key,
        type: spec.type,
        default: spec.default,
        min: spec.min ?? null,
        max: spec.max ?? null,
        enum: spec.enum ?? null,
        requires: spec.requires ?? '',
        group: spec.group ?? 'analysis',
        available: spec.requires === undefined,
        fields: spec.fields ?? null,
      })).sort((a, b) => `${a.group}${a.key}`.localeCompare(`${b.group}${b.key}`)))]
    case 'models.list':
      return ['ok', json({
        detector: { kind: 'onnx', path: '', present: false, license: 'Apache-2.0' },
        face: { available: false, license: 'Apache-2.0' },
        clip: { available: false, license: 'MIT' },
        whisper: { available: false, license: 'MIT' },
        runtime: { opencv: false, numpy: false, onnxruntime: false },
        degraded: true,
        // A double must answer the same QUESTIONS as the thing it doubles, or the
        // host path that reads a reason is never exercised. `opencv-missing` is the
        // honest code for this fake (nothing here is installed).
        degradedReason: 'opencv-missing',
      })]
    case 'quit':
      return ['ok']
    default:
      return ['err', 'INVALID_PARAMS', `未知动词: ${verb}`]
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const nl = buffer.indexOf('\n')
    if (nl < 0) break
    const raw = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (raw.trim() === '') continue
    const [verb, ...rest] = raw.split('\t')
    if (verb === 'hello' && MODE === 'crash') {
      process.exit(7)
    }
    const reply = handle(verb, rest)
    if (reply === null) continue
    say(reply.map(wire).join('\t'))
    if (verb === 'quit') process.exit(0)
  }
})

process.stdin.on('end', () => process.exit(0))
