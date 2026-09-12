# AVStudio — OBS-like media app skeleton on real Cordis

> 中文使用说明见 [README.zh.md](./README.zh.md) · English docs below.

A working skeleton for a C++ audio/video engineer moving from Qt to a web-UI +
plugin host:

> **React UI + `@deepseek-ai/cordis` plugin host drives an independent C++
> media-engine process. Real-time media never enters JS. One codebase, two
> shells: local Node host + browser, or a native window (Electron).**

Positioning: today this is a **complete reference implementation / scaffold**
for an "OBS-like + plugin + AI" app — the paradigm and base layers are reusable,
but it is not yet a generic framework for arbitrary second products
(see [`docs/FRAMEWORK.md`](docs/FRAMEWORK.md) / [`docs/FRAMEWORK.zh.md`](docs/FRAMEWORK.zh.md)).
Done vs not-done inventory: [`docs/STATUS.zh.md`](docs/STATUS.zh.md).

The plugin framework is the **real `@deepseek-ai/cordis`** that DeepSeek Harness
itself runs on (adopted in place of an earlier hand-rolled mini-runtime), and
the repo structure follows DSH conventions: `apps/{cli,web}` +
`packages/{protocol,host/*,client/*}` capability packages + top-level `engine/`.

Everything runs against **real media**: the C++ engine decodes actual video
frames through `ffmpeg`, and the browser paints the raw RGB24 onto a `<canvas>`.

## Two deployment modes (one codebase)

```
Mode B  pnpm run host ──> http://127.0.0.1:3088  (open in any browser)
        apps/cli composes @avstudio/media + @mediabase/server on a root Context

Mode A  desktop/ (Tauri shell) ──spawns──> same `pnpm run host`
        └─ native WebView opens http://127.0.0.1:3088
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ apps/web (Vite) ── composes client plugins into the page     │  UI / monitor
│   @mediabase/connection  ctx.rpc + ctx.streams (WS /stream)   │
│   @avstudio/preview     ctx.preview (control wrapper)        │
│   @mediabase/ui          ctx.ui panel registry + shared view  │
│   @avstudio/ui-media    media capability: ctx.view provider  │
│                         + console + <canvas> monitor panel   │
│   @avstudio/ui-panels   external UI package: connection      │
│                         badge + python/workflow/plugins/     │
│                         settings/agent panels                │
│   @mediabase/ui-web      SHELL: title + renders ctx.ui panels │
└───────────────▲───────────────────────────────┬──────────────┘
        WS JSON-RPC (control plane)             │ HTTP bytes (data plane)
        media.ping/probe/decode/…               │ GET /api/preview.rgb
┌───────────────┴───────────────────────────────▼──────────────┐
│ apps/cli — root cordis Context                              │  app host
│   @avstudio/media  ctx.reflect.provide('media'/'preview')    │  + plugins
│   @mediabase/server :3088 static + WS /rpc + /api (inject)    │
└───────────────▲──────────────────────────────────────────────┘
        tab-separated line protocol (stdin/stdout, never binary)
┌───────────────┴──────────────────────────────────────────────┐
│ engine/  C++ media engine (g++, zero libs)                   │  media core
│   testpattern (pure C++) · decode (orchestrates ffmpeg)      │  (real-time
│   probe (ffmpeg -i parse)                                    │   boundary)
└──────────────────────────────────────────────────────────────┘
```

The invariant is the **one layering rule** in `AGENTS.md`: per-frame work lives
only in `engine/`; host and web only issue commands and display results.

## Quick start

```sh
pnpm install          # workspace deps (ws, react/vite, @deepseek-ai/cordis)
pnpm run build        # g++ engine + vite web bundle
pnpm run host         # Mode B: http://127.0.0.1:3088
```

Open **http://127.0.0.1:3088**:

- **Test Pattern** — C++ generates a frame.
- **Decode Frame** — real ffmpeg decode of one frame from the media file.
- **Probe** — duration + resolution.
- **▶ Play / seek slider** — host-side loop decoding successive frames.

Sample clip: `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=15 -y /tmp/avstudio-sample.mp4`

Headless verification:

```sh
pnpm run host &            # one terminal
node scripts/verify.mjs    # WS JSON-RPC + /api/preview.rgb end-to-end
```

## Repo layout

```
apps/cli        host entrypoint + capability table (compose/verify; graceful dispose)
apps/web        Vite shell: composes client plugins (composition = capability set)
packages/base/  neutral, capability-agnostic (@mediabase/*): rpc (JSON-RPC +
                coded errors) · schema (one schema dialect + JSON-Schema bridge)
                · log (ctx.log) · protocol (neutral contracts) · engine-client
                (line-protocol TRANSPORT only) · gateway · AND the reusable
                capabilities api/server/tools/plugins/settings/agent (host face)
                and ui/ui-web/connection (client face)
packages/protocol   avstudio domain contracts + re-export of @mediabase/rpc
packages/host/api    control-plane registry (ctx.api) + capability manifests
packages/host/media C++ engine client + media VERB vocabulary; ctx.media/ctx.previewState
packages/host/python python sidecar worker (ctx.python tools)
packages/host/tools  tool registry (ctx.tools): capabilities self-register
packages/host/workflow recipe runner over REGISTERED tools (ctx.workflow)
packages/host/agent    LLM agent loop over REGISTERED tools (ctx.agent)
packages/host/settings persisted key->JSON settings (ctx.settings)
packages/host/plugins  runtime plugin manager (load/unload/reload)
packages/host/server   pure composition over @mediabase/gateway (reads ctx.api)
packages/client/connection  WS JSON-RPC channel (ctx.rpc)
packages/client/preview     ctx.preview control wrapper
packages/client/ui          UI panel registry (ctx.ui) + shared panel state
packages/client/i18n        UI translations (ctx.i18n): per-package dictionaries
packages/client/ui           provides JSON-Schema → form helpers
packages/client/ui-web      SHELL (capability-agnostic): title + renders panels
packages/client/ui-media    example media capability: console + canvas monitor
packages/client/ui-panels   example external UI package: badge + 7 panels
python/sidecar/    the python worker the @avstudio/python plugin spawns
engine/         C++ media engine (top-level, like DSH native/ + python/)
desktop/        Tauri shell scaffold (Mode A) · packaging/desktop-electron (Mode B packaged)
scripts/        verify.mjs E2E
```

Plugin and service conventions (how DSH does it) are documented in `AGENTS.md`:
`name/inject/Config/apply` plugin shape, `ctx.reflect.provide` + typed
`declare module '@deepseek-ai/cordis'` augmentation, `inject` reactivation,
`ctx.effect` fiber cleanup, config seam through `apps/cli`, two-plane typecheck
(`tsconfig.host.json` / `tsconfig.client.json`), engine wire protocol in
`engine/` README.

```sh
pnpm run typecheck   # tsc host + client + tests
pnpm run lint        # oxlint
pnpm doctor          # environment & artifacts health check (new machine first step)
pnpm test            # vitest (unit/engine/host-integration)
node scripts/verify.mjs  # E2E smoke (host running)
node scripts/verify.base.mjs  # neutral smoke: shell/health/control plane/registry/manifests + error-key contract + isolation posture + plugin catalog
pnpm run build:host  # bundle the Node host into build/host.cjs (packaging)
pnpm run package     # portable source tarball -> release/avstudio-src-<ver>.tar.gz
```

## Machine prep & CI

New machine: `pnpm doctor` prints what is missing. Hard requirements: Node ≥ 20,
pnpm, a C++ compiler, python3, ffmpeg (or `AVSTUDIO_FFMPEG`); optional: cmake,
MediaComponent (`MEDIACOMPONENT_ROOT`, default
`/Users/chensi/develop/MediaComponent`) — without it the engine builds with the
ffmpeg-CLI decode fallback and the integration tests exercise that path.

CI: `.github/workflows/ci.yml` runs install → engine build (no MediaComponent on
CI → CLI fallback) → web build → typecheck (host+client+tests) → lint → `pnpm test`
on ubuntu with ffmpeg installed. `.github/workflows/engine-matrix.yml` produces
per-platform engine binaries (mac/win/linux) for desktop packaging.

Packaging & install: **how to ship/install on another machine** — `docs/INSTALL.md`
(EN) and `docs/INSTALL.zh.md` (中文,详版). TL;DR: source + toolchain deployment;
portable source tarball via `pnpm run package`. Native window packaging (no
Rust, Electron shell that forks the bundled host): `packaging/desktop-electron/`
(`pnpm start` to run, `pnpm run dist` for a mac DMG).

## Roadmap

1. ~~Mini-runtime → real `@deepseek-ai/cordis`~~ — done; structure mirrors DSH.
2. **Frame transport upgrades** — WS binary frames, shared memory, then GPU
   texture sharing (D3D/Vulkan/WebGL), mirroring OBS.
3. ~~Python sidecar~~ — done (D1: `ctx.python`, silence detection); grow tools.
4. ~~Workflow runner~~ — done (D2: recipes over media/python + WS notifications);
   plugging a real LLM agent loop on top remains future work.
5. ~~Native render-ABI plugin loader~~ — done minimal (D3: dlopen `.dylib/.so`
   + `avplugin_*` exports + checker sample); full OBS-style source/filter
   catalogs, events and UI stay future work.
6. ~~CMake + ffmpeg path config~~ — done (E: `engine/CMakeLists.txt`, build.sh
   cmake-first with gcc fallback, `AVSTUDIO_FFMPEG` env).

## Status

| Piece | State |
|---|---|
| C++ engine (testpattern / decode / probe) | ✅ g++ built & verified |
| Real `@deepseek-ai/cordis` host + client | ✅ adopted; E2E verified |
| Host :3088 (static + WS /rpc + /api/preview.rgb) | ✅ verified |
| React client (media console, canvas preview, play/scrub/speed) | ✅ built & E2E-verified |
| TypeScript two-plane gates + oxlint | ✅ clean |
| Play/stop async race regression | ✅ fixed & tested |
| Graceful shutdown (no orphan engine process) | ✅ SIGINT test passes |
| Python sidecar (`ctx.python`, silence detection) | ✅ D1 verified E2E |
| Workflow runner + WS notifications (`ctx.workflow`) | ✅ D2 verified E2E |
| Scope split: reusable code is `@mediabase/*`, product code is `@avstudio/*` | ✅ base packages declare no product dependency |
| Packable base (`pnpm run build:base` → dist); publishing is blocked (`private: true`) | ✅ packed tarball run by another project with plain Node; `pnpm publish` refuses |
| Capability composition table + drop-in modules (`AVSTUDIO_CAPABILITY_DIR`) | ✅ extra capability callable with no host edit |
| Strict capability verification at boot (`AVSTUDIO_STRICT_CAPABILITIES=1`) | ✅ CI gate; lying manifest fails boot |
| Composition from profile patch layers — the ONLY path (bundle → profile → home → `--patch` → drop-ins, override by row id) | ✅ 37 methods / 8 manifests, frozen by test; the in-code table is deleted |
| Validated capability config: a row states its fields (`!!js ctx.appPaths.root`, `!!js ctx.env.num('PORT')`), the capability's `Config` rejects a bad one with a path, the boot audits that every row activated | ✅ missing `root` in a patch stops the boot naming the row; env-derived ACL verified on both paths |
| The whole suite boots through the composition (281 tests), including drop-ins and the browser suite | ✅ a dropped or renamed row fails the frozen-expectation test |
| The page composes from data too: the UI bundle's `client.yml` is generated into static imports, checked for order (shell last) and for staleness | ✅ real Chrome e2e passes against the roster-built page |
| Single-file host (`pnpm run build:host`) carries its own closed runtime: `plugins.json` + one bundle per row + the one shared module | ✅ an 850 KB copy booted from `/tmp` with plain `node` (no tsx, no repo `node_modules`); `verify:base` + `verify` pass |
| Static composition gate (`pnpm run verify:compose`): bare row names must be declared dependencies, `!!js` only under `config`/`disabled`, patch ids must exist | ✅ runs in `pnpm doctor` too; runtime pre-flight names the failing row |
| Pluggable data plane: pull (`/api/*`) + push (`WS /stream`) with backpressure | ✅ meta+binary frames E2E; slow clients shed frames |
| Local access control (`AVSTUDIO_TOKEN`) + runtime-plugin least privilege (`requires`) | ✅ 401 on both planes; undeclared service access refused with the fix |
| Control-plane audit trail (`ctx.log`, scope `avstudio.api`) | ✅ method/duration/code logged at one choke point |
| Method-level ACL (`mutates` + `readonly`/`allow`/`deny`) | ✅ refused with `-32021`, audited, policy visible via `server.info` |
| Control-plane protocol handshake (`server.info` ↔ `CONTROL_PROTOCOL_VERSION`) | ✅ mismatch surfaces in `connection.status` + badge |
| `@mediabase/gateway` standalone unit tests (SPA/WS/raw routes/health/lifecycle) | ✅ 9 tests, including both traversal shapes |
| UI i18n (`ctx.i18n`): per-package dictionaries, live switching, coded-error texts | ✅ zh-CN + en; guard test blocks new hard-coded literals |
| Panels generated from JSON Schema (API console) | ✅ every registered method callable from a generated form |
| Engine subprocess supervision (backoff restart, crash events, health) | ✅ verified E2E + scripted fake engine |
| Two decode backends, self-declared (`caps` → `media.engineCaps`) | ✅ MediaComponent 131/131; ffmpeg-CLI fallback 129 + 2 skipped |
| Dependency boundaries documented per layer | ✅ `docs/DEPENDENCIES.zh.md` (ffmpeg / MediaComponent / native plugins / sidecar) |
| Handoff-ready: base/product split, fork order, guarded neutrality | ✅ `docs/HANDOFF.zh.md` + `tests/handoff-neutrality.test.ts` |
| Wire protocol versioning (`hello` handshake, mismatch refused) | ✅ engine v1 ↔ host v1, `media.engineInfo.state=incompatible` |
| Test suite (vitest: rpc · log · registries · gateway + limits · supervision · capability loading · base packaging · data plane · shared-memory ring · access control · plugin confinement · settings · agent · i18n + host error keys · forms · UI (jsdom) · engine · host) | ✅ 248 tests pass |
| Real-browser e2e (CDP-driven Chrome: bundle boots, page WS connects, locale switch, COOP/COEP gating, plugin confinement in the panel) | ✅ 8 tests (skips with a reason when no browser) |
| Runtime plugin hot load (load/unload/reload) | ✅ E verified via fiber dispose |
| Native C-ABI plugin loader (dlopen .dylib/.so + checker sample) | ✅ D3 verified |
| Streaming playback (persistent demux/decode session + live seek) | ✅ verified E2E |
| Media metadata (fps/codec/pixel-fmt/audio) + speed playback | ✅ verified E2E |
| Native plugin into UI (`media.pluginFrame`) + python `audio.loudness` | ✅ verified E2E |
| CMake build + ffmpeg path via `AVSTUDIO_FFMPEG` | ✅ E build verified |
| Neutral base (`@mediabase/rpc`, `engine-client` = transport only, `gateway`) | ✅ extracted; server = thin layer; media owns the verbs |
| Tool registry (`@mediabase/tools`): self-register, workflow/agent consume | ✅ + auto `tools.list/run` RPC, args schema-validated |
| Control-plane registry (`ctx.api`) + capability manifests (`ctx.capabilities`) | ✅ 31 methods self-registered; server names no capability; `capabilities.verify()` at boot |
| One schema dialect (`@mediabase/schema`) at every boundary + coded errors | ✅ params/results/tool args validated; `[code]` shown in the UI |
| Scoped logging (`ctx.log`) incl. engine/python stderr | ✅ levels + child scopes (`AVSTUDIO_LOG_LEVEL`) |
| UI panel registry (`ctx.ui`): header + sidebar + monitor areas | ✅ shell renders only registered panels; late registration re-renders (`subscribe`/`revision`) |
| UI capabilities as packages (`ui-media`, `ui-panels`) | ✅ adding UI = composing a package |
| Desktop packaging (Electron shell, DMG) + in-app LLM key settings | ✅ DMG built & installed locally |
| Mode B (browser @127.0.0.1:3088) | ✅ working |
| Mode A (Tauri desktop shell) | 📦 scaffolded in `desktop/` (Rust not installed here; see its README) |

## License

First-party code (all 26 packages, `apps/`, `engine/`, `scripts/`) is **MIT** — see `LICENSE`.
All npm runtime dependencies are MIT as well (`pnpm licenses list --prod`).

**Distribution route (chosen):** the app ships under **GPL-3.0-or-later** (the engine links
FFmpeg + x264), while this repository's own code stays MIT. Because FFmpeg builds with
`--enable-nonfree` are unredistributable, `pnpm run check:native --gate` refuses to package
such an artifact and `packaging/desktop-electron`'s `dist` runs that gate first — see
`docs/GPL-COMPLIANCE.zh.md` for the two rebuild steps and what to ship with the DMG.

`pnpm run notice` regenerates `NOTICE.md` (third-party attributions) and `pnpm doctor`
flags distribution-relevant license facts.

**The native binaries are a separate matter**: the engine statically links FFmpeg, and the
packaging script bundles an FFmpeg binary. A build with `--enable-gpl` (`--enable-libx264`) is
GPL, and `--enable-nonfree` (`--enable-libfdk-aac`) is unredistributable per FFmpeg's own terms —
the MediaComponent checkout on this machine is exactly that build, so a DMG produced today carries
those obligations. Options (ship no native binary and use the user's ffmpeg / build your own LGPL
FFmpeg / accept GPL for the app) and the evidence are in `docs/LICENSING.zh.md`.
