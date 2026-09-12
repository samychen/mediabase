// @mediabase/connection / ring.ts — the frame ring as a CLIENT-SIDE sink.
//
// The push stream hands over one freshly allocated payload per frame, which a
// renderer then reads once. A ring changes that shape: the payload is published into
// shared memory the UI (or a worker) reads through a VIEW, so a 60 fps monitor stops
// allocating a multi-megabyte buffer per frame and stops copying it across threads.
//
// It does NOT remove the network copy — bytes arrive over WS or HTTP and must land
// somewhere. What it removes is everything after that first landing, which is the part
// a UI pays for every frame. Stated here because "zero copy" is otherwise a claim
// nobody can check.
//
// Browser prerequisite: `SharedArrayBuffer` needs a cross-origin-isolated document
// (COOP/COEP). `@mediabase/gateway` can serve those headers (`crossOriginIsolation`);
// this module reports the failure as `permanently-unavailable` behaviour (a ring that
// cannot be created means the caller must fall back to the plain per-frame sink)
// instead of throwing somewhere deep in a render loop.

import { SharedRing, type AcquiredFrame, type RingOptions } from '@mediabase/shm'
import { openStream, type StreamFrameMeta, type StreamHandle, type StreamStatus } from './stream.ts'

export interface RingStreamOptions extends Partial<RingOptions> {
  /** Absolute ws(s) URL of the stream endpoint. */
  url: string
  /**
   * Reuse an existing ring instead of creating one — what a caller does when the
   * ring is already shared with a worker (then `slots`/`slotBytes` are taken from it).
   */
  ring?: SharedRing
  /** Reconnect delay in ms (default 1000); 0 disables reconnecting. */
  retryMs?: number
  /** Called when the ring sheds a frame because the reader fell behind. */
  onDropped?(channel: string, count: number): void
}

export interface RingStream {
  readonly ring: SharedRing
  /** Newest frame as a zero-copy view, or null when none has arrived. */
  latest(): AcquiredFrame | null
  /** Take frames in order from where the reader left off. */
  acquire(): AcquiredFrame | null
  /** Mark the last `acquire()`ed frame consumed. */
  release(): void
  /** Host-reported drops plus ring-shed frames. */
  dropped(): number
  status(): StreamStatus
  /** Metadata of the newest frame (width/height/pts …), for a UI label. */
  meta(): StreamFrameMeta | null
  close(): void
}

/**
 * Subscribe to a channel and publish every frame into `ring`.
 *
 * The ring is created by the CALLER when it must be shared with a worker (create it,
 * then pass `ring.toTransferable()` to the worker); pass `options` instead for the
 * simple same-thread case.
 */
export function openRingStream(channel: string, options: RingStreamOptions): RingStream {
  const ring = options.ring ?? createRing(options)
  let hostDropped = 0
  let meta: StreamFrameMeta | null = null
  const streamHandlers = {
    onFrame(next: StreamFrameMeta, body: Uint8Array): void {
      const result = ring.publish(body)
      // A frame that cannot fit a slot is a shape mismatch between the channel and the
      // ring, not backpressure: count it as dropped rather than pretending it arrived.
      if (result === null) {
        hostDropped++
        options.onDropped?.(next.channel, 1)
        return
      }
      meta = next
      if (result.dropped > 0) options.onDropped?.(next.channel, result.dropped)
    },
    onDropped(_channel: string, count: number): void {
      hostDropped += count
      options.onDropped?.(channel, count)
    },
  }
  const handle: StreamHandle = openStream(channel, streamHandlers, {
    url: options.url,
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
  })

  return {
    ring,
    latest: () => ring.latest(),
    acquire: () => ring.acquire(),
    release: () => ring.release(),
    dropped: () => hostDropped + ring.stats().dropped,
    status: () => handle.status(),
    meta: () => meta,
    close: () => {
      handle.close()
      ring.close()
    },
  }
}

/** Create the ring for this stream, refusing a half-specified shape loudly. */
function createRing(options: RingStreamOptions): SharedRing {
  if (options.slots === undefined || options.slotBytes === undefined) {
    throw new Error('openRingStream: pass both slots and slotBytes, or an existing `ring`')
  }
  return SharedRing.create({ slots: options.slots, slotBytes: options.slotBytes })
}

/**
 * True when this environment can create shared memory at all. A browser needs
 * cross-origin isolation; Node always can. The caller uses this to choose the ring or
 * the plain per-frame sink BEFORE allocating anything.
 */
export function ringSupported(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false
  try {
    // Some browsers expose the constructor but refuse the allocation.
    void new SharedArrayBuffer(8)
    return true
  } catch {
    return false
  }
}
