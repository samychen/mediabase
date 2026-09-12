// mediabase / scripts / build-host-bundle.mjs
//
// Bundles the Node host (apps/cli + workspace packages, tsx-free) into a single
// file for packaging (plain `node build/host.cjs`, Node SEA, or an Electron child
// process). Runtime resource paths come from MEDIABASE_* env (see apps/cli).
//
// It also emits the CLOSED RUNTIME the host needs to compose without a
// `node_modules`: the composition mounts rows by module specifier, and inside a
// bundle there is nothing beside it to resolve those names from. So every bare
// name in the shipped bundle layer is bundled into `build/plugins/<slug>.cjs` and
// listed in `build/plugins.json`; the host reads that manifest when it exists and
// mounts the bundled file instead of resolving the name (see
// `packages/host/boot (profile-boot)`). The row list comes from the bundle layer
// itself, so adding a capability cannot leave this manifest stale.
//
// Run: pnpm run build:host

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// The loader's own dialect, so `!!js` under `config` parses as an expression node
// instead of failing the build with an unknown-tag error.
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'build/host.cjs')
mkdirSync(join(ROOT, 'build'), { recursive: true })
if (existsSync(OUT)) rmSync(OUT)

const esbuildBin = join(ROOT, 'node_modules/.bin/esbuild')
if (!existsSync(esbuildBin)) {
  console.error('[build-host] esbuild not found — run: pnpm add -w -D esbuild')
  process.exit(1)
}

// CJS has no import.meta, and the host resolves its default resource paths
// relative to its own module URL. Pretend the bundle still lives at the source
// entry, so `node build/host.cjs` from the repo finds engine/bin, python/ and
// apps/web/dist exactly like `pnpm run host` does. MEDIABASE_* env still wins
// (the packaged app sets them to its Resources paths).
const SOURCE_URL = pathToFileURL(join(ROOT, 'apps/cli/src/index.ts')).href

execFileSync(
  esbuildBin,
  [join(ROOT, 'apps/cli/src/index.ts'),
    '--bundle', '--platform=node', '--format=cjs',
    `--define:import.meta.url=${JSON.stringify(SOURCE_URL)}`,
    `--outfile=${OUT}`, '--log-level=warning'],
  { stdio: 'inherit' },
)
execFileSync(
  esbuildBin,
  [join(ROOT, 'examples/plugins/hello.ts'),
    '--bundle', '--platform=node', '--format=cjs',
    '--outfile=' + join(ROOT, 'build/examples/hello.cjs'), '--log-level=warning'],
  { stdio: 'inherit' },
)
execFileSync(
  esbuildBin,
  [join(ROOT, 'examples/plugins/sandboxed-demo.ts'),
    '--bundle', '--platform=node', '--format=cjs',
    '--outfile=' + join(ROOT, 'build/examples/sandboxed-demo.cjs'), '--log-level=warning'],
  { stdio: 'inherit' },
)
// The sandbox entry runs in a CHILD process, so it must exist as its own file next
// to the bundle (`build/sandbox.cjs`); @mediabase/plugins resolves it from the app root.
execFileSync(
  esbuildBin,
  [join(ROOT, 'packages/host/plugins/sandbox/entry.ts'),
    '--bundle', '--platform=node', '--format=cjs',
    '--outfile=' + join(ROOT, 'build/sandbox.cjs'), '--log-level=warning'],
  { stdio: 'inherit' },
)
// ------------------------------------------------------------------------- closed runtime
const BUNDLE_LAYER = join(ROOT, 'packages/bundle/app/cordis.patch.yml')

/** Every bare row specifier the shipped bundle layer names, in mount order, deduplicated. */
function bareRowNames() {
  const entries = yaml.load(readFileSync(BUNDLE_LAYER, 'utf8'), { schema: entryListSchema })
  const names = []
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (typeof value.name === 'string' && !value.name.startsWith('cordis:')
      && !value.name.startsWith('.') && !value.name.startsWith('/')) {
      if (!names.includes(value.name)) names.push(value.name)
    }
    if (Array.isArray(value.insert)) walk(value.insert)
  }
  walk(entries)
  return names
}

/** `@mediabase/log` -> `mediabase-log.cjs`: a file name that survives every filesystem. */
const slugOf = (name) => `${name.replace(/^@/, '').replaceAll('/', '-')}.cjs`

const pluginDir = join(ROOT, 'build/plugins')
rmSync(pluginDir, { recursive: true, force: true })
mkdirSync(pluginDir, { recursive: true })

// SHARED modules: a package whose runtime IDENTITY must be one object across every plugin.
// `@mediabase/rpc` is the only one today, and it is not a style choice: `makeServer` decides
// between a coded error and an internal failure with `e instanceof RpcError`, so a plugin
// that threw one copy of that class and a server that holds another would turn every
// capability's `-32001`/`-32602` into `-32603` and drop its `messageKey` — exactly what the
// first bundled run measured. Bundled once into `build/node_modules/<name>` (a real install
// layout, so the plugins' `require()` finds it by ordinary Node resolution, with no
// absolute paths that break when the app directory moves).
const SHARED_MODULES = ['@mediabase/rpc']
const sharedRoot = join(ROOT, 'build/node_modules')
rmSync(sharedRoot, { recursive: true, force: true })
for (const name of SHARED_MODULES) {
  const dir = join(sharedRoot, ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  execFileSync(
    esbuildBin,
    [name,
      '--bundle', '--platform=node', '--format=cjs',
      `--outfile=${join(dir, 'index.cjs')}`, '--log-level=warning'],
    { stdio: 'inherit', cwd: ROOT },
  )
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name,
    version: '0.0.0',
    private: true,
    description: 'shared single instance of a base module, bundled for the closed runtime',
    main: 'index.cjs',
  }, null, 2)}\n`)
}

const names = bareRowNames()
const plugins = {}
/** Shared modules an emitted plugin actually requires (a subset is fine; a typo is not). */
const sharedSet = new Set()
for (const name of names) {
  const file = slugOf(name)
  execFileSync(
    esbuildBin,
    [name,
      '--bundle', '--platform=node', '--format=cjs',
      // The framework is passed INTO a plugin, never imported by it: every capability's
      // cordis import is type-only, so a shared instance is not needed and bundling one
      // per plugin would only duplicate it.
      '--external:@deepseek-ai/cordis',
      // Identity-sensitive base modules stay external and resolve to the single copy in
      // build/node_modules (see SHARED_MODULES above).
      ...SHARED_MODULES.map((name) => `--external:${name}`),
      `--outfile=${join(pluginDir, file)}`, '--log-level=warning'],
    { stdio: 'inherit', cwd: ROOT },
  )
  plugins[name] = `plugins/${file}`
  // Report the external requires, so a module added to that set is visible in the build
  // output rather than discovered by a wrong error code in a packaged app.
  const required = new Set(
    [...readFileSync(join(pluginDir, file), 'utf8').matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]),
  )
  for (const dep of required) {
    if (!SHARED_MODULES.includes(dep)) continue
    if (!sharedSet.has(dep)) sharedSet.add(dep)
  }
}

const manifestPath = join(ROOT, 'build/plugins.json')
writeFileSync(manifestPath, `${JSON.stringify({
  // Explains itself to whoever opens the file in a packaged app.
  note: 'closed runtime for build/host.cjs: bare row specifier -> bundled module (see packages/host/boot (profile-boot))',
  generatedFrom: 'packages/bundle/app/cordis.patch.yml',
  plugins,
}, null, 2)}\n`)

console.log(`[build-host] ok: ${OUT}`)
console.log(`[build-host] closed runtime: ${names.length} plugins + ${manifestPath.replace(`${ROOT}/`, '')}`)
console.log(`[build-host] shared single instances: ${[...sharedSet].sort().join(', ') || '(none required)'}`)
