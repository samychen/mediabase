// No UI string lives in a component, and no host error lands without text:
//
//   1. the editor's dictionaries are parallel (zh-CN and en carry the same keys),
//   2. every messageKey the host capability throws has text in BOTH locales
//      (a key the client does not have falls back to the host's own wording —
//      honest, but untranslated),
//   3. every literal t('…')/flash('…') key used by panels and the store exists.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EDITOR_MESSAGES } from '../packages/client/editor/src/messages.ts'
import { PRODUCT_ROOT } from './support/host.ts'

const zh = EDITOR_MESSAGES['zh-CN']
const en = EDITOR_MESSAGES.en

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path)
  }
  return out
}

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
    const clientSources = sourcesUnder(join(PRODUCT_ROOT, 'packages/client/editor/src'))
      .filter((f) => !f.endsWith('messages.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    const used = new Set<string>([
      ...[...clientSources.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]!),
      ...[...clientSources.matchAll(/\bflash\('([^']+)'/g)].map((m) => m[1]!),
      ...[...clientSources.matchAll(/status\.key[^\n]*?'(ov\.[^']+)'/g)].map((m) => m[1]!),
      // the one dynamic key: aspect shape buttons
      'ov.inspector.landscape',
      'ov.inspector.vertical',
      'ov.inspector.square',
    ])
    const missing = [...used].filter((key) => !(key in zh))
    expect(missing, `keys without text: ${missing.join(', ')}`).toEqual([])
  })
})
