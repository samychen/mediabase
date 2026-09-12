// The browser roster: the page composes from DATA too.
//
// The host's composition is checked at boot and by `verify:compose`; the page's is checked
// here, because its failure mode is quiet — a roster row that is not regenerated leaves the
// page composing the OLD set while the file on disk claims otherwise (green tests, wrong
// app), and a shell that is not last renders an empty page with no error at all.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRoster, renderRoster } from '../scripts/gen-client-roster.mjs'
import { ROOT } from './support/host.ts'

const GENERATED = join(ROOT, 'apps/web/src/roster.generated.ts')

describe('the client roster', () => {
  it('is generated from the UI bundle and up to date', () => {
    // The same check `pnpm test` runs: regenerate into memory and compare with the file, so a
    // roster edit without regeneration fails here rather than in a browser.
    const rendered = renderRoster(readRoster())
    expect(readFileSync(GENERATED, 'utf8')).toBe(rendered)

    // ...and the generator's own CLI agrees (a deployment/CI can run it standalone).
    expect(() => execFileSync(process.execPath, [join(ROOT, 'scripts/gen-client-roster.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' }))
      .not.toThrow()
  }, 60_000)

  it('mounts registries before their consumers and the shell last', () => {
    const rows = readRoster()
    const names = rows.map((row) => row.name)
    // The order is the file's whole meaning. Asserted as relationships, not as a frozen list,
    // so adding a panel package does not fail this test but moving the shell does.
    expect(names.at(-1)).toBe('@mediabase/ui-web')
    expect(names.indexOf('@mediabase/connection')).toBeLessThan(names.indexOf('@mediabase/ui-web'))
    expect(names.indexOf('@mediabase/i18n')).toBeLessThan(names.indexOf('@mediabase/ui-web'))
    expect(names.indexOf('@mediabase/ui')).toBeLessThan(names.indexOf('@mediabase/ui-web'))
    // ...and the generated module preserves exactly that order.
    const generated = readFileSync(GENERATED, 'utf8')
    const generatedNames = [...generated.matchAll(/name: '([^']+)'/g)].map((match) => match[1])
    expect(generatedNames).toEqual(names)
  })

  it('is what the page actually mounts', () => {
    // The entry module must compose the roster, not a hand-written list: this is the test that
    // keeps the data honest about being the source of truth.
    const main = readFileSync(join(ROOT, 'apps/web/src/main.tsx'), 'utf8')
    expect(main).toContain("from './roster.generated.ts'")
    expect(main).toContain('for (const entry of CLIENT_ROSTER)')
    // No leftover direct imports of client packages in the entry.
    expect(main).not.toMatch(/import \* as \w+ from '@(mediabase|avstudio)\//)
  })
})
