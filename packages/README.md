# packages

Capability packages, following the deepseek-harness convention
(`packages/<face>/<capability>`). Each package is one plugin capability with its
own README, exports a Cordis plugin (`name`/`inject`/`Config`/`apply`), provides
services via `ctx.reflect.provide`, and types `ctx` via
`declare module '@deepseek-ai/cordis'`.

Scope: `@mediabase/*` = reusable + packable (**never published**: `private: true`),
never depending on `@avstudio/*`;
`@avstudio/*` = this product's capabilities. Scope and face are independent: the
face chooses the typecheck plane, the scope chooses reusability.

| Face | Package | Role |
|---|---|---|
| shared | `base/rpc` | **neutral base**: JSON-RPC 2.0 + notifications + coded errors (`@mediabase/rpc`) |
| shared | `base/schema` | **neutral base**: the one schema dialect (`@mediabase/schema`): validate a boundary, derive the LLM JSON Schema |
| shared | `base/log` | **neutral base**: leveled, scoped logger as `ctx.log` (`@mediabase/log`) |
| shared | `base/engine-client` | **neutral base**: line-protocol TRANSPORT only (call/scratch/ping) — no media verbs (`@mediabase/engine-client`) |
| shared | `base/gateway` | **neutral base**: HTTP/WS gateway(SPA 静态 + WS JSON-RPC + 原始字节路由 + 通知广播,`@mediabase/gateway`) |
| host | `tools` | capability tool registry (`ctx.tools`): register once, workflow/agent consume; args schema-validated, LLM JSON Schema derived |
| shared | `protocol` | avstudio domain contracts + re-export of `@mediabase/rpc` |
| host | `media` | owns the C++ engine process AND the media verb vocabulary (probe/decode/session/play); `ctx.media` + `ctx.previewState` (frame buffer) |
| host | `python` | python sidecar worker; `ctx.python` tools (silence detection, …) |
| host | `workflow` | recipe runner over **REGISTERED tools**; `ctx.workflow` |
| host | `agent` | LLM agent loop (function calling) over **REGISTERED tools**; `ctx.agent` |
| host | `plugins` | runtime plugin manager (load/unload/reload); `ctx.plugins` |
| host | `settings` | persisted key->JSON settings (~/.avstudio/settings.json); `ctx.settings` |
| host | `api` | **control-plane registry** (`ctx.api`: methods/routes/health) + **capability manifests** (`ctx.capabilities` with `verify()`); schema-validated params & results |
| host | `server` | **pure composition** over `@mediabase/gateway` — reads `ctx.api`, names no capability |
| client | `connection` | WS JSON-RPC + data-plane stream subscriber; `ctx.rpc`/`ctx.streams`/`ctx.net` |
| client | `i18n` | UI translations: per-package dictionaries, live switching, coded-error texts; `ctx.i18n` |
| client | `preview` | `ctx.preview` control-plane wrapper |
| client | `ui` | **UI panel registry** (`ctx.ui`, React-free) + shared panel-state contract (`ctx.view`) + JSON-Schema form helpers; late registrations re-render via `subscribe`/`revision` |
| client | `ui-media` | **example media capability**: provides `ctx.view` + console + canvas monitor panel |
| client | `ui-panels` | external UI package demo: connection badge (header) + python/workflow/plugins/settings/agent panels |
| client | `ui-web` | **SHELL (capability-agnostic)**: title + renders `ctx.ui` panels (header/sidebar/monitor) |

Base packages can be built and **packed locally** with `pnpm run build:base`
(dist + d.ts; `pnpm pack` applies `publishConfig`, and the root LICENSE is copied in
so the tarball carries the notice) — see `tests/base-packaging.test.ts`, which packs a
tarball, inspects it (`private` + MIT + LICENSE) and runs it from a scratch project
with plain Node.

**Nothing here is published**: every package is `private: true`, so `pnpm publish`
fails outright, and the packaging test asserts that flag so nobody flips it by
accident.

Everything in this repo is **MIT**; the native binaries are not (FFmpeg linkage and
the bundled ffmpeg have their own terms) — see `docs/LICENSING.zh.md` and
`docs/GPL-COMPLIANCE.zh.md` before handing an installer to anyone.

Composable capabilities export a `Config` schema (what a composition row may state) and
register a manifest into `ctx.capabilities`; the host is composed from PATCH LAYERS — the
shipped bundle (`packages/bundle/app/cordis.patch.yml`), a profile's own layer, and any
drop-in module found in `AVSTUDIO_CAPABILITY_DIR` — mounted by the vendored Loader
(`apps/cli/src/profile-boot.ts`), which then runs `capabilities.verify()`
(`AVSTUDIO_STRICT_CAPABILITIES=1` turns a mismatch into a boot failure).

Host-face packages run under Node and are type-checked by `tsconfig.host.json`;
client-face packages run in the browser and are checked by `tsconfig.client.json`
— the same two-plane split DSH uses (`tsconfig.host.json` / `tsconfig.client.json`).
