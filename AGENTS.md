# AGENTS.md

**mediabase** is the neutral, bootable base for media-shaped applications: reusable
`@mediabase/*` packages, real `@deepseek-ai/cordis` composition, a thin host CLI, a
capability-agnostic web shell, and an optional Electron packaging template. It is
**not** a product. Consumers (e.g. avstudio, small tools) supply their own identity,
domain capabilities, and — when they need one — a native engine.

This file is the standing rule set for AI agents and contributors, modeled on
deepseek-harness/AGENTS.md.

## The one layering rule

Anything that touches per-frame pixels, codecs, capture, or rendering belongs in a
**product** layer (and typically in a separate native process the product owns) —
**never** in this base. The host only issues commands and serves registries; frames
cross the data plane as bytes (pull / push / shared-memory ring), never through the
WS control plane. The shell (`@mediabase/ui-web`) renders whatever panels `ctx.ui`
holds — it names no media capability. Product layers add engine supervision, media
verbs, preview monitors, and domain panels on top of this base.

## Repository layout

```
apps/
  cli/       thin host entry: BootIdentity + @mediabase/boot (profile/bundle/patch).
             Capability verify is apps/cli (via boot helpers); drop-ins from
             ${prefix}CAPABILITY_DIR mount as one more insert layer
  web/       Vite app shell: CLIENT ROSTER from packages/bundle/ui/client.yml
             (generated into src/roster.generated.ts); mounts and nothing else
packages/    packages/<face>/<capability> (DSH convention).
             SCOPE RULE: everything here is @mediabase/* — reusable and packable
             (never published). Product scopes (@avstudio/*, @yourapp/*, …) live in
             consumer repos and must never be imported by @mediabase/*. Face
             (base/host/client/bundle) chooses the typecheck plane; scope chooses
             reusability — independent axes.
  base/      rpc · schema · log · protocol · engine-client (line transport only —
             no command verbs) · gateway · confine · shm
  host/      boot (shared profile-boot + BootIdentity) · api (ctx.api +
             ctx.capabilities) · tools · plugins · settings · agent · server
             (pure composition over gateway — names no capability)
  client/    connection · i18n · ui · ui-web (SHELL last)
  bundle/    app (cordis.patch.yml) + ui (client.yml) — base rows only
packaging/   desktop-electron: generic shell + sample PRODUCT block (no engine)
scripts/     build-base · build-host · verify:compose · verify:base · notice · …
tests/       package + composition + handoff-neutrality (no engine required)
```

This repo ships **no** agent notes or repo-local skills: `.agents/notes` and the
`.agents/skills` set describe a *product's* history and belong to the consumer repo.

Product layers (elsewhere) typically add: domain packages, a C++/native engine, a
product protocol package, media/preview UI, and profile bundles stacked **after**
`@mediabase/bundle-app`.

## Commands

```sh
pnpm install                # workspace deps
pnpm run build              # web bundle (base roster)
pnpm run build:base         # @mediabase/* -> dist/ (ESM + d.ts) for local packing
pnpm run build:host         # closed host runtime
pnpm run notice             # regenerate NOTICE.md (third-party attributions)
pnpm run host               # http://127.0.0.1:3088
pnpm run typecheck          # tsc -p tsconfig.host.json && -p tsconfig.client.json && -p tsconfig.test.json
pnpm test                   # vitest (base suites; no C++ engine required)
pnpm run lint               # oxlint
pnpm run verify:base        # neutral smoke: shell + health + control plane + registry
pnpm run verify:compose     # composition gate: layer rows resolve, !!js only where evaluated
MEDIABASE_ENV_PREFIX=EXPT_ pnpm run host   # swap the whole env vocabulary (tests, embedding)
pnpm run host -- --dump-config   # print composed layers/rows WITHOUT booting
pnpm run gen:config-catalog  # regenerate docs/CONFIG-CATALOG.md from rows + each Config
MEDIABASE_READONLY=1 pnpm run host               # mutating methods refused (-32021)
MEDIABASE_STRICT_CAPABILITIES=1 pnpm run host   # CI gate: boot fails on a lying manifest
MEDIABASE_NO_BROWSER=1 pnpm test                # browserless CI: browser e2e skips
MEDIABASE_CHROME_ARGS=--no-sandbox pnpm test    # nested sandbox: skip doomed launch
```

Default identity: `bin=mediabase` · `MEDIABASE_` · `~/.mediabase`. Products inject
their own (`AVSTUDIO_` / `~/.avstudio`, …) via `BootIdentity` — never by forking
`profile-boot`.

## Conventions (real cordis, as DSH uses it)

- **Everything is a plugin.** A capability package exports a Cordis plugin:
  `name` / `inject` / `Config` / `apply(ctx, config)` (see
  `packages/host/server/src/index.ts` and DSH's `frontend-static` for the shape).
- **A capability registers its own surface.** It declares methods, data-plane
  routes and health into `ctx.api`, its tools into `ctx.tools`, its panels into
  `ctx.ui`, and what it claims to contribute into `ctx.capabilities` (a manifest
  that `capabilities.verify()` checks at boot). The server/shell therefore name
  no capability — if you find yourself editing them to add one, the registration
  is in the wrong place.
- **Validate at the boundary with `@mediabase/schema`.** API params/results and tool
  arguments are schemas, not `unknown` + casts; failures are coded
  (`RpcCode.INVALID_PARAMS` with a path). Throw `RpcError` for application
  errors so a client can branch on `code` instead of matching prose.
- **Log through `ctx.log`**, never `console.log`: `ctx.log.child('<capability>')`
  gives a scope, levels are configurable via `${prefix}LOG_LEVEL` (read by the log ROW through
  `ctx.env.choice`, so a typo falls back to `info` instead of stopping the boot), and child
  process stderr is routed in (`EngineClientOptions.onStderr`).
- **Services.** Provide with `ctx.reflect.provide(name, value)` inside `apply`
  (auto-unregistered with the fiber); consume with `ctx.get(name)` or the typed
  property `ctx.name`; declare hard dependencies with `export const inject =
  ['name']` — the fiber waits and is reactivated when the service appears. Type
  `ctx` via `declare module '@deepseek-ai/cordis' { interface Context { … } }`
  in the providing package; consumers add a type-only import of that package.
- **The deployment vocabulary has ONE prefix, decided by the boot identity.** This
  repo defaults to `MEDIABASE_`; a product passes its own `BootIdentity`
  (`bin` / `envPrefix` / `homeDir` / `defaultProfile` / `profileKey`) into
  `@mediabase/boot`. Consequences a contributor must respect: a row writes SHORT
  names — `ctx.env.str('TOKEN')` is `${prefix}TOKEN` — so no row and no base
  package ever spells a product (`ctx.env.raw`/`rawNum` are for variables the
  ENVIRONMENT owns, like `PORT`; `ctx.env.choice` is for a knob whose typo must NOT
  stop the boot). The app's own name reaches a row as `ctx.appPaths.bin`; a
  capability that must read the environment (plugin sandbox entry / demo catalog)
  receives `envPrefix: !!js ctx.env.prefix` through its `Config`.
  `${prefix}ENV_PREFIX` swaps the vocabulary wholesale for tests/embedding; there
  is deliberately NO "accept both" layer (`tests/env-prefix.test.ts`).
- **A composition is DATA, so a gate checks it and the boot pre-flights it.** A
  composition mistake is invisible until one deployment boots — a row naming a
  package the app does not depend on, a `!!js` expression in a field the Loader
  never interpolates, a patch whose id no layer declares. `pnpm run verify:compose`
  checks all three statically; `resolveRowSpecifiers` in `@mediabase/boot` repeats
  the resolution check before mounting, naming the row. A bundle's rows resolve
  from THAT bundle's manifest; a profile layer or `--patch` overlay resolves from
  `apps/cli/package.json`.
- **Composition is a bundle + PATCH LAYERS — the only path.** A profile
  (`${prefix}HOME` / `profiles/<name>/`, home defaults to `~/.mediabase`) composes
  the host from patch layers: every bundle's `cordis.patch.yml` (order from
  `package.json`'s `{profileKey}.bundles`) → the profile's own patch →
  `$HOME/cordis.patch.yml` under the identity home → `--patch` overlays. A later
  layer overrides an earlier row **by id** and replaces its whole `config` — an
  override RESTATES every field that row needs. Mechanism: `@mediabase/boot`;
  base rows: `packages/bundle/app/cordis.patch.yml`. `!!js` under `config`
  evaluates against loader context (`ctx.appPaths`, `ctx.env`) before mount.
- **A row's config is validated by the capability's own `Config`.** Wrong type or
  missing required field stops the boot with a path. Fields whose ABSENCE carries
  meaning (`plugins.catalog`, `plugins.sandbox`) are validated in `apply` against
  what the row STATED — never "was it stated?" after cordis normalisation. Treat
  `undefined` and absent the same (`??`, never `in`). Never layer env under a
  config inside `apply`.
- **Patch layers are the ONLY composition path.** A new capability = a package + a
  ROW in the bundle (or a product/profile layer). `tests/compose-yml.test.ts`
  freezes the composed surface so a dropped row or forgotten env knob fails there.
- **The page composes from data too — a generated roster.** `packages/bundle/ui/client.yml`
  lists client plugins in MOUNT ORDER; `scripts/gen-client-roster.mjs` emits
  `apps/web/src/roster.generated.ts`. Shell last (`@mediabase/ui-web`). Adding a UI
  package = a row in the bundle + `pnpm install`, never an edit to `main.tsx`.
- **A bundled host ships a CLOSED RUNTIME, and a shared module must be shared.**
  `pnpm run build:host` emits `build/plugins.json` + `build/plugins/*.cjs`. Manifest
  search order: `${prefix}PLUGIN_MANIFEST` → beside the running entry → installation
  anchor's `build/`. Modules whose runtime IDENTITY crosses a boundary must be ONE
  instance (`@mediabase/rpc` in `SHARED_MODULES` — `e instanceof RpcError`). Prefer
  structural checks (`hasRpcCode`) for anything new.
- **The composition can be inspected without booting it.** `--dump-config` /
  `--dump-default-config` resolve layers through the SAME `planComposition` the boot
  uses; no mount, no `!!js` evaluation, dialect round-trips.
- **A row's contract is generated, not hunted for.** `pnpm run gen:config-catalog`
  writes `docs/CONFIG-CATALOG.md` + `docs/config-catalog.json`. `pnpm test` fails when
  it is stale.
- **A settled tree is audited, not assumed.** `assertEntriesActivated` fails the boot
  when an enabled row did not become ACTIVE, naming the row.
- **Declarations are verified at boot.** `capabilities.verify()`;
  `${prefix}STRICT_CAPABILITIES=1` makes a lying manifest a boot failure.
- **Registries are live.** Gateway resolves method map / raw routes per request —
  late-mounted drop-ins and runtime plugins are immediately callable.
- **NEVER PUBLISH.** Every package is `private: true`. `pnpm pack` for private
  consumption / CI is fine; do not remove `private`, add registry credentials, or
  wire a public publish step into CI.
- **Reusable code is `@mediabase/*` and stays product-free.** Base packages build
  standalone (`pnpm run build:base`); importing a product scope is a design error.
  Each package must typecheck alone.
- **Every side effect is a fiber effect.** `ctx.effect(() => () => cleanup(),
  'label')`. Child processes, timers, servers, sockets and temp files must all be
  registered this way.
- **Async state is guarded.** Re-check or capture after every await. An unexpected
  throw must never take the host down.
- **An optional environment is probed by execution — ALL of it.** Missing browser /
  OS sandbox / codec → skip with a reason, never redden the suite.
  `MEDIABASE_NO_BROWSER=1`, `MEDIABASE_CHROME_ARGS` are the cheap seams.
- **Control plane ≠ data plane.** WS `/rpc` carries commands/status only. Bytes
  travel as pull (`GET /api/<name>`), push (`WS /stream`), or **shared memory**
  (`@mediabase/shm`). Producers do no work with zero subscribers; transports drop
  rather than unbounded-queue. A ring is SPSC; a view is valid only until the next
  `acquire()`.
- **A request is queued or it fails — never dropped.** Client control-plane `send`
  queues while CONNECTING/reconnecting; fails in-flight calls on close.
- **The front door is bounded and fails loudly, never fatally.** `@mediabase/gateway`
  caps payload and connections; throwing handlers become -32603/500 via `onError`.
  `gateway.close()` drains WS (1001) then finishes in-flight responses, then closes
  the listener.
- **No UI string lives in a component.** Every UI package ships `messages.ts`
  (zh-CN + en); components call `useI18n(ctx)` and render `t('key')`.
- **Host errors travel as a code, plus a key when the detail matters.**
  `RpcError` + optional `messageKey` / `messageParams`; client renders via
  `ctx.i18n.errorText`. Codes localize by derivation from `RpcCode`.
- **API UI is generated, not hand-written.** `fieldsFromSchema` / `SchemaForm`;
  hand-write a panel only when a form cannot express the interaction.
- **A runtime plugin that must be contained runs in a sandbox.**
  `isolation: 'process'` — log / events / declared service calls / exported `api`
  only. Sandboxed plugins cannot `provide` host services.
- **A boundary that is claimed must be enforced, or the claim must be withdrawn.**
  `@mediabase/confine`: Node permission model + OS layer (Seatbelt / Bubblewrap).
  Probe availability by EXECUTION; unavailable denials never appear as `enforced`.
  `confinement.required: true` fails closed. Confinement on `in-process` is
  INVALID_PARAMS.
- **Runtime plugins get least privilege.** Catalog `requires` restricts the context;
  never widen it "to make it work".
- **Licensing: MIT for this base.** First-party code is MIT (root `LICENSE`).
  Product consumers that ship native FFmpeg-linked binaries carry their own GPL /
  nonfree obligations — see their docs; this repo's default Electron package does
  **not** ship an engine.
- **The host is a local service.** `${prefix}TOKEN` (opt-in) gates `/api/*` and both
  WS endpoints; the SPA stays public. Local trust boundary — no TLS, no users, no
  sessions.
- **State-changing methods declare it.** `mutates: true` enables
  `policy({ readonly: true })` (`${prefix}READONLY=1`). ACL allow/deny lists
  (`${prefix}ACL_ALLOW` / `ACL_DENY`) enforce inside `ctx.api.call()` as
  `RpcCode.FORBIDDEN`.
- **Bump CONTROL_PROTOCOL_VERSION with the control plane.** Handshake via
  `server.info`; mismatch reported in `connection.status`. Product engine wire
  protocols bump separately in the product (`hello` / `ENGINE_PROTOCOL_VERSION`).
- **Every control-plane call is audited in one place.** `ctx.api.call()` —
  `${prefix}LOG_LEVEL=debug` for a request trail.
- **A separate process is a supervised process.** Product capabilities that own a
  child (engine, sidecar) must reject in-flight calls on death, report exit, restart
  with backoff+cap, and clear timers in `ctx.effect`. `@mediabase/engine-client`
  provides primitives; the policy belongs to the product capability.
- **TypeScript strict everywhere** (`tsconfig.base.json`): noUncheckedIndexedAccess,
  exactOptionalPropertyTypes, noUnusedLocals/Parameters. Two-plane typecheck:
  `tsconfig.host.json` / `tsconfig.client.json`. Relative imports carry explicit
  `.ts` / `.tsx` extensions.
- **Comments state non-obvious contracts**, not implementation narration.

## Adopting this base

`docs/WALKTHROUGH.zh.md` is the hands-on version of this: build a calculator beside
the base whose computation has interchangeable JS / Python / C++ backends (12 files,
no base change) — read it before the checklist if you have never mounted a row.

`docs/HANDOFF.zh.md` is the checklist for a **product** that adopts this repo: what
stays as base, what the product owns, identity / bundle / roster / `PRODUCT` block,
and which properties `tests/handoff-neutrality.test.ts` guards (no machine paths,
base scripts product-free, `@mediabase/*` never importing a product scope). Keep it
true: a change that makes a base-usable script product-specific belongs in the
consumer repo.

## Where design decisions live

This base has **no** `.agents/notes/` and **no** repo-local skills: a base that is
handed to many consumers must not carry one product's history. Decisions that a
consumer or a future maintainer needs are written into the durable docs —
`docs/FRAMEWORK.zh.md` (what is reusable, what stayed product-side),
`docs/HANDOFF.zh.md` (adoption checklist), `docs/CONFIG-CATALOG.md` (generated row
contracts), `docs/STATUS.zh.md` (deliberate deltas from DSH) — or into this file as
a rule. Anything else is a commit message.
