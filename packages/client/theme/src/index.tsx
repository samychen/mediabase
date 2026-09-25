// @mediabase/theme — client plugin: switchable skins as composition data.
//
// The shell and every panel consume CSS design tokens (`var(--bg, …)` etc. in
// the page); this package owns the token VALUES: it injects one stylesheet
// mapping `html[data-theme="<id>"]` → a token set, flips the attribute,
// remembers the choice per browser (the same localStorage seam i18n uses for
// the locale), and registers a one-control picker into the shell's header
// area — so "change the skin" is one click for a user and one roster-row
// config for a deployment:
//
//   - id: theme
//     name: '@mediabase/theme'
//     config: { theme: 'midnight' }
//
// Without this package composed, pages fall back to their inline defaults —
// theming is additive, never load-bearing.

import { useCallback, useSyncExternalStore, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { parse, z, type Schema } from '@mediabase/schema'
import { useI18n } from '@mediabase/i18n'
import type {} from '@mediabase/ui'
import { THEME_MESSAGES } from './messages.ts'
import { THEME_IDS, isThemeId, renderTokenStyles, type ThemeId } from './tokens.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The skin service: current id, set, subscribe. */
    theme: ThemeService
  }
}

export interface ThemeService {
  current(): ThemeId
  /** Switch skins; remembered for this browser. */
  set(id: ThemeId): void
  list(): readonly ThemeId[]
  subscribe(listener: () => void): () => void
}

export const name = 'theme'

/** `ui` for the picker panel, `i18n` for its labels. */
export const inject = ['ui', 'i18n'] as const

export interface ThemeConfig {
  /** Initial skin id when the browser has no remembered choice. */
  theme?: string
}

export const Config: Schema<ThemeConfig, ThemeConfig> = z.object({
  theme: z.string().default('dark').description('initial skin id (dark | midnight | light)'),
})

/** The per-browser memory key — same namespace convention as locale/token. */
export const THEME_KEY = 'mediabase:theme'

function ThemePicker({ ctx }: { ctx: Context }): ReactElement {
  const { t } = useI18n(ctx)
  const theme = ctx.get('theme')
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => theme?.subscribe(onChange) ?? ((): void => {}),
    [theme],
  )
  const getSnapshot = useCallback((): ThemeId => theme?.current() ?? 'dark', [theme])
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return (
    <select
      className="theme-picker"
      aria-label={t('theme.picker')}
      title={t('theme.picker')}
      value={current}
      onChange={(e) => {
        const id = e.target.value
        if (theme !== undefined && isThemeId(id)) theme.set(id)
      }}
    >
      {THEME_IDS.map((id) => (
        <option key={id} value={id}>{t(`theme.name.${id}`)}</option>
      ))}
    </select>
  )
}

export function apply(ctx: Context, rawConfig: ThemeConfig): void {
  const config = parse(Config, rawConfig ?? {})
  for (const [locale, messages] of Object.entries(THEME_MESSAGES)) {
    ctx.i18n.addMessages(locale, messages)
  }

  const listeners = new Set<() => void>()
  let current: ThemeId = readStored() ?? (isThemeId(config.theme ?? '') ? (config.theme as ThemeId) : 'dark')

  /** Remembered choice wins over the row config (locale does the same). */
  function readStored(): ThemeId | null {
    try {
      const stored = localStorage.getItem(THEME_KEY)
      return stored !== null && isThemeId(stored) ? stored : null
    } catch {
      // storage unavailable (privacy modes): fall through to config
      return null
    }
  }

  function activate(id: ThemeId): void {
    current = id
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', id)
    try {
      localStorage.setItem(THEME_KEY, id)
    } catch {
      // remembering is best-effort; the switch itself already happened
    }
    for (const listener of listeners) listener()
  }

  const service: ThemeService = {
    current: () => current,
    set: activate,
    list: () => THEME_IDS,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  ctx.reflect.provide('theme', service)

  // The token stylesheet lives and dies with this fiber.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const style = document.createElement('style')
    style.setAttribute('data-mediabase-theme', '')
    style.textContent = renderTokenStyles()
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, `${name}: token stylesheet`)

  activate(current)
  ctx.ui.register({ id: 'theme.picker', title: '', area: 'header', order: 5, component: ThemePicker })
}
