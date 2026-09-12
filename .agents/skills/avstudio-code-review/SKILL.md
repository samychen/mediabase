---
name: avstudio-code-review
description: Use when reviewing a change in the avstudio repo — orients the reviewer to this skeleton's standing rules (AGENTS.md: the media-layering rule, plugin lifecycle, control-vs-data planes) and the review checks that code alone cannot show
---

# Reviewing an AVStudio change

**This skill is guidance, not a checklist.** Read [AGENTS.md](../../../AGENTS.md)
first, then review the diff with enough surrounding code to understand the
design. This is a small skeleton: one substantiated blocker beats a list of
nits, and the layering rule below is the most likely blocker.

## Blocking requirements

1. **The media-layering rule holds.** Nothing per-frame (decode/encode/pixels/
   capture/render) leaks into `host/` or `web/`. New C++ capabilities land in
   `engine/` behind the line protocol; the host only commands, frames only cross
   as HTTP bytes (`/api/preview.rgb`), never through WS.
2. **Every side effect is reversible.** Child processes, timers, servers,
   sockets, temp files are registered via `ctx.effect(() => cleanup())`; a new
   plugin that spawns/kills/timers without effect-registration is a blocker.
3. **Async state is guarded.** Any value read before an `await` that is used
   after it must be re-checked or captured (see the media play loop history:
   an unguarded `playState.t` after `await` crashed the host). An unexpected
   throw must not take the host down.
4. **Control plane ≠ data plane.** New WS JSON-RPC methods carry commands/status
   only; new byte payloads use HTTP.
5. **Plugin shape is portable.** New plugins use `apply(ctx)` + `ctx.set/get`
   + optional `inject`; no bespoke DI re-implemented per plugin.

## Manual checks

- **Lifecycle:** does stop()/disconnect return the repo to a clean state —
  engine re-spawnable, socket closed, temp frame cleaned?
- **Typing:** strict flags are on (`tsconfig.base.json`); no `any` smuggled in,
  no non-null assertions where a guard is honest.
- **Scope & necessity:** does each abstraction map to a current consumer?
  Challenge speculative generality.
- **Docs match code:** new services/endpoints update the README section that
  documents them; comments state contracts, not narration.
