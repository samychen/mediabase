# AGENTS.md

AVStudio is a skeleton for an OBS-like media application with a web UI and
plugin architecture, built on **real `@deepseek-ai/cordis`** — the same framework
DeepSeek Harness runs on. A TypeScript/Node host drives an **independent C++
media-engine process**; a React + Vite client renders control panel and preview.
This file is the standing rule set for AI agents and contributors, modeled on
deepseek-harness/AGENTS.md.

## The one layering rule

Real-time media work belongs to the C++ engine process (`engine/`) — **never** to
the JS host. The host only issues commands (`testpattern` / `decode` / `probe` /
`play`). Frames cross to the web client as raw bytes over HTTP
(`/api/preview.rgb`), never through the WS control plane, and are painted by the
media capability's monitor panel (`packages/client/ui-media`) — not by the shell.
Anything that touches per-frame pixels, codecs, capture, or rendering must stay
out of the neutral base and out of `@mediabase/ui-web`.

## Repository layout

```
apps/
  cli/       host entrypoint. Composition is the profile/bundle/patch Loader
             (apps/cli/src/profile-boot.ts) and nothing else; the capability
             manifest check is apps/cli/src/verify-capabilities.ts, and drop-in
             modules from AVSTUDIO_CAPABILITY_DIR are discovered by
             apps/cli/src/dropins.ts and mounted as one more insert layer
  web/       Vite app shell: composes the CLIENT ROSTER (the UI bundle's `client.yml`,
             generated into src/roster.generated.ts) into the page (DSH apps/web)
packages/    capability packages, packages/<face>/<capability> (DSH convention).
             SCOPE RULE: @mediabase/* = reusable and packable (never published), and
             must never depend on a @avstudio/* package; @avstudio/* = this product's
             capabilities, i.e. the scope a fork renames. The base scope is deliberately
             NEUTRAL and carries no product identity, because this layer is meant to be
             adopted as-is (it was `@avbase/*`, which named AVStudio inside the layer that
             claims to be product-free). The face directory (base/host/client) chooses the
             typecheck plane, the scope chooses reusability — independent axes.
  base/      neutral base (@mediabase/*): rpc (JSON-RPC + coded errors) · schema
             (schema dialect + JSON-Schema bridge) · log (ctx.log) · protocol
             (neutral contracts) · engine-client (line transport only — no
             command verbs) · gateway (HTTP/WS)
  protocol/  @avstudio/protocol: product contracts (media/python/workflow)
             + re-export of @mediabase/protocol
  host/      api (control-plane registry ctx.api: methods/routes/health +
               capability manifests ctx.capabilities)
             media (owns + supervises the C++ engine and the media verb
               vocabulary, ctx.media + ctx.previewState)
             python (python sidecar worker, ctx.python tools)
             tools (tool registry: capabilities register, ctx.tools)
             workflow (recipe runner over REGISTERED tools, ctx.workflow)
             agent (LLM agent loop over REGISTERED tools, ctx.agent)
             plugins (runtime plugin manager: load/unload/reload, ctx.plugins)
             server (pure composition over @mediabase/gateway — reads ctx.api,
               names no capability)
  client/    connection (ctx.rpc + ctx.streams + ctx.net) · i18n (ctx.i18n)
             · ui (panel registry ctx.ui + shared panel-state contract ctx.view +
               JSON-Schema form helpers; React-free, capability-free)
             · preview (ctx.preview wrapper)
             · ui-web (SHELL: capability-agnostic — title + renders ctx.ui panels
               in header/sidebar/monitor, reactive to late registration)
             · ui-media (example media capability: provides ctx.view + console +
               monitor)
             · ui-panels (example external UI package: connection badge (header)
               + python/workflow/plugins/settings/agent panels)
engine/      C++ media engine (g++/CMake, zero libs beyond optional
             MediaComponent) — decode backend: MediaComponent in-process by
             default (AVReader/Decoder), ffmpeg-CLI fallback when built without
             it (engine/CMakeLists: AVSTUDIO_USE_MEDIACOMPONENT)
python/      sidecar worker (stdlib-only tools; see packages/host/python)
desktop/     Tauri shell (Mode A): spawns the same host, loads its URL
scripts/     end-to-end verification
.agents/     agent skills (mirrored under .claude/)
```

## Commands

```sh
pnpm install                # workspace deps
pnpm run build              # C++ engine + web bundle
pnpm run build:base         # @mediabase/* -> dist/ (ESM + d.ts) for local packing (see below)
pnpm run notice             # regenerate NOTICE.md (third-party attributions)
pnpm run host               # Mode B: http://127.0.0.1:3088
pnpm run typecheck          # tsc -p tsconfig.host.json && -p tsconfig.client.json && -p tsconfig.test.json
pnpm test                   # vitest: rpc · registries · supervision · capability loading · UI · engine · host
pnpm run lint               # oxlint
pnpm run verify:base        # neutral smoke: shell + health + control plane + registry
pnpm run verify             # product smoke: media verbs + pull/push data planes
pnpm run verify:compose     # composition gate: layer rows resolve, !!js only where evaluated
AVSTUDIO_ENV_PREFIX=EXPT_ pnpm run host   # swap the whole env vocabulary (tests, embedding)
pnpm run host -- --dump-config   # print the composed layers/rows WITHOUT booting (add --patch to preview an overlay)
pnpm run gen:config-catalog  # regenerate docs/CONFIG-CATALOG.md from the rows + each Config
AVSTUDIO_READONLY=1 pnpm run host               # method-level ACL: mutating methods refused (-32021)
AVSTUDIO_STRICT_CAPABILITIES=1 pnpm run host   # CI gate: boot fails on a lying manifest
AVSTUDIO_NO_BROWSER=1 pnpm test                # browserless CI: the browser e2e suite skips (with a reason)
AVSTUDIO_CHROME_ARGS=--no-sandbox pnpm test    # nested sandbox: skip the doomed launch attempt
```

Mode A (Tauri desktop shell) lives in `desktop/`; it spawns the same host and
loads the same built client — one codebase, two shells.

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
- **The deployment vocabulary has ONE prefix, decided by the boot identity.** What differs
  between the neutral base and a product lives in `apps/cli/src/identity.ts` (`bin`,
  `envPrefix`, `homeDir`, `defaultProfile`); AVStudio is a consumer that keeps `AVSTUDIO_`,
  and the base defaults to `MEDIABASE_`. Consequences a contributor must respect:
  a row writes SHORT names — `ctx.env.str('TOKEN')` is `${prefix}TOKEN` — so no row and no
  base package ever spells a product (`ctx.env.raw`/`rawNum` are for variables the
  ENVIRONMENT owns, like `PORT`; `ctx.env.choice` is for a knob whose typo must NOT stop the
  boot, which is how the log level keeps its fallback without the package reading env);
  the app's own name reaches a row as `ctx.appPaths.bin` (the log scope is
  `scope: !!js ctx.appPaths.bin`); a capability that genuinely must read the environment
  (the plugin manager's sandbox entry and demo catalog) receives the prefix through its
  `Config` as `envPrefix: !!js ctx.env.prefix`. `${prefix}ENV_PREFIX` swaps the vocabulary
  wholesale for tests/embedding, and there is deliberately NO "accept both" layer — a silent
  second vocabulary is how one of them rots (`tests/env-prefix.test.ts` proves the old one
  stops being read).
- **A composition is DATA, so a gate checks it and the boot pre-flights it.** A composition
  mistake is invisible until one deployment boots — a row naming a package the app does not
  depend on, a `!!js` expression in a field the Loader never interpolates, a patch whose id
  no layer declares. `pnpm run verify:compose` (`scripts/verify-composition.mjs`) checks all
  three statically over every shipped layer, and `resolveRowSpecifiers` in
  `apps/cli/src/profile-boot.ts` repeats the resolution check for a deployment's own layers
  before mounting, naming the row. A bundle's rows resolve from THAT bundle's manifest
  (a bundle declares what it mounts); a profile layer or `--patch` overlay resolves from
  `apps/cli/package.json`. Adding a capability therefore means declaring it in the manifest
  whose layer names it.
- **Composition is a bundle + PATCH LAYERS — the only path.** A profile
  (`$AVSTUDIO_HOME/profiles/<name>/`, `AVSTUDIO_HOME` defaults to `~/.avstudio`) composes
  the host from patch layers, applied in this order: every bundle's `cordis.patch.yml`
  (in the order `package.json`'s `avstudio.profile.bundles` lists them) → the profile's
  own `cordis.patch.yml` → `$AVSTUDIO_HOME/cordis.patch.yml` → `--patch` overlays. A row
  is inserted with `- insert:`; a later layer overrides an earlier row **by id** and
  replaces its whole `config` — so an override RESTATES every field that row needs
  (usually `root` plus the env-derived values it wants), and forgetting one stops the boot
  naming the row and the failing path. Rows are mounted by the vendored Loader
  (`@deepseek-ai/cordis-plugin-loader` + `cordis-plugin-include`); the mechanism lives in
  `apps/cli/src/profile-boot.ts` and the host's row list in
  `packages/bundle/app/cordis.patch.yml`. `!!js` expressions are allowed under `config` and
  evaluate against the loader context, where the composition provides, before the tree
  mounts: `ctx.appPaths` (`{root, home}`) and `ctx.env`
  (`str`/`num`/`flag`/`list` over the boot's environment — an unset variable is `undefined`,
  so the field stays absent and the capability's own default applies, while a value that
  cannot mean what it says names the variable and stops the boot). A deployment value is
  therefore CONFIG, stated in the file a reader edits:
  `port: !!js ctx.env.rawNum('PORT')`.
- **A row's config is validated by the capability's own `Config`.** `Config` is the single
  contract for what a row may say: a wrong type or a missing required field stops the boot
  with a path (`$.root missing required value`), and a path that depends on the application
  root is resolved in `apply` — never repeated in a composition. One framework detail
  decides where a field BELONGS: cordis validates a plugin's config before `apply` and
  normalises it **in place** (an absent array becomes `[]`, an absent object `{}`, a schema
  default is indistinguishable from a stated value). So a field whose ABSENCE carries
  meaning — `plugins.catalog` (absent = the shipped defaults, `[]` = load nothing) or
  `plugins.sandbox` (absent = process isolation unavailable) — is declared only for scalars
  in `Config` and validated in `apply` against what the row STATED. Never read
  "was it stated?" after validation, and never layer the environment under a config inside
  `apply`. (An unset variable leaves a present key whose value is `undefined`, so a consumer
  treats `undefined` and "absent" the same way — `??`, never `in`.)
- **Patch layers are the ONLY composition path — there is no second one to keep in step.**
  The in-code capability table and each capability's `resolveConfig` env translator are
  deleted; `AVSTUDIO_COMPOSE` no longer exists. So a new capability = a package + a ROW in
  the bundle (or a profile layer), and its env vocabulary = expressions on that row.
  `tests/compose-yml.test.ts` freezes the composed surface (the capability set, one method
  per capability, the env vocabulary map) so a dropped row, a renamed capability or a
  forgotten env knob fails there instead of in a deployment.
- **The page composes from data too — a generated roster.** `packages/bundle/ui/client.yml`
  (the UI bundle) lists the client plugins in MOUNT ORDER; `scripts/gen-client-roster.mjs`
  turns it into `apps/web/src/roster.generated.ts` (static imports, because a browser bundle
  cannot resolve a package name at runtime), and `apps/web/src/main.tsx` does nothing but
  mount the roster. Order is the file's meaning: a registry before its consumers, and the
  shell last (`@mediabase/ui-web` mounts React and renders what `ctx.ui` already holds — mounted
  earlier it renders an empty page with NO error). `pnpm run verify:compose` checks the roster
  (rows are exactly `id` + `name`, ids unique, the shell the bundle's manifest names is last),
  `pnpm run verify:ui` / `pnpm test` fail when the generated module is stale, and
  `pnpm run build:web` regenerates it before Vite runs. Adding a UI package = a row in the
  bundle + `pnpm install`, never an edit to the entry module.
- **A bundled host ships a CLOSED RUNTIME, and a shared module must be shared.** `pnpm run
  build:host` emits `build/plugins.json` + `build/plugins/*.cjs` (one file per bare row name
  in the bundle layer, derived from that file so it cannot go stale) and the host mounts
  those files when the manifest is present, in the order `AVSTUDIO_PLUGIN_MANIFEST` → beside
  the running entry → the installation anchor's `build/`. Modules whose runtime IDENTITY
  crosses a boundary must be ONE instance: `@mediabase/rpc` is bundled once into
  `build/node_modules/@mediabase/rpc` because `makeServer` decides with
  `e instanceof RpcError`, and two copies silently downgrade every capability's coded error
  to `-32603` and drop its `messageKey` (measured — see `SHARED_MODULES` in
  `scripts/build-host-bundle.mjs`). Add a module there only with the same argument, and
  prefer structural checks (`hasRpcCode`) for anything new.
- **The composition can be inspected without booting it.** `--dump-config` (and
  `--dump-default-config`, which never parses the user layer) resolves the layers through the
  SAME `planComposition` the boot uses and composes them with the include's own
  `applyEntryPatches`, printing each row under the layer that inserted it plus
  `patched by <layer>` when a later one rewrote it. It mounts nothing, imports no capability,
  evaluates no `!!js` (a deployment value prints as the expression) and binds no port; the
  dialect round-trips, so a dump is also a valid patch file. A snapshot must be the PREFIX of
  the layers — applying one layer to the root loses everything the earlier layers inserted (an
  empty user layer resets the tree to the anchor).
- **A row's contract is generated, not hunted for.** `pnpm run gen:config-catalog` reads the
  shipped bundle's rows and each capability's `Config` and writes `docs/CONFIG-CATALOG.md` +
  `docs/config-catalog.json`: what every row STATES (with `!!js` printed as the expression) and
  what its capability ACCEPTS (types, required flags, defaults). `pnpm test` fails when it is
  stale and when it stops covering a row, because a catalog a reader trusts is worse than none.
- **A settled tree is audited, not assumed.** `assertEntriesActivated` (in
  `apps/cli/src/profile-boot.ts`, ported from the harness boot) fails the boot when an
  enabled row did not become ACTIVE, naming the row: a pending one reports the service it
  waits for, a failed one keeps its own error and stack. Without it a typo in a patch layer
  comes up as a host silently missing a capability.
- **Declarations are verified at boot.** `capabilities.verify()` compares each
  manifest with what actually registered; dev logs a warning, and
  `AVSTUDIO_STRICT_CAPABILITIES=1` (CI, packaging) makes it a boot failure. If you
  add api/tools/services to a capability, update its manifest in the same change.
- **Registries are live.** The gateway resolves the API method map (and raw
  routes) per request, so a capability mounted after boot — a drop-in module or a
  runtime plugin load — is immediately callable. Do not snapshot a registry into
  a long-lived object.
- **NEVER PUBLISH.** Every package is `private: true` on purpose, and no release,
  registry, token or `publish` invocation belongs in this repo. `pnpm pack` (local
  tarballs for private consumption, CI artifacts, hand-offs) is fine and tested —
  publishing is the maintainer's explicit decision, taken elsewhere. Do not remove a
  `private` flag, add registry credentials, or wire a publish step into CI.
- **Reusable code is `@mediabase/*` and stays product-free.** Base packages build
  standalone (`pnpm run build:base`) and can be packed from `dist` via
  `publishConfig` (which `pnpm pack` also applies); a base package importing `@avstudio/*` is a design error, and
  each one must typecheck alone (a cross-package `declare module` augmentation you
  consume needs a type-only import in the consuming package).
- **Every side effect is a fiber effect.** `ctx.effect(() => () => cleanup(),
  'label')` runs the body now and the cleanup on fiber dispose. Child processes,
  timers, servers, sockets and temp files must all be registered this way — a
  SIGINT test asserts no orphan engine process survives `ctx.fiber.dispose()`.
- **Async state is guarded.** A value read before an `await` may be gone after
  it (see the media play loop): re-check or capture after every await. An
  unexpected throw must never take the host down.
- **An optional environment is probed by execution — ALL of it.** A test that needs
  something the machine may not have (a browser, an OS sandbox, a codec) must turn
  every failure into a reported reason and SKIP; an environment fact must never redden
  the suite, because then the suite cannot be run anywhere unknown. `tests/support/browser.ts`
  learned this the hard way: the binary/port/socket steps returned reasons while the CDP
  handshake threw, so a machine whose outer sandbox blocks Chrome's own sandbox failed
  instead of skipping. When a probe needs a deviation to get coverage (launching Chrome
  with `--no-sandbox` because nesting is refused), take it but DISCLOSE it — a green run
  that silently measured a different browser is worse than an honest skip. Cheap seams
  (`AVSTUDIO_NO_BROWSER=1`, `AVSTUDIO_CHROME_ARGS`) exist so CI never pays for a
  probe it cannot use.
- **Control plane ≠ data plane.** WS `/rpc` (JSON-RPC) carries commands/status
  only. Bytes travel on the data plane in one of three shapes, all behind the same
  producer interface (`ctx.api.route` / `ctx.api.stream` → `attach(sink)`): pull
  (`GET /api/<name>`), push (`WS /stream`), or **shared memory** (`@mediabase/shm`: the
  consumer reads a VIEW of the ring's buffer, so a monitor stops allocating and copying
  per frame — `openRingStream` on the client; a browser needs cross-origin isolation,
  which `gateway.crossOriginIsolation` serves and does NOT enable by default). Pick per
  problem, and let a UI fall back from push to pull when the stream is not live.
  Producers do no work with zero subscribers; the transport owns backpressure and drops
  rather than queueing an unbounded backlog — the ring makes that structural (it
  overwrites the oldest slot and counts it). A ring is SPSC with a view valid only until
  the next `acquire()`; state both when you use one.
- **A request is queued or it fails — never dropped.** The client's control-plane `send`
  runs while the socket may still be CONNECTING (panels call on mount) or reconnecting:
  queue with a bound and flush on open, and fail in-flight calls when the socket closes.
  Measured the hard way: a silently dropped request is not an error anywhere — it is a
  30-second timeout and an empty panel, with a healthy host and zero page exceptions.
- **The front door is bounded and fails loudly, never fatally.** `@mediabase/gateway`
  caps an incoming WS frame (`maxPayload`, 1 MiB — the control plane carries no
  media) and the number of live WS connections (`maxConnections`), and answers 503
  beyond it; a throwing method map / raw route / health probe becomes -32603 or 500
  (reported through `onError`) instead of an unhandled rejection, which would end
  the process. `gateway.close()` drains: WS clients get a 1001 farewell, in-flight
  responses finish, only then does the listener close. That ORDER is deliberate —
  Node's `server.close()` closes "idle" connections, and a response that is still
  queued counts as idle, so closing the listener first truncates the very response
  the drain exists to protect (`tests/gateway-limits.test.ts`).
- **No UI string lives in a component.** Every UI package ships `messages.ts`
  (zh-CN + en) and registers it into `ctx.i18n` at apply time; components call
  `useI18n(ctx)` and render `t('key')`, panel titles register a `titleKey`, and a
  status line that stays on screen stores a KEY + params (rendering text into
  state freezes the old language). `tests/i18n-coverage.test.ts` fails on a CJK
  literal outside `messages.ts` (comments and host-side diagnostics excepted).
- **Host errors travel as a code, plus a key when the detail matters.** The host
  keeps its own prose (log, CLI, bug report) and throws `RpcError` with a `code`;
  when the message carries detail a translator cannot guess ("unknown setting
  \"x\""), pass `messageKey` + `messageParams` in the error options and the client
  renders THAT key in the user's language (`ctx.i18n.errorText`), falling back to
  the host prose when it has no such key. Codes are localized by derivation from
  `RpcCode` — never re-hand-write a code→text table (the hand-written one had
  already lost FORBIDDEN and mislabeled PARSE_ERROR).
- **API UI is generated, not hand-written.** A capability publishes params as
  JSON Schema; `fieldsFromSchema`/`SchemaForm` (`@mediabase/ui`) turn that into a
  usable form, and the API console panel exposes every registered method. Hand-write
  a panel only for interactions a form cannot express.
- **A runtime plugin that must be contained runs in a sandbox.** `isolation: 'process'`
  gives it its own child process: `log`, `events`, declared service calls and an
  exported `api` are the ONLY channels (the host checks `requires` on ITS side, so the
  plugin cannot skip it), a crash is contained and visible, and a plugin stuck in
  `apply()` is killed on deadline instead of hanging the host. Sandboxed plugins cannot
  `provide` host services; the child entry (`build/sandbox.cjs`, or the TS source run
  natively by Node in a checkout) must exist as a file and is not bundled into the host.
- **A boundary that is claimed must be enforced, or the claim must be withdrawn.**
  Process isolation contains a crash; it does NOT restrict a hostile module, because the
  child runs as the same user. `@mediabase/confine` adds the restriction: Node's permission
  model (filesystem limited to the declared roots, no subprocesses/workers/native
  addons) plus an OS layer — Seatbelt via `sandbox-exec` on macOS, Bubblewrap on Linux —
  for what Node cannot express, above all **network denial**. Two rules follow:
  availability is probed by EXECUTION (a binary that exists but returns
  `sandbox_apply: Operation not permitted` is unavailable, and that reason is the report),
  and a requested denial that cannot be enforced goes into `unavailable`, never into
  `enforced` — with `confinement.required: true` available to FAIL CLOSED instead of
  loading a less confined child. Roots are passed in BOTH forms (as given and
  realpath-resolved) because Node compares paths literally, and `tsx` needs worker
  threads, which is exactly what the policy denies: prefer the worker-free entry and
  report the give-up (`allowWorker`) rather than silently weakening the policy. A
  confinement on an `in-process` entry is a declaration error (INVALID_PARAMS), not a
  no-op.
- **Runtime plugins get least privilege.** A catalog entry that declares
  `requires` hands the module a restricted context: framework members plus the
  listed services only, and the module's own `inject` must fit inside that list.
  This is least privilege + auditability (`ctx.log` scope `avstudio.plugins`), NOT
  a sandbox — same process, same rights. Never widen `requires` "to make it work";
  widen the declaration deliberately.
- **Licensing: MIT for our code, not for the binaries.** First-party code is MIT
  (root `LICENSE`; `@mediabase/*` tarballs embed the notice). Anything that ships a
  native artifact — the engine's static FFmpeg linkage, the ffmpeg copied into the
  app bundle — carries GPL/nonfree obligations and must be checked against
  `docs/LICENSING.zh.md` before distribution. **The chosen route is: source MIT +
  distribution GPL-3.0-or-later**, which still forbids `--enable-nonfree` artifacts —
  `pnpm run check:native --gate` enforces that and runs inside `pnpm run dist`
  (`docs/GPL-COMPLIANCE.zh.md` has the rebuild steps and what must ship with a bundle).
  `pnpm doctor` reports the same facts and `pnpm run notice` regenerates `NOTICE.md`;
  **never hand-edit `NOTICE.md`** (it is generated) and never describe the whole product
  as "MIT" without that caveat.
- **The host is a local service.** `AVSTUDIO_TOKEN` (opt-in) gates `/api/*` and
  both WS endpoints; the SPA shell stays public. It is a local trust boundary —
  no TLS, no users, no sessions. Anything reachable beyond localhost needs a real
  auth layer in front, and that limitation must be stated rather than implied.
- **State-changing methods declare it.** `ctx.api.register({ …, mutates: true })`
  is what makes `policy({ readonly: true })` (env `AVSTUDIO_READONLY=1`) able to
  refuse exactly the calls that change something — the registry cannot infer it, so
  a new method that plays, writes, loads or executes must say so. Denials (and the
  `allow`/`deny` lists, `AVSTUDIO_ACL_ALLOW`/`AVSTUDIO_ACL_DENY`, exact or
  `prefix.*`) are enforced inside `ctx.api.call()`, logged, and returned as
  `RpcCode.FORBIDDEN`.
- **Bump CONTROL_PROTOCOL_VERSION with the control plane.** The client handshakes
  `server.info` on connect and reports compatibility in `connection.status` (the
  badge shows a mismatch). A breaking change to method names/shapes or the stream
  envelope means bumping `CONTROL_PROTOCOL_VERSION` in `@mediabase/protocol` — the same
  discipline as the engine's `hello`.
- **Every control-plane call is audited in one place.** `ctx.api.call()` logs
  success at debug and failure (with code) at warn, so `AVSTUDIO_LOG_LEVEL=debug`
  gives a request trail without touching capabilities.
- **A separate process is a supervised process.** Anything that owns a child
  process (engine, sidecar) must: reject in-flight calls when it dies, report the
  exit (`ctx.events` + a manifest-declared event so the server forwards it),
  restart with backoff and a cap, and clear its timers/children in `ctx.effect`.
  `@mediabase/engine-client` provides the primitives (`onExit`, `restart`,
  `running`); the policy belongs to the capability.
- **Bump the wire protocol on breaking changes.** `hello` announces
  `kProtocolVersion` (`engine/src/main.cpp`) and the host refuses a mismatch
  (`ENGINE_PROTOCOL_VERSION` + `assertProtocol` in `@mediabase/engine-client`). Any
  change to a column layout/meaning must bump both numbers in the same commit;
  otherwise the failure shows up as a mis-parsed response instead of a clear
  "protocol mismatch".
- **TypeScript strict everywhere** (`tsconfig.base.json`): noUncheckedIndexedAccess,
  exactOptionalPropertyTypes, noUnusedLocals/Parameters. Two-plane typecheck,
  mirroring DSH: `tsconfig.host.json` (Node) and `tsconfig.client.json` (DOM +
  React). Relative imports carry explicit `.ts` / `.tsx` extensions.
- **Comments state non-obvious contracts**, not implementation narration.

## Handing this over as a base

`docs/HANDOFF.zh.md` is the fork checklist: what is base vs product, the order to
rename/compose/replace, which properties tests guard (no machine-specific paths, base
scripts product-free, identity confined to marked blocks, `@mediabase/*` never importing
`@avstudio/*`), and the two decisions the maintainer still owes (git/CI, distribution).
Keep it true: a change that makes a base-usable script product-specific belongs in a
product script, and `tests/handoff-neutrality.test.ts` will say so.

## Agent notes

Design decisions worth keeping live can be recorded under `.agents/notes/`
(proposed → implemented). Notes are evidence, not gospel; a later, better
argument wins over an old note.
