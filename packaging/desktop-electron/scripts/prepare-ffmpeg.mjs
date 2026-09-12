// packaging/desktop-electron/scripts/prepare-ffmpeg.mjs
//
// Copies a local ffmpeg binary into vendor-ffmpeg/ffmpeg so the packaged app can
// run python tools (silence/loudness) and the engine's CLI fallback without a
// shell PATH. Source: AVSTUDIO_FFMPEG env, else `which ffmpeg`, else the known
// MediaComponent build. Run automatically by `pnpm run dist`.
//
// LICENSING: the app's own code is MIT, but the ffmpeg you bundle is NOT yours to
// relicense. A build with `--enable-gpl` (libx264…) makes the whole binary GPL,
// and `--enable-nonfree` (libfdk-aac…) makes it unredistributable per FFmpeg's own
// terms. So this script does not just copy: it reads `ffmpeg -version` and warns
// loudly. Personal/local builds are fine; shipping a DMG is not. See
// docs/LICENSING.zh.md for the three options.
import { copyFileSync, existsSync, mkdirSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(HERE, '..', 'vendor-ffmpeg', 'ffmpeg')

// MIT-clean path: ship NO native binary and let the app use the user's own ffmpeg
// (the engine's ffmpeg-CLI fallback and the python tools both take AVSTUDIO_FFMPEG
// / PATH). Set AVSTUDIO_BUNDLE_FFMPEG=0 for that; see docs/LICENSING.zh.md.
if (process.env.AVSTUDIO_BUNDLE_FFMPEG === '0' || process.env.AVSTUDIO_BUNDLE_FFMPEG === 'false') {
  rmSync(join(HERE, '..', 'vendor-ffmpeg'), { recursive: true, force: true })
  console.log('[prepare-ffmpeg] AVSTUDIO_BUNDLE_FFMPEG=0 → 不捆绑 ffmpeg(分发包不含原生二进制,' +
    '运行时会用用户自带的 ffmpeg;请确保目标机器已安装或设置 AVSTUDIO_FFMPEG)。')
  process.exit(0)
}

/**
 * Candidate locations, in order — no machine-specific paths:
 *   1. AVSTUDIO_FFMPEG (explicit),
 *   2. the ffmpeg next to the MediaComponent SDK the engine was CONFIGURED with
 *      (read from its CMake cache; also honoured via MEDIACOMPONENT_ROOT),
 *   3. `which ffmpeg`.
 */
function candidates() {
  const out = []
  if (process.env.AVSTUDIO_FFMPEG) out.push(process.env.AVSTUDIO_FFMPEG)
  let mcRoot = process.env.MEDIACOMPONENT_ROOT
  if (!mcRoot) {
    try {
      const cache = readFileSync(join(HERE, '..', '..', '..', 'engine', 'build', 'CMakeCache.txt'), 'utf8')
      const line = cache.split('\n').find((l) => l.startsWith('MEDIACOMPONENT_ROOT:'))
      if (line) mcRoot = line.slice(line.indexOf('=') + 1)
    } catch { /* no cache: engine built without it */ }
  }
  if (mcRoot) {
    for (const rel of ['tools/build/bin/ffmpeg', 'build/bin/ffmpeg', 'bin/ffmpeg']) {
      out.push(join(mcRoot, rel))
    }
  }
  try {
    out.push(execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim())
  } catch { /* not on PATH */ }
  return out
}

let src = candidates().find((c) => c && existsSync(c)) ?? ''
if (!src || !existsSync(src)) {
  console.error('[prepare-ffmpeg] 找不到 ffmpeg(设 AVSTUDIO_FFMPEG 或先安装)。python 工具在打包后会不可用。')
  process.exit(1)
}
/** Read the source build's configuration flags to report license obligations. */
function ffmpegConfiguration(bin) {
  try {
    const out = execFileSync(bin, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const line = out.split('\n').find((l) => l.startsWith('configuration:')) ?? ''
    return line
  } catch {
    return ''
  }
}

const configuration = ffmpegConfiguration(src)
const gpl = configuration.includes('--enable-gpl')
const nonfree = configuration.includes('--enable-nonfree')
if (nonfree && process.env.AVSTUDIO_ALLOW_NONFREE !== '1') {
  // Not a warning: `--enable-nonfree` (fdk-aac) makes the binary unredistributable
  // per FFmpeg's own terms, so bundling it means the DMG cannot be given to anyone.
  console.error(
    '[prepare-ffmpeg] ❌ 拒绝捆绑:这份 ffmpeg 带 --enable-nonfree(fdk-aac),按 FFmpeg 条款不可再分发。\n' +
    '              修法:重建 FFmpeg 去掉 --enable-nonfree(docs/GPL-COMPLIANCE.zh.md),\n' +
    '              或走"不发原生二进制"路线:AVSTUDIO_BUNDLE_FFMPEG=0 + 引擎 -DAVSTUDIO_USE_MEDIACOMPONENT=OFF,\n' +
    '              仅本机自用可临时 AVSTUDIO_ALLOW_NONFREE=1。',
  )
  process.exit(1)
}
if (gpl || nonfree) {
  const flags = [gpl ? '--enable-gpl' : '', nonfree ? '--enable-nonfree' : ''].filter(Boolean).join(' ')
  console.warn(
    `[prepare-ffmpeg] ⚠️  这份 ffmpeg 带 ${flags}:自有代码是 MIT,但随包分发这个二进制会让` +
    '整个分发包受 GPL 约束(本仓已选择"整体按 GPL 分发"这条路线)。' +
    '请确保分发包里带上 GPL 全文与对应源码 / 书面要约,见 docs/GPL-COMPLIANCE.zh.md。',
  )
}

mkdirSync(join(VENDOR, '..'), { recursive: true })
copyFileSync(src, VENDOR)
chmodSync(VENDOR, 0o755)
console.log(`[prepare-ffmpeg] bundled: ${src} -> ${VENDOR}${gpl || nonfree ? ' (⚠️ 分发前请阅读 docs/LICENSING.zh.md)' : ''}`)
