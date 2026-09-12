---
name: avstudio-pre-push-checks
description: Use before pushing an avstudio branch or claiming checks pass, to pick the smallest local evidence that covers the outgoing change
---

# AVStudio Pre-Push Checks

Run relevant local evidence once before push. The repo is small; the whole
gate is fast, so when in doubt run all of it.

## Checks

1. Typecheck both projects (strict, DSH-style flags):

```sh
pnpm run typecheck
```

2. Lint:

```sh
pnpm run lint
```

3. Build (C++ engine + web bundle):

```sh
pnpm run build
```

4. If the diff touches the engine protocol, host plugins, or RPC surface, run
   the end-to-end check while the host is up:

```sh
pnpm run host &        # in one terminal
node scripts/verify.mjs
```

5. If the diff touches the play loop or process lifecycle, also run the
   play/stop race exercise (5x start/stop without host crash) — this is the
   regression that previously killed the host.

## Notes

- CI does not exist yet for this skeleton — local evidence is the gate.
- The engine binary and `web/dist/` are gitignored; a clean clone needs
  `pnpm run build` before `pnpm run host`.
