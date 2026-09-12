// Handoff neutrality guard.
//
// "You can hand this over as a base" is a claim about files OTHER people run. This
// suite encodes it so it cannot rot:
//
//   1. no script or packaging file contains a machine-specific absolute path
//      (`/Users/...`, `/home/...`) — resolution must come from the repo root or env;
//   2. the base-usable scripts (doctor / verify.base / package / build-base / notice /
//      check-native-licenses) do not reference a product scope (`@avstudio/`) or a port
//      without reading it from env — a fork runs them unchanged;
//   3. anything that IS deployment-specific is confined to a marked block, so a fork has
//      one place to edit (verified by the marker being present);
//   4. the app shell (Electron main.cjs) keeps its identity in the PRODUCT block.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './support/host.ts'

/** Scripts a fork can run as-is (they must not know a product scope). */
const BASE_SCRIPTS = [
  'scripts/doctor.mjs',
  'scripts/verify.base.mjs',
  'scripts/package.mjs',
  'scripts/build-base.mjs',
  'scripts/notice.mjs',
  'scripts/check-native-licenses.mjs',
  'scripts/lib/host-rpc.mjs',
]

const ABSOLUTE_PATH = /\/(Users|home)\/[A-Za-z0-9._-]+\//

/** Source files under a directory, skipping generated/installed trees. */
function filesUnder(dir: string): string[] {
  const SKIP = new Set(['node_modules', 'dist', 'release', '.electron-cache', 'vendor-ffmpeg', 'out'])
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (SKIP.has(entry)) continue
    const path = join(ROOT, dir, entry)
    if (statSync(path).isDirectory()) out.push(...filesUnder(join(dir, entry)))
    else out.push(join(dir, entry))
  }
  return out
}

const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

describe('handoff neutrality', () => {
  it('has no machine-specific absolute paths in scripts/ or packaging/', () => {
    const offenders: string[] = []
    for (const dir of ['scripts', 'packaging']) {
      for (const file of filesUnder(dir)) {
        read(file).split('\n').forEach((line, i) => {
          if (trimmedIsComment(line)) return
          if (ABSOLUTE_PATH.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`)
        })
      }
    }
    expect(offenders, `machine-specific paths:\n${offenders.join('\n')}`).toEqual([])
  })

  it('keeps the base-usable scripts product-agnostic', () => {
    const offenders: string[] = []
    for (const file of BASE_SCRIPTS) {
      const source = read(file)
      // A product scope must not appear in logic (comments may mention forks).
      source.split('\n').forEach((line, i) => {
        if (trimmedIsComment(line)) return
        if (line.includes('@avstudio/')) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 90)}`)
        // A default port is fine only when it comes from the environment.
        const readsEnv = line.includes('process.env') || line.includes('env.') || line.includes('env[')
        if (line.includes('3088') && !readsEnv) {
          offenders.push(`${file}:${i + 1} hardcoded port: ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(offenders, `product coupling in base scripts:\n${offenders.join('\n')}`).toEqual([])
  })

  it('keeps product identity in clearly marked blocks (fork points)', () => {
    // The desktop shell: one PRODUCT block carries name/config dir/env prefix/resources.
    const shell = read('packaging/desktop-electron/main.cjs')
    expect(shell).toContain('PRODUCT IDENTITY')
    expect(shell).toContain('const PRODUCT = {')
    expect(shell).toContain('resources: [')
    expect(shell).toContain("title: 'Mediabase'")
    expect(shell).toContain("envPrefix: 'MEDIABASE_'")

    // doctor: the app-specific rows live in one block.
    const doctor = read('scripts/doctor.mjs')
    expect(doctor).toContain('APP CHECKS')

    // the host composition (which capabilities, in what order) is the app's choice, and it
    // lives in the bundle layer a fork edits — not in code
    const layer = read('packages/bundle/app/cordis.patch.yml')
    expect(layer).toContain('- insert:')
    expect(layer).toContain("name: '@mediabase/server'")
    expect(layer).not.toContain('@avstudio/')
  })

  it('resolves host/token/base paths from the environment, not from constants', () => {
    const helper = read('scripts/lib/host-rpc.mjs')
    expect(helper).toContain('MEDIABASE_URL')
    expect(helper).toContain('MEDIABASE_TOKEN')
    expect(helper).toContain('process.env')

    // the desktop shell resolves every injected path through its resource table
    const shell = read('packaging/desktop-electron/main.cjs')
    expect(shell).toMatch(/for \(const \[key, packaged, dev\] of PRODUCT\.resources\)/)
  })
})

/** A line whose code part is a comment (so a doc mention is not a violation). */
function trimmedIsComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}
