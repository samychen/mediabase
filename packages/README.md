# packages

Capability packages, following the deepseek-harness convention
(`packages/<face>/<capability>`). Each package is one plugin capability with its
own README, exports a Cordis plugin (`name`/`inject`/`Config`/`apply`), provides
services via `ctx.reflect.provide`, and types `ctx` via
`declare module '@deepseek-ai/cordis'`.

Scope: everything in this repo is `@mediabase/*` — reusable + packable
(**never published**: `private: true`), never depending on a product scope
(`@avstudio/*`, `@yourapp/*`, …). Product capabilities live in consumer repos.
Face and scope are independent: the face chooses the typecheck plane, the scope
chooses reusability.

| Face | Package | Role |
|---|---|---|
| base | `rpc` | JSON-RPC 2.0 + notifications + coded errors |
| base | `schema` | mediabase schema dialect + JSON-Schema bridge |
| base | `log` | leveled, scoped logger as `ctx.log` |
| base | `protocol` | neutral contracts (no product verbs) |
| base | `engine-client` | line-protocol TRANSPORT only — no media verbs |
| base | `gateway` | HTTP/WS gateway (SPA + JSON-RPC + byte routes/streams) |
| base | `confine` | child-process confinement (Node + OS layer) |
| base | `shm` | shared-memory frame ring |
| host | `boot` | shared profile-boot + BootIdentity |
| host | `api` | control-plane registry + capability manifests |
| host | `server` | pure composition over gateway — names no capability |
| host | `tools` | capability tool registry (`ctx.tools`) |
| host | `plugins` | runtime plugin manager (load/unload/reload) |
| host | `settings` | persisted key→JSON (`appPaths.home/settings.json`) |
| host | `agent` | LLM agent loop over REGISTERED tools |
| client | `connection` | `ctx.rpc` + streams + net |
| client | `i18n` | messages + coded-error localization |
| client | `ui` | panel registry + SchemaForm helpers |
| client | `ui-web` | SHELL — title + renders `ctx.ui` panels (mount last) |
| bundle | `app` / `ui` | base cordis.patch.yml + client.yml |

Product layers add domain packages (media, preview panels, product protocol, …)
in the consumer repo, stacked after `@mediabase/bundle-app`.
