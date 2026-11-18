// product/xmedia / scripts / sync-studio.mjs — vendor the HF Studio slice
// from the xmedia-kit checkout into studio/ (server + UI + assets).
//
// WHY vendored (highlight's engine-copy precedent, not openvideo's
// consume-in-place): the Studio is a coherent Python program whose modules
// resolve siblings from their own directory and assets from the repo root —
// a synced mini-tree runs standalone, which is what a PRODUCT artifact must
// do. Upstream stays the single source of truth: edit there, re-run this
// script, commit the resulting diff. --check fails on drift (CI gate).
//
// Exactly TWO mechanical transforms are applied on copy (each asserted by
// occurrence count so an upstream rewording turns the gate red instead of
// silently skipping):
//   T1  tools/xmedia.py bake_bin() — prepend the product seam: env
//       XMEDIA_BAKE_BIN first, then engine/build/xmedia-bake[.app] next to
//       the product root. Upstream probes the kit's own build tree, which
//       does not exist in a product checkout.
//   T2  tools/hf_studio.py agent-chat prompt — upstream hardcodes a machine
//       path (/Users/.../avbase) as the "repo root" handed to the agent CLI;
//       replace with {XMEDIA_KIT_ROOT env, falling back to the synced root}.
//
// Usage:  node scripts/sync-studio.mjs            (sync; needs XMEDIA_KIT_SOURCE_DIR)
//         node scripts/sync-studio.mjs --check    (drift gate: exit 1 on drift)

import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const STUDIO_ROOT = join(PRODUCT_ROOT, 'studio')
const SYNC_JSON = join(STUDIO_ROOT, 'SYNC.json')

const check = process.argv.includes('--check')

// ---- resolve the kit checkout ------------------------------------------------
// Order: XMEDIA_KIT_SOURCE_DIR → the sibling checkout next to THIS repo
// (`<repo>/../xmedia-kit`, the same convention the kit's own CEF probe uses —
// resolved, so no machine path is ever written into a script).

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SIBLING_KIT = join(REPO_ROOT, 'xmedia-kit')

const kitSource = process.env.XMEDIA_KIT_SOURCE_DIR ??
  (existsSync(join(SIBLING_KIT, 'tools', 'hf_studio.py')) ? SIBLING_KIT : undefined)
if (!kitSource) {
  console.error('需要 XMEDIA_KIT_SOURCE_DIR=/path/to/xmedia-kit（或把 kit 检出为本仓同级目录）')
  process.exit(2)
}
if (!existsSync(kitSource)) {
  console.error(`kit 源码树不存在: ${kitSource}`)
  process.exit(2)
}

// ---- the vendored slice (explicit list; a missing upstream file is fatal) ----

const FILES = [
  // server + facade + mcp
  'tools/hf_studio.py',
  'tools/xmedia.py',
  'tools/xmedia_mcp.py',
  // server-side feature modules (import closure of the server)
  'tools/hf_agent.py',
  'tools/hf_asr.py',
  'tools/hf_compose.py',
  'tools/hf_import.py',
  'tools/hf_reference.py',
  'tools/hf_storyboard.py',
  'tools/hf_tts.py',
  'tools/hf_validate.py',
  'tools/studio_contract.py',
  // UI single-file build artifact (committed upstream; byte-parity gate there)
  'tools/studio_ui.html',
  // compose inlines this into generated contract pages
  'tools/gsap.min.js',
]
const DIRS = [
  // compose's builtin SFX / template fallbacks (root-asset whitelist covers
  // everything under the synced studio root)
  'assets/sfx',
  'templates',
]

// ---- the two mechanical transforms -------------------------------------------

const countOccurrences = (text, needle) => text.split(needle).length - 1

function transformXmediaPy(text) {
  const anchor =
    '    rel = [("html_bake.app", "Contents", "MacOS", "html_bake"), ("html_bake",)]'
  const seam = [
    '    # PORT SEAM (sync-studio.mjs T1): the product\'s bake CLI lives in',
    '    # engine/build (xmedia-bake) — probe it before the kit\'s own build tree.',
    '    env_bin = os.environ.get("XMEDIA_BAKE_BIN", "")',
    '    if env_bin and os.path.isfile(env_bin) and os.access(env_bin, os.X_OK):',
    '        return env_bin',
    '    _product_root = os.path.dirname(os.path.dirname(TOOLS_DIR))',
    '    for r in (("xmedia-bake.app", "Contents", "MacOS", "xmedia-bake"),',
    '              ("xmedia-bake",)):',
    '        c = os.path.join(_product_root, "engine", "build", *r)',
    '        if os.path.isfile(c) and os.access(c, os.X_OK):',
    '            return c',
  ].join('\n')
  const occurrences = countOccurrences(text, anchor)
  if (occurrences !== 1) {
    throw new Error(`T1 锚点出现 ${occurrences} 次（期望 1）——上游 bake_bin 改动了，更新本脚本的变换`)
  }
  return text.replace(anchor, `${seam}\n${anchor}`)
}

function transformHfStudioPy(text) {
  const machinePath = '/Users/samychen/Develop/avbase'
  const occurrences = countOccurrences(text, machinePath)
  if (occurrences < 3) {
    throw new Error(`T2 锚点出现 ${occurrences} 次（期望 ≥3）——上游 agent prompt 改动了，更新本脚本的变换`)
  }
  // The upstream prompt hardcodes a machine-specific checkout as the "repo
  // root" handed to the agent CLI. Parameterize it: XMEDIA_KIT_ROOT wins,
  // falling back to the synced studio root. NOTE: single quotes inside the
  // replacement — the anchor lines are double-quoted f-strings.
  return text.replaceAll(machinePath, "{os.environ.get('XMEDIA_KIT_ROOT', ROOT_DIR)}")
}

const TRANSFORMS = {
  'tools/xmedia.py': transformXmediaPy,
  'tools/hf_studio.py': transformHfStudioPy,
}

// ---- upstream commit (provenance; null when the kit has no commits) ----------

function upstreamCommit() {
  const r = spawnSync('git', ['-C', kitSource, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  const head = (r.stdout ?? '').trim()
  return r.status === 0 && /^[0-9a-f]{40}$/.test(head) ? head : null
}

// ---- copy + transform ---------------------------------------------------------

function collectFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...collectFiles(p))
    else out.push(p)
  }
  return out
}

function syncOnce() {
  const missing = [...FILES, ...DIRS].filter((f) => !existsSync(join(kitSource, f)))
  if (missing.length > 0) {
    console.error(`kit 里缺少清单内文件/目录: ${missing.join(', ')}`)
    process.exit(1)
  }
  rmSync(STUDIO_ROOT, { recursive: true, force: true })
  mkdirSync(STUDIO_ROOT, { recursive: true })
  const files = []
  for (const rel of FILES) {
    const src = join(kitSource, rel)
    const dst = join(STUDIO_ROOT, rel)
    mkdirSync(dirname(dst), { recursive: true })
    let text = readFileSync(src, 'utf8')
    const transform = TRANSFORMS[rel]
    if (transform) text = transform(text)
    writeFileSync(dst, text)
    files.push(rel)
  }
  for (const dir of DIRS) {
    const srcDir = join(kitSource, dir)
    for (const abs of collectFiles(srcDir)) {
      const rel = relative(kitSource, abs)
      const dst = join(STUDIO_ROOT, rel)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(abs, dst)
      files.push(rel)
    }
  }
  const commit = upstreamCommit()
  writeFileSync(SYNC_JSON, `${JSON.stringify({
    comment: 'HF Studio 切片的同步副本——上游 kit 是唯一真源：改上游 → 重跑 sync-studio → 提交 diff。两处机械变换（T1 bake 接缝 / T2 agent prompt 参数化）见脚本头注释，--check 闸门盯漂移。',
    upstream: kitSource,
    upstreamCommit: commit,
    syncedAt: new Date().toISOString(),
    files,
  }, null, 2)}\n`)
  console.log(`sync-studio: 已同步 ${files.length} 个文件 → studio/ (upstreamCommit=${commit ?? 'null'})`)
}

// ---- drift check --------------------------------------------------------------

function checkDrift() {
  const fail = (why) => {
    console.error(`sync-studio --check: 漂移 — ${why}`)
    process.exit(1)
  }
  if (!existsSync(SYNC_JSON)) fail('studio/SYNC.json 不存在（先跑一次同步）')
  for (const rel of FILES) {
    const src = join(kitSource, rel)
    const dst = join(STUDIO_ROOT, rel)
    if (!existsSync(src)) fail(`上游缺失 ${rel}`)
    if (!existsSync(dst)) fail(`副本缺失 ${rel}`)
    const want = TRANSFORMS[rel] ? TRANSFORMS[rel](readFileSync(src, 'utf8')) : readFileSync(src, 'utf8')
    if (readFileSync(dst, 'utf8') !== want) fail(`${rel} 与上游(经变换)不一致 — 重跑 sync-studio 并提交 diff`)
  }
  for (const dir of DIRS) {
    for (const abs of collectFiles(join(kitSource, dir))) {
      const rel = relative(kitSource, abs)
      const dst = join(STUDIO_ROOT, rel)
      // Byte comparison: two separately-read Buffers are never `===` (object
      // identity), so `!==` would report perpetual drift — measured.
      if (!existsSync(dst) ||
          Buffer.compare(readFileSync(dst), readFileSync(abs)) !== 0) {
        fail(`${rel} 与上游不一致 — 重跑 sync-studio`)
      }
    }
  }
  console.log('sync-studio: 副本与上游(经变换)一致')
}

if (check) checkDrift()
else syncOnce()
