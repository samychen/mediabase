// product/highlight — the composed host, end to end.
//
// Three worlds, matching the base's engine-supervision contract:
//   1. a working bridge (Node double): strict boot, the full command surface,
//      the agent tools, the job lifecycle, cancel and EDL export.
//   2. degraded (interpreter missing): the host still composes and every engine
//      call fails with a CODED UNAVAILABLE a client can branch on.
//   3. a crashing bridge: the host survives and the product's restart policy
//      runs (the neutral EngineClient only reports; policy lives here).
//
// The REAL Python bridge is exercised by scripts/verify.mjs — a vitest suite
// that requires python3 + ffmpeg would redden CI on a machine that has neither.

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_NAMES, TOOL_NAMES } from '../packages/host/highlight/src/index.ts'
import { bootHighlight, expectError, waitFor, type BootedHost } from './support/host.ts'

const UNAVAILABLE = -32002
const NOT_FOUND = -32001
const INVALID_PARAMS = -32602
const CONFLICT = -32004

const CLIP = '/tmp/vhl-fixture.mp4'
const workDir = mkdtempSync(join(tmpdir(), 'vhl-work-'))


// ---- world 1: a well-behaved bridge ---------------------------------------- //

describe('the highlight host with a working engine', () => {
  let host: BootedHost | null = null

  beforeAll(async () => {
    host = await bootHighlight({
      VHL_STRICT_CAPABILITIES: '1',
      FAKE_BRIDGE_JOB_MS: '300',
      VHL_WORK_DIR: workDir,
    })
  })

  afterAll(async () => {
    await host?.stop()
  })

  const rpc = () => {
    if (host === null) throw new Error('host not booted')
    return host.rpc
  }

  it('composes with a verified capability manifest', async () => {
    const reports = await rpc().call('capabilities.verify') as Array<{ ok: boolean }>
    expect(reports.filter((report) => !report.ok)).toEqual([])
  })

  it('registers every declared method and tool', async () => {
    const methods = (await rpc().call('api.list') as Array<{ name: string }>).map((m) => m.name)
    for (const name of API_NAMES) expect(methods).toContain(name)
    const tools = (await rpc().call('tools.list') as Array<{ name: string }>).map((t) => t.name)
    for (const name of TOOL_NAMES) expect(tools).toContain(name)
    // The retired ad-hoc surface must not creep back in.
    expect(methods).not.toContain('highlight.generate')
  })

  it('handshakes the engine over the versioned protocol', async () => {
    const hello = await rpc().call('highlight.hello') as { protocol: number; engine: string }
    expect(hello.protocol).toBe(1)
    expect(hello.engine).toContain('engine')
  })

  it('reports supervision state', async () => {
    const state = await rpc().call('highlight.engine.state') as { running: boolean; script: string }
    expect(state.running).toBe(true)
    expect(state.script).toContain('fake-bridge.mjs')
  })

  it('probes a media file', async () => {
    const media = await rpc().call('highlight.probe', { path: CLIP }) as {
      durationSec: number; width: number; hasAudio: boolean
    }
    expect(media.durationSec).toBe(120)
    expect(media.width).toBe(1920)
    expect(media.hasAudio).toBe(true)
  })

  it('rejects a relative path instead of guessing one', async () => {
    const error = await expectError(rpc(), 'highlight.probe', { path: 'clip.mp4' })
    expect(error.code).toBe(INVALID_PARAMS)
  })

  it('rejects an unknown engine option', async () => {
    const error = await expectError(rpc(), 'highlight.start', {
      input: CLIP,
      options: { notAKnob: true },
    })
    expect(error.code).toBe(INVALID_PARAMS)
  })

  it('publishes the option catalogue so a UI never hardcodes knobs', async () => {
    const options = await rpc().call('highlight.options') as Array<{
      key: string; type: string; default: unknown; requires: string; available: boolean
      fields: Record<string, { default: number }> | null
    }>
    const byKey = new Map(options.map((option) => [option.key, option]))
    // A knob the engine implements must be discoverable, with its real type.
    expect(byKey.get('clipDurationSec')?.type).toBe('float')
    expect(byKey.get('clipDurationSec')?.default).toBe(6)
    expect(byKey.get('enableClipGuidance')?.requires).toBe('clip')
    // The double reports no models, so a model-backed knob must say so.
    expect(byKey.get('enableClipGuidance')?.available).toBe(false)
    expect(byKey.get('frameSkip')?.available).toBe(true)
    // A composite knob publishes its sub-keys, so a renderer never hardcodes
    // which signals this engine scores on.
    expect(byKey.get('weights')?.type).toBe('weights')
    expect(Object.keys(byKey.get('weights')?.fields ?? {}).sort()).toEqual([
      'audioRms', 'clipGuidance', 'faceSaliency', 'keywordMatch',
      'objectSaliency', 'sceneCut', 'visualMotion',
    ])
    expect(byKey.get('weights')?.fields?.audioRms?.default).toBe(0.22)
  })

  it('enforces the option contract before a job is created', async () => {
    const tooMany = await expectError(rpc(), 'highlight.start', {
      input: CLIP, options: { maxHighlights: 999 },
    })
    expect(tooMany.code).toBe(INVALID_PARAMS)

    const wrongType = await expectError(rpc(), 'highlight.start', {
      input: CLIP, options: { frameSkip: 'many' },
    })
    expect(wrongType.code).toBe(INVALID_PARAMS)

    const badEnum = await expectError(rpc(), 'highlight.start', {
      input: CLIP, options: { whisperModelSize: 'gigantic' },
    })
    expect(badEnum.code).toBe(INVALID_PARAMS)

    // A prompt without guidance is a no-op that looks enabled.
    const orphanPrompt = await expectError(rpc(), 'highlight.start', {
      input: CLIP, options: { clipPrompt: 'a goal' },
    })
    expect(orphanPrompt.code).toBe(INVALID_PARAMS)

    // Composite weights: every way a caller can be wrong, refused up front.
    const badSignal = await expectError(rpc(), 'highlight.start', {
      input: CLIP, options: { weights: { notASignal: 0.5 } },
    })
    expect(badSignal.code).toBe(INVALID_PARAMS)
    expect(badSignal.message).toContain('notASignal')

    const allZero = await expectError(rpc(), 'highlight.start', {
      input: CLIP, options: { weights: { audioRms: 0, sceneCut: 0 } },
    })
    // All-zero would make the engine substitute its defaults: accepted, ignored.
    expect(allZero.code).toBe(INVALID_PARAMS)

    const outOfRange = await expectError(rpc(), 'highlight.start', {
      input: CLIP, options: { weights: { audioRms: 2 } },
    })
    expect(outOfRange.code).toBe(INVALID_PARAMS)
  })

  it('accepts a partial weight map (unspecified signals keep engine defaults)', async () => {
    const started = await rpc().call('highlight.start', {
      input: CLIP,
      output: `/tmp/vhl-weights-${Date.now()}.mp4`,
      options: { weights: { audioRms: 0.5, sceneCut: 0.1 } },
    }) as { jobId: string; state: string }
    expect(started.jobId).not.toBe('')
    await rpc().call('highlight.cancel', { jobId: started.jobId })
  })

  it('refuses an explicit opt-in to a model this deployment lacks', async () => {
    const error = await expectError(rpc(), 'highlight.start', {
      input: CLIP, options: { enableClipGuidance: true },
    })
    expect(error.code).toBe(UNAVAILABLE)
    expect(error.message).toContain('clip')
  })

  it('runs a job from start to a playable clip', async () => {
    const started = await rpc().call('highlight.start', {
      input: CLIP,
      topK: 2,
      clipDurationSec: 6,
      output: `/tmp/vhl-test-${Date.now()}/highlight.mp4`,
    }) as { jobId: string; state: string; clipUrl: string }
    expect(started.jobId).not.toBe('')
    expect(['queued', 'running']).toContain(started.state)

    const done = await waitFor(async () => {
      const job = await rpc().call('highlight.status', { jobId: started.jobId }) as {
        state: string; progress: number; segments: Array<{ startSec: number; endSec: number }>
        segmentCount: number; clipUrl: string
      }
      return job.state === 'succeeded' ? job : false
    }, 20_000)

    expect(done.progress).toBe(1)
    expect(done.segmentCount).toBe(2)
    expect(done.segments[0]?.endSec).toBeGreaterThan(done.segments[0]?.startSec ?? 0)
    expect(done.clipUrl).toBe('')
  })

  it('serves clip, subtitle (WebVTT) and report from the data plane', async () => {
    // No `output`: the host places the clip inside its own work dir, which is the
    // only place it will publish artifacts from.
    const started = await rpc().call('highlight.start', { input: CLIP, topK: 2 }) as { jobId: string }
    const done = await waitFor(async () => {
      const job = await rpc().call('highlight.status', { jobId: started.jobId }) as {
        state: string; clipUrl: string; subtitleUrl: string; reportUrl: string
      }
      return job.state === 'succeeded' ? job : false
    }, 20_000)

    expect(done.clipUrl).toBe(`/api/highlight.clip.${started.jobId}`)
    expect(done.subtitleUrl).toBe(`/api/highlight.subtitle.${started.jobId}`)
    expect(done.reportUrl).toBe(`/api/highlight.report.${started.jobId}`)

    const base = `http://127.0.0.1:${host?.port ?? 0}`

    const clip = await fetch(`${base}${done.clipUrl}`, { headers: { range: 'bytes=0-99' } })
    expect(clip.status).toBe(206)
    expect(clip.headers.get('content-type')).toContain('video/mp4')

    // The engine writes SRT; a browser <track> only accepts WebVTT.
    const subtitle = await fetch(`${base}${done.subtitleUrl}`)
    expect(subtitle.status).toBe(200)
    expect(subtitle.headers.get('content-type')).toContain('text/vtt')
    const vtt = await subtitle.text()
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toContain('00:00:00.500 --> 00:00:02.000')
    expect(vtt).not.toContain('00:00:00,500')

    const report = await fetch(`${base}${done.reportUrl}`)
    expect(report.status).toBe(200)
    expect(report.headers.get('content-type')).toContain('application/json')
    const body = await report.json() as { engine: string; selected_highlights: unknown[] }
    expect(body.engine).toContain('fake-engine')
    expect(body.selected_highlights.length).toBe(2)
  })

  it('cancels a running job', async () => {

    const started = await rpc().call('highlight.start', {
      input: CLIP,
      output: `/tmp/vhl-cancel-${Date.now()}/highlight.mp4`,
    }) as { jobId: string }
    const cancelled = await rpc().call('highlight.cancel', { jobId: started.jobId }) as { state: string }
    expect(cancelled.state).toBe('cancelled')
  })

  it('refuses to export an EDL before the job succeeded', async () => {
    const started = await rpc().call('highlight.start', {
      input: CLIP,
      output: `/tmp/vhl-edl-${Date.now()}/highlight.mp4`,
    }) as { jobId: string }
    await rpc().call('highlight.cancel', { jobId: started.jobId })
    const error = await expectError(rpc(), 'highlight.export.edl', { jobId: started.jobId })
    expect(error.code).toBe(INVALID_PARAMS)
  })

  it('answers NOT_FOUND for an unknown job', async () => {
    const error = await expectError(rpc(), 'highlight.status', { jobId: 'nope' })
    expect(error.code).toBe(NOT_FOUND)
  })

  it('lists jobs and reports models with licence identifiers', async () => {
    const jobs = await rpc().call('highlight.jobs.list') as unknown[]
    expect(Array.isArray(jobs)).toBe(true)
    expect(jobs.length).toBeGreaterThan(0)
    const models = await rpc().call('highlight.models') as {
      detector: { license: string }; clip: { license: string }
    }
    expect(models.detector.license).toContain('Apache-2.0')
    expect(models.clip.license).toContain('MIT')
  })

  it('publishes engine diagnostics on health', async () => {
    const response = await fetch(`http://127.0.0.1:${host?.port ?? 0}/api/health`)
    const health = await response.json() as { highlight?: { running?: boolean } }
    expect(health.highlight?.running).toBe(true)
  })

  it('serves a Prometheus exposition that a scraper can parse', async () => {
    const response = await fetch(`http://127.0.0.1:${host?.port ?? 0}/api/metrics`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.headers.get('content-type')).toContain('version=0.0.4')
    const text = await response.text()

    const sample = (name: string): number => {
      const line = text.split('\n').find((row) => row.startsWith(`${name} `))
      if (line === undefined) throw new Error(`指标缺失: ${name}`)
      return Number(line.slice(name.length + 1))
    }

    // Jobs actually ran above, so these are live numbers, not placeholders.
    expect(sample('vhl_engine_ready')).toBe(1)
    expect(sample('vhl_jobs_started_total')).toBeGreaterThan(0)
    expect(sample('vhl_queue_capacity')).toBe(8)
    expect(sample('vhl_job_duration_seconds_count')).toBeGreaterThan(0)

    // The one metric that must never regress: an id in a label turns every job
    // into a new time series.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })
})

// ---- world 2: no engine at all -------------------------------------------- //

describe('the highlight host without a usable interpreter', () => {
  let host: BootedHost | null = null

  beforeAll(async () => {
    // A path that cannot be spawned: the boot must still succeed.
    host = await bootHighlight({ VHL_PYTHON: '/nonexistent/python-does-not-exist' })
  })

  afterAll(async () => {
    await host?.stop()
  })

  it('composes and keeps the control plane up', async () => {
    const methods = (await host?.rpc.call('api.list') as Array<{ name: string }>).map((m) => m.name)
    expect(methods).toContain('highlight.status')
  })

  it('fails engine calls with a coded UNAVAILABLE', async () => {
    if (host === null) throw new Error('host not booted')
    const error = await expectError(host.rpc, 'highlight.probe', { path: CLIP })
    expect(error.code).toBe(UNAVAILABLE)
  })

  it('still answers health, with running=false', async () => {
    const response = await fetch(`http://127.0.0.1:${host?.port ?? 0}/api/health`)
    const health = await response.json() as { highlight?: { running?: boolean } }
    expect(health.highlight?.running).toBe(false)
  })
})

// ---- world 3: a crashing bridge ------------------------------------------- //

describe('the highlight host when the engine dies on startup', () => {
  let host: BootedHost | null = null

  beforeAll(async () => {
    host = await bootHighlight({
      FAKE_BRIDGE_MODE: 'crash',
      VHL_ENGINE_AUTO_RESTART: '1',
      VHL_ENGINE_MAX_RESTARTS: '1',
      VHL_ENGINE_RESTART_DELAY_MS: '50',
    })
  })

  afterAll(async () => {
    await host?.stop()
  })

  it('survives and keeps answering with coded errors', async () => {
    if (host === null) throw new Error('host not booted')
    const error = await expectError(host.rpc, 'highlight.hello')
    expect([UNAVAILABLE, -32003]).toContain(error.code)
    const state = await host.rpc.call('highlight.engine.state') as { running: boolean; restarts: number }
    expect(state.running).toBe(false)
  })
})

// ---- world 4: queue pressure ---------------------------------------------- //

describe('the highlight host under queue pressure', () => {
  let host: BootedHost | null = null
  const dir = mkdtempSync(join(tmpdir(), 'vhl-queue-'))

  beforeAll(async () => {
    host = await bootHighlight({
      // One knob, host-side: it is passed to the engine as --max-queue, so the
      // refusal, the metric and the config can never disagree.
      VHL_MAX_QUEUE: '1',
      FAKE_BRIDGE_JOB_MS: '5000',
      VHL_WORK_DIR: dir,
    })
  })

  afterAll(async () => {
    await host?.stop()
  })

  it('answers the overflow with CONFLICT instead of queueing forever', async () => {
    if (host === null) throw new Error('host not booted')
    const first = await host.rpc.call('highlight.start', { input: CLIP }) as { jobId: string }
    const error = await expectError(host.rpc, 'highlight.start', { input: CLIP })
    // A distinct code, not a generic ENGINE failure: only CONFLICT is retryable
    // after a backoff, and a client has to be able to tell the difference.
    expect(error.code).toBe(CONFLICT)
    await host.rpc.call('highlight.cancel', { jobId: first.jobId })
  })

  it('reports the queue depth on health', async () => {
    const response = await fetch(`http://127.0.0.1:${host?.port ?? 0}/api/health`)
    const body = await response.json() as { highlight?: { metrics?: { queueDepth?: number } } }
    expect(typeof body.highlight?.metrics?.queueDepth).toBe('number')
  })
})

// ---- world 5: artifact retention ------------------------------------------- //

describe('the highlight host with a retention window', () => {
  let host: BootedHost | null = null
  const dir = mkdtempSync(join(tmpdir(), 'vhl-retain-'))

  beforeAll(async () => {
    host = await bootHighlight({
      VHL_RETAIN_JOBS: '1',
      FAKE_BRIDGE_JOB_MS: '150',
      VHL_WORK_DIR: dir,
    })
  })

  afterAll(async () => {
    await host?.stop()
  })

  it('prunes the oldest artifact directory once the window is exceeded', async () => {
    if (host === null) throw new Error('host not booted')
    const run = async (): Promise<string> => {
      const started = await host!.rpc.call('highlight.start', { input: CLIP }) as { jobId: string }
      await waitFor(async () => {
        const job = await host!.rpc.call('highlight.status', { jobId: started.jobId }) as { state: string }
        return job.state === 'succeeded'
      }, 20_000)
      return started.jobId
    }
    const older = await run()
    expect(existsSync(join(dir, older))).toBe(true)
    const newer = await run()
    await waitFor(async () => !existsSync(join(dir, older)), 10_000)
    expect(existsSync(join(dir, newer))).toBe(true)
  })
})
