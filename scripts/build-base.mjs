// mediabase / scripts / build-base.mjs
//
// Builds every @mediabase/* package into a PACKABLE artifact (local consumption, CI
// artifacts, hand-offs — this repo does not publish; see AGENTS.md):
//
//   packages/*/<pkg>/dist/index.mjs   bundled ESM (deps stay external)
//   packages/*/<pkg>/dist/index.d.ts  type declarations
//   packages/*/<pkg>/dist/*.map       source maps
//
// JSON-RPC/HTTP layers are libraries: a consumer must be able to install the packed
// tarball without a TypeScript toolchain, which is what `publishConfig` in each
// package.json points at (pnpm applies it to `pack` too). In-repo development keeps
// resolving `src/index.ts` (tsx/vite/vitest), so nothing here is needed for
// `pnpm run host`.
//
// Run: pnpm run build:base

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ESBUILD = join(ROOT, 'node_modules/.bin/esbuild')
const TSC = join(ROOT, 'node_modules/.bin/tsc')

if (!existsSync(ESBUILD) || !existsSync(TSC)) {
  console.error('[build-base] esbuild/typescript missing — run: pnpm install')
  process.exit(1)
}

/** Every package whose name starts with @mediabase (neutral, packable). */
function basePackages() {
  const found = []
  for (const face of readdirSync(join(ROOT, 'packages'))) {
    const faceDir = join(ROOT, 'packages', face)
    if (!statSync(faceDir).isDirectory()) continue
    for (const name of readdirSync(faceDir)) {
      const dir = join(faceDir, name)
      if (!statSync(dir).isDirectory()) continue
      const pkgJson = join(dir, 'package.json')
      if (!existsSync(pkgJson)) continue
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
      if (typeof pkg.name === 'string' && pkg.name.startsWith('@mediabase/')) found.push({ dir, pkg })
    }
  }
  return found.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))
}

// Optional filter: `node scripts/build-base.mjs @mediabase/rpc @mediabase/schema`
// (the packaging test builds only what it packs).
const filters = process.argv.slice(2).filter((a) => a.startsWith('@'))
const packages = basePackages().filter(({ pkg }) => filters.length === 0 || filters.includes(pkg.name))
if (packages.length === 0) {
  console.error('[build-base] no @mediabase/* packages found')
  process.exit(1)
}

for (const { dir, pkg } of packages) {
  const entry = ['src/index.ts', 'src/index.tsx'].map((f) => join(dir, f)).find(existsSync)
  if (!entry) {
    console.error(`[build-base] ${pkg.name}: no src/index.ts`)
    process.exit(1)
  }
  const dist = join(dir, 'dist')
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })

  // Ship the license text with every published package: `license: MIT` in
  // package.json is an SPDX id, and a consumer (or an audit tool) expects the
  // actual notice next to it. The repo keeps ONE LICENSE at the root, so it is
  // copied in here (and git-ignored at the package level).
  const license = join(ROOT, 'LICENSE')
  if (existsSync(license)) copyFileSync(license, join(dir, 'LICENSE'))

  // JS: bundle the package itself, keep dependencies external so consumers share
  // one copy of cordis/ws/schemastery.
  execFileSync(ESBUILD, [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=neutral',
    '--target=es2024',
    '--packages=external',
    '--sourcemap',
    `--outfile=${join(dist, 'index.mjs')}`,
    '--log-level=warning',
  ], { stdio: 'inherit' })

  // Types: declarations only (no emit of the JS esbuild already produced).
  // Each package is compiled STANDALONE — that is part of the publishability
  // contract: a consumer installs one package, so it must typecheck without the
  // rest of the workspace in the program.
  execFileSync(TSC, [
    '--declaration', '--emitDeclarationOnly',
    '--outDir', dist,
    '--rootDir', join(dir, 'src'),
    '--lib', 'es2024,dom,dom.iterable',
    '--types', 'node',
    '--target', 'es2024', '--module', 'esnext', '--moduleResolution', 'bundler',
    '--strict', '--skipLibCheck', '--jsx', 'react-jsx',
    // The workspace uses explicit .ts/.tsx extensions in relative imports; for a
    // declaration-only build they are allowed and rewritten to .js.
    '--allowImportingTsExtensions', '--rewriteRelativeImportExtensions',
    entry,
  ], { stdio: 'inherit' })

  console.log(`[build-base] ${pkg.name} -> dist/index.mjs + dist/index.d.ts`)
}

console.log(`[build-base] ok: ${packages.length} packages`)
