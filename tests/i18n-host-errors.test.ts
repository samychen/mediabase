// i18n guard for HOST errors.
//
// The mechanism landed earlier (RpcError carries an optional messageKey/messageParams,
// and ctx.i18n.errorText renders it in the user's language). What could not be trusted
// was COVERAGE: the migration happened by hand across eight packages, and nothing
// stopped the next new host error from shipping Chinese-only prose — or, worse, from
// naming a key that no dictionary defines, which renders as the raw key in the UI.
//
// So this suite encodes the convention as two rules and one completeness check:
//
//   1. STATIC — every `RpcError` construction in host code names a key (or explicitly
//      passes the child's own through, as the sandbox host does);
//   2. DYNAMIC — every key referenced by host code resolves in at least one shipped
//      dictionary, in BOTH locales (a key that only exists in zh-CN is a typo waiting
//      to render as "plugins.foo" in an English UI);
//   3. COMPLETE — every key a dictionary defines exists in both of its locales.
//
// The rule is deliberately about host THROWS: the prose stays the fallback (and the
// log/CLI wording), the key is what a client can translate.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_MESSAGES } from '../packages/client/i18n/src/messages.ts'
import { SHELL_MESSAGES } from '../packages/client/ui-web/src/messages.ts'
import { ROOT } from './support/host.ts'

/** Every shipped dictionary, by the package that owns it. */
const DICTIONARIES: Array<{ owner: string; messages: Record<string, Record<string, string>> }> = [
  { owner: '@mediabase/i18n', messages: CORE_MESSAGES as Record<string, Record<string, string>> },
  { owner: '@mediabase/ui-web', messages: SHELL_MESSAGES as unknown as Record<string, Record<string, string>> },
]

const LOCALES = ['zh-CN', 'en'] as const

/**
 * Every source file that can produce a WIRE error a client receives: the host packages,
 * the base RPC layer that answers transport-level failures (`makeServer`), and the engine
 * client whose failures surface through the media capability. The sandbox child entry is
 * included because it names keys for what only it knows (its export list).
 */
function hostSources(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const rel = join(dir, entry)
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (rel.endsWith('.ts')) files.push(rel)
    }
  }
  for (const dir of ['packages/host', 'packages/base/rpc/src', 'packages/base/engine-client/src']) walk(dir)
  return files
}

/**
 * The full call text of an `RpcError` construction: from the match to the paren that
 * closes it. Strings and templates are skipped so a `)` inside a message cannot end the
 * scan early (which would hide a missing key).
 */
function callTextAt(source: string, start: number): string {
  let depth = 0
  let i = source.indexOf('(', start)
  if (i === -1) return source.slice(start, start + 200)
  const from = i
  for (; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) break
        i++
      }
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(from, from + 600)
}

describe('host errors name a translation key', () => {
  const sources = hostSources().map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), 'utf8') }))
  const CONSTRUCTION = /\b(?:new RpcError\(|RpcError\.(?:notFound|invalidParams|unavailable|unauthorized|worker|forbidden)\()/g

  it('every RpcError construction carries a messageKey', () => {
    const offenders: string[] = []
    let seen = 0
    for (const { rel, text } of sources) {
      for (const match of text.matchAll(CONSTRUCTION)) {
        seen++
        const call = callTextAt(text, match.index)
        // An explicit opt-out for a construction that FORWARDS a key instead of naming
        // one (the RpcError factories) or re-creates it from a wire error (the client).
        // It is a comment on the line above, so the exception is visible in review.
        const lineStart = text.lastIndexOf('\n', match.index) + 1
        const prevLine = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, lineStart)
        const forwards = /i18n:\s*(forwards|pass-through)/.test(prevLine)
        if (!call.includes('messageKey') && !forwards) {
          const line = text.slice(0, match.index).split('\n').length
          offenders.push(`${rel}:${line}: ${call.split('\n')[0]?.trim().slice(0, 90)}`)
        }
      }
    }
    // A guard that scans nothing is a guard that passes for the wrong reason.
    expect(seen, 'the scan must actually see the host error sites').toBeGreaterThan(40)
    expect(offenders, `RpcError without a messageKey:\n${offenders.join('\n')}`).toEqual([])
  })

  it('every referenced key resolves in both locales of some dictionary', () => {
    const referenced = new Set<string>()
    for (const { text } of sources) {
      for (const match of text.matchAll(/messageKey:\s*'([^']+)'/g)) referenced.add(match[1]!)
    }
    expect(referenced.size, 'the migration should have produced many keys').toBeGreaterThan(25)

    const problems: string[] = []
    for (const key of [...referenced].sort()) {
      const owners = DICTIONARIES.filter((d) => LOCALES.some((l) => d.messages[l]?.[key] !== undefined))
      if (owners.length === 0) {
        problems.push(`${key}: no dictionary defines it (the UI would render the raw key)`)
        continue
      }
      for (const owner of owners) {
        for (const locale of LOCALES) {
          if (owner.messages[locale]?.[key] === undefined) {
            problems.push(`${key}: ${owner.owner} defines it but is missing the ${locale} text`)
          }
        }
      }
    }
    expect(problems, `translation keys that do not resolve:\n${problems.join('\n')}`).toEqual([])
  })

  it('keeps every dictionary complete in both locales', () => {
    const problems: string[] = []
    for (const { owner, messages } of DICTIONARIES) {
      const zh = new Set(Object.keys(messages['zh-CN'] ?? {}))
      const en = new Set(Object.keys(messages.en ?? {}))
      for (const key of zh) if (!en.has(key)) problems.push(`${owner}: ${key} exists in zh-CN but not en`)
      for (const key of en) if (!zh.has(key)) problems.push(`${owner}: ${key} exists in en but not zh-CN`)
    }
    expect(problems, `incomplete dictionaries:\n${problems.join('\n')}`).toEqual([])
  })

  it('renders a migrated host error in the user language (the payload the guard protects)', async () => {
    // End to end through the real i18n service: a key from the migration plus the
    // prose the host keeps for its log — the client shows the translated text.
    const { Context } = await import('@deepseek-ai/cordis')
    const i18n = await import('../packages/client/i18n/src/index.ts')
    const ctx = new Context()
    ctx.plugin(i18n, { locale: 'en' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const service = ctx.get('i18n')
    if (!service) throw new Error('ctx.i18n missing')
    // Host-error keys live in the base dictionary now (product panel packages used to
    // own them; the base ships without those packages).
    service.addMessages('zh-CN', CORE_MESSAGES['zh-CN'] ?? {})
    service.addMessages('en', CORE_MESSAGES.en ?? {})

    const err = { code: -32002, message: '插件 "demo" 进程退出(code=1, signal=null)', messageKey: 'plugins.exited', messageParams: { id: 'demo', code: 1, signal: '' } }
    const rendered = service.errorText(err)
    expect(rendered).toContain('plugin demo process exited')
    expect(rendered).toContain('code=1')
    expect(rendered).not.toContain('进程退出')
    await ctx.fiber.dispose()
  })
})
