// The generated config catalog: what each row of the shipped composition may say.
//
// Two failure modes are worth a test, and neither is visible by reading the code:
//   * the catalog goes STALE (a row or a `Config` changes, the file does not), which is worse
//     than no catalog because a fork author trusts it;
//   * the catalog silently drops a row, which reads as "this row accepts nothing".

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCatalog, renderCatalogJson, renderCatalogMarkdown } from '../scripts/gen-config-catalog.ts'
import { PROFILE_PATCH_FILENAME, insertedRows, loadPatches } from '@mediabase/boot'
import { IDENTITY } from '../apps/cli/src/identity.ts'
import { ROOT } from './support/host.ts'

const catalog = await buildCatalog()

describe('the generated config catalog', () => {
  it('is up to date with the rows and the Config schemas', () => {
    // The same check the CLI's `--check` runs, in-process (a mismatch names the file).
    expect(readFileSync(join(ROOT, 'docs/CONFIG-CATALOG.md'), 'utf8')).toBe(renderCatalogMarkdown(catalog))
    expect(readFileSync(join(ROOT, 'docs/config-catalog.json'), 'utf8')).toBe(renderCatalogJson(catalog))

    expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-config-catalog.ts', '--check'], { cwd: ROOT, encoding: 'utf8' }))
      .not.toThrow()
  }, 60_000)

  it('covers exactly the rows the shipped bundle declares', () => {
    const rows = insertedRows(loadPatches(join(ROOT, 'packages/bundle/app', PROFILE_PATCH_FILENAME), true, IDENTITY.bin)!)
    expect(catalog.map((entry) => entry.id)).toEqual(rows.map((row) => row.id))
  })

  it('reports what a row states as the expression, and what the capability accepts', () => {
    const server = catalog.find((entry) => entry.id === 'server')!
    expect(server.stated['port']).toEqual({ __jsExpr: "ctx.env.rawNum('PORT')" })
    expect(server.schema?.properties?.['port']?.default).toBe(3088)
    expect(server.schema?.required).toEqual(['root'])

    // A field whose ABSENCE is meaningful is NOT required: `plugins.catalog` defaults in the
    // capability, so a row may omit it (and `[]` would mean something different).
    const plugins = catalog.find((entry) => entry.id === 'plugins')!
    expect(plugins.schema?.required).toBeUndefined()
    expect(JSON.stringify(plugins.schema)).not.toContain('"catalog"')
    // The prefix travels in the row, because two base capabilities read the environment
    // themselves (sandbox entry / demo catalog) and must not hardcode a product name.
    expect(plugins.stated['envPrefix']).toEqual({ __jsExpr: 'ctx.env.prefix' })
    expect(plugins.schema?.properties?.['envPrefix']?.description).toContain('MEDIABASE_')
  })

  it('renders the JSON in a form tooling can read', () => {
    const json = JSON.parse(readFileSync(join(ROOT, 'docs/config-catalog.json'), 'utf8')) as {
      rows: Array<{ id: string; module: string; stated: Record<string, unknown> }>
    }
    expect(json.rows).toHaveLength(catalog.length)
    const settings = json.rows.find((row) => row.id === 'settings')!
    // JSON has no tag for `!!js`, so the expression travels as a string a tool can spot.
    expect(settings.stated['file']).toBe("!!js ctx.env.str('SETTINGS_FILE')")
  })
})
