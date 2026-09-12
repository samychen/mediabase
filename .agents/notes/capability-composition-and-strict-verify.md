# Note: composition is a table, drop-ins are first-class, declarations are gated

Status: implemented, then SUPERSEDED — the in-code table and `resolveConfig` described here
were replaced by patch-layer composition (`composition-patch-layers.md`) and deleted. The
parts that still hold: a capability registers a manifest, `capabilities.verify()` reconciles
it, `AVSTUDIO_CAPABILITY_DIR` provides drop-ins, and `AVSTUDIO_STRICT_CAPABILITIES=1` makes a
lying declaration a boot failure.

## Problem

"New capability = one place" stopped at the server: `apps/cli` still hand-built
every plugin's config from env and relative paths, so adding a capability meant
editing the bootstrap as well. Nothing could be installed as a third-party
capability (no directory, no discovery), and `capabilities.verify()` only logged
a warning — a capability that declared an API method it never registered kept
booting, and users met `method not found`.

## Decisions

**1. The capability owns its env vocabulary.** Each composable package exports
`resolveConfig({ root, env })` typed by `CapabilityResolveConfig`
(`@avstudio/protocol`). The composition layer owns *root discovery* and *ordering*;
the capability owns which variables it reads and which subpaths it defaults to.
`apps/cli/src/index.ts` shrank to "discover root → compose → verify → wire
signals", and `CAPABILITIES` in `apps/cli/src/capabilities.ts` is the one place
capabilities are chosen.

Why not a manifest FILE (yaml/json) listing capabilities? Because the config is
code (paths, defaults, per-platform extensions, the `restart` policy) and a data
file would just grow an eval/eval-ish DSL. The table is readable, typed, and the
per-capability vocabulary stays next to the capability it configures.

**2. Drop-ins are a directory, not a special case.** `AVSTUDIO_CAPABILITY_DIR`
(colon-separated) is scanned at boot; each `*.mjs|cjs|js` module exporting
`apply()` is mounted like a built-in and registers into the same registries. A
module that is not a plugin fails boot with its path. This is the actual test of
"everything is a plugin": the third-party capability needs no host edit at all.

**3. Verification is a gate, not a log.** `capabilities.verify()` stays a warning
in dev (a half-finished capability should not block a developer) but
`AVSTUDIO_STRICT_CAPABILITIES=1` — set in CI and packaging — turns any mismatch
into a boot failure naming the capability. That closes the loop opened by the
manifests: they only have value if a lie is caught.

**4. Registries are live, not snapshotted.** Writing the drop-in test exposed a
real bug: the gateway took `methods: ctx.api.methodMap()` once at construction, so
a capability mounted after the front door (drop-in, runtime plugin load) was
invisible — the same class of bug as the shell's non-reactive panel registry.
`@mediabase/gateway` now accepts `methods`/`rawRoutes` as functions and resolves them
per request. Cost is negligible (one map build per RPC); the alternative —
rebuilding the gateway on every registration — is worse.

## Evidence

`tests/capability-loading.test.ts` (6), against real booted hosts:
- built-in table mounts and verifies clean (8 manifests for 10 modules: the two
  neutral base modules — log and the registry package — declare none);
- a drop-in module's `extra.ping` is callable over RPC and listed in
  `api.list`/`capabilities.list`;
- a capability declaring `liar.missing` is reported (dev) and boot-refused under
  strict mode;
- a module without `apply()` fails boot with its path;
- a missing directory is ignored.

CI gained a "boot with strict capability verification" step that runs the same
command the user would, on `PORT=3099`, and fails if `/api/health` never answers.
