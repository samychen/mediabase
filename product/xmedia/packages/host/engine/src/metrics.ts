// @xmedia/metrics — in-process observability for the encode/publish control plane.
//
// Deliberately dependency-free (no OpenTelemetry SDK): the product is an internal
// acceptance tool, so a small in-memory collector plus a metrics endpoint is the
// right weight. The collector is a single source of truth the control plane and
// the health endpoint both read from, so counters can never disagree.
//
// Counters are idempotent on completion (recordCompletion is a no-op for a
// jobId already counted), so it is safe to observe a job finishing from more
// than one code path (status poll, event drain, stop reply).

export interface JobRecord {
  jobId: string
  input: string
  startedAt: number
  finishedAt?: number
  ok?: boolean
  elapsedMs?: number
  error?: string | undefined
}

export interface MetricsSnapshot {
  jobsStarted: number
  jobsSucceeded: number
  jobsFailed: number
  activeJobs: number
  lastElapsedMs?: number | undefined
  failureReasons: Record<string, number>
  recent: ReadonlyArray<JobRecord>
}

export class Metrics {
  private jobsStarted = 0
  private jobsSucceeded = 0
  private jobsFailed = 0
  private readonly completed = new Set<string>()
  private readonly active = new Map<string, JobRecord>()
  private readonly recent: JobRecord[] = []
  private readonly failureReasons: Record<string, number> = {}
  private readonly windowSize: number

  constructor(windowSize = 25) {
    this.windowSize = windowSize
  }

  /** A job was accepted by the engine. Counts toward jobsStarted + activeJobs. */
  recordStart(jobId: string, input: string): void {
    this.jobsStarted += 1
    this.active.set(jobId, { jobId, input, startedAt: Date.now() })
  }

  /**
   * A job reached a terminal state. Idempotent: a second call for the same
   * jobId returns false and is ignored, so multiple observers cannot double-count.
   */
  recordCompletion(jobId: string, ok: boolean, elapsedMs: number, error?: string): boolean {
    if (this.completed.has(jobId)) return false
    this.completed.add(jobId)
    if (ok) this.jobsSucceeded += 1
    else this.jobsFailed += 1
    const rec = this.active.get(jobId) ?? { jobId, input: '', startedAt: 0 }
    rec.finishedAt = Date.now()
    rec.ok = ok
    rec.elapsedMs = elapsedMs
    rec.error = error
    this.active.delete(jobId)
    if (!ok && error) this.failureReasons[error] = (this.failureReasons[error] ?? 0) + 1
    this.recent.unshift(rec)
    if (this.recent.length > this.windowSize) this.recent.length = this.windowSize
    return true
  }

  snapshot(): MetricsSnapshot {
    const last = this.recent[0]
    return {
      jobsStarted: this.jobsStarted,
      jobsSucceeded: this.jobsSucceeded,
      jobsFailed: this.jobsFailed,
      activeJobs: this.active.size,
      lastElapsedMs: last?.elapsedMs,
      failureReasons: { ...this.failureReasons },
      recent: this.recent.map((r) => ({ ...r })),
    }
  }
}
