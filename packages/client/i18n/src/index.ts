// @mediabase/i18n — client plugin: UI translations (ctx.i18n).
//
// Text is not scattered through components any more: each UI package registers
// its own dictionary (so a capability ships its own translations instead of
// editing a central file), the user's locale is detected once and remembered,
// and switching it re-renders every subscribed panel.
//
// Host errors carry CODES, never translatable prose: the client maps a code to
// localized text (`errorText`) instead of translating the host's language. For a
// message that needs detail ("unknown setting \"x\""), the host may send a
// messageKey + params; the client renders that when it has the key and otherwise
// shows the host's own wording — honest about what this layer can and cannot do.

import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useSyncExternalStore } from 'react'
import { hasRpcCode, RpcCode } from '@mediabase/protocol'
import { CORE_MESSAGES } from './messages.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** UI translations. */
    i18n: I18nService
  }
}

export type Locale = string

export interface I18nService {
  /** Translate a key; `{name}` placeholders are replaced from `params`. */
  t(key: string, params?: Record<string, string | number>): string
  locale(): Locale
  setLocale(locale: Locale): void
  /** Locales with at least one registered dictionary (plus the fallback). */
  locales(): Locale[]
  /** A capability contributes its own strings; the disposer removes them. */
  addMessages(locale: Locale, messages: Record<string, string>): () => void
  /** Subscribe to locale/dictionary changes (React panels use `useI18n`). */
  subscribe(listener: () => void): () => void
  /** Bumps on every change: the cache key for reactive consumers. */
  revision(): number
  /** `[code] <localized text>` for a coded error, else the message as-is. */
  errorText(e: unknown): string
}

export interface I18nConfig {
  /** Force a locale (otherwise: `?lang=` → localStorage → navigator.language). */
  locale?: Locale
  /** Fallback chain end (default 'en'). */
  fallback?: Locale
}

const LOCALE_KEY = 'mediabase:locale'

/** `?lang=` wins (and is remembered); then storage; then the browser's. */
function detectLocale(fallback: Locale): Locale {
  if (typeof location !== 'undefined') {
    try {
      const fromQuery = new URLSearchParams(location.search).get('lang')
      if (fromQuery) {
        localStorage.setItem(LOCALE_KEY, fromQuery)
        return fromQuery
      }
      const stored = localStorage.getItem(LOCALE_KEY)
      if (stored) return stored
    } catch {
      /* storage unavailable: fall through */
    }
  }
  const nav = typeof navigator === 'undefined' ? '' : navigator.language
  if (nav.startsWith('zh')) return 'zh-CN'
  return nav === '' ? fallback : nav
}

/**
 * Every wire code → its translation key, DERIVED from `RpcCode` rather than
 * hand-listed: a hand-written table silently loses a code (it had already lost
 * FORBIDDEN, and mapped PARSE_ERROR onto INVALID_PARAMS) and a client would then
 * show the host's language for exactly the refusal a user most needs explained.
 * `tests/i18n.test.ts` asserts every code resolves in every locale.
 */
export const ERROR_CODE_KEYS: Record<number, string> = Object.fromEntries(
  Object.entries(RpcCode).map(([codeName, code]) => [code, `error.code.${codeName}`]),
)

export const name = 'i18n'

export function apply(ctx: Context, config: I18nConfig = {}): void {
  const fallback = config.fallback ?? 'en'
  const dictionaries = new Map<Locale, Record<string, string>>()
  const listeners = new Set<() => void>()
  let locale: Locale = config.locale ?? detectLocale(fallback)
  let revision = 0

  for (const [loc, messages] of Object.entries(CORE_MESSAGES)) dictionaries.set(loc, { ...messages })

  const changed = (): void => {
    revision++
    for (const listener of [...listeners]) listener()
  }

  /**
   * Active locale, then the fallback locale, then nothing (the key itself is
   * shown). Deliberately NOT "any dictionary that happens to have the key":
   * mixing languages silently is worse than an obvious missing translation.
   */
  function lookup(key: string): string | undefined {
    const direct = dictionaries.get(locale)?.[key]
    if (direct !== undefined) return direct
    const viaFallback = dictionaries.get(fallback)?.[key]
    if (viaFallback !== undefined) return viaFallback
    return undefined
  }

  const i18n: I18nService = {
    t(key, params) {
      const template = lookup(key) ?? key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, paramName: string) => {
        const value = params[paramName]
        return value === undefined ? match : String(value)
      })
    },
    locale: () => locale,
    setLocale(next): void {
      if (next === locale) return
      locale = next
      try {
        localStorage.setItem(LOCALE_KEY, next)
      } catch {
        /* storage unavailable: the choice just does not persist */
      }
      changed()
    },
    locales(): Locale[] {
      return [...new Set([locale, fallback, ...dictionaries.keys()])].sort()
    },
    addMessages(loc, messages): () => void {
      const existing = dictionaries.get(loc) ?? {}
      dictionaries.set(loc, { ...existing, ...messages })
      changed()
      return () => {
        const current = dictionaries.get(loc)
        if (!current) return
        for (const key of Object.keys(messages)) delete current[key]
        changed()
      }
    },
    subscribe(listener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    revision: () => revision,
    errorText(e): string {
      const coded = hasRpcCode(e)
      const code = coded ? e.code : undefined
      // Read the prose from whatever arrived: a real Error, a string, or the plain
      // wire-shaped object a client may hold ({ code, message, messageKey }) — the last
      // one used to render as "[object Object]", which hides the host's own wording.
      const detail = e instanceof Error
        ? e.message
        : typeof e === 'string' ? e
          : e !== null && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
            ? (e as { message: string }).message
            : e === undefined || e === null ? '' : String(e)
      if (code === undefined) return detail === '' ? i18n.t('error.unknown') : detail
      // The host's own key wins (it can carry detail: "unknown setting \"x\"");
      // otherwise the code is enough to explain the failure in the user's language.
      const hostKey = coded ? e.messageKey : undefined
      const key = hostKey ?? ERROR_CODE_KEYS[code]
      const template = key === undefined ? undefined : lookup(key)
      const localized = template === undefined
        ? undefined
        : template.replace(/\{(\w+)\}/g, (match, paramName: string) => {
          const value = coded ? e.messageParams?.[paramName] : undefined
          return value === undefined ? match : String(value)
        })
      // Show the code always: it is what a bug report and the host log share.
      if (localized === undefined) return `[${code}] ${detail}`
      // A host KEY means the host said exactly what this failure is, in a translatable
      // way: render that and nothing else. Appending its prose would put the host's
      // language back into every translated error (the log still has that prose).
      if (hostKey !== undefined) return `[${code}] ${localized}`
      // No key: only the code explains the kind of failure, so the host detail is what
      // makes it specific ("目标不存在 · media: 文件不存在或不可读 \"/tmp/x.mp4\"").
      return detail === '' || localized === detail ? `[${code}] ${localized}` : `[${code}] ${localized} · ${detail}`
    },
  }

  ctx.reflect.provide('i18n', i18n)
  ctx.effect(() => () => {
    listeners.clear()
    dictionaries.clear()
  }, `${name}: dictionaries`)
}

/**
 * Reactive translation for panels: re-renders when the locale (or any
 * dictionary) changes. `getSnapshot` is a number so React sees a stable value.
 */
export function useI18n(ctx: Context): { t: I18nService['t']; locale: Locale } {
  const service = ctx.get('i18n')
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => service?.subscribe(onChange) ?? (() => {}),
    [service],
  )
  const getSnapshot = useCallback((): number => service?.revision() ?? 0, [service])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => service?.t(key, params) ?? key,
    // revision is deliberately the dependency: a new locale means new strings.
    [service, getSnapshot()],
  )
  return { t, locale: service?.locale() ?? 'en' }
}
