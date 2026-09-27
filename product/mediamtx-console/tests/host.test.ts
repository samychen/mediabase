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
import { existsSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
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
const CONFLICT = -32004

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

  it('fails playback.list with the same coded UNAVAILABLE (endpoint derivation hits the dead server first)', async () => {
    const err = await expectError(host!.rpc, 'mediamtx.playback.list', { name: 'cam1' })
    expect(err.code).toBe(UNAVAILABLE)
    expect(err.messageKey).toBe('mediamtx.unreachable')
  })

  it('manages the server registry offline — registry ops are local and coded', async () => {
    const list = await host!.rpc.call<{ servers: Array<{ name: string; url: string; auth: string }>; active: string }>('mediamtx.servers.list')
    expect(list.active).toBe('default')
    expect(list.servers).toEqual([{ name: 'default', url: 'http://127.0.0.1:9', auth: 'none', expiresAt: null }])

    // add → switch → every call now routes (and fails) against the NEW server
    await host!.rpc.call('mediamtx.servers.add', { name: 'bogus', url: 'http://127.0.0.1:8/' })
    await host!.rpc.call('mediamtx.servers.switch', { name: 'bogus' })
    const routed = await expectError(host!.rpc, 'mediamtx.info')
    expect(routed.code).toBe(UNAVAILABLE)
    expect(routed.messageParams?.url).toBe('http://127.0.0.1:8') // trailing slash normalized away

    // the coded local contract
    const rmActive = await expectError(host!.rpc, 'mediamtx.servers.remove', { name: 'bogus' })
    expect(rmActive.code).toBe(CONFLICT)
    expect(rmActive.messageKey).toBe('mediamtx.serverActive')
    const dup = await expectError(host!.rpc, 'mediamtx.servers.add', { name: 'default', url: 'http://x:1' })
    expect(dup.code).toBe(INVALID_PARAMS)
    expect(dup.messageKey).toBe('mediamtx.serverExists')
    const badUrl = await expectError(host!.rpc, 'mediamtx.servers.add', { name: 'y', url: 'ftp://nope' })
    expect(badUrl.code).toBe(INVALID_PARAMS)
    expect(badUrl.messageKey).toBe('mediamtx.serverBadUrl')
    const ghost = await expectError(host!.rpc, 'mediamtx.servers.switch', { name: 'ghost' })
    expect(ghost.code).toBe(NOT_FOUND)
    expect(ghost.messageKey).toBe('mediamtx.serverUnknown')

    // switch back, clean up — health follows the active server
    await host!.rpc.call('mediamtx.servers.switch', { name: 'default' })
    await host!.rpc.call('mediamtx.servers.remove', { name: 'bogus' })
    const after = await host!.rpc.call<{ servers: unknown[]; active: string }>('mediamtx.servers.list')
    expect(after.servers).toHaveLength(1)
    expect(after.active).toBe('default')
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
    expect(endpoints.playback).toBe(mtx!.playbackUrl)
  })

  it('answers playback.list with an empty window list for a path that never recorded', async () => {
    // Upstream answers 400 "lstat …: no such file or directory" for a path
    // without a recordings directory — the bridge maps that NORMAL state to
    // an empty list, not an error (verified against live v1.21.1).
    const { entries } = await host!.rpc.call<{ entries: unknown[] }>('mediamtx.playback.list', { name: 'seeded' })
    expect(entries).toEqual([])
    // A path that is not CONFIGURED at all is a real parameter error, though.
    const missing = await expectError(host!.rpc, 'mediamtx.playback.list', { name: 'never-existed' })
    expect(missing.code).toBe(INVALID_PARAMS)
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

// ---- world 3: mocked upstream pair --------------------------------------------
//
// The success path of playback.list needs a playback server WITH recordings —
// a real one needs a publisher (ffmpeg), which CI does not have. So: a tiny
// node:http pair (API mock + playback mock) pins the bridge's normalization —
// entry shape, origin rewrite to the browser-reachable base, window params,
// and the coded error when the playback server is disabled upstream.

describe('the playback bridge against a mocked API+playback pair', () => {
  let api: Server | null = null
  let pb: Server | null = null
  let host: BootedHost | null = null
  let pbPort = 0
  let apiUrl = ''
  let playbackEnabled = true
  let lastListQuery: string | null = null
  /** The authorization header the mock API saw most recently (auth tests). */
  let lastAuth: string | null = null

  beforeAll(async () => {
    pb = createHttpServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      if (u.pathname === '/list') {
        lastListQuery = u.search
        res.setHeader('content-type', 'application/json')
        // The upstream builds the /get URL from the request Host IT saw — the
        // mock claims a foreign origin so the rewrite is provable.
        res.end(JSON.stringify([{
          start: '2026-09-26T04:49:51.370862Z',
          duration: 9.978,
          url: `http://10.9.8.7:9996/get?duration=9.978&path=${encodeURIComponent(u.searchParams.get('path') ?? '')}&start=2026-09-26T04%3A49%3A51.370862Z`,
        }]))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>((r) => pb!.listen(0, '127.0.0.1', r))
    pbPort = (pb.address() as AddressInfo).port

    api = createHttpServer((req, res) => {
      lastAuth = (req.headers.authorization as string | undefined) ?? null
      const u = new URL(req.url ?? '/', 'http://localhost')
      res.setHeader('content-type', 'application/json')
      if (u.pathname === '/v3/info') {
        res.end(JSON.stringify({ version: 'v1.21.1-mock', started: '2026-09-26T00:00:00Z' }))
        return
      }
      if (u.pathname === '/v3/config/global/get') {
        res.end(JSON.stringify({
          playback: playbackEnabled,
          playbackAddress: `:${pbPort}`,
          webrtc: false,
          hls: false,
          rtsp: false,
          rtmp: false,
          srt: false,
          metrics: false,
        }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>((r) => api!.listen(0, '127.0.0.1', r))
    const apiPort = (api.address() as AddressInfo).port
    apiUrl = `http://127.0.0.1:${apiPort}`

    host = await bootMtxconsole({
      MTXCONSOLE_STRICT_CAPABILITIES: '1',
      MTXCONSOLE_SERVER_URL: apiUrl,
    })
  }, 120_000)

  afterAll(async () => {
    await host?.stop()
    host = null
    api?.close()
    pb?.close()
    api = null
    pb = null
  })

  it('normalizes entries and rewrites the /get origin to the browser-reachable playback base', async () => {
    const { entries } = await host!.rpc.call<{ entries: Array<{ startIso: string; durationSeconds: number; url: string }> }>(
      'mediamtx.playback.list',
      { name: 'cam1' },
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.startIso).toBe('2026-09-26T04:49:51.370862Z')
    expect(entries[0]!.durationSeconds).toBe(9.978)
    // Origin swapped (10.9.8.7:9996 → the derived base), path+query untouched.
    expect(entries[0]!.url).toBe(
      `http://127.0.0.1:${pbPort}/get?duration=9.978&path=cam1&start=2026-09-26T04%3A49%3A51.370862Z`,
    )
  })

  it('passes the optional start/end window through to the upstream query', async () => {
    await host!.rpc.call('mediamtx.playback.list', {
      name: 'cam1',
      start: '2026-09-26T00:00:00Z',
      end: '2026-09-27T00:00:00Z',
    })
    expect(lastListQuery).toContain('path=cam1')
    expect(lastListQuery).toContain(`start=${encodeURIComponent('2026-09-26T00:00:00Z')}`)
    expect(lastListQuery).toContain(`end=${encodeURIComponent('2026-09-27T00:00:00Z')}`)
  })

  it('reports a coded UNAVAILABLE when the playback server is disabled upstream', async () => {
    playbackEnabled = false
    const err = await expectError(host!.rpc, 'mediamtx.playback.list', { name: 'cam1' })
    expect(err.code).toBe(UNAVAILABLE)
    expect(err.messageKey).toBe('mediamtx.playbackDisabled')
    expect(err.message).toContain('playback: yes')
    playbackEnabled = true
  })

  it('sends basic-auth upstream, and a configured bearer token WINS over it', async () => {
    const basic = await bootMtxconsole({
      MTXCONSOLE_STRICT_CAPABILITIES: '1',
      MTXCONSOLE_SERVER_URL: apiUrl,
      MTXCONSOLE_USERNAME: 'u',
      MTXCONSOLE_PASSWORD: 'p',
    })
    lastAuth = null
    await basic.rpc.call('mediamtx.info')
    expect(lastAuth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
    await basic.stop()

    const bearer = await bootMtxconsole({
      MTXCONSOLE_STRICT_CAPABILITIES: '1',
      MTXCONSOLE_SERVER_URL: apiUrl,
      MTXCONSOLE_USERNAME: 'u',
      MTXCONSOLE_PASSWORD: 'p',
      MTXCONSOLE_SERVER_TOKEN: 'jwt.header.payload',
    })
    lastAuth = null
    await bearer.rpc.call('mediamtx.info')
    expect(lastAuth).toBe('Bearer jwt.header.payload')
    await bearer.stop()
  }, 120_000)

  it('routes every call through the ACTIVE registered server and persists the registry', async () => {
    const list = await host!.rpc.call<{ servers: Array<{ name: string; url: string; auth: string }>; active: string }>('mediamtx.servers.list')
    expect(list.servers).toEqual([{ name: 'default', url: apiUrl, auth: 'none', expiresAt: null }])

    await host!.rpc.call('mediamtx.servers.add', { name: 'second', url: `${apiUrl}/`, username: 'u2', password: 's' })
    const added = await host!.rpc.call<{ servers: Array<Record<string, unknown>> }>('mediamtx.servers.list')
    const second = added.servers.find((s) => s.name === 'second')
    expect(second).toEqual({ name: 'second', url: apiUrl, auth: 'basic', expiresAt: null }) // normalized; NO credentials on the wire
    expect(JSON.stringify(added)).not.toContain('u2')

    await host!.rpc.call('mediamtx.servers.switch', { name: 'second' })
    lastAuth = null
    const info = await host!.rpc.call<{ info: { apiBase: string } }>('mediamtx.info')
    expect(info.info.apiBase).toBe(apiUrl)
    expect(lastAuth).toBe(`Basic ${Buffer.from('u2:s').toString('base64')}`) // per-server credentials

    // persisted under the host identity's home — a restart comes back there
    const registryFile = join(host!.home, 'mtxconsole-servers.json')
    expect(existsSync(registryFile)).toBe(true)
    const restarted = await bootMtxconsole({
      MTXCONSOLE_HOME: host!.home,
      MTXCONSOLE_STRICT_CAPABILITIES: '1',
      MTXCONSOLE_SERVER_URL: apiUrl,
    })
    const afterBoot = await restarted.rpc.call<{ servers: Array<{ name: string }>; active: string }>('mediamtx.servers.list')
    expect(afterBoot.active).toBe('second')
    expect(afterBoot.servers.map((s) => s.name)).toEqual(['default', 'second'])
    await restarted.stop()

    // restore for the remaining tests (the world-3 host is shared)
    await host!.rpc.call('mediamtx.servers.switch', { name: 'default' })
    await host!.rpc.call('mediamtx.servers.remove', { name: 'second' })
  }, 120_000)

  it('decodes a bearer token’s exp for the registry view — without ever exposing the token', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const payload = Buffer.from(JSON.stringify({ exp, sub: 'camops' })).toString('base64url')
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig-never-shown`
    await host!.rpc.call('mediamtx.servers.add', { name: 'jwtcam', url: apiUrl, token })
    await host!.rpc.call('mediamtx.servers.add', { name: 'noexp', url: apiUrl, token: `h.${Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')}.s` })

    const list = await host!.rpc.call<{ servers: Array<{ name: string; auth: string; expiresAt: number | null }> }>('mediamtx.servers.list')
    const jwt = list.servers.find((s) => s.name === 'jwtcam')
    expect(jwt?.auth).toBe('bearer')
    expect(jwt?.expiresAt).toBe(exp) // decoded, for the panel's expiry warning
    expect(list.servers.find((s) => s.name === 'noexp')?.expiresAt).toBeNull()
    expect(list.servers.find((s) => s.name === 'default')?.expiresAt).toBeNull()
    // The token itself never rides the wire in any piece.
    const raw = JSON.stringify(list)
    expect(raw).not.toContain(payload)
    expect(raw).not.toContain('sig-never-shown')

    await host!.rpc.call('mediamtx.servers.remove', { name: 'jwtcam' })
    await host!.rpc.call('mediamtx.servers.remove', { name: 'noexp' })
  }, 120_000)

  it('updates a registered server IN PLACE — omitted fields keep, empty string clears', async () => {
    await host!.rpc.call('mediamtx.servers.add', { name: 'rot', url: apiUrl, username: 'u3', password: 'p3' })

    // url normalized, basic kept from the add
    const upd = await host!.rpc.call<{ server: { name: string; url: string; auth: string; expiresAt: number | null } }>(
      'mediamtx.servers.update', { name: 'rot', url: `${apiUrl}/` },
    )
    expect(upd.server).toEqual({ name: 'rot', url: apiUrl, auth: 'basic', expiresAt: null })

    // rotate in a token: bearer wins over the retained basic
    const exp = 1234
    const tok = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`
    const withTok = await host!.rpc.call<{ server: { auth: string; expiresAt: number | null } }>(
      'mediamtx.servers.update', { name: 'rot', token: tok },
    )
    expect(withTok.server.auth).toBe('bearer')
    expect(withTok.server.expiresAt).toBe(exp)

    // clear the token with an empty string: basic is still underneath
    const cleared = await host!.rpc.call<{ server: { auth: string; expiresAt: number | null } }>(
      'mediamtx.servers.update', { name: 'rot', token: '' },
    )
    expect(cleared.server.auth).toBe('basic')
    expect(cleared.server.expiresAt).toBeNull()

    // clearing basic too leaves an unauthenticated entry
    const noAuth = await host!.rpc.call<{ server: { auth: string } }>(
      'mediamtx.servers.update', { name: 'rot', username: '' },
    )
    expect(noAuth.server.auth).toBe('none')

    // coded local failures
    const ghost = await expectError(host!.rpc, 'mediamtx.servers.update', { name: 'ghost', url: apiUrl })
    expect(ghost.code).toBe(NOT_FOUND)
    expect(ghost.messageKey).toBe('mediamtx.serverUnknown')
    const badUrl = await expectError(host!.rpc, 'mediamtx.servers.update', { name: 'rot', url: 'ftp://x' })
    expect(badUrl.code).toBe(INVALID_PARAMS)
    expect(badUrl.messageKey).toBe('mediamtx.serverBadUrl')

    // persisted: the registry file carries the updated entry
    const reg = JSON.parse(readFileSync(join(host!.home, 'mtxconsole-servers.json'), 'utf8')) as {
      servers: Array<{ name: string; url: string; username?: string; token?: string }>
    }
    const saved = reg.servers.find((s) => s.name === 'rot')
    expect(saved?.url).toBe(apiUrl)
    expect(saved?.username).toBeUndefined()
    expect(saved?.token).toBeUndefined()

    await host!.rpc.call('mediamtx.servers.remove', { name: 'rot' })
  }, 120_000)
})
