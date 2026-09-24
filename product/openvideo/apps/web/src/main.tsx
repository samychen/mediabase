// product/openvideo / apps/web — Vite app shell: boot the client Cordis
// context and compose the PRODUCT'S client roster.
//
// The roster is DATA: `@openvideo/bundle-ui`'s client.yml (base rows + the
// editor, shell last), turned into `roster.generated.ts` by this product's own
// copy of the roster generator (the base generator resolves the base bundle —
// a product needs its own, as docs/HANDOFF.zh.md says).
import { Context } from '@deepseek-ai/cordis'
import { CLIENT_ROSTER } from './roster.generated.ts'

const ctx = new Context()
for (const entry of CLIENT_ROSTER) {
  ctx.plugin(entry.plugin, entry.config)
}

// expose for devtools / debugging
declare global {
  interface Window {
    openvideoCtx?: Context
  }
}
window.openvideoCtx = ctx
