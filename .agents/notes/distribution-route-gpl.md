# Note: distribution route 3 — GPL for the bundle, MIT for the source, and a gate

Status: implemented

## The choice

The maintainer picked route 3: **accept GPL for the distributed app**. That is
coherent with keeping the source MIT (MIT is GPLv3-compatible), and it matches what
the engine actually is: `engine/CMakeLists.txt` statically links FFmpeg with
`--enable-libx264`, so the shipped binary is a GPL work regardless of what our
package.json files say.

## What route 3 does NOT permit — and the evidence

`--enable-nonfree` (libfdk-aac) makes a build **unredistributable per FFmpeg's own
terms**, GPL or not. The engine binary on this machine contains it — verified by
strings, not by reading a config file:

```
$ strings engine/bin/engine | grep -i fdk
Fraunhofer FDK AAC
libfdk_aac
```

So "we accept GPL" is not the end of the licensing story: fdk-aac must go before
anything leaves the machine. That is why the tooling stops a bad artifact instead
of documenting the risk and hoping.

## Decisions

**1. A gate, not a warning.** `scripts/check-native-licenses.mjs` inspects the
artifacts that would ship (engine binary strings + the ffmpeg staging path) and:

- report mode (`pnpm run check:native`) → explains, exits 0;
- `--gate` → exits 1 on a nonfree component, with both fixes named (rebuild FFmpeg
  without it, or ship no native binary at all);
- `AVSTUDIO_ALLOW_NONFREE=1` → personal/local build, warns and continues.

`packaging/desktop-electron`'s `dist` now starts with that gate, and
`prepare-ffmpeg.mjs` refuses to bundle a nonfree ffmpeg. Rationale: a warning in a
doc gets ignored at 2am before a release; a non-zero exit does not.

**2. Ship the licenses with the bundle.** `licenses/` inside the app carries the
GPLv3 text (674 lines, fetched from gnu.org), the MIT text, a distribution notice
in both languages (what is GPL, what is MIT, what corresponding source is promised),
and the generated `NOTICE.md`.

**3. The checklist is a document, because the remaining work is not code.**
`docs/GPL-COMPLIANCE.zh.md` has the two one-time steps (rebuild MediaComponent's
FFmpeg without `--enable-nonfree`; rebuild the libs + engine with it), the exact
command to verify the new ffmpeg's flags, and what must accompany a distribution
under GPLv3 §4–§6 — including the corresponding-source requirement and where to put
it in the DMG.

## Deliberately left open

- **MediaComponent's own license.** GPL linking requires it to be GPL-compatible,
  and its checkout has no license file. The notice says exactly that; confirmation
  is a human step with its maintainer.
- ~~Whether the repository's own `license` fields become GPL-3.0-or-later.~~
  **Decided: they stay MIT.** Why this is the right split, not just a legal dodge:
  `@mediabase/*` is meant to be *reusable by other people's projects*, and a GPL base
  package cannot be adopted by a closed-source product. Keeping the source MIT while
  the assembled app is GPLv3 keeps the base adoptable and still satisfies the GPL
  obligations of the shipped bundle. It also means the 16 packed tarballs carry
  `license: MIT` with the notice embedded, which is what a consumer's audit expects.
- Non-macOS license facts: the collected evidence is this machine's.

## Evidence

- `pnpm run check:native` → reports `❌ 含不可再分发组件: Fraunhofer FDK AAC, libfdk_aac`
  for the current engine binary; `--gate` → exit 1; `AVSTUDIO_ALLOW_NONFREE=1 --gate` → exit 0.
- `AVSTUDIO_FFMPEG=<nonfree ffmpeg> node prepare-ffmpeg.mjs` → refuses (exit 1);
  with `AVSTUDIO_ALLOW_NONFREE=1` → bundles with a GPL notice pointing at the checklist.
- `AVSTUDIO_BUNDLE_FFMPEG=0` → removes any staged ffmpeg and explains the runtime
  dependency on the user's own binary.
