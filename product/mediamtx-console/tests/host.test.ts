// The composed console host, end to end: the product profile boots (base
// layer + product layer), the capability's manifest survives STRICT
// verification, and the whole surface a client/agent uses answers over the
// control plane — in BOTH worlds:
//
//   degraded (no MediaMTX anywhere): every call fails with the CODED error
//   the panels branch on (UNAVAILABLE + messageKey), never a raw socket error;
//
//   live (a real MediaMTX binary, spawned here when MTX_BIN/sandbox path
//   exists): the full round trip — info, endpoints, path add/list/delete with
//   the upstream error contract mapped onto RPC codes, metrics summary.
//
// The live suites SKIP (with a printed reason) when no binary is present, so
// CI without MediaMTX still runs everything that does not need a server.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootMtxconsole,
  expectError,
  mtxBin,
  spawnMtx,
  type BootedHost,
  type MtxServer,
} from './support/host.ts'

const UNAVAILABLE = -32002
const NOT_FOUND = -32001
const INVALID_PARAMS = -32602

interface PathRowWire {
  name: string
  ready: boolean
  source: string | null
  readers: number
  record: boolean
}
interface EndpointsWire {
  api: string
  webrtc: string | null
  hls: string | null
  metrics: string | null
  playback: string | null
}

// ---- world 1: degraded -------------------------------------------------------

describe('the console host without a MediaMTX server', () => {
  let host: BootedHost | null = null
  afterAll(async () => {
    await host?.stop()
    host = null
  })

  it('boots STRICT and registers the capability + tools', async () => {
    // Point at a port nothing listens on: the capability must still compose —
    // a console for an offline server is a console showing "unreachable".
    host = await bootMtxconsole({
      MTXCONSOLE_STRICT_CAPABILITIES: '1',
      MTXCONSOLE_SERVER_URL: 'http://127.0.0.1:9',
    })
    const health = (await (await fetch(`http://127.0.0.1:${host.port}/api/health`)).json()) as Record<string, unknown>
    expect(health.ok).toBe(true)
    expect(health.mediamtx).toMatchObject({ server: 'http://127.0.0.1:9' })

    const reports = await host.rpc.call<{ id: string; ok: boolean; missing: unknown }[]>('capabilities.verify')
    const mediamtx = reports.find((r) => r.id === 'mediamtx')
    expect(mediamtx?.ok, JSON.stringify(mediamtx?.missing ?? null)).toBe(true)

    const tools = await host.rpc.call<{ name: string }[]>('tools.list')
    const names = tools.map((t) => t.name)
    for (const wanted of [
      'mediamtx.info',
      'mediamtx.endpoints',
      'mediamtx.paths.list',
      'mediamtx.path.add',
      'mediamtx.path.delete',
      'mediamtx.sessions.kick',
    ]) {
      expect(names, `tool ${wanted}`).toContain(wanted)
    }
  }, 90_000)

  it('fails every server call with the coded UNAVAILABLE the panels branch on', async () => {
    const err = await expectError(host!.rpc, 'mediamtx.info')
    expect(err.code).toBe(UNAVAILABLE)
    expect(err.messageKey).toBe('mediamtx.unreachable')
    const err2 = await expectError(host!.rpc, 'mediamtx.paths.list')
    expect(err2.code).toBe(UNAVAILABLE)
  })

  it('refuses a kick of a non-kickable protocol BEFORE any network call', async () => {
    const err = await expectError(host!.rpc, 'mediamtx.sessions.kick', { kind: 'rtmp', id: 'x' })
    expect(err.code).toBe(INVALID_PARAMS)
    expect(err.messageKey).toBe('mediamtx.notKickable')
  })
})

// ---- world 2: live -----------------------------------------------------------

const bin = mtxBin()

describe.skipIf(bin === null)('the console host against a REAL MediaMTX', () => {
  let mtx: MtxServer | null = null
  let host: BootedHost | null = null

  beforeAll(async () => {
    if (bin === null) return
    mtx = await spawnMtx()
    host = await bootMtxconsole({
      MTXCONSOLE_STRICT_CAPABILITIES: '1',
      MTXCONSOLE_SERVER_URL: mtx.apiUrl,
    })
  }, 120_000)

  afterAll(async () => {
    await host?.stop()
    host = null
    await mtx?.stop()
    mtx = null
  })

  it('reports the server identity and derives endpoints from its config', async () => {
    const { info } = await host!.rpc.call<{ info: { version: string; started: string; apiBase: string } }>('mediamtx.info')
    expect(info.version).toMatch(/^v?\d+\./)
    expect(info.apiBase).toBe(mtx!.apiUrl)

    const { endpoints } = await host!.rpc.call<{ endpoints: EndpointsWire }>('mediamtx.endpoints')
    expect(endpoints.api).toBe(mtx!.apiUrl)
    // The throwaway server disabled webrtc/hls → nulls, and enabled metrics →
    // an absolute URL borrowing the API hostname.
    expect(endpoints.webrtc).toBeNull()
    expect(endpoints.hls).toBeNull()
    expect(endpoints.metrics).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('walks the path lifecycle with the upstream error contract mapped onto RPC codes', async () => {
    const seeded = await host!.rpc.call<{ paths: PathRowWire[] }>('mediamtx.paths.list')
    expect(seeded.paths.map((p) => p.name)).toContain('seeded')

    // add a pull source (the "put a camera on air" gesture)
    await host!.rpc.call('mediamtx.config.paths.add', { name: 'verify-cam', source: 'rtsp://127.0.0.1:1554/none' })
    const after = await host!.rpc.call<{ paths: PathRowWire[] }>('mediamtx.paths.list')
    const added = after.paths.find((p) => p.name === 'verify-cam')
    expect(added).toBeDefined()
    expect(added!.source).toBe('rtsp://127.0.0.1:1554/none')
    expect(added!.ready).toBe(false) // nothing publishes here; still not an error

    // duplicate add → upstream 400 → INVALID_PARAMS with the upstream detail
    const dup = await expectError(host!.rpc, 'mediamtx.config.paths.add', { name: 'verify-cam' })
    expect(dup.code).toBe(INVALID_PARAMS)
    expect(dup.messageKey).toBe('mediamtx.upstream')
    expect(String(dup.messageParams?.detail ?? '')).toContain('already exists')

    // get / patch / delete
    const one = await host!.rpc.call<{ path: PathRowWire }>('mediamtx.paths.get', { name: 'verify-cam' })
    expect(one.path.name).toBe('verify-cam')
    await host!.rpc.call('mediamtx.config.paths.patch', { name: 'verify-cam', record: true })
    await host!.rpc.call('mediamtx.config.paths.delete', { name: 'verify-cam' })
    const gone = await host!.rpc.call<{ paths: PathRowWire[] }>('mediamtx.paths.list')
    expect(gone.paths.find((p) => p.name === 'verify-cam')).toBeUndefined()

    // delete again → upstream 404 → NOT_FOUND
    const again = await expectError(host!.rpc, 'mediamtx.config.paths.delete', { name: 'verify-cam' })
    expect(again.code).toBe(NOT_FOUND)
    const missing = await expectError(host!.rpc, 'mediamtx.paths.get', { name: 'nope' })
    expect(missing.code).toBe(NOT_FOUND)
  })

  it('summarizes metrics and lists sessions/recordings as (possibly empty) arrays', async () => {
    const metrics = await host!.rpc.call<{ pathsReady: number; pathsNotReady: number; totalReaders: number; perPath: unknown[] }>('mediamtx.metrics')
    expect(metrics.pathsReady + metrics.pathsNotReady).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(metrics.perPath)).toBe(true)

    const sessions = await host!.rpc.call<{ sessions: unknown[] }>('mediamtx.sessions.list')
    expect(Array.isArray(sessions.sessions)).toBe(true)
    const recordings = await host!.rpc.call<{ recordings: unknown[] }>('mediamtx.recordings.list')
    expect(Array.isArray(recordings.recordings)).toBe(true)

    const global = await host!.rpc.call<{ config: Record<string, unknown> }>('mediamtx.config.global.get')
    expect(typeof global.config.logLevel === 'string').toBe(true)
  })

  it('exposes the same surface to the agent (tools run through the registry)', async () => {
    // The agent and the control plane share ONE door: tools.run validates the
    // args against the registered schema and executes — no model key needed to
    // prove the tool surface works.
    const paths = await host!.rpc.call<{ name: string }[]>('tools.run', { name: 'mediamtx.paths.list', args: {} })
    expect(Array.isArray(paths)).toBe(true)
    expect(paths.map((p) => p.name)).toContain('seeded')

    const info = await host!.rpc.call<{ version: string }>('tools.run', { name: 'mediamtx.info', args: {} })
    expect(info.version).toMatch(/^v?\d+\./)

    // The director's gesture, as an agent would issue it: put a camera on air.
    await host!.rpc.call('tools.run', {
      name: 'mediamtx.path.add',
      args: { name: 'agent-cam', source: 'rtsp://127.0.0.1:1554/none' },
    })
    const after = await host!.rpc.call<{ name: string }[]>('tools.run', { name: 'mediamtx.paths.list', args: {} })
    expect(after.map((p) => p.name)).toContain('agent-cam')
    await host!.rpc.call('tools.run', { name: 'mediamtx.path.delete', args: { name: 'agent-cam' } })
  })
})
