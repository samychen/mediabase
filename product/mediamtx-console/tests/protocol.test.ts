// The protocol package is the clean-room heart of the product: normalization
// adapters, endpoint derivation, and the Prometheus parser. These unit tests
// pin the shapes OBSERVED against a real MediaMTX v1.21 (fixtures are verbatim
// wire captures, trimmed), so an accidental adapter regression shows up here
// instead of as a blank panel.

import { describe, expect, it } from 'vitest'
import {
  SESSION_LIST_ROUTE,
  addressToUrl,
  classifyUpstream,
  parseMetrics,
  parsePlaybackList,
  rewriteOrigin,
  toPathRow,
  toRecordingRow,
  toSessionRow,
} from '../packages/protocol/src/index.ts'

// A verbatim runtime-path row captured from /v3/paths/list on v1.21.1.
const LIVE_PATH_ROW = {
  name: 'cam1',
  confName: 'cam1',
  ready: true,
  readyTime: '2026-09-25T10:00:00Z',
  available: true,
  availableTime: '2026-09-25T10:00:00Z',
  online: true,
  onlineTime: '2026-09-25T10:00:00Z',
  source: 'rtsp://camera.local/stream1',
  sourceType: 'rtspSession',
  tracks: [null, null],
  tracks2: [
    { type: 'video', codec: 'H264', id: 'videoH264' },
    { type: 'audio', codec: 'MPEG4-Audio', id: 'audioMPEG4' },
  ],
  readers: [{ type: 'webRTCSession', id: 'abc' }],
  inboundBytes: 1234,
  outboundBytes: 5678,
  inboundFramesInError: 0,
  bytesReceived: 1234,
  bytesSent: 5678,
}

describe('toPathRow', () => {
  it('normalizes a live v1.21 row', () => {
    const row = toPathRow(LIVE_PATH_ROW, { record: true })
    expect(row).toEqual({
      name: 'cam1',
      confName: 'cam1',
      ready: true,
      source: 'rtsp://camera.local/stream1',
      sourceType: 'rtspSession',
      readers: 1,
      inboundBytes: 1234,
      outboundBytes: 5678,
      tracks: [
        { type: 'video', codec: 'H264', id: 'videoH264' },
        { type: 'audio', codec: 'MPEG4-Audio', id: 'audioMPEG4' },
      ],
      record: true,
    })
  })

  it('degrades an idle row without tracks', () => {
    const row = toPathRow({ name: 'cam2', confName: 'cam2', ready: false, source: null, tracks: [], tracks2: [], readers: [] }, { record: false })
    expect(row).toMatchObject({ ready: false, source: null, tracks: [], readers: 0 })
  })

  it('refuses garbage instead of throwing', () => {
    expect(toPathRow(null, { record: false })).toBeNull()
    expect(toPathRow('cam', { record: false })).toBeNull()
    expect(toPathRow({ confName: 'no-name' }, { record: false })).toBeNull()
  })

  it('falls back to the CONFIG source while the static source is not connected', () => {
    // Observed live: a configured-but-unreachable rtsp camera reports a null
    // runtime source; the operator must still see the URL they configured.
    const row = toPathRow({ name: 'cam3', ready: false, source: null, readers: [] }, { record: false, source: 'rtsp://127.0.0.1:1554/none' })
    expect(row?.source).toBe('rtsp://127.0.0.1:1554/none')
    // 'publisher' is the wait-for-push default — a state, not an address.
    const pub = toPathRow({ name: 'cam4', ready: false, source: null, readers: [] }, { record: false, source: 'publisher' })
    expect(pub?.source).toBeNull()
    // Once the runtime source connects it wins over the config.
    const live = toPathRow({ name: 'cam5', ready: true, source: 'rtspSession#1', readers: [] }, { record: false, source: 'rtsp://x' })
    expect(live?.source).toBe('rtspSession#1')
  })
})

describe('toSessionRow', () => {
  it('normalizes a webrtc session', () => {
    const row = toSessionRow('webrtc', {
      id: '6f9d1c2e-0000-1111-2222-333344445555',
      created: '2026-09-25T10:00:00Z',
      remoteAddr: '192.168.1.5:54321',
      path: 'cam1',
      bytesSent: 42,
    })
    expect(row).toMatchObject({ kind: 'webrtc', path: 'cam1', bytes: 42, kickable: true })
  })

  it('marks rtmp not kickable and refuses id-less rows', () => {
    expect(toSessionRow('rtmp', { id: 'x', created: '', remoteAddr: '' })?.kickable).toBe(false)
    expect(toSessionRow('rtmp', { created: '' })).toBeNull()
  })
})

describe('addressToUrl', () => {
  it('borrows the API hostname for bare-port addresses', () => {
    expect(addressToUrl(':8889', 'http://127.0.0.1:9997')).toBe('http://127.0.0.1:8889')
    expect(addressToUrl(':8554', 'http://mtx.example.com:9997', 'rtsp')).toBe('rtsp://mtx.example.com:8554')
  })

  it('passes through explicit hosts and full URLs', () => {
    expect(addressToUrl('192.168.1.9:8888', 'http://127.0.0.1:9997')).toBe('http://192.168.1.9:8888')
    expect(addressToUrl('https://cdn.example/hls', 'http://x')).toBe('https://cdn.example/hls')
  })

  it('maps disable/empty/undefined to null', () => {
    expect(addressToUrl('disable', 'http://x')).toBeNull()
    expect(addressToUrl('', 'http://x')).toBeNull()
    expect(addressToUrl(undefined, 'http://x')).toBeNull()
  })
})

describe('parseMetrics', () => {
  // Verbatim (trimmed) capture of a two-path server's /metrics.
  const TEXT = [
    '# HELP paths_paths number of paths',
    '# TYPE paths_paths gauge',
    'paths{name="cam1",state="ready"} 1',
    'paths{name="cam2",state="notReady"} 1',
    'paths_readers{name="cam1",readerType="",state="ready"} 2',
    'paths_readers{name="cam2",readerType="",state="notReady"} 0',
    'paths_inbound_bytes{name="cam1",state="ready"} 1048576',
    'paths_outbound_bytes{name="cam1",state="ready"} 2097152',
    'paths_inbound_bytes{name="cam2",state="notReady"} 0',
    'paths_outbound_bytes{name="cam2",state="notReady"} 0',
    'some_unrelated_metric 42',
    'garbage line without braces',
    '',
  ].join('\n')

  it('summarizes the path families and ignores the rest', () => {
    const summary = parseMetrics(TEXT)
    expect(summary.pathsReady).toBe(1)
    expect(summary.pathsNotReady).toBe(1)
    expect(summary.totalReaders).toBe(2)
    expect(summary.perPath).toHaveLength(2)
    const cam1 = summary.perPath.find((p) => p.name === 'cam1')
    expect(cam1).toEqual({ name: 'cam1', state: 'ready', readers: 2, inboundBytes: 1048576, outboundBytes: 2097152 })
  })

  it('handles an empty exposition', () => {
    expect(parseMetrics('')).toEqual({ pathsReady: 0, pathsNotReady: 0, totalReaders: 0, perPath: [] })
  })
})

describe('toRecordingRow', () => {
  it('normalizes days and refuses garbage', () => {
    const row = toRecordingRow({ name: 'cam1', days: [{ day: '2026-09-25', duration: 3600, size: 1024, segments: 12 }] })
    expect(row).toEqual({ name: 'cam1', days: [{ day: '2026-09-25', duration: 3600, size: 1024, segments: 12 }] })
    expect(toRecordingRow({})).toBeNull()
  })
})

describe('classifyUpstream', () => {
  it('maps statuses to kinds and lifts the upstream error text', () => {
    expect(classifyUpstream(404, { status: 'error', error: 'path not found' })).toEqual({ kind: 'not_found', detail: 'path not found' })
    expect(classifyUpstream(400, { status: 'error', error: 'path already exists' })).toEqual({ kind: 'invalid', detail: 'path already exists' })
    expect(classifyUpstream(401, {}).kind).toBe('unavailable')
    expect(classifyUpstream(500, null)).toEqual({ kind: 'conflict', detail: 'HTTP 500' })
  })
})

describe('session routes', () => {
  it('every kind has a list route; kick routes are null exactly where upstream cannot kick', () => {
    for (const kind of Object.keys(SESSION_LIST_ROUTE)) {
      expect(SESSION_LIST_ROUTE[kind as keyof typeof SESSION_LIST_ROUTE]).toMatch(/^\/v3\//)
    }
  })
})

describe('parsePlaybackList', () => {
  // Verbatim from a live v1.21.1 playback server: a TOP-LEVEL array whose
  // durations are float seconds and whose URLs carry the server's own Host.
  const LIVE_LIST = [
    {
      start: '2026-09-26T04:49:51.370862Z',
      duration: 9.978,
      url: 'http://127.0.0.1:9996/get?duration=9.978&path=cam1&start=2026-09-26T04%3A49%3A51.370862Z',
    },
  ]

  it('parses the live top-level-array shape', () => {
    expect(parsePlaybackList(LIVE_LIST)).toEqual([
      {
        startIso: '2026-09-26T04:49:51.370862Z',
        durationSeconds: 9.978,
        url: LIVE_LIST[0]!.url,
      },
    ])
  })

  it('tolerates a wrapped list, skips malformed entries, defaults odd durations', () => {
    expect(parsePlaybackList({ items: LIVE_LIST })).toHaveLength(1)
    expect(parsePlaybackList([null, 7, { duration: 1 }, { start: 'x' }])).toEqual([
      { startIso: 'x', durationSeconds: 0, url: '' },
    ])
    expect(parsePlaybackList('nope')).toEqual([])
    expect(parsePlaybackList(null)).toEqual([])
  })
})

describe('rewriteOrigin', () => {
  it('swaps scheme+host and keeps path and query', () => {
    expect(rewriteOrigin('http://10.9.8.7:9996/get?a=1&b=2', 'https://cam.example:9443')).toBe(
      'https://cam.example:9443/get?a=1&b=2',
    )
  })

  it('returns null on unparseable input instead of throwing', () => {
    expect(rewriteOrigin('not a url', 'http://x')).toBeNull()
    expect(rewriteOrigin('http://x/y', 'also not a url')).toBeNull()
  })
})
