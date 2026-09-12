// Base packages must be PACKABLE (and must NOT be publishable) — proven with real
// artifacts. This repo does not publish: every package is `private: true`, so
// `pnpm publish` is refused by the tool. What this suite verifies instead is that a
// tarball produced by `pnpm pack` is usable by another project without this repo's
// TypeScript toolchain — the property that makes `@mediabase/*` genuinely reusable
// (private consumption, CI artifacts, hand-offs), with publication impossible.
//
// It builds and packs the real packages and then:
//   1. inspects the tarball (dist only, publishConfig applied, deps declared),
//   2. installs @mediabase/rpc into a scratch project and RUNS it with plain Node.
//
// @mediabase/rpc is the zero-dependency case (it must work offline, i.e. it really
// pulls nothing); @mediabase/schema is the dependency case (its runtime deps must be
// declared so a consumer installs them).
//
// NOTE: this suite shells out to `pnpm pack` (which applies publishConfig and
// files) and therefore takes ~20s — it is the price of testing real artifacts
// instead of asserting the manifest shape by hand.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT } from './support/host.ts'

const PACKAGED: string[] = []

const packed = new Map<string, { tgz: string; manifest: Record<string, unknown>; entries: string[] }>()

/** `pnpm pack` applies publishConfig + files, so it is the real artifact (slow: ~10s).
 *  NOTE: packing is local — nothing is uploaded, and `private: true` makes an
 *  accidental `pnpm publish` fail rather than ship. */
function pack(pkgDir: string): { tgz: string; manifest: Record<string, unknown>; entries: string[] } {
  const cached = packed.get(pkgDir)
  if (cached) return cached
  const out = execFileSync('pnpm', ['pack'], { cwd: join(ROOT, pkgDir), encoding: 'utf8' })
  const tgz = out.trim().split('\n').at(-1)!.trim()
  const abs = join(ROOT, pkgDir, tgz)
  PACKAGED.push(abs)
  const entries = execFileSync('tar', ['-tzf', abs], { encoding: 'utf8' }).trim().split('\n')
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', abs, 'package/package.json'], { encoding: 'utf8' })) as Record<string, unknown>
  const result = { tgz: abs, manifest, entries }
  packed.set(pkgDir, result)
  return result
}

beforeAll(() => {
  // Only the two packages this suite packs (a full base build is ~15 tsc runs).
  execFileSync(process.execPath, ['scripts/build-base.mjs', '@mediabase/rpc', '@mediabase/schema'], { cwd: ROOT, stdio: 'inherit' })
}, 180_000)

afterAll(() => {
  for (const tgz of PACKAGED) rmSync(tgz, { force: true })
})

describe('packable base packages (publishing is blocked by private:true)', () => {
  it('packs @mediabase/rpc as compiled dist (pnpm pack applies publishConfig)', () => {
    const { manifest, entries } = pack('packages/base/rpc')
    expect(manifest['main']).toBe('dist/index.mjs')
    expect(manifest['types']).toBe('dist/index.d.ts')
    expect(manifest['license']).toBe('MIT')
    expect(entries).toContain('package/dist/index.mjs')
    expect(entries).toContain('package/dist/index.d.ts')
    // the SPDX id in package.json plus the actual notice next to it
    expect(entries).toContain('package/LICENSE')
    expect(execFileSync('tar', ['-xzOf', pack('packages/base/rpc').tgz, 'package/LICENSE'], { encoding: 'utf8' }))
      .toContain('MIT License')
    // consumers get compiled output, never this repo's sources
    expect(entries.some((e) => e.startsWith('package/src/'))).toBe(false)
    // and the pack is explicitly non-publishable: `pnpm publish` refuses private packages
    expect(manifest['private']).toBe(true)
  })

  it('declares the runtime dependencies a consumer must install (@mediabase/schema)', () => {
    const { manifest, entries } = pack('packages/base/schema')
    expect(manifest['dependencies']).toMatchObject({ '@deepseek-ai/schemastery': expect.any(String) })
    expect(entries).toContain('package/dist/index.d.ts')
  })

  it('is usable from another project with plain Node (no TypeScript toolchain)', () => {
    const { tgz } = pack('packages/base/rpc')
    const project = mkdtempSync(join(tmpdir(), 'mediabase-consumer-'))
    try {
      // Install the packed artifact the way a package manager would lay it out
      // (extract to node_modules/<name>) — fast, offline, and exactly the bytes a
      // consumer would get. Package-manager metadata correctness is asserted by
      // the manifest checks above.
      execFileSync('bash', ['-c', `mkdir -p node_modules/@mediabase/rpc && tar -xzf ${tgz} -C node_modules/@mediabase/rpc --strip-components=1`], { cwd: project })

      // A real round-trip through the packed artifact: if the packed entry points
      // at sources or misses dist, this fails.
      const program = `
        import { makeServer, makeClient } from '@mediabase/rpc'
        const handle = makeServer({ 'demo.echo': async (p) => ({ got: p }) })
        // client -> wire -> server -> wire -> client, entirely inside the artifact
        const client = makeClient((raw) => { handle(raw).then((resp) => resp && client.handle(resp)) })
        console.log(JSON.stringify(await client.call('demo.echo', { x: 1 })))
      `
      // If the client left its 30s timeout timer armed, this child would hang for
      // 30s after printing — the assertion below would pass but the suite would
      // crawl, so the timing itself is part of the check.
      const started = Date.now()
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', program], { cwd: project, encoding: 'utf8' })
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(JSON.parse(stdout.trim())).toEqual({ got: { x: 1 } })

      // The installed package.json is the PACKED one (pnpm applies publishConfig
      // to `pack` as well — the field name is npm's historical convention).
      const installed = JSON.parse(readFileSync(join(project, 'node_modules/@mediabase/rpc/package.json'), 'utf8')) as { main: string }
      expect(installed.main).toBe('dist/index.mjs')
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  }, 120_000)
})
