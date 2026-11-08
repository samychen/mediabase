// product/highlight / scripts / lib / media.mjs — the synthetic test clip.
//
// Shared by verify.mjs (control plane) and verify-ui.mjs (browser acceptance) so
// both scripts analyse byte-identical media: a 12s clip = 4s flat navy / 4s
// moving testsrc2 / 4s flat slate, with a quiet 220Hz bed replaced by a loud
// 880Hz burst in the middle. One motion+audio burst means the engine has exactly
// one obvious place to cut, which makes the assertions meaningful rather than
// lucky.
//
// Codec choice matters: the engine's default render path is stream copy, so the
// clip inherits the fixture's codec. H.264 is what a browser can actually play
// (and what real inputs use), so it is preferred; MPEG-4 Part 2 is the fallback
// when the local FFmpeg has no libx264. `browserPlayable` reports the truth
// instead of letting a caller assume it.

import { spawnSync } from 'node:child_process'

/** Does this FFmpeg know the encoder? */
export function hasEncoder(name) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  if (res.status !== 0 || typeof res.stdout !== 'string') return false
  return new RegExp(`^ V[.A-Z]{5} ${name} `, 'm').test(res.stdout)
}

/** Does this machine have a usable ffmpeg at all? */
export function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0
}

/**
 * Write the 12s fixture.
 * @returns {{ codec: string, browserPlayable: boolean }}
 */
export function makeFixture(path, { width = 320, height = 180, fps = 25, seconds = 4 } = {}) {
  const filter = [
    `color=c=navy:s=${width}x${height}:r=${fps}:d=${seconds}[v0]`,
    `testsrc2=s=${width}x${height}:r=${fps}:d=${seconds}[v1]`,
    `color=c=darkslategray:s=${width}x${height}:r=${fps}:d=${seconds}[v2]`,
    '[v0][v1][v2]concat=n=3:v=1:a=0[vout]',
    `sine=frequency=220:sample_rate=44100:duration=${seconds},volume=0.01[a0]`,
    `sine=frequency=880:sample_rate=44100:duration=${seconds},volume=0.95[a1]`,
    `sine=frequency=220:sample_rate=44100:duration=${seconds},volume=0.01[a2]`,
    '[a0][a1][a2]concat=n=3:v=0:a=1[aout]',
  ].join(';')

  const base = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
  ]

  // -g 25 keeps IDRs frequent: a long-GOP stream copy looks black in a fresh
  // decoder until the next keyframe, which would make a UI check lie.
  const encode = (video) =>
    spawnSync('ffmpeg', [...base, ...video, '-c:a', 'aac', path], { encoding: 'utf8' })

  if (hasEncoder('libx264')) {
    const res = encode(['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(fps)])
    if (res.status === 0) return { codec: 'h264', browserPlayable: true }
  }
  const res = encode(['-c:v', 'mpeg4', '-q:v', '4'])
  if (res.status !== 0) throw new Error(`fixture generation failed: ${res.stderr}`)
  // MPEG-4 Part 2 in MP4 is not decodable by Chrome/Firefox. Say so.
  return { codec: 'mpeg4', browserPlayable: false }
}
