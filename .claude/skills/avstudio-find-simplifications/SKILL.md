---
name: avstudio-find-simplifications
description: Use when asked to find non-obvious simplification candidates in the avstudio repo — dead, duplicated, speculative, over-built, or hand-rolled-where-a-dependency-exists surfaces
---

# Finding AVStudio Simplifications

This skill turns a broad "find things to simplify" request into evidence-backed
candidates. Prefer a few well-proven candidates over a pile of thin guesses.

## Where to look

- **Fights against cordis:** avstudio runs real `@deepseek-ai/cordis`. Any code
  that re-implements DI, service lookup, or fiber lifecycle locally (instead of
  `apply`/`ctx.reflect.provide`/`ctx.effect`/`inject`) is a candidate to fold
  back into the framework shape.
- **Control/data duplication:** WS (control) + HTTP (data plane) are intentional
  (see AGENTS.md). Suspect anything that duplicates either protocol or the
  engine line-protocol parsing.
- **Engine protocol drift:** commands in `engine/src/main.cpp` must match
  `MediaEngineClient` in `packages/host/media/src/engine.ts`. Divergence is a
  real cost — a generated/single-source protocol is a candidate once the
  command set grows.
- **Server consolidation:** `@mediabase/server` deliberately merges what DSH
  splits into a `webServer` Service + `frontend-static` + an RPC plugin. When a
  second host package needs HTTP, promoting `ctx.webServer` (see the package
  README) is the simplification that unblocks it — not another bespoke server.
- **Dead branches and speculative options:** default widths, fallback
  durations, reconnect loops — each should map to a current consumer.

## Evidence before proposing

Each candidate must name the concrete cost it removes (lines, failure modes,
build weight) and, for intentional-looking designs, the AGENTS.md rule it
respects or the note that documents it. Proposals are suggestions — a later
better argument wins over an old note.
