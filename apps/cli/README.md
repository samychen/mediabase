# @mediabase/cli

Thin host entrypoint for this base repo: resolves `BootIdentity`, delegates to
`@mediabase/boot` (profile / bundle / patch Loader), verifies capability
manifests, and disposes the tree on SIGINT/SIGTERM.

Run from the repo root: `pnpm run host` (tsx on `src/index.ts`).

Default identity: `mediabase` / `MEDIABASE_` / `~/.mediabase`. A product keeps
its own thin entry and passes a different `BootIdentity` — do not fork
`profile-boot`. Composition values (port, dist index, sandbox paths) are injected
as row configs via `!!js ctx.env…`, same seam DSH uses for deployment knowledge.
