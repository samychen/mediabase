# mediabase as a reusable base (honest answer)

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**

TL;DR: this repo **is** the extracted neutral base (`@mediabase/*`). Product
engines and domain verbs live in consumer repos. Remaining gaps are UI chrome
polish and packaging opinions — not "still bound inside AVStudio source". Full details (in Chinese): `docs/FRAMEWORK.zh.md`.

## Reusable today

- The architecture paradigm: React UI ↔ cordis host ↔ **separate C++ media
  process**; control plane (WS JSON-RPC) vs data plane (HTTP bytes); real
  `@deepseek-ai/cordis`; `packages/<face>/<capability>` layout;
  `tsconfig.{host,client,test}`; plugin = `name/inject/Config/apply` with fiber
  lifecycle and reversible `ctx.effect` side effects.
- Base code worth extracting (done, and now published as `@mediabase/*`): JSON-RPC +
  notifications, schema dialect, scoped logging, gateway, engine transport;
  subprocess engine client + streaming session, host server skeleton, and the
  capability-agnostic `plugins` (hot load), `workflow` (recipes) and `agent`
  (LLM tool loop) layers; test/doctor/CI/packaging tooling.
- The capability seam: `ctx.api` (control-plane methods, data-plane routes,
  health) + `ctx.capabilities` (manifests with a boot-time `verify()`), plus
  `@mediabase/schema` for validated boundaries and coded errors end to end — a new
  capability no longer edits the server.
- Process discipline: the engine subprocess is versioned (`hello` handshake,
  mismatches refused) and supervised (coded in-flight failures, backoff restart
  with a cap, status events forwarded to clients, health surfaced).
- The UI seam: `@mediabase/ui` is a React-free panel registry
  (header/sidebar/monitor) with `subscribe`/`revision`, so a capability — or a
  plugin loaded at runtime — adds UI by registering a panel. The shell
  (`@mediabase/ui-web`) names no capability: it depends only on `ui`, cordis and
  React, and `ui-media`/`ui-panels` can be dropped from the composition.

## Remaining gaps (UI chrome / packaging — not product verbs)

A panel registry with only three coarse areas and no visibility/ordering
configuration, `App.tsx`-level title and CSS class names, no method-level
permissions and no plugin sandbox (a runtime plugin runs in the host process), a
pull-only data plane, no i18n, and packaging/signing/licensing still unfinished
for third-party distribution.
The RPC surface itself is no longer hard-coded: capabilities self-register
methods, routes, health payloads and manifests into `ctx.api` / `ctx.capabilities`
and the server just reads those registries; params, results and tool arguments
are validated by one schema dialect with coded errors, and logging goes through
`ctx.log`.

## Three routes to make it generic

- **A. Fork and rebrand** — fastest; fine if you only build one product.
- **B. Extract a neutral base** (done as this repo): pull rpc/server/engine-session/
  plugins/workflow/agent/packaging into a neutral `base/`; keep media/python as
  example capability packages. Each new product = base + its capability
  packages + its UI.
- **C. Go full framework (DSH-grade)**: deepen the Slot/UI registration
  (finer slots, visibility/ordering config, slot props), plus loader/manifests,
  schema validation, settings/i18n/error-code infrastructure.

Status snapshot & full table: `docs/FRAMEWORK.zh.md`.
