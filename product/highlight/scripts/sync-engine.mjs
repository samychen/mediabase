// product/highlight / scripts / sync-engine.mjs — import the engine core.
//
// The highlight algorithm lives in its own repository (the "engine upstream");
// this product VENDORS a copy into engine/highlight_core so the product tree is
// self-contained and dispatchable (no sibling checkout required at build or
// run time). The copy is mechanical: only the package name changes
// (`highlighter` -> `highlight_core`), so a diff against the upstream is always
// readable.
//
// The upstream stays the single source of truth — edit there, re-run this, and
// commit the resulting vendor diff. SYNC.json records the exact source commit
// so "which algorithm version is this product shipping?" has an answer.
//
// Usage:
//   node product/highlight/scripts/sync-engine.mjs
//   VHL_UPSTREAM_ENGINE=/path/to/highlighter node product/highlight/scripts/sync-engine.mjs
//   node product/highlight/scripts/sync-engine.mjs --check   # fail if out of sync

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = join(PRODUCT_ROOT, '..', '..')
const DEFAULT_UPSTREAM = join(REPO_ROOT, '..', 'video_highlight_engine', 'highlighter')
const UPSTREAM = process.env.VHL_UPSTREAM_ENGINE ?? DEFAULT_UPSTREAM
const TARGET = join(PRODUCT_ROOT, 'engine', 'highlight_core')
const MANIFEST = join(PRODUCT_ROOT, 'engine', 'SYNC.json')
const PACKAGE = 'highlight_core'

const check = process.argv.includes('--check')

if (!existsSync(UPSTREAM)) {
  console.error(
    `sync-engine: 引擎上游不存在: ${UPSTREAM}\n`
    + '  设置 VHL_UPSTREAM_ENGINE 指向包含 highlighter/ 的目录,或先检出引擎仓。',
  )
  process.exit(2)
}

/** Every .py under the upstream package, excluding caches. */
function pyFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '__pycache__' || name.endsWith('.pyc')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) pyFiles(full, out)
    else if (name.endsWith('.py')) out.push(full)
  }
  return out
}

/**
 * Rewrite the package name. Relative imports (`.config`) are untouched, so this
 * is the ONLY transformation the vendored copy needs.
 */
function rewrite(source) {
  return source
    .replaceAll('from highlighter.', `from ${PACKAGE}.`)
    .replaceAll('from highlighter import', `from ${PACKAGE} import`)
    .replaceAll('import highlighter\n', `import ${PACKAGE}\n`)
}

function upstreamCommit() {
  try {
    // `stdio` matters: a repo with no commits makes git print its usage text to
    // stderr, which used to leak into the CI gate output as if it were a failure.
    return execFileSync('git', ['-C', dirname(UPSTREAM), 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

const files = pyFiles(UPSTREAM).sort()
const manifest = {
  package: PACKAGE,
  upstream: relative(PRODUCT_ROOT, UPSTREAM),
  upstreamCommit: upstreamCommit(),
  syncedAt: new Date().toISOString(),
  files: files.map((f) => relative(UPSTREAM, f)),
}

const expected = new Map(files.map((file) => {
  const rel = relative(UPSTREAM, file)
  return [rel, rewrite(readFileSync(file, 'utf8'))]
}))

if (check) {
  const drift = []
  for (const [rel, body] of expected) {
    const target = join(TARGET, rel)
    if (!existsSync(target) || readFileSync(target, 'utf8') !== body) drift.push(rel)
  }
  if (!existsSync(MANIFEST)) drift.push('SYNC.json')
  if (drift.length > 0) {
    console.error(`sync-engine: 与上游不一致(${drift.join(', ')})—— 运行 node product/highlight/scripts/sync-engine.mjs`)
    process.exit(1)
  }
  console.log(`sync-engine: 已是最新(${expected.size} 个文件)`)
  process.exit(0)
}

rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })
for (const [rel, body] of expected) {
  const target = join(TARGET, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
}
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

// A vendored file that still names the upstream package would import a module
// that does not exist here — catch it at sync time, not at first job.
const leftovers = expected.size
  ? [...expected].filter(([, body]) => /(^|\n)\s*(from|import)\s+highlighter\b/.test(body)).map(([rel]) => rel)
  : []
if (leftovers.length > 0) {
  console.error(`sync-engine: 仍有未改写的上游包名引用: ${leftovers.join(', ')}`)
  process.exit(1)
}

console.log(`sync-engine: 已同步 ${expected.size} 个文件 → engine/highlight_core (${manifest.upstreamCommit ?? '无 git 提交'})`)
