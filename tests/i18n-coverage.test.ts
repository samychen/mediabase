// i18n coverage guard.
//
// Extracting strings once is easy; keeping them extracted is not — the next
// component someone writes would quietly reintroduce a hard-coded literal. This
// test reads the UI sources and fails when a CJK literal appears outside a
// messages module (or a host-side diagnostic), so "translated" stays true.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './support/host.ts'

const UI_PACKAGES = [
  'packages/client/ui/src',
  'packages/client/ui-web/src',
  'packages/client/i18n/src',
]

/** Any CJK ideograph, kana or fullwidth punctuation. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/

/** Files/lines allowed to carry Chinese: dictionaries and host-side diagnostics. */
function allowed(file: string, line: string): boolean {
  if (file.endsWith('messages.ts')) return true // the dictionaries themselves
  // Comments may be Chinese (this repo documents in Chinese) …
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true
  // … and so may developer-facing diagnostics that never render in the UI.
  if (line.includes('throw new Error(') || line.includes('console.error(')) return true
  if (line.includes('console.warn(') || line.includes('log.warn(') || line.includes('log.error(')) return true
  return false
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

describe('i18n coverage', () => {
  it('keeps UI text in messages modules, not in components', () => {
    const offenders: string[] = []
    for (const pkg of UI_PACKAGES) {
      for (const file of sourceFiles(join(ROOT, pkg))) {
        const relative = file.slice(ROOT.length + 1)
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (CJK.test(line) && !allowed(relative, line)) {
            offenders.push(`${relative}:${i + 1}: ${line.trim().slice(0, 90)}`)
          }
        })
      }
    }
    expect(offenders, `untranslated literals:\n${offenders.join('\n')}`).toEqual([])
  })

  it('ships both zh-CN and en for every UI package', () => {
    const reports: string[] = []
    for (const pkg of UI_PACKAGES.filter((p) => !p.includes('/ui/src') && !p.includes('/i18n/src'))) {
      const messages = join(ROOT, pkg, 'messages.ts')
      const source = readFileSync(messages, 'utf8')
      if (!source.includes("'zh-CN':") || !/\ben:\s*\{/.test(source)) {
        reports.push(`${pkg}/messages.ts is missing a zh-CN or en dictionary`)
      }
    }
    expect(reports).toEqual([])
  })
})
