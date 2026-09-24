// The product's page composition is DATA too — the same quiet failure mode
// the base guards: a roster row that is not regenerated leaves the page
// composing the OLD set, and a shell that is not last renders an empty page
// with no error at all.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRoster, renderRoster } from '../scripts/gen-client-roster.mjs'
import { PRODUCT_ROOT } from './support/host.ts'

const GENERATED = join(PRODUCT_ROOT, 'apps/web/src/roster.generated.ts')

describe('the openvideo client roster', () => {
  it('is generated from the product UI bundle and up to date', () => {
    const rendered = renderRoster(readRoster())
    expect(readFileSync(GENERATED, 'utf8')).toBe(rendered)

    // ...and the generator's own CLI agrees (CI can run it standalone).
    expect(() => execFileSync(
      process.execPath,
      [join(PRODUCT_ROOT, 'scripts/gen-client-roster.mjs'), '--check'],
      { cwd: PRODUCT_ROOT, encoding: 'utf8' },
    )).not.toThrow()
  }, 60_000)

  it('mounts the base registries, then the editor, and the shell LAST', () => {
    const rows = readRoster()
    const names = rows.map((row) => row.name)
    expect(names.at(-1)).toBe('@mediabase/ui-web')
    for (const registry of ['@mediabase/connection', '@mediabase/i18n', '@mediabase/ui']) {
      expect(names.indexOf(registry)).toBeLessThan(names.indexOf('@openvideo/ui-editor'))
    }
    // ...and the generated module preserves exactly that order.
    const generated = readFileSync(GENERATED, 'utf8')
    const generatedNames = [...generated.matchAll(/name: '([^']+)'/g)].map((match) => match[1])
    expect(generatedNames).toEqual(names)
  })

  it('titles the shell as the product (branding is roster config, not code)', () => {
    const source = readFileSync(GENERATED, 'utf8')
    expect(source).toContain('"title":"OpenVideo"')
  })

  it('is what the page actually mounts', () => {
    const main = readFileSync(join(PRODUCT_ROOT, 'apps/web/src/main.tsx'), 'utf8')
    expect(main).toContain("from './roster.generated.ts'")
    expect(main).toContain('for (const entry of CLIENT_ROSTER)')
  })
})
