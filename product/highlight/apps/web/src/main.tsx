// apps/web — Vite app shell: boot the client Cordis context and compose the
// CLIENT ROSTER.
//
// The roster is DATA, not this file: `packages/bundle/ui/client.yml` (the UI
// bundle) lists which client plugins the page composes and in what order, and
// `product/highlight/scripts/gen-client-roster.mjs` turns it into
// `roster.generated.ts` (static imports, because a browser bundle cannot resolve
// a package name at runtime). So "add a UI package" = add a row to the bundle —
// the same gesture as adding a host capability.

import { Context } from '@deepseek-ai/cordis'
// Shared element recipes (buttons/fields/badges/…), tokenized with literal
// fallbacks — imported unconditionally so the page renders correctly with or
// without the theme PLUGIN composed; layout lives in index.html.
import '@mediabase/theme/chrome.css'
import { CLIENT_ROSTER } from './roster.generated.ts'

const ctx = new Context()
for (const entry of CLIENT_ROSTER) {
  // Mount order comes from the roster: a registry before whatever registers into
  // it, the shell last.
  ctx.plugin(entry.plugin, entry.config)
}

// expose for devtools / debugging
declare global {
  interface Window {
    vhlCtx?: Context
  }
}
window.vhlCtx = ctx
