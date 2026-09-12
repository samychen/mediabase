// @mediabase/shm — a shared-memory frame RING over SharedArrayBuffer.
//
// Why a ring and not a queue: a live viewer that cannot keep up must LOSE frames,
// not build a backlog (the same policy the WS push transport follows). The ring
// makes that structural — the producer overwrites the oldest slot and counts the
// drop — instead of relying on the transport to notice.
//
// Where it actually removes a copy: the produced bytes land in ONE SharedArrayBuffer
// that producer and consumer both map. A consumer reads a subarray VIEW of that
// buffer (`bytes.buffer === the ring`), so there is no per-frame allocation and no
// copy on the read path — which is what matters between a pump (network, worker)
// and a renderer, and between two Node threads.
//
// What it is NOT: a way to move memory into a browser from another process. A page
// cannot be handed a SharedArrayBuffer over a WebSocket; the page must CREATE one
// (see the cross-origin isolation headers `@mediabase/gateway` can serve) and this ring
// then lets everything inside that page share frames without copies.
//
// Concurrency contract, stated plainly because it is the part callers get wrong:
//   * exactly ONE producer and ONE consumer (SPSC). More than one of either needs
//     external synchronisation.
//   * a view returned by `acquire()` stays valid until the next `acquire()` on the
//     same consumer. Overwrite only happens once the consumer is a full ring behind
//     (`slots`) — by then the drop counter has moved — so copy out if a frame must
//     outlive that.
//   * `Atomics.wait`/`notify` are available for a consumer that blocks instead of
//     polling (`waitForData()`), and are what makes the ring usable from a worker.

/** The control block: 8 Int32 slots at the head of the buffer. */
const CONTROL_INTS = 8
const WRITE_SEQ = 0
const READ_SEQ = 1
const DROPPED = 2
const CLOSED = 3
const SLOTS = 4
const SLOT_BYTES = 5
const NOTIFY_SEQ = 6
const GENERATION = 7

/** Per-slot descriptor: [seq, len]. `seq` marks the slot as published. */
const DESC_INTS_PER_SLOT = 2

export interface RingOptions {
  /** Number of frames the ring holds (power of two is not required; default 4). */
  slots: number
  /** Bytes per frame slot (default 4 MiB — one 1080p RGBA frame fits). */
  slotBytes: number
}

export interface RingStats {
  /** Frames published since creation (they may have been dropped later). */
  published: number
  /** Frames still readable. */
  pending: number
  /** Frames the producer had to drop because the consumer was too far behind. */
  dropped: number
  closed: boolean
  slots: number
  slotBytes: number
  /** Total bytes of shared memory (header + descriptors + payload). */
  bytes: number
}

export interface AcquiredFrame {
  seq: number
  /** ZERO-COPY view into the shared buffer — valid until the next `acquire()`. */
  bytes: Uint8Array
}

/** Total byte length a ring with these options needs. */
export function ringByteLength(options: RingOptions): number {
  assertShape(options)
  return (CONTROL_INTS + options.slots * DESC_INTS_PER_SLOT) * 4 + options.slots * options.slotBytes
}

function assertShape(options: RingOptions): void {
  if (!Number.isInteger(options.slots) || options.slots < 1) {
    throw new Error(`shm ring: slots must be a positive integer (got ${String(options.slots)})`)
  }
  if (!Number.isInteger(options.slotBytes) || options.slotBytes < 1) {
    throw new Error(`shm ring: slotBytes must be a positive integer (got ${String(options.slotBytes)})`)
  }
}

/**
 * A frame ring. Both ends construct it from the SAME SharedArrayBuffer — one side
 * creates it (the page, or the accepting process) and hands the buffer to the other
 * (postMessage, worker `data`, or `structuredClone`), which is the "handle
 * handshake": the buffer IS the handle, and nothing is copied to pass it.
 */
export class SharedRing {
  readonly buffer: SharedArrayBuffer
  readonly slots: number
  readonly slotBytes: number
  private readonly control: Int32Array
  private readonly desc: Int32Array
  private readonly payload: Uint8Array

  private constructor(buffer: SharedArrayBuffer, options: RingOptions) {
    this.buffer = buffer
    this.slots = options.slots
    this.slotBytes = options.slotBytes
    this.control = new Int32Array(buffer, 0, CONTROL_INTS)
    this.desc = new Int32Array(buffer, CONTROL_INTS * 4, options.slots * DESC_INTS_PER_SLOT)
    this.payload = new Uint8Array(buffer, (CONTROL_INTS + options.slots * DESC_INTS_PER_SLOT) * 4)
  }

  /** Create a ring (the side that decides the shape). */
  static create(options: RingOptions): SharedRing {
    const buffer = new SharedArrayBuffer(ringByteLength(options))
    const ring = new SharedRing(buffer, options)
    Atomics.store(ring.control, SLOTS, options.slots)
    Atomics.store(ring.control, SLOT_BYTES, options.slotBytes)
    Atomics.store(ring.control, GENERATION, 1)
    return ring
  }

  /** Attach to an existing buffer, validating it against the expected shape. */
  static attach(buffer: SharedArrayBuffer, options?: Partial<RingOptions>): SharedRing {
    if (buffer.byteLength < (CONTROL_INTS + DESC_INTS_PER_SLOT) * 4) {
      throw new Error('shm ring: buffer is too small to hold a control block')
    }
    const control = new Int32Array(buffer, 0, CONTROL_INTS)
    const slots = Atomics.load(control, SLOTS)
    const slotBytes = Atomics.load(control, SLOT_BYTES)
    if (Atomics.load(control, GENERATION) !== 1) throw new Error('shm ring: buffer is not an initialized ring')
    if (options?.slots !== undefined && options.slots !== slots) {
      throw new Error(`shm ring: shape mismatch — buffer has ${slots} slots, caller expects ${options.slots}`)
    }
    if (options?.slotBytes !== undefined && options.slotBytes !== slotBytes) {
      throw new Error(`shm ring: shape mismatch — buffer has ${slotBytes} bytes/slot, caller expects ${options.slotBytes}`)
    }
    const needed = ringByteLength({ slots, slotBytes })
    if (buffer.byteLength !== needed) {
      throw new Error(`shm ring: buffer is ${buffer.byteLength} bytes, a ${slots}x${slotBytes} ring needs ${needed}`)
    }
    return new SharedRing(buffer, { slots, slotBytes })
  }

  /**
   * Publish one frame. Returns null when the frame does not fit a slot (a caller
   * error: the ring's shape is the contract) and otherwise the assigned seq plus
   * how many frames were dropped to make room.
   */
  publish(bytes: Uint8Array): { seq: number; dropped: number } | null {
    if (bytes.byteLength > this.slotBytes) return null
    const writeSeq = Atomics.load(this.control, WRITE_SEQ)
    let readSeq = Atomics.load(this.control, READ_SEQ)
    let dropped = 0
    // Full: overwrite the OLDEST unread frame (live data beats a backlog) and count it.
    while (writeSeq - readSeq >= this.slots) {
      readSeq++
      dropped++
    }
    const index = writeSeq % this.slots
    const offset = index * this.slotBytes
    this.payload.set(bytes, offset)
    // Publish the length first, then the seq: a consumer treats the slot as readable
    // only once seq matches, so a partially written slot is never observed.
    Atomics.store(this.desc, index * DESC_INTS_PER_SLOT + 1, bytes.byteLength)
    Atomics.store(this.desc, index * DESC_INTS_PER_SLOT, writeSeq)
    Atomics.store(this.control, WRITE_SEQ, writeSeq + 1)
    if (dropped > 0) {
      Atomics.add(this.control, DROPPED, dropped)
      Atomics.store(this.control, READ_SEQ, readSeq)
    }
    Atomics.store(this.control, NOTIFY_SEQ, writeSeq + 1)
    Atomics.notify(this.control, NOTIFY_SEQ)
    return { seq: writeSeq, dropped }
  }

  /**
   * Take the next frame WITHOUT copying: `bytes` is a view into the shared buffer.
   * Call `release()` (or simply the next `acquire()`) when done with it.
   */
  acquire(): AcquiredFrame | null {
    const readSeq = Atomics.load(this.control, READ_SEQ)
    if (readSeq >= Atomics.load(this.control, WRITE_SEQ)) return null
    const index = readSeq % this.slots
    const seq = Atomics.load(this.desc, index * DESC_INTS_PER_SLOT)
    if (seq !== readSeq) {
      // The producer is between "chose the slot" and "published it"; the caller can
      // retry. Never happens when the consumer is behind the writer, which is the
      // normal case, so a single null is the honest answer rather than a spin.
      return null
    }
    const length = Atomics.load(this.desc, index * DESC_INTS_PER_SLOT + 1)
    return { seq, bytes: this.payload.subarray(index * this.slotBytes, index * this.slotBytes + length) }
  }

  /** Mark the frame from the last `acquire()` as consumed. */
  release(): void {
    const readSeq = Atomics.load(this.control, READ_SEQ)
    if (readSeq < Atomics.load(this.control, WRITE_SEQ)) {
      Atomics.store(this.control, READ_SEQ, readSeq + 1)
    }
  }

  /** Acquire + copy out in one step, for a frame that must outlive the next read. */
  takeCopy(): AcquiredFrame | null {
    const frame = this.acquire()
    if (frame === null) return null
    const copy = frame.bytes.slice()
    this.release()
    return { seq: frame.seq, bytes: copy }
  }

  /** The newest frame without consuming it — what a "latest frame" consumer wants. */
  latest(): AcquiredFrame | null {
    const writeSeq = Atomics.load(this.control, WRITE_SEQ)
    if (writeSeq === 0) return null
    const seq = writeSeq - 1
    const index = seq % this.slots
    if (Atomics.load(this.desc, index * DESC_INTS_PER_SLOT) !== seq) return null
    const length = Atomics.load(this.desc, index * DESC_INTS_PER_SLOT + 1)
    return { seq, bytes: this.payload.subarray(index * this.slotBytes, index * this.slotBytes + length) }
  }

  /** Advance past everything currently readable (a consumer that only wants latest). */
  drain(): number {
    const writeSeq = Atomics.load(this.control, WRITE_SEQ)
    const readSeq = Atomics.load(this.control, READ_SEQ)
    if (writeSeq > readSeq) Atomics.store(this.control, READ_SEQ, writeSeq)
    return Math.max(0, writeSeq - readSeq)
  }

  /** True when at least one frame is readable. */
  hasData(): boolean {
    return Atomics.load(this.control, READ_SEQ) < Atomics.load(this.control, WRITE_SEQ)
  }

  /**
   * Block until a frame arrives or the timeout expires.
   *
   * This BLOCKS THE CALLING THREAD: correct in a worker, wrong on a UI thread (it
   * would freeze the page). The ring cannot tell which thread it is on, so the caller
   * decides — the media/UI code polls (`acquire()` on each animation frame) and only
   * an off-main-thread consumer waits.
   */
  waitForData(timeoutMs = 1_000): boolean {
    if (this.hasData()) return true
    // Waiting on NOTIFY_SEQ with its current value as the expectation: the producer
    // bumps it on every publish, so wake-ups are both correct and prompt.
    Atomics.wait(this.control, NOTIFY_SEQ, Atomics.load(this.control, NOTIFY_SEQ), timeoutMs)
    return this.hasData()
  }

  stats(): RingStats {
    const writeSeq = Atomics.load(this.control, WRITE_SEQ)
    const readSeq = Atomics.load(this.control, READ_SEQ)
    return {
      published: writeSeq,
      pending: Math.max(0, writeSeq - readSeq),
      dropped: Atomics.load(this.control, DROPPED),
      closed: Atomics.load(this.control, CLOSED) === 1,
      slots: this.slots,
      slotBytes: this.slotBytes,
      bytes: this.buffer.byteLength,
    }
  }

  /** Tell the other side no more frames are coming (a consumer can stop waiting). */
  close(): void {
    Atomics.store(this.control, CLOSED, 1)
    Atomics.store(this.control, NOTIFY_SEQ, Atomics.load(this.control, NOTIFY_SEQ) + 1)
    Atomics.notify(this.control, NOTIFY_SEQ)
  }

  /**
   * Pass the ring to another thread/worker. The buffer is structured-cloned by
   * reference (SharedArrayBuffer is never copied), which is the whole point.
   */
  toTransferable(): { buffer: SharedArrayBuffer; slots: number; slotBytes: number } {
    return { buffer: this.buffer, slots: this.slots, slotBytes: this.slotBytes }
  }
}

/** The receiving side of `toTransferable()`. */
export function attachRing(handle: { buffer: SharedArrayBuffer; slots?: number; slotBytes?: number }): SharedRing {
  return SharedRing.attach(handle.buffer, {
    ...(handle.slots === undefined ? {} : { slots: handle.slots }),
    ...(handle.slotBytes === undefined ? {} : { slotBytes: handle.slotBytes }),
  })
}
