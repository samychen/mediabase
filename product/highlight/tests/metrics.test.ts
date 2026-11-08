// product/highlight — Prometheus exposition.
//
// The renderer is pure, so the format is testable without a host, a child
// process or a scraper. What is worth asserting is not "it prints numbers" but
// the three ways an exposition can be wrong in production and still look fine:
// a histogram whose +Inf disagrees with _count, a label value that breaks the
// parser, and an unbounded label (a job id) that quietly explodes cardinality.

import { describe, expect, it } from 'vitest'
import {
  escapeLabel,
  JOB_DURATION_BUCKETS,
  newHistogram,
  observe,
  renderMetrics,
  type MetricsSnapshot,
} from '../packages/host/highlight/src/prometheus.ts'

const base = (): MetricsSnapshot => ({
  protocol: 1,
  engine: 'vhl-engine/2.1.0',
  processUp: true,
  ready: true,
  restarts: 0,
  fastDeaths: 0,
  handshakeFailures: 0,
  uptimeSec: 12,
  jobsStarted: 2,
  succeeded: 1,
  failed: 0,
  cancelled: 1,
  inFlight: 0,
  queueCapacity: 8,
  segmentsTotal: 3,
  durations: newHistogram(),
  artifactRoutes: 2,
  restored: 0,
  interrupted: 0,
  degraded: false,
})

/** Parse the exposition into `{name, labels, value}` samples. */
function parse(text: string): Array<{ name: string; labels: Record<string, string>; value: string }> {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (\S+)$/.exec(line)
      if (match === null) throw new Error(`不是合法样本行: ${line}`)
      const labels: Record<string, string> = {}
      for (const pair of (match[2] ?? '').slice(1, -1).split(',').filter((p) => p !== '')) {
        const eq = pair.indexOf('=')
        labels[pair.slice(0, eq)] = pair.slice(eq + 2, -1)
      }
      return { name: match[1]!, labels, value: match[3]! }
    })
}

describe('histogram', () => {
  it('keeps buckets cumulative and +Inf equal to count', () => {
    const hist = newHistogram()
    for (const seconds of [0.4, 3, 20, 240]) observe(hist, seconds)

    const text = renderMetrics({ ...base(), durations: hist })
    const buckets = parse(text).filter((s) => s.name === 'vhl_job_duration_seconds_bucket')
    const count = parse(text).find((s) => s.name === 'vhl_job_duration_seconds_count')

    // 0.4s → le=1; 3s → le=5; 20s → le=60; 240s → le=300. Nothing lands in
    // le=15, which is exactly the shape a cumulative histogram must still show.
    expect(buckets.map((b) => Number(b.value))).toEqual([1, 2, 2, 3, 4, 4, 4])
    expect(Number(buckets.at(-1)!.value)).toBe(Number(count!.value))
    // `le` labels must follow the declared bounds in order.
    expect(buckets.map((b) => b.labels.le)).toEqual([...JOB_DURATION_BUCKETS.map(String), '+Inf'])
  })

  it('sums milliseconds-as-seconds, not milliseconds', () => {
    const hist = newHistogram()
    observe(hist, 2.5)
    observe(hist, 7.5)
    const sum = parse(renderMetrics({ ...base(), durations: hist }))
      .find((s) => s.name === 'vhl_job_duration_seconds_sum')
    expect(Number(sum!.value)).toBe(10)
  })

  it('ignores negative and non-finite observations instead of poisoning the sum', () => {
    const hist = newHistogram()
    observe(hist, -1)
    observe(hist, Number.NaN)
    observe(hist, Number.POSITIVE_INFINITY)
    expect(hist.count).toBe(0)
    expect(hist.sum).toBe(0)
  })
})

describe('renderMetrics', () => {
  it('emits HELP and TYPE for every metric exactly once', () => {
    const text = renderMetrics(base())
    const types = text.split('\n').filter((line) => line.startsWith('# TYPE ')).map((line) => line.split(' ')[2])
    const helps = text.split('\n').filter((line) => line.startsWith('# HELP ')).map((line) => line.split(' ')[2])

    expect(new Set(types).size).toBe(types.length)
    expect(types).toEqual(helps)
    expect(types).toContain('vhl_job_duration_seconds')
  })

  it('has no duplicate series (a duplicate makes the whole scrape fail)', () => {
    const text = renderMetrics({ ...base(), durations: newHistogram() })
    const keys = parse(text).map((s) => `${s.name}{${JSON.stringify(s.labels)}}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('leaks no job id and no other high-cardinality label', () => {
    const text = renderMetrics(base())
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    expect(text).not.toMatch(uuid)
    for (const sample of parse(text)) {
      for (const key of Object.keys(sample.labels)) {
        expect(['state', 'le', 'protocol', 'engine']).toContain(key)
      }
    }
  })

  it('omits the capacity gauge when the queue is unbounded', () => {
    const text = renderMetrics({ ...base(), queueCapacity: 0 })
    expect(text).not.toContain('vhl_queue_capacity')
  })

  it('omits the degraded gauge until models have been inspected', () => {
    // 0 would claim "fully equipped"; null means "unknown", and unknown must not
    // be published as a value.
    expect(renderMetrics({ ...base(), degraded: null })).not.toContain('vhl_models_degraded')
    expect(renderMetrics({ ...base(), degraded: true })).toContain('vhl_models_degraded 1')
  })

  it('publishes the journal gauges even when they are zero', () => {
    // The opposite of `degraded`: zero restores is a MEASUREMENT ("empty
    // journal"), so the series must exist on a healthy host — a dashboard panel
    // that disappears when everything is fine is a panel nobody watches.
    const fresh = parse(renderMetrics(base()))
    expect(fresh.find((s) => s.name === 'vhl_jobs_restored')!.value).toBe('0')
    expect(fresh.find((s) => s.name === 'vhl_jobs_interrupted')!.value).toBe('0')

    const afterCrash = parse(renderMetrics({ ...base(), restored: 4, interrupted: 1 }))
    expect(afterCrash.find((s) => s.name === 'vhl_jobs_restored')!.value).toBe('4')
    expect(afterCrash.find((s) => s.name === 'vhl_jobs_interrupted')!.value).toBe('1')
  })

  it('declares the journal gauges as gauges, not counters', () => {
    // A counter that a restart resets to a non-zero value (the restored count)
    // breaks the one thing counters promise. Gauge is the honest type here.
    const types = renderMetrics({ ...base(), restored: 4, interrupted: 1 })
      .split('\n')
      .filter((line) => line.startsWith('# TYPE vhl_jobs_restored') || line.startsWith('# TYPE vhl_jobs_interrupted'))
    expect(types).toEqual([
      '# TYPE vhl_jobs_restored gauge',
      '# TYPE vhl_jobs_interrupted gauge',
    ])
  })

  it('reports an unhandshaken engine as down but present', () => {
    const text = renderMetrics({ ...base(), processUp: true, ready: false, engine: null })
    const samples = parse(text)
    expect(samples.find((s) => s.name === 'vhl_engine_process_up')!.value).toBe('1')
    expect(samples.find((s) => s.name === 'vhl_engine_ready')!.value).toBe('0')
    expect(samples.find((s) => s.name === 'vhl_build_info')!.labels.engine).toBe('unknown')
  })

  it('ends with a newline', () => {
    expect(renderMetrics(base()).endsWith('\n')).toBe(true)
  })
})

describe('escapeLabel', () => {
  it('escapes the three characters the format reserves', () => {
    expect(escapeLabel('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd')
  })

  it('keeps a quote inside a label value parseable', () => {
    const text = renderMetrics({ ...base(), engine: 'weird"engine' })
    const info = parse(text).find((s) => s.name === 'vhl_build_info')
    expect(info!.labels.engine).toBe('weird\\"engine')
  })
})
