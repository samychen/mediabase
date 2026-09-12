// `--dump-config` / `--dump-default-config`: the composition, printed WITHOUT booting it.
//
// This is the diagnostic a deployment needs when a profile misbehaves: it applies the same
// patch algorithm a boot mounts through, prints which layer put each row where and which
// later layer rewrote it, and never evaluates `!!js`, imports a capability or binds a port.
// Observed by RUNNING the CLI, because the output is the contract.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchFlags, loadDump } from '@mediabase/boot'
import { IDENTITY } from '../apps/cli/src/identity.ts'
import { ROOT } from './support/host.ts'

const made: string[] = []
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mediabase-dump-'))
  made.push(dir)
  return dir
}

/** Run the CLI with these flags and return its stdout (stderr is ignored: warnings only). */
function dump(...args: string[]): string {
  const dir = home()
  return execFileSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MEDIABASE_HOME: dir },
  })
}

describe('the boot-free config dump', () => {
  it('parses the flags, with the recovery diagnostic winning', () => {
    expect(launchFlags(['--profile', 'web', '--dump-config'], {}, IDENTITY)).toMatchObject({ profile: 'web', dump: 'composed' })
    expect(launchFlags(['--dump-default-config'], {}, IDENTITY)).toMatchObject({ dump: 'bundles-only' })
    // A caller that asks for both gets the diagnostic that cannot be broken by a user layer.
    expect(launchFlags(['--dump-config', '--dump-default-config'], {}, IDENTITY)).toMatchObject({ dump: 'bundles-only' })
    expect(launchFlags([], {}, IDENTITY)).toMatchObject({ dump: 'none' })
  })

  it('prints the layers, the rows, and the expressions the Loader would evaluate', () => {
    const out = dump('--dump-config')

    // The header names every layer in application order.
    expect(out).toContain('# mediabase --dump-config — web profile')
    expect(out).toContain('# layers: 2')
    expect(out).toContain('packages/bundle/app/cordis.patch.yml')

    // The rows, grouped under the layer that inserted them.
    const ids = [...out.matchAll(/^- id: (\S+)$/gm)].map((match) => match[1])
    expect(ids).toEqual([
      'include', 'log', 'api', 'settings', 'tools', 'agent', 'plugins', 'server',
    ])

    // A deployment value is printed as the EXPRESSION, not as this machine's environment —
    // and in the dialect that round-trips, so the dump is usable as a patch file.
    // SHORT names: the prefix is the boot identity's, so a row (and a dump) never spells a
    // product — piping a dump back in therefore works under any prefix.
    expect(out).toContain("file: !!js ctx.env.str('SETTINGS_FILE')")
    expect(out).toContain('root: !!js ctx.appPaths.root')
    expect(out).toContain("port: !!js ctx.env.rawNum('PORT')")
    expect(out).toContain('scope: !!js ctx.appPaths.bin')

    // Nothing was booted: no host, no session, no port.
    expect(out).not.toContain('宿主就绪')
  }, 60_000)

  it('names the layer that patched a row, and prints the winning config', () => {
    const dir = home()
    const overlay = join(dir, 'overlay.yml')
    writeFileSync(overlay, '- id: log\n  config:\n    level: debug\n    scope: from-overlay\n')

    const out = dump('--dump-config', '--patch', overlay)

    // Provenance: the bundle inserted the row, the overlay rewrote it.
    expect(out).toContain('packages/bundle/app/cordis.patch.yml, patched by ')
    expect(out).toContain(overlay)
    // ...and the config shown is the overlay's, not the bundle's.
    expect(out).toContain('level: debug')
    expect(out).toContain('scope: from-overlay')
  }, 60_000)

  it('skips the user layers entirely for the recovery diagnostic', () => {
    const dir = home()
    const overlay = join(dir, 'overlay.yml')
    // A user layer that would make a boot fail must not stop the dump that explains it.
    writeFileSync(overlay, '- insert:\n    - id: broken\n      name: !!! not yaml\n')

    const out = dump('--dump-default-config', '--patch', overlay)

    expect(out).toContain('(bundles only)')
    expect(out).toContain('# layers: 1')
    expect(out).not.toContain('overlay.yml')
    expect([...out.matchAll(/^- id: (\S+)$/gm)]).toHaveLength(8)
  }, 60_000)

  it('round-trips: the printed text parses back into rows', () => {
    const dir = home()
    const file = join(dir, 'dump.yml')
    writeFileSync(file, dump('--dump-config'))

    const rows = loadDump(file, IDENTITY.bin)
    expect(rows.map((row) => row.id)).toEqual([
      'include', 'log', 'api', 'settings', 'tools', 'agent', 'plugins', 'server',
    ])
    // An expression survives the round trip as an expression node, ready to be mounted.
    const settings = rows.find((row) => row.id === 'settings')
    expect(settings?.config).toMatchObject({ file: { __jsExpr: "ctx.env.str('SETTINGS_FILE')" } })
  }, 60_000)
})
