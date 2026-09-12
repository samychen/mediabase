// The frame ring as a data-plane transport: gateway → client ring, zero-copy reads.
//
// `@mediabase/shm` is unit-tested on its own; what these tests add is the seam that makes
// it a TRANSPORT rather than a data structure:
//
//   1. frames published by the gateway's stream channel land in the client's ring, and
//      a reader gets a VIEW of that memory (no per-frame allocation on the read path);
//   2. the ring sheds frames when the reader falls behind, and the accounting a UI
//      shows comes from BOTH ends (host backpressure + ring overflow);
//   3. the browser prerequisite is served, not assumed: `crossOriginIsolation` puts
//      COOP/COEP on every response, and is off unless asked for (it breaks embedding
//      cross-origin subresources);
//   4. a ring shared with a worker is usable for real (the UI thread publishes nothing,
//      the worker reads the same memory).

import { Worker } from 'node:worker_threads'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGateway, type Gateway } from '../packages/base/gateway/src/index.ts'
import { openRingStream, ringSupported } from '../packages/client/connection/src/ring.ts'
import { SharedRing, attachRing } from '../packages/base/shm/src/index.ts'
import { waitFor } from './support/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function dist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mediabase-ring-dist-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">shell</div>')
  return dir
}

/** A gateway whose `frames` channel publishes on demand (no media involved). */
async function gatewayWithFrames(options: { frames?: number; crossOriginIsolation?: boolean } = {}): Promise<{ g: Gateway; publish: (n: number) => void; attachCount: () => number }> {
  let sink: { send(meta: Record<string, unknown>, body: Uint8Array): boolean } | null = null
  let attachments = 0
  const g = createGateway({
    host: '127.0.0.1',
    port: 0,
    distIndex: join(dist(), 'index.html'),
    methods: {},
    ...(options.crossOriginIsolation === true ? { crossOriginIsolation: true } : {}),
    streams: {
      frames: {
        name: 'frames',
        attach(next) {
          attachments++
          sink = next
          return () => { sink = null }
        },
      },
    },
  })
  await g.ready()
  cleanups.push(() => g.close({ drainMs: 200 }))
  void options
  return {
    g,
    publish: (n: number) => {
      const body = new Uint8Array([n, n, n, n])
      sink?.send({ channel: 'frames' }, body)
    },
    attachCount: () => attachments,
  }
}

const frameValue = (bytes: Uint8Array): number => bytes[0] ?? -1

describe('the frame ring as a client transport', () => {
  it('receives pushed frames as VIEWS into shared memory (no per-frame allocation)', async () => {
    const { g, publish, attachCount } = await gatewayWithFrames()
    const stream = openRingStream('frames', {
      url: `ws://127.0.0.1:${g.port()}/stream`,
      slots: 4,
      slotBytes: 64,
      retryMs: 0,
    })
    cleanups.push(() => stream.close())

    await waitFor(() => attachCount() > 0, 4_000)
    publish(1)
    await waitFor(() => stream.latest() !== null, 4_000)

    const frame = stream.latest()!
    // THE property: the reader's bytes live in the ring's buffer, so rendering does not
    // pay for a copy and the GC does not see a new multi-megabyte allocation per frame.
    expect(frame.bytes.buffer).toBe(stream.ring.buffer)
    expect(frameValue(frame.bytes)).toBe(1)
    expect(stream.meta()?.channel).toBe('frames')

    publish(2)
    await waitFor(() => frameValue(stream.latest()?.bytes ?? new Uint8Array([0])) === 2, 4_000)
    // In-order consumption still works for a caller that wants every frame.
    const first = stream.acquire()!
    expect(frameValue(first.bytes)).toBe(1)
    stream.release()
    const second = stream.acquire()!
    expect(frameValue(second.bytes)).toBe(2)
    stream.release()
    expect(stream.acquire()).toBeNull()
    expect(stream.dropped()).toBe(0)
  }, 30_000)

  it('sheds frames when the reader falls behind and counts both ends', async () => {
    const { g, publish, attachCount } = await gatewayWithFrames()
    const stream = openRingStream('frames', {
      url: `ws://127.0.0.1:${g.port()}/stream`,
      slots: 2,
      slotBytes: 64,
      retryMs: 0,
    })
    cleanups.push(() => stream.close())
    await waitFor(() => attachCount() > 0, 4_000)

    // Publish more frames than the ring holds, without ever reading: live data must win.
    for (let i = 1; i <= 5; i++) {
      publish(i)
      await new Promise((r) => setTimeout(r, 20))
    }
    await waitFor(() => stream.dropped() >= 3, 4_000)
    expect(stream.ring.stats()).toMatchObject({ dropped: 3, slots: 2 })
    // The survivor is the NEWEST frame, not the oldest queued one.
    expect(frameValue(stream.latest()!.bytes)).toBe(5)
  }, 30_000)

  it('serves the browser prerequisite only when asked (COOP/COEP)', async () => {
    const plain = await gatewayWithFrames()
    const plainRes = await fetch(`http://127.0.0.1:${plain.g.port()}/`)
    expect(plainRes.headers.get('cross-origin-opener-policy')).toBeNull()

    const isolated = await gatewayWithFrames({ crossOriginIsolation: true })
    for (const path of ['/', '/api/health']) {
      const res = await fetch(`http://127.0.0.1:${isolated.g.port()}${path}`)
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    }
  }, 30_000)

  it('is readable from a worker through the same memory (the reason to share it)', async () => {
    const ring = SharedRing.create({ slots: 4, slotBytes: 32 })
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const CTRL = 8, WRITE = 0, READ = 1, NOTIFY = 6
      const control = new Int32Array(workerData.buffer, 0, CTRL)
      const slots = Atomics.load(control, 4)
      const desc = new Int32Array(workerData.buffer, CTRL * 4, slots * 2)
      const payload = new Uint8Array(workerData.buffer, (CTRL + slots * 2) * 4)
      const seen = []
      const deadline = Date.now() + 4000
      while (seen.length < 2 && Date.now() < deadline) {
        const read = Atomics.load(control, READ)
        if (read >= Atomics.load(control, WRITE)) { Atomics.wait(control, NOTIFY, Atomics.load(control, NOTIFY), 100); continue }
        const index = read % slots
        if (Atomics.load(desc, index * 2) !== read) continue
        const len = Atomics.load(desc, index * 2 + 1)
        // A zero-copy view INSIDE the worker: the same bytes this thread wrote.
        seen.push(payload.subarray(index * workerData.slotBytes, index * workerData.slotBytes + len)[0])
        Atomics.store(control, READ, read + 1)
      }
      parentPort.postMessage(seen)
    `, { eval: true, workerData: { buffer: ring.buffer, slotBytes: ring.slotBytes } })
    const consumed = new Promise<number[]>((resolve) => worker.on('message', (m: number[]) => resolve(m)))
    ring.publish(new Uint8Array([11]))
    ring.publish(new Uint8Array([22]))
    expect(await consumed).toEqual([11, 22])
    await worker.terminate()
    // The handshake is by reference: attach() sees the SAME buffer, no serialization.
    expect(attachRing(ring.toTransferable()).buffer).toBe(ring.buffer)
    expect(ringSupported()).toBe(true)
  }, 30_000)
})
