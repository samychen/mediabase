// @mediabase/theme / tokens.ts — the design-token vocabulary and the built-in
// skins.
//
// ONE contract, two sides:
//   - pages consume tokens as `var(--token, <fallback>)` — the fallbacks keep
//     a page looking right even when this package is NOT composed (a base
//     checkout boots to its classic dark shell with no theme plugin), so
//     theming is purely additive;
//   - a theme is a flat record of CSS values; the plugin injects one
//     `html[data-theme="<id>"] { … }` block per theme and flips the attribute.
//
// Tokens are deliberately few and semantic (surface/text/accent/state) — a
// new skin is a value set, never new selectors.

export interface ThemeTokens {
  /** Page background behind the panels. */
  bg: string
  /** Panel/card surface. */
  panel: string
  /** Recessed surface: inputs, code, wells. */
  inset: string
  /** Hairline borders. */
  border: string
  /** Primary text. */
  text: string
  /** Secondary text (labels, status lines). */
  muted: string
  /** Interactive accent (primary buttons, selection, focus ring). */
  accent: string
  /** Text drawn ON the accent. */
  accentText: string
  /** Error / destructive. */
  danger: string
  /** Warning / unsaved. */
  warn: string
  /** Success / saved. */
  ok: string
  /** Corner radius scale. */
  radius: string
  /** Panel elevation. */
  shadow: string
  /** Form-control scheme the browser should match (`dark`/`light`). */
  colorScheme: string
}

export const THEME_IDS = ['dark', 'midnight', 'light'] as const
export type ThemeId = (typeof THEME_IDS)[number]

export const isThemeId = (value: string): value is ThemeId =>
  (THEME_IDS as readonly string[]).includes(value)

export const THEMES: Record<ThemeId, ThemeTokens> = {
  // The classic shell look, refined: same family, better accent and elevation.
  dark: {
    bg: '#0d1117',
    panel: '#161b22',
    inset: '#0b0f14',
    border: '#2d333b',
    text: '#d8dee6',
    muted: '#9198a1',
    accent: '#6ea8fe',
    accentText: '#0b0f14',
    danger: '#f85149',
    warn: '#d29922',
    ok: '#3fb950',
    radius: '10px',
    shadow: '0 1px 2px rgba(0, 0, 0, 0.35)',
    colorScheme: 'dark',
  },
  // Deep blue-violet, the "designed" skin: the product page's default.
  midnight: {
    bg: '#0b1020',
    panel: '#121a30',
    inset: '#0a0f1e',
    border: '#263252',
    text: '#dbe4ff',
    muted: '#8fa0c9',
    accent: '#7c9cff',
    accentText: '#0b1020',
    danger: '#ff7b8a',
    warn: '#ffd479',
    ok: '#57d9a3',
    radius: '12px',
    shadow: '0 2px 12px rgba(2, 6, 23, 0.55)',
    colorScheme: 'dark',
  },
  light: {
    bg: '#f6f8fa',
    panel: '#ffffff',
    inset: '#eef1f4',
    border: '#d0d7de',
    text: '#1f2328',
    muted: '#57606a',
    accent: '#0969da',
    accentText: '#ffffff',
    danger: '#cf222e',
    warn: '#9a6700',
    ok: '#1a7f37',
    radius: '10px',
    shadow: '0 1px 3px rgba(31, 35, 40, 0.12)',
    colorScheme: 'light',
  },
}

/** The stylesheet the plugin injects: one block per theme, nothing else. */
export function renderTokenStyles(): string {
  return THEME_IDS.map((id) => {
    const t = THEMES[id]
    const vars = Object.entries({
      '--bg': t.bg,
      '--panel': t.panel,
      '--inset': t.inset,
      '--border': t.border,
      '--text': t.text,
      '--muted': t.muted,
      '--accent': t.accent,
      '--accent-text': t.accentText,
      '--danger': t.danger,
      '--warn': t.warn,
      '--ok': t.ok,
      '--radius': t.radius,
      '--shadow': t.shadow,
    })
      .map(([k, v]) => `${k}:${v};`)
      .join('')
    return `html[data-theme="${id}"]{color-scheme:${t.colorScheme};${vars}}`
  }).join('\n')
}
