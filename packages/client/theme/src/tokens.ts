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
  /** Soft accent wash: focus glows, count badges. */
  accentTint: string
  /** Soft danger wash: destructive buttons at rest. */
  dangerTint: string
  /** Error / destructive. */
  danger: string
  /** Warning / unsaved. */
  warn: string
  /** Success / saved. */
  ok: string
  /** Solid (primary) button surface — upstream-OpenVideo-style skins keep
    * this "ink" while the accent stays an identity color. */
  primary: string
  /** Text drawn ON the primary surface. */
  primaryText: string
  /** UI font stack (a skin may prefer a face the user has installed). */
  font: string
  /** Corner radius scale. */
  radius: string
  /** Panel elevation. */
  shadow: string
  /** Form-control scheme the browser should match (`dark`/`light`). */
  colorScheme: string
}

export const THEME_IDS = ['dark', 'midnight', 'light', 'studio', 'studio-light'] as const
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
    accentTint: '#12233d',
    dangerTint: '#3a1d21',
    primary: '#6ea8fe',
    primaryText: '#0b0f14',
    font: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
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
    accentTint: '#1a2144',
    dangerTint: '#3a1c26',
    primary: '#7c9cff',
    primaryText: '#0b1020',
    font: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    danger: '#ff7b8a',
    warn: '#ffd479',
    ok: '#57d9a3',
    radius: '12px',
    shadow: '0 2px 12px rgba(2, 6, 23, 0.55)',
    colorScheme: 'dark',
  },
  // Warm-neutral dark with a rose identity accent and INK primary buttons —
  // palette derived from clawnify/OpenVideo src/client/styles.css (MIT):
  // surfaces on hue 85 ("never blue-gray"), accent for identity/focus only,
  // "the one solid button per screen is ink, not the accent". Inter leads the
  // font stack when the user has it; no font files are shipped or fetched.
  studio: {
    bg: '#100f0e',
    panel: '#161615',
    inset: '#222120',
    border: '#2e2e2c',
    text: '#efeeed',
    muted: '#c0bdb9',
    accent: '#e4415d',
    accentText: '#ffffff',
    accentTint: '#3b1c1e',
    dangerTint: '#3b1c1a',
    primary: '#efeeed',
    primaryText: '#100f0e',
    font: "Inter, 'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    danger: '#e64243',
    warn: '#e5bd7e',
    ok: '#3c9c5d',
    radius: '12px',
    shadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
    colorScheme: 'dark',
  },
  // The upstream LIGHT mode, same design language: white surfaces, ink primary,
  // rose identity accent (palette from the same MIT styles.css :root block).
  'studio-light': {
    bg: '#ffffff',
    panel: '#ffffff',
    inset: '#f7f7f5',
    border: '#e5e3de',
    text: '#1b1a19',
    muted: '#646360',
    accent: '#df3656',
    accentText: '#ffffff',
    accentTint: '#f9eded',
    dangerTint: '#f9edec',
    primary: '#1b1a19',
    primaryText: '#ffffff',
    font: "'Inter Variable', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', ui-sans-serif, system-ui, sans-serif",
    danger: '#e1363a',
    warn: '#664e27',
    ok: '#319656',
    radius: '12px',
    shadow: 'none',
    colorScheme: 'light',
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
    accentTint: '#ddf4ff',
    dangerTint: '#ffebe9',
    primary: '#0969da',
    primaryText: '#ffffff',
    font: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
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
      '--accent-tint': t.accentTint,
      '--danger-tint': t.dangerTint,
      '--primary': t.primary,
      '--primary-text': t.primaryText,
      '--font': t.font,
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
