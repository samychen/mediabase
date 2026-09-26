// mse.ts — dependency-free playback of MediaMTX's recording windows.
//
// The playback server streams `ftyp + moov + (moof mdat)*` (fMP4, verified
// against v1.21.1). `<video src>` cannot play that progressively — it has no
// Range support and the MP4 muxer puts `moov` last — so this feeds the stream
// to Media Source Extensions instead. Zero dependencies, like whep.ts.
//
// Two pieces:
//   fmp4CodecString — parses the init segment (ISO-BMFF boxes) to build the
//     exact `video/mp4; codecs="…"` MIME that addSourceBuffer demands.
//   MsePlayer — fetch → SourceBuffer append loop with backpressure, buffered
//     eviction, and honest error states.

// ---- init segment parsing ----------------------------------------------------

type Bytes = Uint8Array

function u32(buf: Bytes, off: number): number {
  return ((buf[off]!) << 24) | ((buf[off + 1]!) << 16) | ((buf[off + 2]!) << 8) | buf[off + 3]!
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0').toUpperCase()
}

/**
 * Find `path` (a chain of box types) inside buf[start,end).
 * Returns the payload range of the last box, or null when absent.
 * `incomplete` (out-param style via return 'partial') signals the chain starts
 * but the last box is cut off — callers reading a growing buffer care.
 */
function findBox(
  buf: Bytes,
  start: number,
  end: number,
  path: readonly string[],
): { start: number; end: number; partial: boolean } | null {
  let range = { start, end, partial: false }
  for (let depth = 0; depth < path.length; depth++) {
    const type = path[depth]!
    let off = range.start
    let found: { start: number; end: number; partial: boolean } | null = null
    while (off + 8 <= range.end) {
      let size = u32(buf, off)
      if (size === 1) {
        // 64-bit largesize — recordings this big are beyond M2; treat as end.
        break
      }
      if (size === 0) size = range.end - off
      if (off + size > range.end) {
        // Box announced but not fully buffered yet — partial only if it is the
        // type we are looking for.
        const t = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!)
        if (t === type) found = { start: off + 8, end: range.end, partial: true }
        break
      }
      const t = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!)
      if (t === type) {
        // Payload = the box minus its 8-byte header. (stsd additionally
        // carries version/flags + entry_count before its children — its
        // caller skips those 8 bytes; every box here is otherwise plain.)
        found = { start: off + 8, end: off + size, partial: false }
        break
      }
      off += size
    }
    if (found === null) return null
    range = found
    if (range.partial) return range
  }
  return range
}

/** avcC → "avc1.PPCCLL" (profile, compatibility, level as hex bytes). */
function avcCodec(buf: Bytes, entryStart: number, entryEnd: number): string | null {
  const c = findBox(buf, entryStart, entryEnd, ['avcC'])
  if (c === null || c.partial || c.end - c.start < 4) return null
  return `avc1.${hex2(buf[c.start + 1]!)}${hex2(buf[c.start + 2]!)}${hex2(buf[c.start + 3]!)}`
}

/**
 * hvcC → the RFC 6381 HEVC code point, e.g. "hvc1.1.6.L120.90".
 * Byte layout (ISO/IEC 14496-15): [1] space|tier|idc, [2..5] compatibility
 * flags, [6..11] constraint indicators, [12] level.
 */
function hevcCodec(buf: Bytes, entryStart: number, entryEnd: number): string | null {
  const c = findBox(buf, entryStart, entryEnd, ['hvcC'])
  if (c === null || c.partial || c.end - c.start < 13) return null
  const p = c.start
  const profileByte = buf[p + 1]!
  const tier = (profileByte & 0x20) !== 0
  const compat = u32(buf, p + 2)
  const level = buf[p + 12]!
  // Constraint indicator bytes: keep the significant tail, all-zero → "B0".
  const constraints: number[] = []
  for (let i = 6; i < 12; i++) constraints.push(buf[p + i]!)
  while (constraints.length > 1 && constraints[constraints.length - 1] === 0) constraints.pop()
  const allZero = constraints.every((b) => b === 0)
  const constraintPart = allZero ? 'B0' : `B${constraints.map((b) => hex2(b)).join('')}`
  return `hvc1.${profileByte}.${compat.toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}.${constraintPart}`
}

/** esds → "mp4a.40.2" when the decoder config says MPEG-4 Audio (OTI 0x40). */
function aacCodec(buf: Bytes, entryStart: number, entryEnd: number): string | null {
  const c = findBox(buf, entryStart, entryEnd, ['esds'])
  if (c === null || c.partial) return null
  // Scan for the DecoderConfigDescriptor tag (0x04) and read its OTI byte.
  // Descriptor lengths are expandable (0x80 continuation bits).
  for (let i = c.start; i + 2 < c.end; i++) {
    if (buf[i] !== 0x04) continue
    let j = i + 1
    let len = 0
    for (let k = 0; k < 4 && j < c.end; k++) {
      const b = buf[j++]!
      len = (len << 7) | (b & 0x7f)
      if ((b & 0x80) === 0) break
    }
    if (len > 0 && j < c.end) {
      const oti = buf[j]!
      if (oti === 0x40) return 'mp4a.40.2'
      return null // a recognized esds with a non-AAC decoder: no audio codec
    }
  }
  return null
}

/**
 * Build the addSourceBuffer MIME from an fMP4 init segment.
 * Returns:
 *   string  — the exact `video/mp4; codecs="…"`
 *   null    — init complete but no recognizable video codec (caller should
 *             fall back to plain 'video/mp4' and let the browser sniff)
 *   undefined — the init segment is not fully buffered yet (keep reading)
 */
export function fmp4CodecString(init: Bytes): string | undefined | null {
  const ftyp = findBox(init, 0, init.length, ['ftyp'])
  if (ftyp === null) return undefined
  const moov = findBox(init, 0, init.length, ['moov'])
  if (moov === null) return undefined
  if (moov.partial) return undefined

  let video: string | null = null
  let audio: string | null = null
  // Walk EVERY trak's stsd (video is usually trak #1, audio trak #2 — stopping
  // at the first hit would drop the audio codec from the MIME); sample entries
  // carry a fixed-size header before their child boxes (78 bytes video / 28
  // bytes audio).
  let off = moov.start
  while (off + 8 <= moov.end && (video === null || audio === null)) {
    const size = u32(init, off)
    if (size < 8 || off + size > moov.end) break
    const type = String.fromCharCode(init[off + 4]!, init[off + 5]!, init[off + 6]!, init[off + 7]!)
    if (type === 'trak') {
      const stsd = findBox(init, off + 8, off + size, ['mdia', 'minf', 'stbl', 'stsd'])
      if (stsd !== null && !stsd.partial) {
        // stsd payload = version/flags(4) + entry_count(4), THEN the entries.
        let e = stsd.start + 8
        while (e + 8 <= stsd.end) {
          const esize = u32(init, e)
          if (esize < 8 || e + esize > stsd.end) break
          const etype = String.fromCharCode(init[e + 4]!, init[e + 5]!, init[e + 6]!, init[e + 7]!)
          const payloadStart = e + 8 + (etype === 'mp4a' ? 28 : 78)
          if (etype === 'avc1' || etype === 'avc3') {
            if (video === null) video = avcCodec(init, payloadStart, e + esize)
          } else if (etype === 'hvc1' || etype === 'hev1') {
            if (video === null) video = hevcCodec(init, payloadStart, e + esize)
          } else if (etype === 'mp4a') {
            if (audio === null) audio = aacCodec(init, payloadStart, e + esize)
          }
          e += esize
        }
      }
    }
    off += size
  }
  if (video === null) return null
  return `video/mp4; codecs="${audio !== null ? `${video},${audio}` : video}"`
}

// ---- the player ----------------------------------------------------------------

export type MseState = 'opening' | 'playing' | 'ended' | 'error'

const MAX_INIT_SCAN = 256 * 1024 // moov is ~1KB typically; refuse runaway scans
const MAX_BUFFERED_AHEAD = 8 * 1024 * 1024 // backpressure the fetch at 8MB queued
const EVICT_BEHIND = 60 // seconds behind currentTime to start evicting
const EVICT_KEEP = 30 // seconds of past buffer to keep after eviction

/**
 * One recording window on one <video> element. Lifecycle mirrors the WHEP
 * handle: play(url) starts it, dispose() tears everything down (abort the
 * fetch, detach the MediaSource, clear the element) — safe to call anytime.
 */
export class MsePlayer {
  private controller = new AbortController()
  private disposed = false
  private objectUrl: string | null = null
  private onPlaying: (() => void) | null = null
  private onVideoError: (() => void) | null = null

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onState: (state: MseState, detail?: string) => void,
  ) {}

  async play(url: string): Promise<void> {
    if (typeof MediaSource === 'undefined') {
      this.onState('error', 'mse-unsupported')
      return
    }
    const video = this.video
    const ms = new MediaSource()
    this.objectUrl = URL.createObjectURL(ms)
    video.srcObject = null
    video.src = this.objectUrl

    const opened = new Promise<void>((resolve, reject) => {
      ms.addEventListener('sourceopen', () => resolve(), { once: true })
      ms.addEventListener('sourceclose', () => reject(new Error('mediasource closed')), { once: true })
    })

    let res: Response
    try {
      res = await fetch(url, { signal: this.controller.signal })
    } catch (e) {
      this.fail(e)
      return
    }
    if (!res.ok || res.body === null) {
      this.fail(new Error(`playback server answered ${res.status}`))
      return
    }

    try {
      await opened
    } catch (e) {
      this.fail(e)
      return
    }
    if (this.disposed) return

    const reader = res.body.getReader()
    const queue: Bytes[] = []
    let queuedBytes = 0
    let streamDone = false
    let drainWait: (() => void) | null = null
    let sb: SourceBuffer

    const concat = (a: Bytes, b: Bytes): Bytes => {
      const out = new Uint8Array(a.length + b.length)
      out.set(a, 0)
      out.set(b, a.length)
      return out
    }

    // Backpressure predicate: queuedBytes is drained asynchronously (pump ←
    // updateend), so this reads as a function call the linter cannot prove
    // constant — and it genuinely is not.
    const overBuffer = (): boolean => !this.disposed && queuedBytes > MAX_BUFFERED_AHEAD

    // 1) Buffer the head until the init segment parses (or the scan cap hits).
    let head: Bytes = new Uint8Array(0)
    let mime: string | undefined | null
    for (;;) {
      mime = fmp4CodecString(head)
      if (mime !== undefined || head.length >= MAX_INIT_SCAN) break
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value) head = concat(head, chunk.value)
    }
    if (this.disposed) return
    const finalMime = typeof mime === 'string' ? mime : 'video/mp4'
    if (!MediaSource.isTypeSupported(finalMime)) {
      this.fail(new Error(`browser cannot play ${finalMime}`))
      return
    }
    try {
      sb = ms.addSourceBuffer(finalMime)
    } catch (e) {
      this.fail(e)
      return
    }

    const finish = (): void => {
      if (this.disposed || streamDone === false) return
      try {
        if (ms.readyState === 'open') ms.endOfStream()
      } catch {
        // endOfStream during a pending append throws — the sourceended path
        // will not fire again; the video simply stops at the buffer end.
      }
      this.onState('ended')
    }

    const evict = (): void => {
      try {
        if (sb.buffered.length === 0) return
        const behind = video.currentTime - sb.buffered.start(0)
        if (behind > EVICT_BEHIND) sb.remove(0, video.currentTime - EVICT_KEEP)
      } catch {
        // remove() while updating throws; the next updateend retries.
      }
    }

    const pump = (): void => {
      if (this.disposed || sb.updating || queue.length === 0) return
      const next = queue.shift()!
      queuedBytes -= next.length
      try {
        sb.appendBuffer(next)
      } catch (e) {
        this.fail(e)
      }
    }

    sb.addEventListener('updateend', () => {
      evict()
      pump()
      drainWait?.()
      drainWait = null
      if (queue.length === 0 && streamDone) finish()
    })
    sb.addEventListener('error', () => this.fail(new Error('source buffer error')))

    this.onPlaying = (): void => this.onState('playing')
    this.onVideoError = (): void => {
      const err = video.error
      this.fail(new Error(err !== null ? `media error ${err.code}${err.message ? ` (${err.message})` : ''}` : 'playback error'))
    }
    video.addEventListener('playing', this.onPlaying, { once: true })
    video.addEventListener('error', this.onVideoError)

    if (head.length > 0) {
      queue.push(head)
      queuedBytes += head.length
    }
    this.onState('opening')
    pump()
    void video.play().catch((e: unknown) => this.fail(e))

    // 2) Stream the rest with byte-based backpressure.
    try {
      for (;;) {
        if (this.disposed) return
        const chunk = await reader.read()
        if (this.disposed) return
        if (chunk.done) {
          streamDone = true
          if (queue.length === 0 && !sb.updating) finish()
          return
        }
        if (chunk.value) {
          queue.push(chunk.value)
          queuedBytes += chunk.value.length
          pump()
        }
        while (overBuffer()) {
          await new Promise<void>((resolve) => {
            drainWait = resolve
          })
        }
      }
    } catch (e) {
      if (!this.disposed) this.fail(e)
    }
  }

  private fail(e: unknown): void {
    if (this.disposed) return
    const detail = e instanceof Error ? e.message : String(e)
    // An aborted fetch is a normal teardown, not an error.
    if (this.controller.signal.aborted) return
    this.onState('error', detail)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort()
    const video = this.video
    if (this.onPlaying !== null) video.removeEventListener('playing', this.onPlaying)
    if (this.onVideoError !== null) video.removeEventListener('error', this.onVideoError)
    this.onPlaying = null
    this.onVideoError = null
    video.removeAttribute('src')
    video.load()
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
  }
}
