// The MSE init-segment parser (mse.ts) — the piece that decides whether
// recording playback starts at all. The headline fixture is a VERBATIM init
// segment captured from a live MediaMTX v1.21.1 playback server (ffmpeg
// testsrc2 + sine, H.264 baseline 3.1 + AAC): ftyp + moov, 1158 bytes.

import { describe, expect, it } from 'vitest'
import { fmp4CodecString } from '../packages/client/console/src/mse.ts'

const LIVE_INIT_B64 = 'AAAAIGZ0eXBtcDQyAAAAAW1wNDFtcDQyaXNvbWhsc2YAAARmbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/////wAAAe50cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAUAAAADwAAAAAAGKbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAFfkAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABNW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAPVzdGJsAAAAqXN0c2QAAAAAAAAAAQAAAJlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAA8ABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAf/+EAGGdCwB/ZAUH7ARAAAAMAEAAAAwHg8YMkgAEABGjLjLIAAAAUYnRydAAAAAAAD0JAAA9CQAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAABvHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAVhtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAKxEAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAEDbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADHc3RibAAAAHtzdHNkAAAAAAAAAAEAAABrbXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAKxEAAAAAAAzZXNkcwAAAAADgICAIgACAASAgIAUQBUAAAAAAfc5AAH3OQWAgIACEggGgICAAQIAAAAUYnRydAAAAAAAAfc5AAH3OQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAACB0cmV4AAAAAAAAAAIAAAABAAAAAAAAAAAAAAAA'

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

// ---- synthetic box builder (ISO-BMFF: size(4BE) + fourcc + payload) ----------

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

/** stsd wraps entries behind version/flags + entry_count (8 extra bytes). */
function stsd(...entries: Uint8Array[]): Uint8Array {
  return box('stsd', concat(new Uint8Array(8), ...entries))
}

/** A visual sample entry: 78 fixed bytes before child boxes. */
function videoEntry(type: string, ...children: Uint8Array[]): Uint8Array {
  return box(type, concat(new Uint8Array(78), ...children))
}

function trakWithStsd(stsdBox: Uint8Array): Uint8Array {
  return box('trak', box('mdia', box('minf', box('stbl', stsdBox))))
}

const FTYP = box('ftyp', concat(new Uint8Array([0x6d, 0x70, 0x34, 0x32]), new Uint8Array(4)))

describe('fmp4CodecString', () => {
  it('builds the exact MIME from the live v1.21.1 init segment', () => {
    const init = fromB64(LIVE_INIT_B64)
    // H.264 baseline (0x42) compat 0xc0 level 31 (0x1f) + AAC-LC.
    expect(fmp4CodecString(init)).toBe('video/mp4; codecs="avc1.42C01F,mp4a.40.2"')
  })

  it('says "not yet" (undefined) while the init is still arriving', () => {
    const init = fromB64(LIVE_INIT_B64)
    expect(fmp4CodecString(init.subarray(0, 32))).toBeUndefined() // ftyp only
    expect(fmp4CodecString(init.subarray(0, 600))).toBeUndefined() // moov cut mid-way
    expect(fmp4CodecString(new Uint8Array(0))).toBeUndefined()
  })

  it('builds the RFC 6381 HEVC code point from a synthetic hvc1 track', () => {
    const hvcC = box('hvcC', new Uint8Array([
      1,    // configurationVersion
      0x01, // profile_space=0, tier=0, profile_idc=1
      0, 0, 0, 2, // profile_compatibility_flags = 0x00000002
      0, 0, 0, 0, 0, 0, // constraint indicators (all zero → B0)
      93, // level_idc
      0, 0, 0, // tail padding the parser must ignore
    ]))
    const init = concat(FTYP, box('moov', trakWithStsd(stsd(videoEntry('hvc1', hvcC)))))
    expect(fmp4CodecString(init)).toBe('video/mp4; codecs="hvc1.1.2.L93.B0"')
  })

  it('returns null (browser-sniff fallback) when no video codec is recognizable', () => {
    const junk = videoEntry('junk', new Uint8Array(16))
    const init = concat(FTYP, box('moov', trakWithStsd(stsd(junk))))
    expect(fmp4CodecString(init)).toBeNull()
  })

  it('omits the audio codec when the esds declares a non-AAC decoder', () => {
    const avcC = box('avcC', new Uint8Array([1, 0x64, 0x00, 0x1f]))
    // esds whose DecoderConfigDescriptor (tag 0x04) says OTI 0x20 (not AAC).
    const esds = box('esds', new Uint8Array([0, 0, 0, 0, 0x03, 0x19, 0, 1, 0, 0x04, 0x11, 0x20]))
    const audio = box('mp4a', concat(new Uint8Array(28), esds))
    const init = concat(
      FTYP,
      box('moov', concat(
        trakWithStsd(stsd(videoEntry('avc1', avcC))),
        trakWithStsd(stsd(audio)),
      )),
    )
    expect(fmp4CodecString(init)).toBe('video/mp4; codecs="avc1.64001F"')
  })
})
