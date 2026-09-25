# @mediabase/theme

Client plugin: **switchable skins as composition data**.

The page consumes CSS design tokens (`var(--bg, …)`, `var(--panel, …)`,
`var(--accent, …)` — see `apps/web/index.html`); this package owns the token
VALUES. It injects one stylesheet mapping `html[data-theme="<id>"]` to a token
set, flips the attribute, remembers the choice in `localStorage` (the same
seam i18n uses for the locale), and registers a single-control picker into the
shell's `header` area.

- Built-in skins: `dark` (the classic look, refined), `midnight` (deep
  blue-violet), `light`. A new skin is a value set in `src/tokens.ts` — no new
  selectors, no component edits.
- Deployment default is roster config: `{ theme: 'midnight' }`; the remembered
  browser choice wins over it.
- **Additive by contract**: pages carry literal fallbacks in every `var()`, so
  a composition WITHOUT this package renders the classic shell unchanged, and
  panels from any package pick a skin up for free as long as they color through
  the tokens.
- Service: `ctx.theme` (`current/set/list/subscribe`) for panels that want to
  react to the skin.
