# AVStudio packaging & install

> TL;DR: today avstudio ships as **source + toolchain** (Mode B). There is no
> one-click installer yet; that needs Mode A (Tauri) or Node bundling, which
> are still scaffolding (see `desktop/README.md`). This page documents what
> works right now. 中文完整版见 `INSTALL.zh.md`。

## Ship contents

engine binary (`engine/bin/engine`, machine/architecture specific — it links
MediaComponent + local brew/system libs), native plugin
(`engine/bin/plugins/checker.<dylib|so>`), web bundle (`apps/web/dist`), Node
host source (`apps/cli` + `packages`), python sidecar (`python/sidecar`), and
`pnpm-lock.yaml`.

## Install on a new machine (recommended)

1. Prereqs: Node ≥ 20, pnpm, C++ compiler, python3, ffmpeg (or
   `AVSTUDIO_FFMPEG`); cmake optional. `pnpm doctor` tells you what's missing.
2. Get the source (clone, or the tarball from `pnpm run package`).
3. `pnpm install && pnpm doctor`
4. **Rebuild for THIS machine**: `pnpm run build:engine` (falls back to the
   ffmpeg-CLI decode path automatically when MediaComponent is absent) and
   `pnpm run build:web`.
5. `pnpm run host` → open http://127.0.0.1:3088 (change port with `PORT=`).

Do **not** copy the engine binary across machines — always rebuild (step 4).

## Source distribution tarball

`pnpm run package` → `release/avstudio-src-<version>.tar.gz` (source + built
artifacts, minus node_modules/.git/build dirs).

## Real installers (not done yet)

- Mode A (Tauri): scaffold only — needs Rust compile, Node sidecar bundling,
  icons, signing (desktop/README.md).
- Node SEA/single-binary host: not started (needs an esbuild pass first).

Full troubleshooting in `INSTALL.zh.md` §5.
