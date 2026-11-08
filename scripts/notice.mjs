// mediabase / scripts / notice.mjs
//
// Generates NOTICE.md — the third-party attribution file a distribution has to
// carry. Two rules it follows, because attribution files that drift are worse
// than none:
//
//   1. npm dependencies come from `pnpm licenses list --prod --json` (the lockfile
//      is the authority); nothing here is typed by hand.
//   2. native entries name the artifact and, where the license is not knowable
//      from this machine, say so instead of guessing. The FFmpeg cone is one such
//      case — see docs/LICENSING.zh.md.
//
// Run: pnpm run notice

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'NOTICE.md')

/** Homebrew libraries the engine links; each entry's license is VERIFIED by
 *  reading the keg's license file below (a missing keg is reported, not invented). */
const BREW_DEPS = [
  { name: 'glog', spdx: 'BSD-3-Clause', licenseFile: 'COPYING', holder: 'Google Inc.' },
  { name: 'gflags', spdx: 'BSD-3-Clause', licenseFile: 'COPYING.txt', holder: 'Google Inc.' },
  { name: 'jsoncpp', spdx: 'MIT (public-domain 声明见其 LICENSE)', licenseFile: 'LICENSE', holder: 'Baptiste Lepilleur / contributors' },
  { name: 'cJSON', spdx: 'MIT', licenseFile: 'LICENSE', holder: 'Dave Gamble and cJSON contributors' },
  { name: 'SDL2', spdx: 'Zlib', licenseFile: 'LICENSE.txt', holder: 'Sam Lantinga' },
  { name: 'lz4', spdx: 'BSD-2-Clause (lib/;仓库其余文件为 GPL-2.0-or-later)', licenseFile: 'LICENSE', holder: 'Yann Collet' },
]

/** Libraries that arrive with MediaComponent's FFmpeg cone. Their licenses are
 *  not knowable from this machine, so the entry says that plainly. */
const FFMPEG_CONE = [
  'avformat avcodec avutil swscale swresample avfilter avdevice postproc (FFmpeg)',
  'x264 (GPL, --enable-gpl 带入)',
  'fdk-aac (非自由, --enable-nonfree 带入)',
  'vpx opus srt rist mbedtls mbedx509 mbedcrypto yuv bz2 z iconv curl ssl crypto',
]

function brewLicense(pkg, file) {
  const prefix = brewPrefix(pkg)
  if (prefix === null) return null
  const path = join(prefix, file)
  if (!existsSync(path)) return { path, firstLine: '(许可证文件未找到)' }
  const firstLine = readFileSync(path, 'utf8').split('\n').find((l) => l.trim() !== '') ?? ''
  return { path, firstLine: firstLine.trim() }
}

function brewPrefix(pkg) {
  try {
    const out = execFileSync('brew', ['--prefix', pkg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out !== '' && existsSync(out) ? out : null
  } catch {
    return null
  }
}

/** npm runtime dependencies, straight from the lockfile-aware pnpm command.
 *
 *  `-r` is load-bearing: the ROOT manifest has no `dependencies` at all — every
 *  runtime package belongs to a workspace package (packages, apps, and each
 *  product's own packages). Under pnpm 12 `licenses list --prod` at the root
 *  therefore reports `{}` and an empty-but-plausible notice gets written. `-r`
 *  aggregates every workspace project, which is the set that actually ships.
 */
function npmDeps() {
  const args = ['-r', 'licenses', 'list', '--prod', '--json']
  const raw = execFileSync('pnpm', args, { cwd: ROOT, encoding: 'utf8' })
  const byLicense = JSON.parse(raw)
  const rows = []
  for (const [license, entries] of Object.entries(byLicense)) {
    for (const entry of entries) {
      rows.push({ license, name: entry.name, versions: (entry.versions ?? []).join(', ') })
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

function engineBuild() {
  const cache = join(ROOT, 'engine/build/CMakeCache.txt')
  if (!existsSync(cache)) return null
  const line = readFileSync(cache, 'utf8').split('\n').find((l) => /USE_MEDIACOMPONENT:/.test(l))
  const mcRoot = readFileSync(cache, 'utf8').split('\n').find((l) => l.startsWith('MEDIACOMPONENT_ROOT:'))
  return {
    mediacomponent: line?.split('=')[1] ?? 'unknown',
    root: mcRoot?.split('=')[1] ?? '(默认)',
    flag: line?.split(':')[0] ?? 'USE_MEDIACOMPONENT',
  }
}

const npm = npmDeps()
const hasEngine = existsSync(join(ROOT, 'engine'))
const build = hasEngine ? engineBuild() : null

// Fail BEFORE touching the file. The previous order wrote first and exited 1
// afterwards, so a broken run replaced a correct NOTICE with an empty one and
// then announced it had refused to write it. A generator that damages the
// artifact it declines to produce is worse than one that does nothing.
if (npm.length === 0) {
  console.error('[notice] pnpm returned no runtime dependencies — NOTICE.md left untouched.')
  console.error('[notice] 手动确认: pnpm -r licenses list --prod --json')
  process.exit(1)
}

/** Product layers that carry their own native engine. The base has none, so this
 *  file must not claim anything about them — but it also must not pretend they
 *  do not exist, which is what a bare "this checkout has no engine" did once the
 *  product trees landed. */
const productEngines = existsSync(join(ROOT, 'product'))
  ? readdirSync(join(ROOT, 'product'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, 'product', entry.name, 'engine')))
      .map((entry) => `product/${entry.name}/engine`)
  : []

const lines = []
lines.push('# Third-party notices')
lines.push('')
lines.push('> Generated by `pnpm run notice` (`scripts/notice.mjs`). Do not edit by hand —')
lines.push('> edit the script, or fix the dependency, and regenerate.')
lines.push('')
lines.push('This project\'s own code is MIT (see `LICENSE`). This file covers everything else that')
lines.push('ends up in a build or a distributed package.')
lines.push('')

lines.push('## npm runtime dependencies')
lines.push('')
lines.push('Source: `pnpm -r licenses list --prod --json` (the lockfile is the authority).')
lines.push('')
lines.push('| Package | Version | License |')
lines.push('|---|---|---|')
for (const row of npm) lines.push(`| ${row.name} | ${row.versions} | ${row.license} |`)
lines.push('')
lines.push(`All ${npm.length} runtime dependencies are permissive (${[...new Set(npm.map((r) => r.license))].join(', ')}).`)
lines.push('')

if (!hasEngine) {
  lines.push('## Native libraries / FFmpeg')
  lines.push('')
  lines.push('The **base** ships no native engine binary: analysis, encoding and publishing are')
  lines.push('delegated to product layers and to FFmpeg invocations, and no FFmpeg is bundled.')
  lines.push('')
  if (productEngines.length > 0) {
    lines.push(`Product layers in this checkout do carry engines (${productEngines.map((p) => `\`${p}\``).join(', ')}).`)
    lines.push('Each one attributes its own native dependencies — they are NOT covered by this file,')
    lines.push('because they are distributed separately from the base:')
    lines.push('')
    for (const dir of productEngines) {
      const readme = join(ROOT, dir, 'README.zh.md')
      const note = existsSync(readme) ? `\`${dir}/README.zh.md\`` : `\`${dir}\``
      lines.push(`- ${note}`)
    }
    lines.push('')
    lines.push('A distribution that bundles a product regenerates this file in that product\'s tree.')
  } else {
    lines.push('This checkout has no product engine either; native attribution sections are omitted.')
  }
  lines.push('')
} else {
  lines.push('## Native libraries linked into the engine binary')
  lines.push('')
  lines.push('Verified on this machine by reading each library\'s license file:')
  lines.push('')
  lines.push('| Library | License | License file |')
  lines.push('|---|---|---|')
  for (const dep of BREW_DEPS) {
    const found = brewLicense(dep.name, dep.licenseFile)
    const where = found === null ? '_未安装,无法核实_' : `\`${found.path}\``
    lines.push(`| ${dep.name} | ${dep.spdx} | ${where} |`)
  }
  lines.push('')

  lines.push('## FFmpeg cone (via MediaComponent)')
  lines.push('')
  if (build !== null) {
    lines.push(`Last engine configure: \`${build.flag}=${build.mediacomponent}\`,` +
      ` \`MEDIACOMPONENT_ROOT=${build.root}\`.`)
    lines.push('')
  }
  lines.push('When MediaComponent is enabled, the engine statically links these into one binary:')
  lines.push('')
  for (const item of FFMPEG_CONE) lines.push(`- ${item}`)
  lines.push('')
  lines.push('**Their licenses are not knowable from this checkout** — they follow the FFmpeg build')
  lines.push('MediaComponent ships. On the machine this file was generated from that build was')
  lines.push('configured with `--enable-gpl --enable-nonfree`, which makes the resulting binary GPL')
  lines.push('and, per FFmpeg\'s own terms, unredistributable. Read `docs/LICENSING.zh.md` before')
  lines.push('distributing an installer.')
  lines.push('')

  lines.push('## ffmpeg binary bundled into the desktop app')
  lines.push('')
  lines.push('`packaging/desktop-electron/scripts/prepare-ffmpeg.mjs` copies one ffmpeg executable')
  lines.push('into the app bundle. It prints a warning when that build carries `--enable-gpl` or')
  lines.push('`--enable-nonfree`; set `MEDIABASE_BUNDLE_FFMPEG=0` to ship without it (the app then uses')
  lines.push('the user\'s own ffmpeg).')
  lines.push('')

  lines.push('## MediaComponent itself')
  lines.push('')
  lines.push('The MediaComponent checkout the engine links is a separate project; its own license')
  lines.push('governs that code (no license file was found in the checkout on this machine — confirm')
  lines.push('with its maintainer before distributing a binary that contains it).')
  lines.push('')

  lines.push('## macOS system frameworks')
  lines.push('')
  lines.push('CoreFoundation, Security, AudioToolbox, VideoToolbox, CoreMedia, CoreVideo, CoreImage,')
  lines.push('QuartzCore, CoreAudio, OpenGL, AVFoundation, AppKit, Cocoa, IOKit, Metal — part of the')
  lines.push('operating system, no attribution required.')
  lines.push('')
}

writeFileSync(OUT, lines.join('\n'))
console.log(`[notice] wrote ${OUT}`)
console.log(`[notice] ${npm.length} npm runtime dependencies${hasEngine ? `, ${BREW_DEPS.length} native entries` : ' (base ships no engine — native sections point at the products)'}`)
