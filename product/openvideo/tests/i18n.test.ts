// No UI string lives in a component, and no host error lands without text:
//
//   1. the editor's dictionaries are parallel (zh-CN and en carry the same keys),
//   2. every messageKey the host capability throws has text in BOTH locales
//      (a key the client does not have falls back to the host's own wording —
//      honest, but untranslated),
//   3. every literal t('…')/flash('…') key used by panels and the store exists,
//   4. no key exists that nothing renders (orphans rot: their wording drifts
//      away from what the UI actually says, invisibly).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_MESSAGES } from '@mediabase/i18n'
import { EDITOR_MESSAGES } from '../packages/client/editor/src/messages.ts'
import { SHELL_MESSAGES } from '../packages/client/shell/src/messages.ts'
import { PRODUCT_ROOT } from './support/host.ts'

// The dictionary the browser actually holds: the base i18n plugin mounts its
// CORE_MESSAGES, then the product plugins addMessages() their own over them.
const PRODUCT_ZH = { ...EDITOR_MESSAGES['zh-CN'], ...SHELL_MESSAGES['zh-CN'] }
const PRODUCT_EN = { ...EDITOR_MESSAGES.en, ...SHELL_MESSAGES.en }
const zh = { ...CORE_MESSAGES['zh-CN'], ...PRODUCT_ZH }
const en = { ...CORE_MESSAGES.en, ...PRODUCT_EN }

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    // pnpm links dep sources INSIDE product packages — never our copy to scan.
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path)
  }
  return out
}

/** Every i18n call site the client names, so far as literals can say it. The
 * ternary catch is scoped to t(…) calls — className ternaries pick CSS, not
 * copy. These keys MUST have text in both locales. */
const used: Set<string> = (() => {
  const client = sourcesUnder(join(PRODUCT_ROOT, 'packages/client'))
    .filter((f) => !f.endsWith('messages.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  return new Set<string>([
    ...[...client.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]!),
    ...[...client.matchAll(/\bflash\('([^']+)'/g)].map((m) => m[1]!),
    ...[...client.matchAll(/\btitleKey: '([^']+)'/g)].map((m) => m[1]!),
    // shell-parts options are render sites too: the boundary renders errorKey
    ...[...client.matchAll(/\berrorKey: '([^']+)'/g)].map((m) => m[1]!),
    // issue objects carry a message key: `key: 'ov.…'` is i18n by namespace
    ...[...client.matchAll(/\bkey: '((?:ov|openvideo)\.[^']+)'/g)].map((m) => m[1]!),
    ...[...client.matchAll(/status\.key[^\n]*?'(ov\.[^']+)'/g)].map((m) => m[1]!),
    // dynamic selection inside a t() call: t(cond ? 'a' : 'b')
    ...[...client.matchAll(/\bt\([^\n()]*'([^']+)'\s*:\s*'([^']+)'/g)].flatMap((m) => [m[1]!, m[2]!]),
    // the one dynamic template: aspect shape buttons
    'ov.inspector.landscape',
    'ov.inspector.vertical',
    'ov.inspector.square',
  ])
})()

/** A deliberately LOOSE superset for the orphan check only: anything that
 * MIGHT render a key (host-thrown messageKeys via ctx.i18n.errorText, loose
 * `key: '…'` holders). Over-approximating here can only hide an orphan, never
 * invent one — while the strict set above stays exact for the missing-text
 * assertion. */
const renderable: Set<string> = (() => {
  const client = sourcesUnder(join(PRODUCT_ROOT, 'packages/client'))
    .filter((f) => !f.endsWith('messages.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  const host = sourcesUnder(join(PRODUCT_ROOT, 'packages/host'))
    .filter((f) => !f.endsWith('messages.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  return new Set<string>([
    ...used,
    ...[...client.matchAll(/\bkey: '([^']+)'/g)].map((m) => m[1]!),
    ...[...host.matchAll(/messageKey: '([^']+)'/g)].map((m) => m[1]!),
  ])
})()

describe('editor i18n coverage', () => {
  it('keeps zh-CN and en parallel', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    // no empty translations
    for (const [key, value] of Object.entries(zh)) expect(value, `zh-CN ${key}`).not.toBe('')
    for (const [key, value] of Object.entries(en)) expect(value, `en ${key}`).not.toBe('')
  })

  it('localizes every messageKey the host throws', () => {
    const hostSources = sourcesUnder(join(PRODUCT_ROOT, 'packages/host/media/src'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    const keys = [...hostSources.matchAll(/messageKey: '([^']+)'/g)].map((m) => m[1]!)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of new Set(keys)) {
      expect(zh, `zh-CN missing ${key}`).toHaveProperty(key)
      expect(en, `en missing ${key}`).toHaveProperty(key)
    }
  })

  it('has text for every literal key the client uses', () => {
    const missing = [...used].filter((key) => !(key in zh))
    expect(missing, `keys without text: ${missing.join(', ')}`).toEqual([])
  })

  it('leaves no orphan keys (declared but never rendered)', () => {
    // Orphan candidates are the keys THIS product declares: base CORE_MESSAGES
    // keys are the base suite's business, not ours.
    const orphans = Object.keys(PRODUCT_ZH).filter((key) => !renderable.has(key))
    expect(orphans, `keys nobody renders: ${orphans.join(', ')}`).toEqual([])
  })
})
