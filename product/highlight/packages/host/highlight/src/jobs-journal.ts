// The job journal — the host's half of job state, made to survive the host.
//
// The engine's registry is IN MEMORY: restart it and every completed job is
// forgotten. The host already keeps a Map for exactly that reason, but a Map
// dies with the process. This file keeps the smallest thing that answers the two
// questions a client actually asks after a restart: *what was I working on?* and
// *how far did it get?*
//
// What this deliberately is NOT:
//
//   * Not a database. Append-only JSONL, one snapshot per line, replayed into
//     memory at boot. No index, no query surface, no migration framework. `v`
//     on the first line exists so a future shape can refuse to be misread.
//
//   * Not the source of truth. A row the engine still reports WINS; the journal
//     only supplies rows the engine no longer has (it restarted, or the job was
//     submitted by a previous process).
//
//   * Not a resumption mechanism. A job that was `queued`/`running` when the
//     process died is replayed as `interrupted`, never `running`. The child that
//     owned the render is gone; a state claiming otherwise would count a ghost in
//     queue depth and promise a clip that can never appear. Resuming would mean
//     re-running analysis from the top and silently doubling the work — a
//     decision for a caller, not for a boot path.
//
// Three failure modes are designed for, in the order they actually happen:
//
//   * a torn last line (the process died mid-append) — dropped, counted, the
//     rest of the file is still good;
//   * a corrupt middle line (disk, hand-edited) — same treatment, one row lost;
//   * a full/read-only disk — the append fails, the callback fires, and the JOB
//     STILL RUNS. Persistence is bookkeeping; it must never become a dependency
//     of the work it is describing.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HighlightJob, HighlightSegment } from './index.ts'

/** Bumped only when replaying an old shape would be WRONG, not merely unreadable. */
const RECORD_VERSION = 1

/** States that mean "a process was in the middle of something when it died". */
const LIVE_STATES = new Set(['queued', 'running'])

export interface JournalOptions {
  /** Absolute path to the JSONL file. Parent directories are created on demand. */
  file: string
  /** Compaction target: keep the newest N job records. 0 = keep every record. */
  keep?: number
  /** Compact once the file holds this many lines. 0 = only when compact() is called. */
  maxRecords?: number
  /** One line per unusable record (torn tail, bad JSON, unknown version). */
  onDrop?: (reason: string) => void
  /** One line per failed write. The caller logs it; the job is unaffected. */
  onError?: (reason: string) => void
  /** Injectable clock, so the tests do not depend on wall time. */
  now?: () => number
}

export interface ReplayResult {
  /** Last snapshot per job id, oldest first, live states already `interrupted`. */
  jobs: HighlightJob[]
  /** Lines that held a record (blank lines excluded). */
  read: number
  /** Lines this replay refused (torn, corrupt, wrong version). */
  dropped: number
  /** Jobs that were mid-flight and are now reported interrupted by THIS boot. */
  interrupted: number
}

interface Entry {
  job: HighlightJob
  atMs: number
  /** The record minus its timestamp: two snapshots with the same signature are the same observation. */
  signature: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Serialise one snapshot.
 *
 * `segments` is written only for a SUCCEEDED job. A running job re-appends as it
 * polls, and a 30-segment array on every heartbeat is how a 40 KB journal becomes
 * a 4 MB one without a single reader asking for it. For a finished job the
 * segments are the result, and a restored row that cannot draw its timeline is a
 * worse outcome than a slightly larger line.
 */
function toRecord(job: HighlightJob, atMs: number): Record<string, unknown> {
  return {
    v: RECORD_VERSION,
    atMs,
    jobId: job.jobId,
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    input: job.input,
    output: job.output,
    error: job.error,
    createdAtMs: job.createdAtMs,
    startedAtMs: job.startedAtMs,
    finishedAtMs: job.finishedAtMs,
    durationSec: job.durationSec,
    fps: job.fps,
    segmentCount: job.segmentCount,
    srtPath: job.srtPath,
    reportPath: job.reportPath,
    ...(job.state === 'succeeded' ? { segments: job.segments } : {}),
  }
}

/**
 * Two snapshots with the same signature are the same observation.
 *
 * `atMs` is deliberately excluded: it records when we looked, not what we saw,
 * and including it would make every poll a unique event — the exact opposite of
 * the throttle this exists for.
 */
function signatureOf(job: HighlightJob, atMs: number): string {
  return JSON.stringify(toRecord(job, atMs), (key, value) => (key === 'atMs' ? 0 : value))
}

/** Rebuild a job from one line, or null when the line cannot be trusted. */
function fromRecord(raw: unknown): { job: HighlightJob; atMs: number } | null {
  if (!isRecord(raw)) return null
  if (num(raw.v, -1) !== RECORD_VERSION) return null
  const jobId = str(raw.jobId).trim()
  const state = str(raw.state).trim()
  if (jobId === '' || state === '') return null
  const segments: HighlightSegment[] = []
  if (Array.isArray(raw.segments)) {
    for (const item of raw.segments) {
      if (!isRecord(item)) continue
      const signals: Record<string, number> = {}
      if (isRecord(item.signals)) {
        for (const [key, value] of Object.entries(item.signals)) {
          if (typeof value === 'number' && Number.isFinite(value)) signals[key] = value
        }
      }
      segments.push({
        startSec: num(item.startSec),
        endSec: num(item.endSec),
        score: num(item.score),
        signals,
      })
    }
  }
  const job: HighlightJob = {
    jobId,
    state,
    stage: str(raw.stage, state),
    progress: Math.min(1, Math.max(0, num(raw.progress))),
    input: str(raw.input),
    output: str(raw.output),
    error: str(raw.error),
    createdAtMs: num(raw.createdAtMs),
    startedAtMs: stamp(raw.startedAtMs),
    finishedAtMs: stamp(raw.finishedAtMs),
    durationSec: num(raw.durationSec),
    fps: num(raw.fps),
    segmentCount: num(raw.segmentCount, segments.length),
    srtPath: str(raw.srtPath),
    reportPath: str(raw.reportPath),
    segments,
  }
  return { job, atMs: num(raw.atMs, job.createdAtMs) }
}

/**
 * Rewrite a mid-flight snapshot into the state a later boot is allowed to claim.
 *
 * The error text says three things a client needs to act: that it was the HOST
 * that went away (not the job failing), which phase it died in, and how far it
 * got — so "resubmit" is an informed choice rather than a guess.
 */
export function asInterrupted(job: HighlightJob, atMs: number): HighlightJob {
  if (!LIVE_STATES.has(job.state)) return job
  const pct = Math.round(Math.min(1, Math.max(0, job.progress)) * 100)
  const phase = job.state === 'queued' ? '排队' : '运行'
  return {
    ...job,
    state: 'interrupted',
    stage: 'interrupted',
    error: job.error !== '' && job.error !== ' '
      ? job.error
      : `宿主在任务${phase}时退出,重启后不再继续(中断时进度 ${pct}%)`,
    finishedAtMs: job.finishedAtMs ?? atMs,
  }
}

export class JobJournal {
  private readonly options: JournalOptions
  private readonly now: () => number
  /** Last known snapshot per job id — the compaction set. */
  private last = new Map<string, Entry>()
  /** Records currently on disk. */
  private lines = 0
  /** A job was forgotten (retention): compact on the next append. */
  private dirty = false

  constructor(options: JournalOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  get file(): string {
    return this.options.file
  }

  /** Records on disk as this instance counts them (a lower bound after an external edit). */
  size(): number {
    return this.lines
  }

  /**
   * Append one snapshot. Returns false when nothing changed.
   *
   * Idempotent by signature, and that is what makes it safe to call on every
   * poll: the host reports `progress` continuously, and a journal that logs every
   * tick turns a 40-second job into 60 lines nobody will ever read. A poll that
   * changed nothing is not an event.
   *
   * Never throws: a read-only home must not turn a working job into a failed one.
   */
  append(job: HighlightJob): boolean {
    const atMs = this.now()
    const record = toRecord(job, atMs)
    const signature = signatureOf(job, atMs)
    const previous = this.last.get(job.jobId)
    if (previous !== undefined && previous.signature === signature) return false
    try {
      mkdirSync(dirname(this.options.file), { recursive: true })
      appendFileSync(this.options.file, `${JSON.stringify(record)}\n`)
    } catch (error) {
      this.options.onError?.(`写入任务日志失败: ${String(error)}`)
      return false
    }
    this.lines += 1
    this.last.set(job.jobId, { job, atMs, signature })
    const ceiling = this.options.maxRecords ?? 0
    if (this.dirty || (ceiling > 0 && this.lines >= ceiling)) this.compact()
    return true
  }

  /**
   * Read the file back, last snapshot per job id.
   *
   * NOT read-only, on purpose: each job it salvages is re-appended once in its
   * `interrupted` form. That is what makes a death counted ONCE — without it,
   * every subsequent boot would re-surface the same `running` line and report the
   * same crash again, and `vhl_jobs_interrupted` would climb with uptime instead
   * of measuring anything.
   */
  replay(): ReplayResult {
    let text = ''
    try {
      text = readFileSync(this.options.file, 'utf8')
    } catch {
      return { jobs: [], read: 0, dropped: 0, interrupted: 0 }
    }
    const byId = new Map<string, Entry>()
    let read = 0
    let dropped = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      read += 1
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A torn tail is EXPECTED — append is a single write, not a transaction,
        // and the last line is exactly where a killed process leaves a fragment.
        dropped += 1
        this.options.onDrop?.('任务日志末行不完整(进程在写入时退出)')
        continue
      }
      const row = fromRecord(parsed)
      if (row === null) {
        dropped += 1
        this.options.onDrop?.('任务日志存在不可识别的记录(版本或字段不符)')
        continue
      }
      byId.set(row.job.jobId, {
        job: row.job,
        atMs: row.atMs,
        signature: '',
      })
    }

    const jobs: HighlightJob[] = []
    let interrupted = 0
    for (const entry of byId.values()) {
      const job = asInterrupted(entry.job, entry.atMs)
      if (job !== entry.job) interrupted += 1
      jobs.push(job)
    }
    jobs.sort((a, b) => a.createdAtMs - b.createdAtMs)

    this.lines = read - dropped
    this.last = new Map()
    for (const [jobId, entry] of byId) {
      // Seed with the FILE's signature (the raw record), not the salvaged one:
      // that difference is exactly what makes the corrected state a change worth
      // writing below. Seeding with the salvaged snapshot would make the append
      // look like a no-op and the `running` line would survive forever.
      this.last.set(jobId, { job: entry.job, atMs: entry.atMs, signature: signatureOf(entry.job, entry.atMs) })
    }
    for (const job of jobs) {
      const raw = byId.get(job.jobId)?.job.state ?? ''
      // Only the ones the file claimed were still moving: an `interrupted` row
      // from an earlier boot is already correct and needs no second line.
      if (LIVE_STATES.has(raw)) this.append(job)
    }
    return { jobs, read, dropped, interrupted }
  }

  /**
   * Rewrite the file with the newest `keep` records.
   *
   * tmp + rename, because this is the one operation that can lose everything:
   * a crash halfway through a truncate-then-write leaves an empty journal, while
   * a rename either happens or does not.
   */
  compact(): number {
    const entries = [...this.last.values()].sort((a, b) => a.job.createdAtMs - b.job.createdAtMs)
    const keep = (this.options.keep ?? 0) > 0 ? entries.slice(-(this.options.keep as number)) : entries
    const body = keep.map((entry) => JSON.stringify(toRecord(entry.job, entry.atMs))).join('\n')
    const tmp = `${this.options.file}.tmp`
    try {
      mkdirSync(dirname(this.options.file), { recursive: true })
      writeFileSync(tmp, body === '' ? '' : `${body}\n`)
      renameSync(tmp, this.options.file)
    } catch (error) {
      this.options.onError?.(`整理任务日志失败: ${String(error)}`)
      return this.lines
    }
    this.lines = keep.length
    this.dirty = false
    this.last = new Map(keep.map((entry) => [entry.job.jobId, entry]))
    return keep.length
  }

  /** Drop a job's history (its artifacts were pruned); compaction follows on the next append. */
  forget(jobId: string): void {
    if (this.last.delete(jobId)) this.dirty = true
  }
}
