// packaging/desktop-electron/scripts/prepare-ffmpeg.mjs
//
// Copies a local ffmpeg binary into vendor-ffmpeg/ffmpeg so the packaged app can
// run tools that need ffmpeg without a shell PATH. Source: MEDIABASE_FFMPEG env,
// else `which ffmpeg`, else a MediaComponent build beside an engine/ tree.
// Run automatically by `pnpm run dist` when that script exists.
//
// Soft-skip: when this checkout has no engine/ and bundling is not forced, exit 0.
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
const ROOT = join(HERE, '..', '..', '..')
const VENDOR = join(HERE, '..', 'vendor-ffmpeg', 'ffmpeg')
const hasEngine = existsSync(join(ROOT, 'engine'))

// MIT-clean path: ship NO native binary and let the app use the user's own ffmpeg
// (MEDIABASE_FFMPEG / PATH). Set MEDIABASE_BUNDLE_FFMPEG=0 for that.
if (process.env.MEDIABASE_BUNDLE_FFMPEG === '0' || process.env.MEDIABASE_BUNDLE_FFMPEG === 'false') {
  rmSync(join(HERE, '..', 'vendor-ffmpeg'), { recursive: true, force: true })
  console.log('[prepare-ffmpeg] MEDIABASE_BUNDLE_FFMPEG=0 → 不捆绑 ffmpeg(分发包不含原生二进制,' +
    '运行时会用用户自带的 ffmpeg;请确保目标机器已安装或设置 MEDIABASE_FFMPEG)。')
  process.exit(0)
}

if (!hasEngine && !process.env.MEDIABASE_FFMPEG) {
  console.log('[prepare-ffmpeg] 本仓无 engine/ 且未设 MEDIABASE_FFMPEG —— 跳过捆绑(基座仓)')
  process.exit(0)
}

/**
 * Candidate locations, in order — no machine-specific paths:
 *   1. MEDIABASE_FFMPEG (explicit),
 *   2. the ffmpeg next to the MediaComponent SDK the engine was CONFIGURED with
 *      (read from its CMake cache; also honoured via MEDIACOMPONENT_ROOT),
 *   3. `which ffmpeg`.
 */
function candidates() {
  const out = []
  if (process.env.MEDIABASE_FFMPEG) out.push(process.env.MEDIABASE_FFMPEG)
  let mcRoot = process.env.MEDIACOMPONENT_ROOT
  if (!mcRoot && hasEngine) {
    try {
      const cache = readFileSync(join(ROOT, 'engine', 'build', 'CMakeCache.txt'), 'utf8')
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
  console.error('[prepare-ffmpeg] 找不到 ffmpeg(设 MEDIABASE_FFMPEG 或先安装)。')
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
if (nonfree && process.env.MEDIABASE_ALLOW_NONFREE !== '1') {
  console.error(
    '[prepare-ffmpeg] ❌ 拒绝捆绑:这份 ffmpeg 带 --enable-nonfree(fdk-aac),按 FFmpeg 条款不可再分发。\n' +
    '              修法:重建 FFmpeg 去掉 --enable-nonfree(docs/GPL-COMPLIANCE.zh.md),\n' +
    '              或走"不发原生二进制"路线:MEDIABASE_BUNDLE_FFMPEG=0,\n' +
    '              仅本机自用可临时 MEDIABASE_ALLOW_NONFREE=1。',
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
