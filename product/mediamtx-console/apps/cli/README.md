# @mtxconsole/cli

Host entrypoint for the MediaMTX console: the product identity over the
mediabase composition. `src/identity.ts` is the ONE place the product's
vocabulary is decided (`bin=mtxconsole`, `MTXCONSOLE_`, `~/.mtxconsole`);
`src/index.ts` is a thin boot (shared logic lives in `@mediabase/boot`) whose
only composition decision is the bundle stack: base layer, then
`@mtxconsole/bundle-app`. Run with `pnpm run host:mtxconsole` (or
`dev:mtxconsole` after a build).
