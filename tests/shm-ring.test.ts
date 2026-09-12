// @mediabase/shm — the frame ring's own contract.
//
// A ring is shared mutable memory, so its tests are about the properties that make
// that safe and about the copy it exists to remove:
//
//   1. a read is a VIEW into the shared buffer (no allocation, no copy) — the whole
//      reason this transport exists;
//   2. a full ring DROPS the oldest frame and counts it (live data beats a backlog);
//   3. wrap-around is exact: sequence numbers stay monotonic across the wrap, and a
//      consumer that falls behind sees the accounting rather than stale data silently;
//   4. the handle handshake passes the buffer by reference (a worker/thread gets the
//      same memory, nothing is serialized);
//   5. a real second thread can consume what the main thread produced (the ring is
//      genuinely shared, not a same-realm illusion).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { attachRing, ringByteLength, SharedRing } from '../packages/base/shm/src/index.ts'
import { ROOT } from './support/host.ts'

const frame = (n: number, size = 8): Uint8Array => {
  const bytes = new Uint8Array(size)
  bytes.fill(n)
  bytes[0] = n
  return bytes
}

describe('@mediabase/shm: zero-copy frame ring', () => {
  it('hands a VIEW of the shared buffer, not a copy', () => {
    const ring = SharedRing.create({ slots: 2, slotBytes: 16 })
    ring.publish(frame(7, 8))
    const got = ring.acquire()!
    // The bytes live in the ring's own buffer: this is the property that removes a
    // per-frame allocation + copy from the read path.
    expect(got.bytes.buffer).toBe(ring.buffer)
    expect(got.bytes.byteLength).toBe(8)
    expect(got.bytes[0]).toBe(7)
    expect(got.seq).toBe(0)
    // Writing through the view is writing the shared memory (proof, not a promise).
    got.bytes[1] = 99
    expect(ring.latest()!.bytes[1]).toBe(99)
    ring.release()
  })

  it('keeps sequence numbers monotonic across wrap-around', () => {
    const ring = SharedRing.create({ slots: 2, slotBytes: 4 })
    for (let i = 0; i < 5; i++) expect(ring.publish(frame(i, 2))!.seq).toBe(i)
    expect(ring.stats()).toMatchObject({ published: 5, pending: 2, slots: 2 })
    // Only the last two survive (the ring holds 2), and they are the NEWEST two.
    expect(ring.acquire()!.seq).toBe(3)
    ring.release()
    expect(ring.acquire()!.seq).toBe(4)
    ring.release()
    expect(ring.acquire()).toBeNull()
  })

  it('drops the OLDEST frame when full, and counts the drop', () => {
    const ring = SharedRing.create({ slots: 2, slotBytes: 4 })
    ring.publish(frame(1, 2))
    ring.publish(frame(2, 2))
    const third = ring.publish(frame(3, 2))!
    expect(third).toMatchObject({ seq: 2, dropped: 1 })
    expect(ring.stats().dropped).toBe(1)
    // A viewer that could not keep up gets the live frame, not a backlog.
    expect(ring.acquire()!.bytes[0]).toBe(2)
    ring.release()
    expect(ring.acquire()!.bytes[0]).toBe(3)
  })

  it('refuses a frame that cannot fit a slot instead of truncating it', () => {
    const ring = SharedRing.create({ slots: 1, slotBytes: 4 })
    expect(ring.publish(frame(1, 5))).toBeNull()
    expect(ring.stats().published).toBe(0)
  })

  it('takes a copy only when asked, for a frame that must outlive the next read', () => {
    const ring = SharedRing.create({ slots: 2, slotBytes: 4 })
    ring.publish(frame(1, 2))
    const copy = ring.takeCopy()!
    expect(copy.bytes.buffer).not.toBe(ring.buffer)
    ring.publish(frame(2, 2))
    expect(copy.bytes[0]).toBe(1) // untouched by later frames
    expect(ring.stats().pending).toBe(1)
  })

  it('validates the handle it is given', () => {
    const ring = SharedRing.create({ slots: 2, slotBytes: 8 })
    // The handshake passes { buffer, slots, slotBytes }; a mismatch must be loud,
    // because a wrong shape would read someone else's bytes.
    expect(attachRing(ring.toTransferable()).stats()).toMatchObject({ slots: 2, slotBytes: 8, bytes: ringByteLength({ slots: 2, slotBytes: 8 }) })
    expect(() => SharedRing.attach(ring.buffer, { slots: 4 })).toThrow(/shape mismatch/)
    expect(() => SharedRing.attach(new SharedArrayBuffer(16))).toThrow(/too small|not an initialized ring/)
    expect(() => SharedRing.attach(new SharedArrayBuffer(ringByteLength({ slots: 2, slotBytes: 8 })))).toThrow(/not an initialized ring/)
  })

  it('close() wakes a waiting consumer instead of leaving it blocked', () => {
    const ring = SharedRing.create({ slots: 1, slotBytes: 4 })
    const other = attachRing(ring.toTransferable())
    const started = Date.now()
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const control = new Int32Array(workerData.buffer, 0, 8)
      const NOTIFY_SEQ = 6
      const result = Atomics.wait(control, NOTIFY_SEQ, Atomics.load(control, NOTIFY_SEQ), 5000)
      parentPort.postMessage(result)
    `, { eval: true, workerData: { buffer: ring.buffer } })
    const woke = new Promise<string>((resolve) => worker.on('message', (m: string) => resolve(m)))
    setTimeout(() => other.close(), 50)
    return woke.then(async (result) => {
      await worker.terminate()
      expect(result).toBe('ok')
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(ring.stats().closed).toBe(true)
    })
  }, 20_000)

  it('is genuinely shared: a worker consumes what this thread produced', async () => {
    const ring = SharedRing.create({ slots: 4, slotBytes: 16 })
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const WRITE_SEQ = 0, READ_SEQ = 1, SLOTS = 4, CTRL = 8
      const control = new Int32Array(workerData.buffer, 0, CTRL)
      const slots = Atomics.load(control, SLOTS)
      const desc = new Int32Array(workerData.buffer, CTRL * 4, slots * 2)
      const payload = new Uint8Array(workerData.buffer, (CTRL + slots * 2) * 4)
      const slotBytes = workerData.slotBytes
      const seen = []
      const deadline = Date.now() + 4000
      while (seen.length < 3 && Date.now() < deadline) {
        const read = Atomics.load(control, READ_SEQ)
        const write = Atomics.load(control, WRITE_SEQ)
        if (read >= write) { Atomics.wait(control, 6, Atomics.load(control, 6), 100); continue }
        const index = read % slots
        if (Atomics.load(desc, index * 2) !== read) continue
        const len = Atomics.load(desc, index * 2 + 1)
        seen.push(Array.from(payload.subarray(index * slotBytes, index * slotBytes + len)))
        Atomics.store(control, READ_SEQ, read + 1)
      }
      parentPort.postMessage(seen)
    `, { eval: true, workerData: { buffer: ring.buffer, slotBytes: ring.slotBytes } })
    const consumed = new Promise<number[][]>((resolve) => worker.on('message', (m: number[][]) => resolve(m)))

    for (const n of [1, 2, 3]) {
      ring.publish(frame(n, 4))
      await new Promise((r) => setTimeout(r, 30))
    }
    const seen = await consumed
    await worker.terminate()
    expect(seen).toEqual([[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]])
    // The worker advanced the consumer index in the SAME memory this thread reads.
    expect(ring.stats()).toMatchObject({ published: 3, pending: 0, dropped: 0 })
  }, 20_000)

  it('stays isomorphic: the ring is imported by a CLIENT package, so no Node builtin', () => {
    // `@mediabase/connection` imports this package, which means it ends up in the browser
    // bundle: a `node:` import here would break the bundle (and a Node Buffer would
    // break the page). The tests may use Node; the package may not.
    const source = readFileSync(join(ROOT, 'packages/base/shm/src/index.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+['"]node:/)
    expect(source).not.toMatch(/\brequire\(/)
    expect(source).not.toMatch(/\bBuffer\b/)
    // SharedArrayBuffer + Atomics are the whole dependency surface, by design.
    expect(source).toContain('SharedArrayBuffer')
    expect(source).toContain('Atomics')
  })

  it('reports its accounting in one place (what a status card shows)', () => {
    const ring = SharedRing.create({ slots: 2, slotBytes: 8 })
    ring.publish(frame(1, 4))
    ring.publish(frame(2, 4))
    ring.publish(frame(3, 4))
    expect(ring.stats()).toEqual({
      published: 3,
      pending: 2,
      dropped: 1,
      closed: false,
      slots: 2,
      slotBytes: 8,
      bytes: ringByteLength({ slots: 2, slotBytes: 8 }),
    })
    expect(ring.drain()).toBe(2)
    expect(ring.stats().pending).toBe(0)
  })
})
