// product/xmedia — the composed host, end to end.
//
// Three worlds, matching the base's engine-supervision contract:
//   1. fake engine (Node): strict boot, full capability surface, command
//      round trips, agent tools, events and the publish control plane.
//   2. degraded (no engine binary): the host still composes, and every call
//      fails with a CODED UNAVAILABLE error a client can branch on.
//   3. crashing engine: the host survives and the product's restart policy
//      runs (the neutral EngineClient only reports; policy lives in @xmedia).
//
// A real xmedia-bridge is exercised by scripts/verify.mjs when its binary is
// present. Nothing here requires a C++ toolchain.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_NAMES, TOOL_NAMES } from '../packages/host/engine/src/index.ts'
import {
  bootXmedia,
  expectError,
  waitFor,
  type BootedHost,
} from './support/host.ts'

const UNAVAILABLE = -32002
const FORBIDDEN = -32021
const INVALID_PARAMS = -32602

/** The retired Player self-check pipeline + the earlier MJPEG preview surface. */
const REMOVED = [
  'xmedia.open', 'xmedia.play', 'xmedia.pause', 'xmedia.stop', 'xmedia.reset',
  'xmedia.seek', 'xmedia.rate', 'xmedia.volume', 'xmedia.mute',
  'xmedia.status', 'xmedia.info', 'xmedia.diagnostics', 'xmedia.snapshot',
  'xmedia.frame', 'xmedia.preview.state', 'xmedia.preview.rate',
]

// ---- world 1: a well-behaved engine ------------------------------------------

describe('the xmedia host with a working engine', () => {
  let host: BootedHost | null = null

  beforeAll(async () => {
    host = await bootXmedia({ XMEDIA_STRICT_CAPABILITIES: '1' })
  })
  afterAll(async () => {
    await host?.stop()
    host = null
  })

  it('boots STRICT with an honest capability manifest', async () => {
    const reports = await host!.rpc.call<Array<{ ok: boolean; missing: unknown }>>('capabilities.verify')
    expect(reports.filter((r) => !r.ok)).toEqual([])

    const caps = await host!.rpc.call<Array<{ id: string }>>('capabilities.list')
    expect(caps.map((c) => c.id)).toContain('xmedia')

    const methods = (await host!.rpc.call<Array<{ name: string }>>('api.list')).map((m) => m.name)
    for (const wanted of API_NAMES) expect(methods).toContain(wanted)

    const tools = (await host!.rpc.call<Array<{ name: string }>>('tools.list')).map((t) => t.name)
    for (const wanted of TOOL_NAMES) expect(tools).toContain(wanted)
  })

  it('announces the engine over health and the hello handshake', async () => {
    const health = await (await fetch(`http://127.0.0.1:${host!.port}/api/health`)).json() as Record<string, unknown>
    expect(health.ok).toBe(true)
    expect(health.xmedia).toMatchObject({ running: true })

    const hello = await waitFor<{ protocol: number; engine: string }>(async () => {
      try {
        return await host!.rpc.call<{ protocol: number; engine: string }>('xmedia.hello')
      } catch {
        return false
      }
    }, 10_000)
    expect(hello.protocol).toBe(1)
    expect(hello.engine).toContain('xmedia-kit')
  })

  it('has no playback self-check, byte route or frame channel left', async () => {
    const methods = (await host!.rpc.call<Array<{ name: string }>>('api.list')).map((m) => m.name)
    const tools = (await host!.rpc.call<Array<{ name: string }>>('tools.list')).map((t) => t.name)
    for (const removed of REMOVED) {
      expect(methods).not.toContain(removed)
      expect(tools).not.toContain(removed)
    }
    const channels = await host!.rpc.call<Array<{ name: string }>>('api.streams')
    expect(channels.map((c) => c.name)).not.toContain('xmedia.frames')
  })

  it('validates publish arguments at the boundary', async () => {
    const bad = await expectError(host!.rpc, 'xmedia.publish.start', { input: '' })
    expect(bad.code).toBe(INVALID_PARAMS)
  })

  it('drains engine events and exposes verbs as agent tools', async () => {
    await host!.rpc.call('xmedia.publish.start', { input: '/tmp/agent.mp4', path: 'events' })
    await host!.rpc.call('xmedia.publish.stop')
    const events = await host!.rpc.call<Array<{ type: string }>>('xmedia.events')
    expect(events.some((e) => e.type === 'PublishStarted')).toBe(true)
    expect(events.some((e) => e.type === 'PublishDone')).toBe(true)

    const viaTool = await host!.rpc.call<Record<string, unknown>>('tools.run', {
      name: 'xmedia.publish.viewers', args: { path: 'agent' },
    })
    expect(viaTool.path).toBe('agent')

    const state = await host!.rpc.call<Record<string, unknown>>('xmedia.engine.state')
    expect(state).toMatchObject({ running: true, protocol: 1, binary: process.execPath })
  })

  it('drives the publish control plane and hands out MediaMTX viewer URLs', async () => {
    const viewers = await host!.rpc.call<Record<string, unknown>>('xmedia.publish.viewers')
    expect(viewers).toMatchObject({
      path: 'xmedia',
      publish: 'rtmp://127.0.0.1:1935/xmedia',
      whep: 'http://127.0.0.1:8889/xmedia/whep',
      hls: 'http://127.0.0.1:8888/xmedia/index.m3u8',
    })

    const started = await host!.rpc.call<{
      running: boolean
      input: string
      output: string
      format: string
      viewers: { whep: string }
    }>('xmedia.publish.start', { input: '/tmp/clip.mp4', path: 'unit' })
    expect(started).toMatchObject({
      running: true,
      input: '/tmp/clip.mp4',
      output: 'rtmp://127.0.0.1:1935/unit',
      format: 'flv',
    })
    expect(started.viewers.whep).toBe('http://127.0.0.1:8889/unit/whep')

    const status = await host!.rpc.call<Record<string, unknown>>('xmedia.publish.status')
    expect(status.running).toBe(true)

    const stopped = await host!.rpc.call<Record<string, unknown>>('xmedia.publish.stop')
    expect(stopped).toMatchObject({ running: false, done: true })

    const events = await host!.rpc.call<Array<{ type: string }>>('xmedia.events')
    expect(events.some((e) => e.type === 'PublishDone')).toBe(true)
  })

  it('re-encodes live outputs but keeps copy for offline files', async () => {
    // A stream-copied long-GOP source gives MediaMTX no IDR to start a WHEP
    // reader on (measured: RTP packets arrive, framesDecoded stays 0).
    // Live outputs must therefore default to a real encoder. Offline FILE jobs
    // have no browser waiting on a keyframe and keep the cheap copy path.
    const live = await host!.rpc.call<Record<string, any>>('xmedia.publish.start', {
      input: '/tmp/clip.mp4', path: 'codec-live',
    })
    expect(typeof live.videoCodec).toBe('string')
    expect(live.videoCodec).not.toBe('copy')
    expect(live.videoCodec).not.toBe('')
    await host!.rpc.call('xmedia.publish.stop')

    const offline = await host!.rpc.call<Record<string, any>>('xmedia.publish.start', {
      input: '/tmp/clip.mp4', output: '/tmp/clip-out.mp4',
    })
    expect(offline.videoCodec).toBe('copy')
    await host!.rpc.call('xmedia.publish.stop')

    // An explicit operator choice still wins.
    const explicit = await host!.rpc.call<Record<string, any>>('xmedia.publish.start', {
      input: '/tmp/clip.mp4', path: 'codec-copy', videoCodec: 'copy',
    })
    expect(explicit.videoCodec).toBe('copy')
    await host!.rpc.call('xmedia.publish.stop')
  })

  it('exposes observability metrics for the publish control plane', async () => {
    await host!.rpc.call('xmedia.publish.start', { input: '/tmp/metrics.mp4', path: 'metrics' })
    await host!.rpc.call('xmedia.publish.stop')
    const m = await host!.rpc.call<{
      jobsStarted: number
      jobsSucceeded: number
      jobsFailed: number
      activeJobs: number
      recent: Array<{ jobId: string; input: string }>
    }>('xmedia.metrics')
    expect(typeof m.jobsStarted).toBe('number')
    expect(m.jobsStarted).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(m.recent)).toBe(true)
    expect(m.recent.some((r) => r.input === '/tmp/metrics.mp4')).toBe(true)
  })

  it('runs multiple jobs concurrently via the task pool (no single BUSY)', async () => {
    const a = await host!.rpc.call<{ jobId: string; running: boolean }>('xmedia.publish.start', {
      input: '/tmp/a.mp4', path: 'pool-a',
    })
    const b = await host!.rpc.call<{ jobId: string; running: boolean }>('xmedia.publish.start', {
      input: '/tmp/b.mp4', path: 'pool-b',
    })
    expect(a.jobId).not.toBe(b.jobId)
    expect(a.running).toBe(true)
    expect(b.running).toBe(true)

    const statusA = await host!.rpc.call<{ running: boolean }>('xmedia.publish.status', { jobId: a.jobId })
    const statusB = await host!.rpc.call<{ running: boolean }>('xmedia.publish.status', { jobId: b.jobId })
    expect(statusA.running).toBe(true)
    expect(statusB.running).toBe(true)

    // Stopping one job must not disturb the other.
    await host!.rpc.call('xmedia.publish.stop', { jobId: a.jobId })
    const stillB = await host!.rpc.call<{ running: boolean }>('xmedia.publish.status', { jobId: b.jobId })
    expect(stillB.running).toBe(true)
    await host!.rpc.call('xmedia.publish.stop', { jobId: b.jobId })
  })

  it('reports sandbox state as a boolean (false by default)', async () => {
    const state = await host!.rpc.call<{ sandboxed: boolean }>('xmedia.engine.state')
    expect(typeof state.sandboxed).toBe('boolean')
    expect(state.sandboxed).toBe(false)
  })
})

// ---- world 2: engine binary missing -----------------------------------------

describe('the xmedia host with no engine binary', () => {
  let host: BootedHost | null = null

  afterAll(async () => {
    await host?.stop()
    host = null
  })

  it('still composes STRICT and fails calls with a coded error', async () => {
    host = await bootXmedia({
      XMEDIA_STRICT_CAPABILITIES: '1',
      XMEDIA_ENGINE_BIN: '/definitely/not/a/binary',
      XMEDIA_ENGINE_ARGS: '',
      XMEDIA_ENGINE_AUTO_RESTART: '0',
    })
    const reports = await host.rpc.call<Array<{ ok: boolean }>>('capabilities.verify')
    expect(reports.filter((r) => !r.ok)).toEqual([])

    const error = await expectError(host.rpc, 'xmedia.publish.status')
    expect(error.code).toBe(UNAVAILABLE)

    const health = await (await fetch(`http://127.0.0.1:${host.port}/api/health`)).json() as Record<string, unknown>
    expect(health.xmedia).toMatchObject({ running: false })
  })
})

// ---- world 3: crash + supervision -------------------------------------------

describe('the xmedia host when the engine keeps crashing', () => {
  let host: BootedHost | null = null

  afterAll(async () => {
    await host?.stop()
    host = null
  })

  it('survives the crash and applies the product restart policy', async () => {
    host = await bootXmedia({
      XMEDIA_STRICT_CAPABILITIES: '1',
      FAKE_ENGINE_MODE: 'crash',
      XMEDIA_ENGINE_MAX_RESTARTS: '2',
      XMEDIA_ENGINE_RESTART_DELAY_MS: '50',
    })
    const state = await waitFor(async () => {
      const current = await host!.rpc.call<{ restarts: number }>('xmedia.engine.state')
      return current.restarts > 0 ? current : false
    }, 15_000)
    expect(state.restarts).toBeGreaterThan(0)

    // The host's control plane must still answer after the child died.
    const info = await host!.rpc.call<Record<string, unknown>>('server.info')
    expect(info.protocol).toEqual(expect.any(Number))
  })
})

// ---- world 4: readonly policy ------------------------------------------------

describe('the xmedia host in readonly mode', () => {
  let host: BootedHost | null = null

  afterAll(async () => {
    await host?.stop()
    host = null
  })

  it('refuses mutating engine verbs but still serves reads', async () => {
    host = await bootXmedia({ XMEDIA_READONLY: '1' })
    const refused = await expectError(host.rpc, 'xmedia.publish.start', { input: '/tmp/clip.mp4' })
    expect(refused.code).toBe(FORBIDDEN)
    expect(await host.rpc.call('xmedia.publish.viewers')).toMatchObject({ path: 'xmedia' })
  })
})

// ---- world 5: engine sandbox engaged ------------------------------------------

describe('the xmedia host with the engine sandbox engaged', () => {
  let host: BootedHost | null = null

  afterAll(async () => {
    await host?.stop()
    host = null
  })

  it('reports sandboxed=true through engine.state', async () => {
    host = await bootXmedia({
      XMEDIA_STRICT_CAPABILITIES: '1',
      XMEDIA_ENGINE_SANDBOX: '1',
    })
    const state = await waitFor<{ sandboxed: boolean }>(async () => {
      try {
        const s = await host!.rpc.call<{ sandboxed: boolean }>('xmedia.engine.state')
        return s.sandboxed ? s : false
      } catch {
        return false
      }
    }, 10_000)
    expect(state.sandboxed).toBe(true)
  })
})

// ---- protocol contract: single source of truth --------------------------------

describe('the xmedia wire protocol contract', () => {
  it('is generated consistently from protocol/contract.json', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const contract = JSON.parse(
      readFileSync(fileURLToPath(new URL('../protocol/contract.json', import.meta.url)), 'utf8'),
    ) as { protocolVersion: number; verbs: Record<string, unknown> }
    const header = readFileSync(
      fileURLToPath(new URL('../engine/src/xmedia_protocol.h', import.meta.url)),
      'utf8',
    )
    expect(contract.protocolVersion).toBe(1)
    const verbs = Object.keys(contract.verbs)
    const missing = verbs.filter((v) => !header.includes(`"${v}"`))
    expect(missing).toEqual([])
  })
})
