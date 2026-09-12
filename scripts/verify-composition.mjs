// mediabase / scripts / verify-composition.mjs — the static gate over patch layers.
//
// A composition is DATA, so its mistakes stay invisible until a specific deployment boots:
// a row that names a package the app does not depend on, a `!!js` expression where the
// Loader never interpolates, a patch that targets an id no layer declares. Each one is
// cheap to check here and expensive to discover there — the runtime counterpart is the
// pre-flight in `packages/host/boot (profile-boot)`, which resolves rows before mounting and
// names the row that failed.
//
// What this checks, per layer (patch file), and per CLIENT roster (`client.yml`, the
// browser's own composition — same row shape, no patch semantics):
//
//   1. the file is a top-level LIST of entries (the Loader's contract);
//   2. only `config` and `disabled` carry `!!js` expressions. The Loader interpolates
//      exactly those two against the loader context; an expression in `id`/`name`/`inject`
//      stays truthy DATA, so the row would compose something other than what it says;
//   3. every BARE row name is resolvable from the manifest that OWNS the layer — a bundle
//      layer from that bundle's `package.json`, anything else (a profile's own layer, a
//      `--patch` overlay a deployment passes) from the app's (`apps/cli/package.json`):
//      that is the package a bare name has to be a dependency of;
//   4. no layer inserts the same id twice (the Loader refuses a duplicate at mount);
//   5. a patch (an entry with an `id` and no `name`) targets an id SOME layer declares —
//      otherwise a typo silently changes nothing;
//   6. in a client roster: every row is just `id` + `name` (there is no patch step in a
//      page), ids do not repeat, and the SHELL the bundle's manifest names is last — the
//      shell mounts React and renders what `ctx.ui` already holds, so a roster that puts it
//      anywhere else renders an empty page with no error.
//
// Run:  pnpm run verify:compose                       # every layer the repo ships
//       node scripts/verify-composition.mjs <file…>   # a deployment's own layers
//
// Exit code 1 with one line per violation, 0 with a one-line summary.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
// The Loader's own dialect: `!!js` must survive parsing as an expression node, or the gate
// would report every expression as a YAML error instead of inspecting where it sits.
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Entry fields the Loader never interpolates: a `!!js` expression there is inert data. */
const STATIC_FIELDS = ['id', 'name', 'inject', 'intercept', 'isolate', 'provide']
/** The only two entry fields the Loader evaluates `!!js` in. */
const DYNAMIC_FIELDS = new Set(['config', 'disabled'])

/** True for the Loader's own builtins (`cordis:include`, `cordis:group`, …). */
const isBuiltin = (name) => name.startsWith('cordis:')
/** True for a specifier a layer resolves itself, beside the profile. */
const isPath = (name) => name.startsWith('.') || name.startsWith('/')
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const errors = []
const fail = (file, message) => errors.push(`${file}: ${message}`)

/** Is this YAML node a serialized `!!js` expression? (the Loader's own node shape) */
export function isJsExpr(value) {
  return value instanceof Object && !Array.isArray(value) && '__jsExpr' in value
}

/** Every path inside one value tree where a `!!js` expression appears. */
export function jsExprPaths(value, path = '') {
  if (isJsExpr(value)) return [path === '' ? '(根)' : path]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item, index) => jsExprPaths(item, `${path}[${index}]`))
  return Object.entries(value).flatMap(([key, item]) => jsExprPaths(item, path === '' ? key : `${path}.${key}`))
}

/** The ids an entry DECLARES (its own, plus everything it `insert`s), depth-first. */
export function declaredIds(entry) {
  const ids = []
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!isRecord(value)) return
    if (typeof value.name === 'string' && typeof value.id === 'string') ids.push(value.id)
    if (Array.isArray(value.insert)) walk(value.insert)
    if (isBuiltin(String(value.name)) && isRecord(value.config) && Array.isArray(value.config.patches)) {
      walk(value.config.patches)
    }
  }
  walk(entry)
  return ids
}

/**
 * Validate one entry, recursing into the places rows hide: `insert` lists, and the
 * `patches` of a `cordis:include` row.
 */
function checkEntry(entry, file, path, ctx) {
  if (!isRecord(entry)) {
    fail(file, `${path} 必须是对象(loader 条目)`)
    return
  }
  // (2) an expression where the Loader will never look
  for (const field of STATIC_FIELDS) {
    if (!(field in entry)) continue
    for (const where of jsExprPaths(entry[field])) {
      fail(file, `${path}.${field} 里有 !!js 表达式(${where}):loader 只对 config/disabled 求值,这里会当作普通数据`)
    }
  }
  // (3) a bare name must resolve from the layer's OWN manifest
  if (typeof entry.name === 'string') {
    const id = typeof entry.id === 'string' ? entry.id : '(未命名)'
    if (!isBuiltin(entry.name) && !isPath(entry.name)) {
      try {
        ctx.require.resolve(entry.name)
      } catch {
        fail(file, `行 "${id}" 的模块 ${entry.name} 无法从 ${ctx.manifest} 解析:把它加进该清单的 dependencies`)
      }
    }
  }
  if (Array.isArray(entry.insert)) {
    entry.insert.forEach((item, index) => checkEntry(item, file, `${path}.insert[${index}]`, ctx))
  }
  if (isBuiltin(String(entry.name)) && isRecord(entry.config) && Array.isArray(entry.config.patches)) {
    entry.config.patches.forEach((item, index) => checkEntry(item, file, `${path}.config.patches[${index}]`, ctx))
  }
}

/** True for a file that is a CLIENT roster rather than a host patch layer. */
export function isClientRoster(file) {
  return file.replaceAll('\\', '/').endsWith('/client.yml')
}

/**
 * Validate a client roster: the browser's composition, in the same row shape.
 *
 * A roster has no patch step (nothing to override at runtime in a page that is built), so a
 * row is `id` + `name` plus an optional plain `config` object (no `!!js` — the page never
 * evaluates loader expressions), and mount ORDER is the whole meaning of the file — which is
 * why the shell's position is checked against the manifest's own `mediabase.uiBundle.shell`
 * (with a legacy `avstudio.uiBundle.shell` fallback) rather than trusted to a comment.
 */
export function checkClientRoster(file) {
  const before = errors.length
  const entries = loadEntries(file)
  if (entries === undefined) return false
  // A roster ships INSIDE the bundle that owns it, next to that bundle's manifest — so the
  // manifest beside the file is the owner, and a deployment's own UI bundle works the same
  // way without living under this repo's `packages/bundle/`.
  const beside = join(dirname(file), 'package.json')
  const manifestPath = existsSync(beside) ? beside : ownerManifest(file)
  const ctx = { require: createRequire(manifestPath), manifest: relative(ROOT, manifestPath) }
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    fail(file, `无法读取所属清单 ${ctx.manifest}`)
  }
  const ids = new Set()
  entries.forEach((entry, index) => {
    const path = `[${index}]`
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
      fail(file, `${path} 客户端名册每行需要 id + name(可选 config)`)
      return
    }
    const keys = Object.keys(entry)
    for (const key of keys) {
      if (key !== 'id' && key !== 'name' && key !== 'config') {
        fail(file, `${path} 客户端名册不允许字段 "${key}"(只认 id/name/config)`)
      }
    }
    if ('config' in entry) {
      if (!isRecord(entry.config) || Array.isArray(entry.config)) {
        fail(file, `${path}.config 必须是对象`)
      } else {
        for (const where of jsExprPaths(entry.config)) {
          fail(file, `${path}.config 里有 !!js 表达式(${where}):页面不会对名册求值`)
        }
      }
    }
    if (ids.has(entry.id)) fail(file, `客户端插件 id "${entry.id}" 重复`)
    ids.add(entry.id)
    checkEntry(entry, file, path, ctx)
  })
  const shell = manifest?.mediabase?.uiBundle?.shell ?? manifest?.avstudio?.uiBundle?.shell
  const last = entries.at(-1)
  if (typeof shell === 'string' && isRecord(last) && last.name !== shell) {
    fail(file, `最后一行必须是外壳 ${shell}(现在是 ${String(last.name)})——外壳挂载 React 并渲染已注册面板,必须在所有面板包之后`)
  }
  return errors.length === before
}

/** Read one layer's entries, or `undefined` when the file is absent/malformed. */
function loadEntries(file) {
  let parsed
  try {
    parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
  } catch (e) {
    fail(file, `不是合法 YAML:${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
  if (!Array.isArray(parsed)) {
    fail(file, '顶层必须是数组(loader patch 条目)')
    return undefined
  }
  return parsed
}

/** The manifest a layer's bare names must be declared in, as a repo-relative path. */
export function ownerManifest(file) {
  const normalized = file.replaceAll('\\', '/')
  const bundle = /^(.*\/packages\/bundle\/[^/]+)\/(?:cordis\.patch\.yml|cordis\.yml|client\.yml)$/.exec(normalized)
  if (bundle) return join(bundle[1], 'package.json')
  return join(ROOT, 'apps', 'cli', 'package.json')
}

/**
 * Validate one layer.
 *
 * `declared` accumulates the ids every layer so far declared, so a patch in a LATER layer
 * can be checked against them — the override that makes a bundle reusable instead of
 * forkable. Each layer's own ids are collected first, so the check does not depend on the
 * order of a patch and the insert it targets within one file.
 */
export function checkLayer(file, declared) {
  const before = errors.length
  const entries = loadEntries(file)
  if (entries === undefined) return declared
  const ctx = {
    require: createRequire(ownerManifest(file)),
    manifest: relative(ROOT, ownerManifest(file)),
  }

  // (4) a layer may not insert one id twice
  const own = []
  for (const entry of entries) for (const id of declaredIds(entry)) own.push(id)
  for (const id of new Set(own)) {
    if (own.filter((item) => item === id).length > 1) fail(file, `行 id "${id}" 在本层被插入了两次`)
  }

  const available = new Set([...declared, ...own])
  entries.forEach((entry, index) => {
    const path = `[${index}]`
    checkEntry(entry, file, path, ctx)
    if (!isRecord(entry)) return
    // (5) a patch must target something a layer declares
    const isPatch = entry.name === undefined && typeof entry.id === 'string'
    if (isPatch && !available.has(entry.id)) {
      fail(file, `${path} 覆盖行 "${entry.id}",但没有任何层声明这个 id(id 打错了?)`)
    }
  })

  for (const id of own) declared.add(id)
  return errors.length === before ? declared : declared
}

/** Every layer the repo ships, in application order (bundle layers, then the app's own). */
export function repoLayers() {
  const files = []
  const bundleRoot = join(ROOT, 'packages', 'bundle')
  if (existsSync(bundleRoot)) {
    for (const name of readdirSync(bundleRoot).sort()) {
      // Both halves of a bundle: the host layer it contributes and, when it has one, the
      // browser roster it ships.
      for (const candidate of ['cordis.patch.yml', 'client.yml']) {
        const file = join(bundleRoot, name, candidate)
        if (existsSync(file)) files.push(file)
      }
    }
  }
  const appConfig = join(ROOT, 'apps', 'cli', 'config')
  if (existsSync(appConfig)) {
    for (const name of readdirSync(appConfig).sort()) {
      if (/\.cordis\.ya?ml$|\.patch\.yml$/.test(name)) files.push(join(appConfig, name))
    }
  }
  return files
}

const argv = process.argv.slice(2)
const files = argv.length > 0 ? argv.map((file) => resolve(file)) : repoLayers()
const declared = new Set()
let checked = 0
for (const file of files) {
  const ok = isClientRoster(file) ? checkClientRoster(file) : checkLayer(file, declared) !== undefined
  if (ok) checked++
}

if (errors.length > 0) {
  console.error('verify-composition: 组合层有问题:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `verify-composition: ${checked} 个组合文件通过(裸包名都在所属清单的 dependencies 里,`
    + '!!js 只出现在 config/disabled,覆盖的 id 都存在,客户端名册以外壳收尾)。',
  )
}
