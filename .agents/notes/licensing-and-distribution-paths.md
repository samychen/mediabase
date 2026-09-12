# Note: MIT for our code, and the exact cost of the native path

Status: implemented

## What the license choice actually settled

First-party code is MIT (root `LICENSE`; all 26 packages carry `license: MIT`, and
`@mediabase/*` tarballs now embed the notice — `scripts/build-base.mjs` copies it,
`tests/base-packaging.test.ts` asserts both the field and the file). npm runtime
dependencies turned out to be permissive across the board (10 packages, all MIT,
verified with `pnpm licenses list --prod --json` rather than assumed).

## What it did NOT settle, and why that had to be said out loud

The product is not "MIT" as a whole, because it ships native artifacts:

- `engine/CMakeLists.txt` statically links `avformat avcodec avutil … x264 fdk-aac …`
  when `AVSTUDIO_USE_MEDIACOMPONENT=ON` (the default).
- The FFmpeg in the MediaComponent checkout on this machine was configured with
  `--enable-gpl --enable-nonfree`. `--enable-gpl` (x264) makes the binary GPL;
  `--enable-nonfree` (fdk-aac) makes it, per FFmpeg's own words, unredistributable.
- `packaging/desktop-electron/scripts/prepare-ffmpeg.mjs` copies an ffmpeg into the
  app bundle, so today's DMG carries those obligations too.

Wording matters here: claiming "MIT" for the whole product would have been false in
a way that is expensive to discover later. So `docs/LICENSING.zh.md` states the facts
with the evidence (the configuration line), and gives three concrete routes: ship no
native binary and use the user's ffmpeg / build an LGPL FFmpeg / accept GPL for the app
(and drop `--enable-nonfree` in every case).

## Tooling, so the facts stay visible instead of living in a doc

- `pnpm run notice` → `NOTICE.md` (`scripts/notice.mjs`): npm attributions come from
  pnpm (lockfile is the authority); native entries are **verified by reading each
  keg's license file on this machine** (glog/gflags BSD-3, jsoncpp MIT, cJSON MIT,
  SDL2 Zlib, lz4 BSD-2 in `lib/`); the FFmpeg cone is listed honestly as
  "not knowable from this checkout" instead of inventing SPDX ids. The script refuses
  to write an empty notice.
- `pnpm doctor` gained two distribution-relevant rows: the current ffmpeg's
  `--enable-gpl`/`--enable-nonfree` flags, and whether the engine binary was built with
  MediaComponent (i.e. whether it contains FFmpeg/x264/fdk-aac).
- `AVSTUDIO_BUNDLE_FFMPEG=0` makes packaging skip bundling entirely (and removes the
  stale `vendor-ffmpeg/`), which is the MIT-clean path.
- `prepare-ffmpeg.mjs` warns loudly when the ffmpeg it is about to bundle carries those
  flags (personal builds stay convenient; shipping is where it matters).

## Deliberately left open (a maintainer/business decision, not a code one)

- Which route to take for distribution. The tooling makes all three reachable; the
  choice depends on whether the packaged app must keep in-process MediaComponent
  decoding and whether the app can be GPL.
- MediaComponent's own license: no license file exists in that checkout, so it cannot
  be asserted from here and the notice says exactly that.
- Non-macOS equivalents: the license facts collected are this machine's (Homebrew
  kegs, one FFmpeg build); win/linux builds need their own `notice` run.
