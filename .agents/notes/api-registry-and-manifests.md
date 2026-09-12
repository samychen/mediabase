# Note: the server names no capability — `ctx.api` + manifests + one schema dialect

Status: implemented

## Problem

Adding a capability meant editing four places: its plugin, its service, a
hand-written entry in `@mediabase/server`'s method map, and the client. The tool
registry had already removed that pattern for tools (`tools.list/run`), but the
control plane itself was still a 100-line literal full of `(p ?? {}) as
DecodeOptions` casts: no validation, no introspection, and every new verb an edit
outside the capability that owns it. Errors were bare `new Error(text)`, so the
UI could only match prose, and diagnostics were `console.log` plus raw engine
stderr.

## Decisions

**1. `ctx.api` is the control plane, and it is a registry like everything else.**
A capability registers `{name, description, params, result, handler}`, plus raw
byte routes and health contributors. `@mediabase/server` becomes
`methods: ctx.api.methodMap(), rawRoutes: ctx.api.routeMap(), health: () =>
ctx.api.healthPayload()` — it no longer contains the string "media". Verified by
reading the file: one capability name in it would be the signal the design
slipped.

**2. Namespaces stay conventions, not registries.** `media.*` / `python.*` are
just names a capability picks; the registry only enforces `capability.action`
shape and uniqueness. A capability may own several services (`media` provides
`ctx.media` + `ctx.previewState`) — service names and method names are separate axes.
The host frame buffer was renamed from `ctx.preview` to `ctx.previewState` once the
test plane put both faces in one program: the client-face `ctx.preview` (control
wrapper) had the same name with a different type.

**3. Manifests are declarations, and declarations are checked.** Each capability
registers a manifest (services/api/tools/events). Nothing *requires* it, so it
would rot — hence `capabilities.verify()` at boot, comparing the claim with what
actually registered, logged as a warning. The declared `events` list is also load
-bearing: the server forwards exactly those host events to clients, which is how
`media.play.tick` / `workflow.progress` reach the browser without a server edit
(and `capabilities.subscribe()` covers capabilities mounted at runtime).

**4. One schema dialect for every boundary.** `@mediabase/schema` wraps DSH's
`@deepseek-ai/schemastery` and adds `parse()` (path-carrying failure) and
`toJsonSchema()` (the OpenAI-style fragment the LLM needs). Params are validated
BEFORE the handler and results AFTER it: a capability that breaks its own contract
gets `-32603 能力契约不符` instead of shipping malformed data to the UI. Tool
parameters use the same schemas, so the JSON Schema sent to the model is derived,
never hand-maintained.

Rejected: JSON-Schema-as-source-of-truth (worse TS inference, and the LLM
fragment is a subset), and per-capability ad-hoc validation (that is what the
casts were).

**5. Codes on the wire, one formatter in the UI.** `RpcCode` (transport block +
`-320xx` application block) and `RpcError` live in `@mediabase/rpc`; the engine
client raises the same vocabulary (`ENGINE`, `UNAVAILABLE`), and `describeRpcError`
renders `[code] message` so "bad params" is distinguishable from "engine down".

**6. `ctx.log` instead of `console.log`.** Levels + child scopes; child-process
stderr is routed in through `EngineClientOptions.onStderr` (base stays free of
logging: it takes a callback). Default level `info`, `AVSTUDIO_LOG_LEVEL=debug`
surfaces engine/ffmpeg chatter.

## Evidence

- `tests/api-registry.test.ts` (11): schema/defaults/paths/JSON-Schema derivation,
  registration rules, INVALID_PARAMS/METHOD_NOT_FOUND/NOT_FOUND codes, result
  contract violation, registry teardown, manifest verify + subscribe, log levels.
- `tests/host.integration.test.ts` (+3): `api.list` exposes every namespace with
  signatures/JSON Schema, all capability declarations verify clean, malformed
  requests answer `-32602`/`-32601`/`-32001` with paths, and health/preview come
  from capability-contributed routes.
- `scripts/verify.mjs`: asserts capabilities verify and one coded error E2E.

## Known gaps (deliberate)

- Server-side "one place" is done; the **client** still hand-writes a panel per
  capability (a UI manifest/panel-from-schema generator is a separate piece of
  work).
- No schema versioning for the wire protocol, and no method-level
  permissions/audit — both listed as remaining base work.
