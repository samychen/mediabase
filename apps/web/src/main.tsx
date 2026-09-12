// apps/web — Vite app shell (mirrors DSH apps/web): boot the client Cordis
// context and compose the CLIENT ROSTER.
//
// The roster is DATA, not this file: `packages/bundle/ui/client.yml` (the UI bundle) lists
// which client plugins the page composes and in what order, and
// `scripts/gen-client-roster.mjs` turns it into `roster.generated.ts` (static imports,
// because a browser bundle cannot resolve a package name at runtime). So "add a UI package"
// = add a row to the bundle, the same gesture as adding a host capability — and the shell
// (`@mediabase/ui-web`) only renders panels registered into `ctx.ui` (areas:
// header/sidebar/monitor), never a capability by name.
//
// Drop ui-media/ui-panels from the roster and you get an empty but working shell; registration
// is reactive, so a panel package composed AFTER the shell mounted still renders.
import { Context } from '@deepseek-ai/cordis'
import { CLIENT_ROSTER } from './roster.generated.ts'

const ctx = new Context()
for (const entry of CLIENT_ROSTER) {
  // Mount order comes from the roster: a registry before whatever registers into it, the
  // shell last (the roster file and `pnpm run verify:compose` state why).
  ctx.plugin(entry.plugin)
}

// expose for devtools / debugging
declare global {
  interface Window {
    avstudioCtx?: Context
    mediabaseCtx?: Context
  }
}
window.mediabaseCtx = ctx
