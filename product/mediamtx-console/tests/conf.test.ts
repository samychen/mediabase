// The global-config panel's pure half (conf.ts) and the store actions behind
// it. The panel renders ALL ~122 upstream keys — so the grouping must never
// drop one, the draft must never contain a composite value, and the diff must
// send ONLY what the operator actually changed (a subset patch reboots
// listeners; sending untouched keys would be reckless).

import { describe, expect, it } from 'vitest'
import {
  configDiff,
  fieldKind,
  groupConfig,
  seedDraft,
} from '../packages/client/console/src/conf.ts'
import { createConsoleStore } from '../packages/client/console/src/store.ts'

// A representative slice of the real v1.21 global config (key NAMES verbatim,
// values trimmed): every prefix family the grouper claims, plus composites.
const CONFIG: Record<string, unknown> = {
  logLevel: 'info',
  logDestinations: ['stdout'],
  api: true,
  apiAddress: '127.0.0.1:9997',
  metrics: false,
  metricsAddress: '127.0.0.1:9998',
  playback: true,
  playbackAddress: '127.0.0.1:9996',
  rtsp: true,
  rtspAddress: ':8554',
  rtspsAddress: ':8322',
  rtmp: true,
  rtmpAddress: ':1935',
  hls: true,
  hlsAddress: ':8888',
  hlsAllowOrigin: '*',
  webrtc: true,
  webrtcAddress: ':8889',
  srt: true,
  srtAddress: ':8890',
  record: false,
  recordPath: './recordings/%path/%Y-%m-%d_%H-%M-%S',
  recordFormat: 'fmp4',
  recordSegmentDuration: 3600,
  recordDeleteAfter: 24,
  authMethod: 'internal',
  authBasicUsers: null,
  authInternalUsers: [{ user: 'any', permissions: [{ action: 'publish' }] }],
  pathDefaults: { source: '', record: false },
  sessionTimeout: 10,
  udpReadBufferSize: null,
}

function fakeRpc(handlers: Record<string, (params: never) => Promise<unknown>>) {
  return {
    call: async (method: string, params: never): Promise<unknown> => {
      const h = handlers[method]
      if (h === undefined) throw new Error(`unexpected rpc: ${method}`)
      return h(params)
    },
  } as never
}

describe('field kinds', () => {
  it('classifies by JSON type, with null as an (empty) string', () => {
    expect(fieldKind(true)).toBe('bool')
    expect(fieldKind(8888)).toBe('number')
    expect(fieldKind('info')).toBe('string')
    expect(fieldKind(null)).toBe('string')
    expect(fieldKind([])).toBe('complex')
    expect(fieldKind({})).toBe('complex')
  })
})

describe('grouping the flat config', () => {
  it('buckets keys by prefix and never drops one', () => {
    const groups = groupConfig(CONFIG)
    const seen = groups.flatMap((g) => g.fields.map((f) => f.key))
    expect(seen.slice().sort()).toEqual(Object.keys(CONFIG).sort())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('routes the known families and keeps display order stable', () => {
    const groups = groupConfig(CONFIG)
    const byName = new Map(groups.map((g) => [g.group, g.fields.map((f) => f.key)]))
    expect(byName.get('rtsp')).toContain('rtspAddress')
    expect(byName.get('rtsp')).toContain('rtspsAddress')
    expect(byName.get('servers')).toContain('apiAddress')
    expect(byName.get('servers')).toContain('playbackAddress')
    expect(byName.get('record')).toContain('recordPath')
    expect(byName.get('auth')).toContain('authMethod')
    expect(byName.get('paths')).toContain('pathDefaults')
    expect(byName.get('general')).toContain('logLevel')
    expect(byName.get('general')).toContain('sessionTimeout')
    const order = groups.map((g) => g.group)
    expect(order.indexOf('general')).toBeLessThan(order.indexOf('rtsp'))
    expect(order.indexOf('rtsp')).toBeLessThan(order.indexOf('record'))
  })

  it('puts an unknown key in "other" instead of hiding it', () => {
    const groups = groupConfig({ zzzBrandNewKey: 'x' })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.group).toBe('other')
  })

  it('marks composite values complex — read-only in the form', () => {
    const groups = groupConfig(CONFIG)
    const fields = groups.flatMap((g) => g.fields)
    expect(fields.find((f) => f.key === 'pathDefaults')!.kind).toBe('complex')
    expect(fields.find((f) => f.key === 'authInternalUsers')!.kind).toBe('complex')
    expect(fields.find((f) => f.key === 'logDestinations')!.kind).toBe('complex')
  })
})

describe('draft seeding and diffing', () => {
  it('seeds scalars only, with null as the empty string', () => {
    const draft = seedDraft(CONFIG)
    expect(draft.logLevel).toBe('info')
    expect(draft.recordSegmentDuration).toBe(3600)
    expect(draft.api).toBe(true)
    expect(draft.udpReadBufferSize).toBe('') // null → ''
    expect('pathDefaults' in draft).toBe(false)
    expect('authInternalUsers' in draft).toBe(false)
    expect('logDestinations' in draft).toBe(false)
  })

  it('an untouched draft diffs to NOTHING', () => {
    expect(configDiff(CONFIG, seedDraft(CONFIG))).toEqual({})
  })

  it('sends only the changed keys, with their drafted types', () => {
    const draft = seedDraft(CONFIG)
    draft.logLevel = 'debug'
    draft.recordSegmentDuration = 600
    draft.metrics = true
    expect(configDiff(CONFIG, draft)).toEqual({
      logLevel: 'debug',
      recordSegmentDuration: 600,
      metrics: true,
    })
  })

  it('treats an emptied number field (NaN) and a null-left-empty string as untouched', () => {
    const draft = seedDraft(CONFIG)
    draft.recordSegmentDuration = Number.NaN
    expect(configDiff(CONFIG, draft)).toEqual({})
    // udpReadBufferSize was null → seeded as ''; leaving it '' changes nothing,
    // typing a value does.
    expect(configDiff(CONFIG, draft)).toEqual({})
    draft.udpReadBufferSize = '4096'
    expect(configDiff(CONFIG, draft)).toEqual({ udpReadBufferSize: '4096' })
  })

  it('ignores draft keys the loaded config does not have', () => {
    const draft = seedDraft(CONFIG)
    draft.ghostKey = 'boo'
    expect(configDiff(CONFIG, draft)).toEqual({})
  })
})

describe('the store’s config actions', () => {
  it('loads the flat config into the snapshot', async () => {
    const store = createConsoleStore(fakeRpc({
      'mediamtx.config.global.get': async () => ({ config: CONFIG }),
    }))
    expect(store.get().cfg).toBeNull()
    await store.loadGlobalConfig()
    expect(store.get().cfg).toEqual(CONFIG)
    expect(store.get().cfgLoading).toBe(false)
    expect(store.get().cfgError).toBeNull()
  })

  it('surfaces a failed load as cfgError, not a blank panel', async () => {
    const store = createConsoleStore(fakeRpc({
      'mediamtx.config.global.get': async () => { throw new Error('MediaMTX unreachable at http://127.0.0.1:9') },
    }))
    await store.loadGlobalConfig()
    expect(store.get().cfg).toBeNull()
    expect(store.get().cfgError).toContain('unreachable')
    expect(store.get().cfgLoading).toBe(false)
  })

  it('patches with ONLY the given values, then re-reads the server’s truth', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    let served: Record<string, unknown> = CONFIG
    const store = createConsoleStore(fakeRpc({
      'mediamtx.config.global.get': async () => {
        calls.push({ method: 'get', params: null })
        return { config: served }
      },
      'mediamtx.config.global.patch': async (params) => {
        calls.push({ method: 'patch', params })
        served = { ...served, logLevel: 'debug' } // the server normalizes
        return { ok: true }
      },
    }))
    await store.patchGlobalConfig({ logLevel: 'debug' })
    expect(calls).toEqual([
      { method: 'patch', params: { values: { logLevel: 'debug' } } },
      { method: 'get', params: null },
    ])
    expect(store.get().cfgSaving).toBe(false)
    // The re-read replaced the snapshot with what the server now says.
    expect(store.get().cfg?.logLevel).toBe('debug')
  })

  it('a failed patch sets cfgError, clears saving, and rethrows for the panel', async () => {
    const store = createConsoleStore(fakeRpc({
      'mediamtx.config.global.get': async () => ({ config: CONFIG }),
      'mediamtx.config.global.patch': async () => { throw new Error('MediaMTX: 400 bad') },
    }))
    await expect(store.patchGlobalConfig({ logLevel: 'nope' })).rejects.toThrow()
    expect(store.get().cfgSaving).toBe(false)
    expect(store.get().cfgError).toContain('400')
  })
})
