# Note: composition becomes bundle + patch layers (route C)

Status: implemented (stages 1–3; the in-code capability table is deleted)

## Problem

The base was assembled by an in-code table: `apps/cli/src/capabilities.ts` listed the
capabilities in mount order and called `ctx.plugin(module, resolveConfig({ root, env }))`.
It worked, but it is not how deepseek-harness (0.1.5-rc.2) composes an application, and the
difference is not cosmetic:

- the harness composes from **`cordis.yml` + patch layers** mounted by the vendored
  `cordis-plugin-loader`; a *bundle* is a package whose `cordis.patch.yml` is one layer, so
  composition itself is publishable and a deployment **overrides a row by id** instead of
  editing TypeScript;
- the harness keeps deployment choices in validated `Config` fields, populated from
  `cordis.yml` (`!!js` expressions allowed), not in a `resolveConfig(env)` function.

For a base meant to be handed over, the first difference is the expensive one: with a table,
"change one capability's port" means forking the product's code.

## Decisions (stage 1)

**1. Port the mechanism, not the harness.** `apps/cli/src/profile-boot.ts` implements the
same shape with the same vendored pair (`@deepseek-ai/cordis-plugin-loader@1.0.3` +
`cordis-plugin-include@1.0.7`, installed from the npm mirror): a profile lives in
`$AVSTUDIO_HOME/profiles/<name>/` with `package.json` (`avstudio.profile.bundles`),
`cordis.yml` (the include root — an empty list, rewritten every boot) and
`cordis.patch.yml` (the layer a deployment edits). Layers apply in order:

    bundle layers → profile layer → $AVSTUDIO_HOME/cordis.patch.yml → --patch overlays

A row is inserted with `- insert:`; a later layer **replaces an earlier row's whole
`config` by id**. That is the whole point, and it is measured: an overlay changed `log`'s
level and scope and `settings.file` in one run, with no bundle edit.

**2. Both compositions stay, at parity, until the switch.** (Stage 1: `AVSTUDIO_COMPOSE=yml`
selected the new path while the table was still the default; both are gone now — see stage 3.) `tests/compose-yml.test.ts` asserts the two
produce the same control plane (identical method names, identical manifests) — so the
migration cannot quietly drop a capability, and the day the default flips is a one-line
change with a test already holding it.

**3. Deliberate simplifications, listed rather than implied.** No live patch reload
(`patchReload: startup`), no `.env` layering, no telemetry row, no `cordis:group` isolate
realms, and no per-profile `node_modules` projection — bare
specifiers resolve from the **installation anchor** (`apps/cli/package.json`, which declares
the bundle it templates), so a profile outside the workspace still boots.

## Decisions (stage 2): the bridge is gone, and where each thing lives

Stage 1 kept `ctx.rowDefaults` (each capability's `resolveConfig()` output, keyed by row id)
so a row did not have to restate defaults. That bridge hid the deployment's own decisions,
so it was deleted and replaced by three responsibilities:

**1. The ROW states the configuration.** `packages/bundle/app/cordis.patch.yml` names every
row's fields: `root: !!js ctx.appPaths.root` for the application root, and deployment values
read from the environment through the readers the composition provides on the loader context
— `ctx.env.str/num/flag/list`, over the boot's own environment (not necessarily
`process.env`, which is what makes it testable):

    - id: server
      name: '@mediabase/server'
      config:
        root: !!js ctx.appPaths.root
        port: !!js ctx.env.num('PORT')

A reader that finds nothing yields `undefined`, so the field stays ABSENT and the
capability's default applies; a reader that finds something it cannot interpret
(`AVSTUDIO_ENGINE_FPS=ten`) stops the boot naming the variable. Stating env-derived values
in YAML is the harness's own idiom (`mode: !!js process.env.DSH_TOOLS_MODE`); the difference
is that parsing lives in one tested place instead of in every expression — and, because a
`!!js` plain scalar cannot contain `": "`, the helper form is also the one that parses.

**2. The CAPABILITY validates it.** Every plugin package exports `Config` (a
`@mediabase/schema` schema) and cordis validates a row's config before `apply` runs: a missing
required field or a wrong type stops the boot with a path
(`failed to apply loader entry server (@mediabase/server): invalid config: - $.root missing
required value (at root)`). Root-relative defaults are resolved in `apply` (`<root>/engine/bin/engine`,
`<root>/python/sidecar/main.py`, `<root>/apps/web/dist/index.html`), so a composition never
repeats a layout.

**3. The BOOT audits the tree.** `assertEntriesActivated` (ported from the harness boot)
fails the boot when an enabled row did not become ACTIVE, naming the row — a pending entry
reports the service it waits for, a failed one keeps its original error. Without it a typo
in a patch layer comes up as a host that is silently missing a capability.

### The framework detail that decides where a field belongs

cordis validates a plugin's config BEFORE `apply` and normalises it **in place**: an absent
array becomes `[]`, an absent object `{}`, and a schema default is indistinguishable from a
value the row stated. So "was this stated?" cannot be asked after validation, and the
environment cannot be layered under the config inside `apply` (a materialised `[]` would beat
the env).

Two consequences are designed in rather than worked around:

- fields whose ABSENCE carries meaning are declared in `Config` only for scalars and
  validated in `apply` against what the row stated: `plugins.catalog` (absent = the shipped
  demo catalog, `[]` = load nothing) and `plugins.sandbox` (absent = process isolation is
  unavailable, and then an `isolation: 'process'` entry is REFUSED rather than mounted
  somewhere less contained). `keepStatedShape` restores the stated value of
  `requires`/`confinement` — an omitted `requires` keeps the plugin's full context while
  `requires: []` grants it nothing, which is a boundary, not a style;
- env-derived values are stated by the row (see above), which is why the capability's
  `resolveConfig({ root, env })` survived only as the legacy table path's translator — and
  went with it when stage 3 deleted the table.

## Evidence

```
AVSTUDIO_READONLY=1 pnpm run host          # 组合就是 patch 层,没有开关可拨
  → 宿主就绪 · 已组合 能力树(其中 8 个登记 manifest)
    {"api":37,"tools":6,"组合":"patch 层","profile":"web","layers":2}
  → server.info acl {"readonly":true} · media.play 被拒 -32021
  → verify:base  BASE OK(12 条)      → verify  ALL CHECKS PASSED(媒体管线)
  → pnpm run verify:compose           → verify-composition: 1 个层通过
  (迁移期间还额外跑过表路径的两条 verify,表删除后只剩这一条)
--patch 覆盖 3 层:DEBUG custom-app 作用域 + settings 写入覆盖后的路径
patch 覆盖 server 但漏掉 root → 启动失败并点名:
  failed to apply loader entry server (@mediabase/server): invalid config: $.root missing required value
tests/compose-yml.test.ts 20 用例(对等且先证明两次启动确实不同、层序、按 id 覆盖、home 层优先、
  环境变量进入配置并被拒绝、patch 丢字段响亮失败、行解析预检点名、deploymentEnv 读取器、
  表路径与行配置逐字段对齐、启动失败原因展开、未知 bundle/坏 YAML)
tests/composition-gate.test.ts 10 用例(裸包名未声明、!!js 出现在 name、同层重复 id、
  覆盖不存在的 id、相对路径行、非法顶层结构,以及仓库自身的层必须通过)
pnpm run verify:compose → verify-composition: 1 个层通过 · pnpm doctor 里也跑一遍
```

## Stage 3 in progress: the default flipped, and the gate that protects it

**The default is the yml path.** (At that point `AVSTUDIO_COMPOSE=table` still selected the
legacy table as an escape hatch; the section below records its deletion.) The flip was cheap to make and expensive to justify, so
it was paid for in verification: the ENTIRE suite (browser e2e, engine supervision, plugin
sandbox/confinement, host integration, drop-ins) now boots the default path — 272 tests over
31 files — plus `verify:base` and `verify` on both paths. The parity test got stricter for
the same reason: it first asserts the two boots actually composed differently
(`"组合":"yml"` vs `"组合":"table"`), because after the flip a test that forgot to ask for
the table would silently compare the yml path with itself.

**Drop-ins are a layer, not a special case.** `AVSTUDIO_CAPABILITY_DIR` used to exist only in
the table code path; deleting the table would have deleted a documented feature silently.
`apps/cli/src/dropins.ts` now owns discovery (same ids, same file-name order, same
`no apply()` refusal), the table mounts what it finds, and the yml path synthesizes it into
one extra `insert` layer applied after the overlays — so a third-party capability is last,
after everything it may depend on, and the boot's layer report includes it.

**A composition is data, so it gets a gate.** `scripts/verify-composition.mjs`
(`pnpm run verify:compose`, also run inside `pnpm doctor`) checks every shipped layer
statically: bare row names must resolve from the manifest that OWNS the layer (a bundle's
own manifest for a bundle layer, `apps/cli/package.json` otherwise), `!!js` may appear only
under `config`/`disabled` (the Loader interpolates exactly those two, so an expression in
`name` would compose something other than what the file says), no layer inserts an id twice,
and every patch target must exist. Its runtime half is `resolveRowSpecifiers` in
`profile-boot.ts`: rows are resolved before mounting, so an unresolvable row fails as

    avstudio: 以下组合行无法从安装锚点解析(apps/cli/package.json):
      行 "ghost": @mediabase/not-installed

instead of the Loader's nameless "loader entries failed to apply".

## A limit that remains after stage 3: the one-file host

The yml path needs rows to be importable **at runtime by bare specifier**, and a packaged host
does not have a `node_modules` beside it. Measured (while both paths existed):
`pnpm run build:host && AVSTUDIO_COMPOSE=yml node build/host.cjs` failed, while the same bundle
on the table path booted (its capabilities were
statically bundled) and the same yml profile boots under `tsx` (bare names resolve from
`apps/cli`, which is where the Loader's `import()` runs from). The harness solves this with a
closed packaged runtime (`bareModuleBaseUrl` + a bundle manifest). It was not a blocker for the
flip — the shipped distribution is source + `pnpm install`, and Mode A spawns `pnpm host` — but
it IS a blocker for shipping `build/host.cjs` to a machine without the packages, so it is listed
in `docs/STATUS.zh.md` as a known gap rather than as done. The failure itself is honest but opaque: the Loader reports concurrent
mount failures as one `AggregateError`, so `describeBootFailure` now walks the chain (the
per-entry reasons for THIS case are swallowed one level higher, by the include wrapper).

## Stage 3 finished: one path, no escape hatch

Deleting the table is what made this a migration instead of a second implementation kept
alive. Three things had to be true first, and each was checked before the deletion:

- **Nothing the table owned was left unported.** `AVSTUDIO_CAPABILITY_DIR` was the one
  feature that lived ONLY in the table code path; it now has a single implementation
  (`apps/cli/src/dropins.ts`) that the composition turns into one extra `insert` layer.
- **The default had already been exercised by the whole suite.** Every test, both verify
  scripts and the browser e2e had been booting the patch-layer composition for a full round
  before the table was removed, so the deletion could not be confused with the flip.
- **The tests that only made sense while two paths existed were REWRITTEN, not deleted.**
  The old "parity with the table" test became a frozen expectation of the composed surface:
  the capability set is asserted exactly (`agent, media, plugins, python, server, settings,
  tools, workflow`), one method per capability must answer, and the env-vocabulary map in
  `tests/compose-yml.test.ts` now fails if a row forgets a knob OR invents a field nothing
  documents. A test that compares two implementations disappears with one of them; a test
  that freezes the remaining one keeps guarding it.

Also deleted: `CapabilityResolveConfig`/`CapabilityComposeOptions` from `@mediabase/protocol`
(the seam existed only for the table), and `AVSTUDIO_COMPOSE` itself — an escape hatch with
nothing to escape from is a way to run an untested composition.

## Seeing a composition without booting it

`--dump-config` prints the composed tree from the FILES: the layers in application order, each
row under the layer that inserted it, and `patched by <layer>` when a later one rewrote it.
Two properties make it trustworthy rather than a second implementation: it resolves the layers
through the same `planComposition` the boot uses, and it composes them with the include's OWN
`applyEntryPatches`. Two make it useful: `!!js` is printed as the expression (so the dump is
about the composition, not about one machine's environment), and the dialect round-trips, so a
dump can be piped back in as a patch file. `--dump-default-config` skips the profile's own
layer, the machine-local layer, the overlays and the drop-ins — and does not even parse them —
which is the diagnostic for a user layer that stops a boot.

The bug this surfaced is worth keeping: applying ONE layer to the root and calling that the
snapshot loses everything the earlier layers inserted — an empty user layer (`[]`, which every
fresh profile has) reset an eleven-row tree back to the anchor row. A snapshot must be the
PREFIX (`layers[1..k]`), which is what the include mounts and what the dump now does.

## Both halves compose from data now

**The page composes from a roster.** `packages/bundle/ui/client.yml` (the UI bundle) lists the
client plugins in mount order, `scripts/gen-client-roster.mjs` renders it into
`apps/web/src/roster.generated.ts`, and the entry module only mounts the roster. Two failure
modes made this worth generating rather than hand-writing: a browser bundle cannot resolve a
package name at runtime (so the roster has to become static imports), and a roster edit that is
not regenerated leaves the page composing the OLD set while the file claims otherwise — so
`pnpm test` fails on a stale generated file, and the gate checks the property that order alone
cannot express safely: rows are exactly `id` + `name`, ids are unique, and the SHELL the
manifest names (`avstudio.uiBundle.shell`) is LAST, because a shell mounted earlier renders an
empty page with no error at all. Proof it works in a page rather than in a test: the real-Chrome
suite (8 cases) runs against the page built from the roster.

**A one-file host composes from a closed runtime.** `pnpm run build:host` derives the row
specifiers from the bundle layer, bundles each into `build/plugins/<slug>.cjs`, writes
`build/plugins.json`, and materializes the one module whose runtime identity must be shared.
The measurement that shaped it: with `@mediabase/rpc` bundled per plugin, every capability error
arrived as `-32603` with no `messageKey`, because `makeServer` decides between a coded error and
an internal failure with `e instanceof RpcError` — two copies, no match. With the shared copy in
`build/node_modules/@mediabase/rpc` and everything else self-contained, an 850 KB copy of `build/`
started from `/tmp` with plain `node` (no tsx, no repo `node_modules`) composed all ten
capabilities and passed `verify:base` + `verify`.

## Packaging, measured

The smoke test changed the artifact, and that is the point of running it:

1. **The packaged host needs BOTH closed-runtime halves.** Shipping `build/host.cjs` alone was
   not enough: the rows resolve through `plugins.json` (shipped beside the entry) and the
   BUNDLE LAYER resolves through `<entry dir>/bundles/<package>/`, which did not exist. Both
   are now in `extraResources`, and the anchor-less case was verified for real by booting a
   copy whose baked installation path does not exist — it composed from what it ships.
2. **A distributable package does not need a rebuilt FFmpeg.** `engine/build.sh
   -DAVSTUDIO_USE_MEDIACOMPONENT=OFF` plus `AVSTUDIO_BUNDLE_FFMPEG=0` passes the licence gate
   with no bypass flag (the engine links no FFmpeg at all; the CLI fallback uses the user's
   own binary). The gate used to block exactly this route by scanning an ffmpeg that would not
   be bundled — that is fixed, and route B is now the documented distribution path until the
   FFmpeg rebuild happens.
3. **`hdiutil` does not work inside this sandbox** (`create failed - 目录非空` for any image,
   measured three ways), so `dist:dir` is the sandbox/CI target and the DMG step stays a
   normal-session action. Verified instead, in full: the `.app`, a direct run of the packaged
   host, and the Electron shell's own `AVSTUDIO_SMOKE=1` path (`host ready` → `smoke ok`).

## What is left

1. The maintainer's own decisions: the git baseline is committed (placeholder author — amend
   it), the DMG step needs a normal macOS session, and route A (rebuild FFmpeg without
   `--enable-nonfree`) remains open if a static-FFmpeg engine is ever wanted for distribution.
2. The generated config catalog is DONE (`pnpm run gen:config-catalog` →
   `docs/CONFIG-CATALOG.md` + `docs/config-catalog.json`): the shipped rows and each
   capability's `Config`, together, with `!!js` printed as the expression a row actually says.
   It is generated and test-verified against both sources, so it cannot describe a composition
   that no longer exists — and a test fails if it stops covering a row, because a catalog a
   reader trusts is worse than no catalog.
