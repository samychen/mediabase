# Note: dependencies belong to layers, and the engine declares what it can do

Status: implemented

## Why this round happened

Two questions kept coming back — "is ffmpeg in the base?" and "is MediaComponent in the
base?" — and answering them required grep every time, because the facts were scattered
across six READMEs, two CI workflows and the CMake file. Worse, the *second* question
exposed something the project did not actually know about itself: nothing in the running
system could say which decode backend the engine binary in front of it had been built
with, and the test suite silently assumed the strong one.

**Answer to both questions: no.** `packages/base/**` contains no reference to ffmpeg,
MediaComponent or `composesdk`; neither do the host capability packages (even
`@avstudio/media` only speaks the engine's column layout). The only real dependency is
inside `engine/`, and it degrades automatically: no `libcomposesdk.a` → CMake builds the
ffmpeg-CLI backend with no error.

## Decisions

**1. Documentation as a table, not prose.** `docs/DEPENDENCIES.zh.md` lists every
external thing by LAYER with: is it required, what changes if you swap it out, its
license position, and who reads its env vars. The "change surface" is deliberately
concrete (e.g. replacing the in-process decoder = `engine/src/mediacomponent.{cpp,h}` +
one row in `engine/CMakeLists.txt` + one doctor line; the host, base, client and
packaging are untouched).

**2. The engine now declares its capabilities: `caps`.** `caps` answers
`mediacomponent=0|1  session=0|1  pmeta=basic|full`. The host reads it during the boot
handshake (`media.engineCaps`, also in `/api/health` and `media.engineInfo.caps`), the
tests gate the backend-specific assertions on it, and `pnpm doctor` asks the BINARY
(not the CMake cache) so the report cannot lie about what got linked.

**3. Both backends are now a tested configuration.** The suite runs green either way:
131/131 with MediaComponent, 129 + 2 skipped with the CLI fallback (only the two
backend-specific cases skip). CI — which has no local checkout and therefore builds the
fallback — would previously have failed six tests; it has never run (no git repo), so
this was invisible until the fallback was exercised locally.

## Two real bugs the fallback exposed (both fixed)

1. **Seek-mode playback never reported progress.** `seekTick` decoded frames and
   advanced the clock but never called `notifyTick()`; the streaming path hid it, so the
   UI timeline stayed frozen at 0 whenever the fallback ran. 
2. **Ticks overlapped.** In fallback mode one frame = one ffmpeg subprocess (~200ms)
   against a 100ms tick, so two decodes raced on the SAME scratch file → the loop errored
   out and stopped. A "one decode in flight" guard now skips a beat instead of breaking
   (frame rate degrades; nothing corrupts).

A third, smaller one: `engine/build.sh` silently ignored extra arguments, so the
documented `build.sh -DAVSTUDIO_USE_MEDIACOMPONENT=OFF` command did not actually do
anything. It forwards `"$@"` to cmake now.

## Evidence

- `printf 'caps\n' | engine/bin/engine` → `caps  mediacomponent=1  session=1  pmeta=full`;
  after `build.sh -DAVSTUDIO_USE_MEDIACOMPONENT=OFF` → `0/0/basic`, and `otool -L` on that
  binary shows only libc++/libSystem (no FFmpeg, no brew libs).
- `tests/engine.test.ts`: new `caps` contract test (all three fields always reported) +
  the two MediaComponent-only cases gated on it.
- `tests/host.integration.test.ts`: `media.meta` details gated on `media.engineCaps`;
  the WS-push test now stops stale playback and matches ITS frame instead of `frames[0]`
  (a leftover decode from a slower backend was being asserted against).
- `test/support/host.ts`: a boot failure after the socket opened now reports the child's
  log instead of a bare `ws connect failed` (that race appeared only with the fallback).
- `pnpm doctor` prints an authoritative "engine 构建能力(权威: caps 命令)" row.
