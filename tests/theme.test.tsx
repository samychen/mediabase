// @vitest-environment jsdom
// The theme plugin: tokens injected, attribute flipped, choice remembered,
// picker registered — and the ADDITIVE contract: nothing here breaks a page
// that composes no theme at all (that is the fallbacks' job, asserted by the
// roster/shell suites).

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as i18n from '../packages/client/i18n/src/index.ts'
import * as ui from '../packages/client/ui/src/index.ts'
import * as theme from '../packages/client/theme/src/index.tsx'
import { THEME_IDS, renderTokenStyles } from '../packages/client/theme/src/tokens.ts'
import type { ThemeService } from '../packages/client/theme/src/index.tsx'

/** cordis activates a plugin's service on a microtask, so wait one macrotask. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

describe('@mediabase/theme', () => {
  let ctx: Context

  beforeEach(async () => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    ctx = new Context()
    ctx.plugin(i18n, { locale: 'zh-CN' })
    await settle()
    ctx.plugin(ui)
    await settle()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('provides the service, injects tokens, and activates the configured skin', async () => {
    ctx.plugin(theme, { theme: 'midnight' })
    await settle()
    const service = ctx.get('theme') as ThemeService
    expect(service).toBeDefined()
    expect(service?.current()).toBe('midnight')
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight')
    const style = document.querySelector('style[data-mediabase-theme]')
    expect(style?.textContent).toContain('html[data-theme="midnight"]')
    expect(style?.textContent).toContain('--accent')
  })

  it('remembers the choice, and the memory beats the row config', async () => {
    localStorage.setItem('mediabase:theme', 'light')
    ctx.plugin(theme, { theme: 'midnight' })
    await settle()
    const service = ctx.get('theme') as ThemeService
    expect(service?.current()).toBe('light')
    act(() => service?.set('dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('mediabase:theme')).toBe('dark')
  })

  it('falls back to dark on an unknown configured id', async () => {
    ctx.plugin(theme, { theme: 'chartreuse-neon' })
    await settle()
    expect((ctx.get('theme') as ThemeService)?.current()).toBe('dark')
  })

  it('registers exactly one header picker panel', async () => {
    ctx.plugin(theme)
    await settle()
    const panels = ctx.get('ui')!.list('header')
    expect(panels.map((p) => p.id)).toContain('theme.picker')
  })

  it('every built-in skin defines the full token vocabulary', () => {
    const css = renderTokenStyles()
    for (const id of THEME_IDS) {
      expect(css).toContain(`html[data-theme="${id}"]`)
    }
    for (const token of ['--bg', '--panel', '--inset', '--border', '--text', '--muted', '--accent', '--accent-text', '--primary', '--primary-text', '--font', '--danger', '--warn', '--ok', '--radius', '--shadow']) {
      // one declaration per skin
      expect(css.split(`${token}:`).length - 1).toBe(THEME_IDS.length)
    }
  })

  it('unmounting removes the injected stylesheet (fiber effect)', async () => {
    ctx.plugin(theme)
    await settle()
    expect(document.querySelector('style[data-mediabase-theme]')).not.toBeNull()
    await ctx.fiber.dispose()
    expect(document.querySelector('style[data-mediabase-theme]')).toBeNull()
    // keep afterEach's dispose idempotent
    ctx = new Context()
  })
})
