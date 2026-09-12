# Note: `@mediabase/*` vs `@avstudio/*`, and a base you can actually install

Status: implemented; the base scope was later renamed `@avbase/*` -> `@mediabase/*` (see
below), because the layer that claims to be product-free must not carry the product's name.

## Problem

"Neutral base" was a file-layout claim, not a checkable one: the packages that
were genuinely reusable (tools, api, server, settings, plugins, agent, ui,
ui-web, connection) carried the product's scope, and the ones under `packages/base`
declared `private: true` with `main: src/index.ts` — no consumer could install
them without this repo's TypeScript toolchain. Two databases of truth for "is this
reusable": the directory and the name.

## Decisions

**1. Scope is the reusability axis; the face directory is the typecheck axis.**
Renamed 9 packages to `@mediabase/*` and kept them in `packages/host|client` where
their plane is decided by `tsconfig.host.json` / `tsconfig.client.json`. Moving
them under `packages/base/` would have forced base to span both planes (the client
plane would have to include base's Node-only packages, or vice versa) — the
directory would then lie about the plane instead of lying about reusability.
Now the rule is mechanical and auditable: **a `@mediabase/*` package must not depend
on `@avstudio/*`** — verified by a script over every base package.json, and
enforced by the per-package standalone build (a product import would drag the
product's whole dependency cone in).

**2. `@mediabase/protocol` holds the neutral vocabulary.** The old
`@avstudio/protocol` mixed the wire vocabulary (plugins/agent/tools/api/manifests/
settings) with product contracts (media/python/workflow). Base packages needed the
former; depending on the product package for it made "neutral" false. The neutral
half moved to `@mediabase/protocol` (re-exporting `@mediabase/rpc`), and
`@avstudio/protocol` re-exports it plus the product contracts — so capability
packages keep importing one package and nothing downstream changed.

**3. Packability is a build plus a **test** — and publishing stays impossible.**
(The distinction was made explicit after the maintainer pushed back on any publishing
intent: the repo has no release step, every package is `private: true`, and the test
now asserts that flag so an accidental `pnpm publish` fails loudly.)
`pnpm run build:base` compiles each `@mediabase/*` to `dist/index.mjs` + `dist/index.d.ts`
(esbuild with `--packages=external`, then `tsc --emitDeclarationOnly`), and every
base package carries `files` + `publishConfig` so `pnpm pack`/`publish` rewrites
`main`/`types`/`exports` to the compiled output while in-repo development keeps
resolving `src/index.ts` (tsx/vite unchanged). The claim is then checked by
`tests/base-packaging.test.ts`: it builds, packs, extracts the real tarball into
a scratch project and runs a client↔server round-trip with plain Node.
`license` stays `UNLICENSED` on purpose — picking a license is the maintainer's
decision, not an agent's.

**4. Compiling each package alone is the test that finds hidden coupling.** The
standalone declaration build immediately caught `@mediabase/agent` reading
`ctx.settings` without a type-only import of `@mediabase/settings`: it only worked
because the host plane typecheck puts every package in one program. AGENTS.md
already prescribed the type-only import; the build now enforces it. The same
sweep removed stale declared deps from server/agent/api/workflow (audited by
comparing imports against `dependencies`).

## Bug found by writing the packaging test

The packed `@mediabase/rpc` "worked" but the consuming Node process took 30 seconds
to exit: `makeClient` armed its per-call timeout and never cleared it when the
response arrived, so a stray timer held the event loop open. Fixed by keeping the
timer handle on the pending slot, `clearTimeout` on settle, and `unref()` when the
timer supports it (optional call — DOM timers have no `unref`, so the base stays
isomorphic). The test now asserts the child process finishes in <10s, which is
what turned a silent 30s hang into a red test.

## Evidence

- `tests/base-packaging.test.ts` (3): tarball contains `dist` and no `src`;
  `@mediabase/schema` declares its runtime dependency; `@mediabase/rpc` runs from a
  scratch project with plain Node.
- `pnpm run build:base` builds all 15 `@mediabase/*` packages standalone.
- Full suite 79/79, typecheck green in all three planes.
