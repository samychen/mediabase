# Note: the engine is versioned and supervised

Status: implemented

## Problem

`@mediabase/engine-client` spawned the C++ engine once and never looked at it again.
When the child died — bad stream, OOM, external kill — every later call failed
with a generic message, playback kept ticking against a corpse, and the only way
back was restarting the host. Nothing told the UI what happened. And because the
line protocol had no version, an engine built from older sources would answer with
a different column layout and the host would happily mis-parse it into nonsense
(`decode` returning 0×0, timeline permanently at 0).

## Decisions

**1. `hello` is transport, not a verb.** The handshake belongs to the wire
protocol itself, so it lives in the base client (`hello()`,
`ENGINE_PROTOCOL_VERSION`, `assertProtocol()`) and in the engine's command loop,
next to `ping`. Everything with column semantics (`probe`, `decode`, `sread`, …)
stays in the capability that owns the binary. Consequence, now a rule in
AGENTS.md: **a breaking column change bumps `kProtocolVersion` in
`engine/src/main.cpp` and `ENGINE_PROTOCOL_VERSION` together** — otherwise the bug
shows up as garbage data instead of a refusal.

**2. Supervision primitives in base, policy in the capability.** Base guarantees
the mechanics: in-flight calls are rejected with `UNAVAILABLE` the moment the
child exits (a pending promise must never hang), `running`/`restart()` exist, and
`onExit(info)` reports code/signal/uptime. `@avstudio/media` owns the policy
(backoff 200ms→5s, 5 attempts, `config.restart`), because "how many times do we
retry, and what do we do about the user's playback" is a product decision.

Rejected: putting the restart loop in base (it would guess at policy and would
have to know about playback), and guarding only the `call()` path (a dead child
must not look alive to `media.getPreview`/health either).

**3. A replaced child's exit is not a crash.** `restart()` swaps the process;
the old one's exit event arrives afterwards and would otherwise be read as "it
crashed again", producing an infinite restart loop. The exit handler therefore
ignores any process that is no longer `this.proc`, and `dispose()` marks exits as
expected (no restart after teardown). Both cases are covered by the tests.

**4. Same state machine serves the UI.** `media.engine.status`
(`starting|ready|crashed|restarting|failed|incompatible`) is declared in the media
manifest, so the server forwards it without naming media; `media.engineInfo` and
`/api/health` carry the same shape (`state/alive/protocol/restarts/lastExit`), and
the media console shows "引擎: 就绪 · 协议 v1 · 已重启 1 次 · 上次退出码 9". The
handshake path deliberately does NOT set `failed` when the failure is
`UNAVAILABLE` — the supervisor owns that transition, otherwise the two writers
race (this was caught by the "broken binary" test expecting exactly 2 restarts and
seeing 1).

**5. User-visible failures get codes, not prose.** Sidecar worker failures became
`WORKER` (-32005), LLM 401/403 became `UNAUTHORIZED` (-32020), LLM/agent and
sidecar transport failures became `UNAVAILABLE`, and the agent now formats tool
failures with `describeRpcError` so `[code]` reaches both the UI and the model.
Internal assertions (duplicate name, contract violation) intentionally stay plain
`Error` — they are programming errors, not user-facing branches.

## Also fixed on the way

`ctx.preview` existed twice with different types: the host frame buffer
(`PreviewState`) and the client control wrapper (`PreviewService`). Harmless until
one typecheck program contained both faces (the new test imports host `media`
alongside the jsdom UI tests). The host service is now `ctx.previewState`.

## Evidence

- `tests/engine-supervision.test.ts` (9): FIFO/hello/refusal codes/timeout/exit
  rejection/restart/stale-exit/stderr routing, plus media-level crash → restart →
  `ready` with status events, broken binary → `failed` after exactly the cap, and
  protocol 99 → `incompatible`.
- `tests/engine.test.ts`: the real C++ engine answers `hello` with the version the
  host expects.
- `tests/host.integration.test.ts`: `media.engineInfo.state === 'ready'`,
  `protocol === expectedProtocol`, and `/api/health` carries the engine block.
