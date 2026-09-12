// mediabase / scripts / gen-config-catalog.ts — every row's contract, in one file.
//
// A composition is data, and a capability's `Config` is the contract for its row. That is two
// places to look for one answer ("what may this row say?"), and reading seven packages to
// answer it is how a fork author gives up and edits a row by trial and error. This generates
// the answer instead, from BOTH sources so they cannot drift:
//
//   * the rows the shipped bundle declares (`packages/bundle/app/cordis.patch.yml`) — what the
//     composition states, `!!js` expressions included;
//   * each row's `Config` schema — what the capability will accept, defaults included.
//
// Run:  pnpm run gen:config-catalog            # rewrite docs/CONFIG-CATALOG.md + .json
//       tsx scripts/gen-config-catalog.ts --check   # fail when stale (a test runs this)

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
// A relative import on purpose: this script lives outside the workspace packages, so a bare
// `@mediabase/schema` has nothing to resolve from (the same reason the capability modules below
// are resolved through the app's manifest).
import { toJsonSchema, type JsonSchema } from '../packages/base/schema/src/index.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE_LAYER = join(ROOT, 'packages/bundle/app/cordis.patch.yml')
const MARKDOWN = join(ROOT, 'docs/CONFIG-CATALOG.md')
const JSON_OUT = join(ROOT, 'docs/config-catalog.json')

/** One row of the shipped bundle, with what it states and what its capability accepts. */
export interface CatalogEntry {
  id: string
  module: string
  /** The row's own `config`, `!!js` kept as expression nodes (so a YAML dump round-trips). */
  stated: Record<string, unknown>
  /** The capability's `Config` as JSON Schema, when it exports one. */
  schema?: JsonSchema
}

/** Rows the bundle layer inserts, in mount order. */
function bundleRows(): Array<{ id: string; name: string; config: Record<string, unknown> }> {
  const entries = yaml.load(readFileSync(BUNDLE_LAYER, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(entries)) throw new Error(`gen-config-catalog: ${BUNDLE_LAYER} 顶层必须是数组`)
  const rows: Array<{ id: string; name: string; config: Record<string, unknown> }> = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const entry = value as Record<string, unknown>
    if (typeof entry['id'] === 'string' && typeof entry['name'] === 'string') {
      rows.push({
        id: entry['id'],
        name: entry['name'],
        config: (entry['config'] as Record<string, unknown> | undefined) ?? {},
      })
    }
    if (Array.isArray(entry['insert'])) walk(entry['insert'])
  }
  walk(entries)
  return rows
}

/**
 * The row's stated config, with `!!js` left as the node the include's dialect round-trips —
 * the Markdown dump then prints `!!js ctx…`, which is what the file actually says.
 */
function statedNodes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(statedNodes)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (typeof record['__jsExpr'] === 'string') return { __jsExpr: record['__jsExpr'] }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, statedNodes(item)]))
}

/** The same values for JSON, where a tag cannot be represented: `"!!js ctx…"`. */
function statedForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(statedForJson)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (typeof record['__jsExpr'] === 'string') return `!!js ${record['__jsExpr']}`
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, statedForJson(item)]))
}

/**
 * Import every row's capability and collect its `Config`.
 *
 * A module that cannot be imported is reported rather than skipped: the catalog exists to be
 * trustworthy, and a row whose contract is missing would look like "this row accepts nothing".
 */
export async function buildCatalog(): Promise<CatalogEntry[]> {
  const catalog: CatalogEntry[] = []
  for (const row of bundleRows()) {
    let schema: JsonSchema | undefined
    try {
      // Resolve the row's specifier the way the host will (through the app's manifest), so
      // the catalog describes the modules a boot would actually mount.
      const resolved = createRequire(join(ROOT, 'apps/cli/package.json')).resolve(row.name)
      const module = (await import(pathToFileURL(resolved).href)) as { Config?: unknown }
      if (module.Config !== undefined) schema = toJsonSchema(module.Config as never)
    } catch (e) {
      throw new Error(
        `gen-config-catalog: 无法 import 行 "${row.id}" 的模块 ${row.name}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      )
    }
    catalog.push({
      id: row.id,
      module: row.name,
      stated: statedNodes(row.config) as Record<string, unknown>,
      ...(schema === undefined ? {} : { schema }),
    })
  }
  return catalog
}

/** Flatten a JSON Schema object into one row per field, dotted for nested objects. */
function schemaRows(
  schema: JsonSchema | undefined,
  prefix = '',
  isRequired = false,
): Array<Record<string, string>> {
  if (schema === undefined) return []
  if (schema.type === 'object' && schema.properties !== undefined) {
    // `required` is the object's own list (JSON Schema), not a per-property flag, so each
    // property's state is read HERE and carried down to whatever row it becomes.
    return Object.entries(schema.properties).flatMap(([key, property]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`
      const requiredHere = (schema.required ?? []).includes(key)
      const nested = schemaRows(property, path, requiredHere)
      return nested.length > 0 ? nested : [leafRow(path, property, requiredHere)]
    })
  }
  return [leafRow(prefix, schema, isRequired)]
}

/** One leaf field of a `Config`, as the table shows it. */
function leafRow(path: string, property: JsonSchema, isRequired: boolean): Record<string, string> {
  const type = property.enum !== undefined
    ? property.enum.map((value) => (typeof value === 'string' ? `'${value}'` : String(value))).join(' | ')
    : property.anyOf !== undefined
      ? property.anyOf.map((member) => member.type ?? '?').join(' | ')
      : property.type === 'array'
        ? `array<${property.items?.type ?? '?'}>`
        : (property.type ?? 'any')
  return {
    field: path,
    type,
    required: isRequired ? 'yes' : 'no',
    default: property.default === undefined ? '' : JSON.stringify(property.default),
    description: (property.description ?? '').replaceAll('|', '\\|'),
  }
}

/** The generated Markdown: rows first (what composed), then each row's accepted fields. */
export function renderCatalogMarkdown(catalog: readonly CatalogEntry[]): string {
  const lines: string[] = [
    '<!-- GENERATED by scripts/gen-config-catalog.ts — do not edit.',
    '     Source: packages/bundle/app/cordis.patch.yml (the rows) + each capability\'s `Config`.',
    '     Regenerate: pnpm run gen:config-catalog; verify: pnpm test (or the --check flag). -->',
    '',
    '# mediabase 配置目录(生成物)',
    '',
    '宿主由行组成,每行的"能给什么"由该能力的 `Config` 说了算。本文件从两处生成,因此不会与代码不一致:',
    '行表里的**本行陈述**(含 `!!js` 表达式)与能力导出的 **`Config` schema**(含默认值)。',
    '机器可读版本:`docs/config-catalog.json`。',
    '',
    `共 ${catalog.length} 行。`,
    '',
    '| 行 id | 模块 | 本行陈述的字段 |',
    '|---|---|---|',
  ]
  for (const entry of catalog) {
    const stated = Object.keys(entry.stated)
    lines.push(`| \`${entry.id}\` | \`${entry.module}\` | ${stated.length === 0 ? '(无,全部走默认)' : stated.map((key) => `\`${key}\``).join(', ')} |`)
  }
  for (const entry of catalog) {
    lines.push('', `## \`${entry.id}\` — \`${entry.module}\``, '')
    lines.push('本行陈述:')
    lines.push('')
    lines.push('```yaml')
    lines.push(yaml.dump(entry.stated, { schema: entryListSchema, noRefs: true }).trimEnd() || '{}')
    lines.push('```')
    lines.push('')
    const rows = schemaRows(entry.schema)
    if (rows.length === 0) {
      lines.push('该能力没有导出 `Config`(这一行不需要配置)。')
      continue
    }
    lines.push('`Config` 接受的字段:')
    lines.push('')
    lines.push('| 字段 | 类型 | 必填 | 默认 | 说明 |')
    lines.push('|---|---|---|---|---|')
    for (const row of rows) {
      lines.push(`| \`${row['field']}\` | ${row['type']} | ${row['required']} | ${row['default']} | ${row['description']} |`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** The generated JSON: the same data, for tooling. */
export function renderCatalogJson(catalog: readonly CatalogEntry[]): string {
  return `${JSON.stringify({
    note: 'generated by scripts/gen-config-catalog.ts — see docs/CONFIG-CATALOG.md',
    source: 'packages/bundle/app/cordis.patch.yml + each capability Config',
    // JSON has no tag for `!!js`, so the expression is kept as a string a tool can spot.
    rows: catalog.map((entry) => ({ ...entry, stated: statedForJson(entry.stated) })),
  }, null, 2)}\n`
}

const CATALOG = await buildCatalog()
const markdown = renderCatalogMarkdown(CATALOG)
const json = renderCatalogJson(CATALOG)
const check = process.argv.includes('--check')

const stale = [
  ...(existsSync(MARKDOWN) && readFileSync(MARKDOWN, 'utf8') === markdown ? [] : ['docs/CONFIG-CATALOG.md']),
  ...(existsSync(JSON_OUT) && readFileSync(JSON_OUT, 'utf8') === json ? [] : ['docs/config-catalog.json']),
]

if (check) {
  if (stale.length > 0) {
    console.error(`gen-config-catalog: ${stale.join('、')} 与代码不一致 —— 运行 \`pnpm run gen:config-catalog\`。`)
    process.exitCode = 1
  } else {
    console.log(`gen-config-catalog: 已是最新(${CATALOG.length} 行)。`)
  }
} else if (stale.length === 0) {
  console.log(`gen-config-catalog: 无需改动(${CATALOG.length} 行)。`)
} else {
  writeFileSync(MARKDOWN, markdown)
  writeFileSync(JSON_OUT, json)
  console.log(`gen-config-catalog: 已写入 ${stale.map((file) => relative(ROOT, join(ROOT, file))).join('、')}(${CATALOG.length} 行)。`)
}
