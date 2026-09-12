# @avstudio/cli

Host entrypoint (mirrors DSH's `apps/cli`): creates the root Cordis context,
mounts the plugin tree — `@avstudio/media` then `@mediabase/server` — and runs it
until SIGINT/SIGTERM, which disposes the whole application tree.

Run from the repo root: `pnpm run host` (tsx on `src/index.ts`).

Composition values (engine binary path, dist index, port) are injected here as
plugin configs rather than hardcoded in packages — same seam DSH uses for
deployment-specific knowledge.
