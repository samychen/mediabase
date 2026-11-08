/**
 * Prometheus text exposition (format 0.0.4), written by hand — no client library.
 *
 * Two rules shape this file, and both are load-bearing:
 *
 * 1. **A scrape performs no I/O.** Every value comes from counters the host
 *    already keeps in memory. If the engine child is wedged, `/api/metrics` must
 *    still answer in microseconds and say `vhl_engine_ready 0`; making a scrape
 *    talk to the engine would let one hung FFmpeg turn a monitoring gap into a
 *    monitoring outage (the scraper times out instead of learning what broke).
 *
 * 2. **Labels are bounded.** A job id is a UUID; as a label it creates one time
 *    series per job and eventually kills the TSDB. Per-job detail lives in
 *    `highlight.metrics().recent`, which is a bounded ring — not here. The only
 *    labels below are enums (`state`) or one-valued build metadata.
 *
 * The renderer is pure: given a snapshot it returns text. That makes the format
 * unit-testable without booting a host, and keeps metric naming in one place.
 */

/** Seconds. Chosen so a 5-minute job lands in a useful bucket, not `+Inf`. */
export const JOB_DURATION_BUCKETS = [1, 5, 15, 60, 300, 900] as const

export interface HistogramSnapshot {
  readonly bounds: readonly number[]
  /** Cumulative counts: `counts[i]` = observations <= `bounds[i]`. */
  counts: number[]
  sum: number
  count: number
}

export function newHistogram(bounds: readonly number[] = JOB_DURATION_BUCKETS): HistogramSnapshot {
  return { bounds, counts: bounds.map(() => 0), sum: 0, count: 0 }
}

/**
 * Record one observation.
 *
 * Cumulative on purpose: the exposition format wants `le` buckets to be running
 * totals (`_bucket{le="5"}` includes everything <= 1s too). Storing per-bucket
 * deltas and summing at render time would be equivalent but invites an
 * off-by-one in `le="+Inf"`, which is the one bucket Prometheus requires to
 * equal `_count`.
 */
export function observe(histogram: HistogramSnapshot, value: number): void {
  if (!Number.isFinite(value) || value < 0) return
  histogram.count += 1
  histogram.sum += value
  for (let i = 0; i < histogram.bounds.length; i += 1) {
    if (value <= histogram.bounds[i]!) histogram.counts[i] = (histogram.counts[i] ?? 0) + 1
  }
}

export interface MetricsSnapshot {
  /** Protocol version this build speaks (a label, so a mixed fleet is visible). */
  protocol: number
  /** Engine identity from the handshake, or null before the first hello. */
  engine: string | null
  /** Child process alive. */
  processUp: boolean
  /** Handshake completed: the engine can actually answer a verb. */
  ready: boolean
  restarts: number
  fastDeaths: number
  handshakeFailures: number
  uptimeSec: number
  jobsStarted: number
  succeeded: number
  failed: number
  cancelled: number
  /** Jobs the host believes are queued or running. */
  inFlight: number
  /** Engine queue ceiling (0 = unbounded, reported as the gauge's absence). */
  queueCapacity: number
  segmentsTotal: number
  durations: HistogramSnapshot
  artifactRoutes: number
  /** null = not known yet (models() has never been called): the line is omitted. */
  degraded: boolean | null
}

/** Label values may contain quotes and backslashes; the format needs them escaped. */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Prometheus rejects `Infinity`/`NaN` spellings but accepts these three tokens. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return '+Inf'
  if (value === -Infinity) return '-Inf'
  return String(value)
}

interface Line {
  name: string
  help: string
  type: 'counter' | 'gauge' | 'histogram'
  /** Rendered series, in order. */
  series: string[]
}

function labels(pairs: Array<[string, string]>): string {
  if (pairs.length === 0) return ''
  return `{${pairs.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`
}

function sample(name: string, pairs: Array<[string, string]>, value: number): string {
  return `${name}${labels(pairs)} ${formatValue(value)}`
}

/** Build the exposition text. Deterministic order: tests can diff it. */
export function renderMetrics(snapshot: MetricsSnapshot): string {
  const lines: Line[] = []
  const add = (
    name: string,
    help: string,
    type: Line['type'],
    series: string[],
  ): void => {
    lines.push({ name, help, type, series })
  }

  add('vhl_build_info',
    'Build identity: protocol version spoken and the engine that answered hello.',
    'gauge',
    [sample('vhl_build_info', [
      ['protocol', String(snapshot.protocol)],
      ['engine', snapshot.engine ?? 'unknown'],
    ], 1)])

  add('vhl_uptime_seconds', 'Seconds since this capability was applied.', 'gauge',
    [sample('vhl_uptime_seconds', [], snapshot.uptimeSec)])

  add('vhl_engine_process_up',
    'Engine child process is alive (1) or not (0). 0 means every call fails UNAVAILABLE.',
    'gauge', [sample('vhl_engine_process_up', [], snapshot.processUp ? 1 : 0)])

  add('vhl_engine_ready',
    'Engine answered the handshake (1) or is not usable yet (0). Distinguishes "spawned" from "works".',
    'gauge', [sample('vhl_engine_ready', [], snapshot.ready ? 1 : 0)])

  add('vhl_engine_restarts_total',
    'Engine restarts performed by the supervisor.', 'counter',
    [sample('vhl_engine_restarts_total', [], snapshot.restarts)])

  add('vhl_engine_fast_deaths_total',
    'Engine exits within 1s of spawn. 3 in a row stops the restart loop (broken binary, not a crash).',
    'counter', [sample('vhl_engine_fast_deaths_total', [], snapshot.fastDeaths)])

  add('vhl_engine_handshake_failures_total',
    'Failed handshakes. Non-zero with process_up=0 means a missing interpreter or script.',
    'counter', [sample('vhl_engine_handshake_failures_total', [], snapshot.handshakeFailures)])

  add('vhl_jobs_started_total', 'Analyze jobs accepted (including ones that later failed).',
    'counter', [sample('vhl_jobs_started_total', [], snapshot.jobsStarted)])

  // One metric with a bounded enum label beats three near-identical names.
  add('vhl_jobs_terminal_total', 'Jobs that reached a terminal state, by state.',
    'counter', [
      sample('vhl_jobs_terminal_total', [['state', 'succeeded']], snapshot.succeeded),
      sample('vhl_jobs_terminal_total', [['state', 'failed']], snapshot.failed),
      sample('vhl_jobs_terminal_total', [['state', 'cancelled']], snapshot.cancelled),
    ])

  add('vhl_jobs_in_flight',
    'Jobs queued or running as the HOST sees them (survives an engine restart, unlike the engine table).',
    'gauge', [sample('vhl_jobs_in_flight', [], snapshot.inFlight)])

  if (snapshot.queueCapacity > 0) {
    add('vhl_queue_capacity',
      'Engine queue ceiling. in_flight/capacity near 1 predicts CONFLICT refusals.',
      'gauge', [sample('vhl_queue_capacity', [], snapshot.queueCapacity)])
  }

  add('vhl_segments_total', 'Highlight segments produced across all succeeded jobs.',
    'counter', [sample('vhl_segments_total', [], snapshot.segmentsTotal)])

  add('vhl_artifact_routes', 'Live playback/artifact byte routes (bounded ring; oldest evicted).',
    'gauge', [sample('vhl_artifact_routes', [], snapshot.artifactRoutes)])

  // A gauge that only exists once it is known: exporting 0 before the first
  // models() call would claim "not degraded" about a state nobody measured.
  if (snapshot.degraded !== null) {
    add('vhl_models_degraded',
      'Engine runs without at least one optional model (1) or fully equipped (0).',
      'gauge', [sample('vhl_models_degraded', [], snapshot.degraded ? 1 : 0)])
  }

  const hist = snapshot.durations
  const histSeries: string[] = []
  for (let i = 0; i < hist.bounds.length; i += 1) {
    histSeries.push(sample('vhl_job_duration_seconds_bucket',
      [['le', String(hist.bounds[i]!)]], hist.counts[i] ?? 0))
  }
  // +Inf MUST equal _count; Prometheus derives the last bucket from it.
  histSeries.push(sample('vhl_job_duration_seconds_bucket', [['le', '+Inf']], hist.count))
  histSeries.push(sample('vhl_job_duration_seconds_sum', [], hist.sum))
  histSeries.push(sample('vhl_job_duration_seconds_count', [], hist.count))
  add('vhl_job_duration_seconds', 'Wall time of terminal jobs (engine start to terminal state).',
    'histogram', histSeries)

  const out: string[] = []
  for (const line of lines) {
    out.push(`# HELP ${line.name} ${line.help}`)
    out.push(`# TYPE ${line.name} ${line.type}`)
    out.push(...line.series)
  }
  // The format requires a trailing newline; without it some scrapers drop the
  // final sample.
  return `${out.join('\n')}\n`
}
