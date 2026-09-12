// avstudio / scripts / package.mjs
//
// Builds a portable SOURCE distribution tarball (Mode B style). Honest scope:
// this project today ships as "source + toolchain", not a binary installer — the
// tarball carries the built artifacts (engine binary + plugins, web dist,
// python sidecar) plus the full source & lockfile, and the target machine
// runs `pnpm install` + (optional) `pnpm run build:engine` to fit its own
// toolchain. See docs/INSTALL.zh.md for the full packaging story.
//
// Run: pnpm run package   ->  release/avstudio-src-<version>.tar.gz

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(join(ROOT, 'package.json'), 'utf8')))
const version = pkg.version ?? '0.1.0'
// Product name comes from the manifest (scope stripped): a fork does not edit this file.
const name = typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : 'app'
const outDir = join(ROOT, 'release')
const outFile = join(outDir, `${name}-src-${version}.tar.gz`)

mkdirSync(outDir, { recursive: true })
for (const p of [outFile]) if (existsSync(p)) execFileSync('rm', [p])

const excludes = [
  '--exclude=.git',
  '--exclude=node_modules',
  '--exclude=release',
  '--exclude=engine/build*',
  '--exclude=*.log',
  '--exclude=.DS_Store',
]

console.log('[package] archiving source distribution (excluding node_modules/.git/build dirs)...')
execFileSync('tar', ['-czf', outFile, ...excludes, '-C', ROOT, '.'], { stdio: 'inherit' })

const mb = Math.round(Number(execFileSync('wc', ['-c', outFile]).toString().trim().split(/\s+/)[0]) / 1024 / 1024)
console.log(`[package] done: ${outFile} (${mb} MB)`)
console.log('[package] contents (top):')
for (const line of execFileSync('tar', ['-tzf', outFile], { encoding: 'utf8' }).split('\n').slice(0, 16)) {
  if (line) console.log(`  ${line}`)
}
console.log('\n目标机安装步骤见 docs/INSTALL.zh.md(或 tarball 内 docs/INSTALL.zh.md)。')
