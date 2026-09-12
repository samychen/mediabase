// mediabase / scripts / check-native-licenses.mjs
//
// Gate for DISTRIBUTABLE builds. Our own code is MIT, but the native artifacts we
// ship are not ours to relicense, and one of them is not even redistributable:
//
//   --enable-gpl        (x264)      → the whole binary is GPL
//   --enable-nonfree    (fdk-aac)   → per FFmpeg's own terms, UNREDISTRIBUTABLE
//
// Route "accept GPL for the app" still requires dropping --enable-nonfree, so this
// script looks for evidence OF THE ARTIFACTS WE WOULD SHIP (not for a comment in a
// config file): the engine binary's strings, and the ffmpeg that packaging copies
// into the bundle.
//
// Modes:
//   node scripts/check-native-licenses.mjs                 report only (exit 0)
//   node scripts/check-native-licenses.mjs --gate          exit 1 on nonfree
//   MEDIABASE_ALLOW_NONFREE=1 node … --gate               personal build: warns, exits 0
//
// Soft-skip: when this checkout has no engine/ tree (base-only), exit 0 with a message.
// Run: pnpm run check:native  ·  enforced by packaging/desktop-electron `dist`.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GATE = process.argv.includes('--gate')
const ALLOW_NONFREE = process.env.MEDIABASE_ALLOW_NONFREE === '1'

/** Markers only present when the nonfree/GPL codecs were compiled in. */
const NONFREE_MARKERS = ['Fraunhofer FDK AAC', 'libfdk_aac', 'libfdk-aac', 'fdk-aac']
const GPL_MARKERS = ['x264', 'X264']

/**
 * `strings` is not guaranteed on every machine (binutils); fall back to reading
 * the file and matching ASCII runs, which is enough for these markers.
 */
function stringsOf(file) {
  try {
    return execFileSync('strings', ['-a', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    const buf = execFileSync('cat', [file], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    return buf.toString('latin1').replace(/[^\x20-\x7e]+/g, '\n')
  }
}

function scanBinary(path) {
  if (!existsSync(path)) return null
  const text = stringsOf(path)
  const lower = text.toLowerCase()
  return {
    path,
    nonfree: NONFREE_MARKERS.filter((m) => lower.includes(m.toLowerCase())),
    gpl: GPL_MARKERS.filter((m) => lower.includes(m.toLowerCase())),
  }
}

/**
 * The ffmpeg packaging would copy in, if it is already staged.
 *
 * `MEDIABASE_BUNDLE_FFMPEG=0` means the app ships NO ffmpeg (the user's own binary on PATH
 * serves the engine's CLI fallback), so there is nothing to scan — without this the gate
 * would block the very route it recommends as the alternative to rebuilding FFmpeg.
 */
const BUNDLE_FFMPEG = process.env.MEDIABASE_BUNDLE_FFMPEG !== '0'

function stagedFfmpeg() {
  if (!BUNDLE_FFMPEG) return null
  const candidates = [
    join(ROOT, 'packaging/desktop-electron/vendor-ffmpeg/ffmpeg'),
    process.env.MEDIABASE_FFMPEG ?? '',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function scanFfmpegConfig(bin) {
  try {
    const out = execFileSync(bin, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const configuration = out.split('\n').find((l) => l.startsWith('configuration:')) ?? ''
    return {
      path: bin,
      nonfree: configuration.includes('--enable-nonfree') ? ['--enable-nonfree'] : [],
      gpl: configuration.includes('--enable-gpl') ? ['--enable-gpl'] : [],
    }
  } catch {
    return { path: bin, nonfree: [], gpl: [] }
  }
}

if (!existsSync(join(ROOT, 'engine'))) {
  console.log('[native] 本仓无 engine/ —— 跳过原生产物许可证检查(基座仓)')
  process.exit(0)
}

const findings = []
const engine = scanBinary(join(ROOT, 'engine/bin/engine'))
if (engine !== null) findings.push({ kind: 'engine 二进制', ...engine })
const ffmpegPath = stagedFfmpeg()
if (ffmpegPath !== null) findings.push({ kind: 'ffmpeg(将被打包)', ...scanFfmpegConfig(ffmpegPath) })
else if (!BUNDLE_FFMPEG) console.log('[native] ffmpeg: 不随包分发(MEDIABASE_BUNDLE_FFMPEG=0 → 用目标机的 ffmpeg CLI)')

const blocking = []
for (const f of findings) {
  const nonfree = f.nonfree.length > 0
  const gpl = f.gpl.length > 0
  const verdict = nonfree
    ? `❌ 含不可再分发组件:${f.nonfree.join(', ')}`
    : gpl
      ? `⚠️ GPL 组件:${f.gpl.join(', ')}(可分发,但整个分发包按 GPL 走)`
      : '✅ 未发现 GPL/nonfree 组件'
  console.log(`[native] ${f.kind}: ${f.path}`)
  console.log(`         ${verdict}`)
  if (nonfree) blocking.push(f)
}

if (findings.length === 0) {
  console.log('[native] 未找到可检查的原生产物(先 build:engine / 打包前先 prepare-ffmpeg)')
}

if (blocking.length > 0) {
  if (!GATE) {
    console.log('\n[native] 提示:`--enable-nonfree` 的构建(fdk-aac)按 FFmpeg 自己的说法不可再分发。')
    console.log('[native] 对外分发前请重建 FFmpeg(去掉 --enable-nonfree),或改走"不发原生二进制"路线。')
    console.log('[native] 详见 docs/LICENSING.zh.md 与 docs/GPL-COMPLIANCE.zh.md')
    process.exit(0)
  }
  if (ALLOW_NONFREE) {
    console.log('\n[native] MEDIABASE_ALLOW_NONFREE=1 → 仅本机/自用构建,继续(请勿对外分发此产物)')
    process.exit(0)
  }
  console.error('\n[native] 拒绝:待分发产物含 --enable-nonfree(fdk-aac),按 FFmpeg 条款不可再分发。')
  console.error('[native] 修法之一:重建 FFmpeg 时去掉 --enable-nonfree(见 docs/GPL-COMPLIANCE.zh.md);')
  console.error('[native] 修法之二:走"不发原生二进制"路线(MEDIABASE_BUNDLE_FFMPEG=0);')
  console.error('[native] 仅本机自用可临时 MEDIABASE_ALLOW_NONFREE=1。')
  process.exit(1)
}
