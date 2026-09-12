// i18n: locale detection/switch, per-package dictionaries, coded-error texts.
//
// The service is deliberately small — the interesting parts are the fallback
// chain, live switching (subscribers), dictionary ownership (a capability brings
// its own strings) and the refusal to guess at host prose: coded errors are
// localized by CODE, everything else falls back to the host's message.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as i18n from '../packages/client/i18n/src/index.ts'
import type { I18nService } from '../packages/client/i18n/src/index.ts'
import { RpcCode, RpcError } from '../packages/base/rpc/src/index.ts'

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

async function compose(config?: i18n.I18nConfig): Promise<{ ctx: Context; t: I18nService }> {
  const ctx = new Context()
  ctx.plugin(i18n, config ?? { locale: 'zh-CN' })
  await settle()
  const service = ctx.get('i18n')
  if (!service) throw new Error('ctx.i18n missing')
  return { ctx, t: service }
}

describe('ctx.i18n', () => {
  it('translates, interpolates and falls back to the key', async () => {
    const { t } = await compose()
    t.addMessages('zh-CN', { 'demo.greet': '你好 {who}', 'demo.only.zh': '只有中文' })
    t.addMessages('en', { 'demo.greet': 'hello {who}' })

    expect(t.t('demo.greet', { who: '世界' })).toBe('你好 世界')
    expect(t.t('demo.only.zh')).toBe('只有中文')
    expect(t.t('demo.missing.key')).toBe('demo.missing.key') // visible, not silent

    t.setLocale('en')
    expect(t.t('demo.greet', { who: 'world' })).toBe('hello world')
    // The chain is active → fallback → key. A key translated only in another
    // locale shows as a key rather than mixing languages behind the user's back.
    expect(t.t('demo.only.zh')).toBe('demo.only.zh')
  })

  it('notifies subscribers on locale and dictionary changes', async () => {
    const { t } = await compose()
    let changes = 0
    const off = t.subscribe(() => { changes++ })
    t.setLocale('en')
    expect(changes).toBe(1)
    t.setLocale('en') // no-op
    expect(changes).toBe(1)

    const disposer = t.addMessages('en', { 'demo.late': 'late' })
    expect(changes).toBe(2)
    expect(t.t('demo.late')).toBe('late')
    disposer()
    expect(t.t('demo.late')).toBe('demo.late')
    off()
    t.setLocale('zh-CN')
    expect(changes).toBe(3)
  })

  it('lists locales and drops dictionaries with the fiber', async () => {
    const { ctx, t } = await compose()
    t.addMessages('ja', { 'demo.greet': 'こんにちは' })
    expect(t.locales()).toEqual(expect.arrayContaining(['zh-CN', 'en', 'ja']))
    await ctx.fiber.dispose()
    expect(t.locales()).not.toContain('ja')
  })

  it('localizes coded errors by code and keeps the host detail', async () => {
    const { t } = await compose()
    const notFound = new RpcError(RpcCode.NOT_FOUND, 'media: 文件不存在或不可读 "/tmp/x.mp4"')
    expect(t.errorText(notFound)).toContain('目标不存在')
    expect(t.errorText(notFound)).toContain('/tmp/x.mp4') // the host detail survives
    expect(t.errorText(notFound)).toMatch(/^\[-32001\]/)

    t.setLocale('en')
    expect(t.errorText(notFound)).toContain('Not found')

    // an uncoded error is passed through: no invented translation
    expect(t.errorText(new Error('engine exploded'))).toBe('engine exploded')
    expect(t.errorText(undefined)).toBe('Unknown error')
  })

  it('has a translation for EVERY wire code, in every locale', async () => {
    // Derived from RpcCode, so a new code cannot silently render in the host's
    // language: a hand-written table had already lost FORBIDDEN and mislabeled
    // PARSE_ERROR as invalid params.
    const { ctx, t } = await compose()
    const missing: string[] = []
    for (const [codeName, code] of Object.entries(RpcCode)) {
      const text = t.errorText({ code, message: 'host prose' })
      if (text.includes('error.code.')) missing.push(`${codeName} (${code}) → ${text}`)
    }
    expect(missing, `codes without a translation:\n${missing.join('\n')}`).toEqual([])

    // Both shipped locales, not just the active one.
    const base = await import('../packages/client/i18n/src/messages.ts')
    for (const locale of ['zh-CN', 'en']) {
      const messages = base.CORE_MESSAGES[locale] ?? {}
      for (const codeName of Object.keys(RpcCode)) {
        expect(messages[`error.code.${codeName}`], `${locale} is missing error.code.${codeName}`).toBeDefined()
      }
    }
    await ctx.fiber.dispose()
  })

  it('prefers a message KEY from the host over its prose, with params', async () => {
    const { t } = await compose()
    t.addMessages('zh-CN', { 'demo.badKey': '未知设置键 "{key}"' })
    t.addMessages('en', { 'demo.badKey': 'unknown setting key "{key}"' })
    const err = RpcError.invalidParams('settings: 未知设置键 "nope"', undefined, {
      messageKey: 'demo.badKey',
      messageParams: { key: 'nope' },
    })

    // The host's prose is the FALLBACK; a key makes the detail localizable.
    expect(t.errorText(err)).toContain('未知设置键 "nope"')
    t.setLocale('en')
    expect(t.errorText(err)).toContain('unknown setting key "nope"')
    expect(t.errorText(err)).toMatch(/^\[-32602\]/)

    // Key the client does not know: the host prose is shown rather than the key.
    const unknownKey = RpcError.invalidParams('host prose only', undefined, { messageKey: 'demo.notRegistered' })
    expect(t.errorText(unknownKey)).toContain('host prose only')
    expect(t.errorText(unknownKey)).not.toContain('demo.notRegistered')
  })

  it("explains the base's own access refusals in the user's language", async () => {
    const { t } = await compose()
    const denied = RpcError.forbidden('media.play: 只读模式拒绝改状态的方法', { method: 'media.play' }, {
      messageKey: 'error.acl.readonly',
      messageParams: { method: 'media.play' },
    })
    expect(t.errorText(denied)).toContain('只读模式')
    t.setLocale('en')
    expect(t.errorText(denied)).toContain('Read-only mode')
  })

  it('resolves a panel title key and follows a locale switch', async () => {
    const { t } = await compose()
    t.addMessages('zh-CN', { 'demo.panel': '演示面板' })
    t.addMessages('en', { 'demo.panel': 'Demo panel' })
    const title = (): string => t.t('demo.panel')
    expect(title()).toBe('演示面板')
    t.setLocale('en')
    expect(title()).toBe('Demo panel')
  })
})
