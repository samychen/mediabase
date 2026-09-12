# Note: the front door is bounded, and its messages are translatable

Status: implemented

## Problem

Two base-level gaps, both found by attacking the front door rather than by adding
a feature to it.

**1. `@mediabase/gateway` had no limits and no drain.** Anything a client sent was
buffered (`ws` defaults to a 100 MB `maxPayload`, i.e. a remote OOM), unlimited
sockets were accepted, and a capability that threw from a raw route producer or a
health probe threw *inside* the HTTP request handler — an uncaught exception, and
Node's default is to end the process. `close()` called `terminate()` on every WS
client (1006, indistinguishable from a network drop) and returned as soon as
`server.close()`'s callback fired.

**2. Host prose was unlocalizable.** `ctx.i18n.errorText` already localized by
CODE, deliberately refusing to translate prose — but the *detail* of an error
("unknown setting \"x\"", "read-only mode refuses…") stayed in the host's Chinese,
and the code→text table was hand-written, which had already gone wrong: FORBIDDEN
(-32021, the refusal a user most needs explained) was missing entirely, and
PARSE_ERROR was mapped onto "invalid parameters".

## Decisions

**1. Budgets, and a failing capability that stays a failing capability.** The
gateway takes `maxPayload` (default 1 MiB — the control plane carries commands and
status, never media), `maxConnections` (default 64, shared by `/rpc` and
`/stream`, refused with 503 before the upgrade) and `onError`. A throwing method
map answers `-32603`; a throwing route producer or health probe answers 500. In
both cases the host keeps serving, and the failure is *reported* (`onError` →
`ctx.log`) rather than silently swallowed. Server→client payloads are deliberately
uncapped: a capability may answer with more than a client may send.

**2. `close()` drains, and the ORDER is the whole point.** Measured on Node 23
(via a bare `http` server, no gateway involved): `server.close()` runs
`closeIdleConnections()` internally, and a connection whose response is **still
queued in Node's write queue** counts as idle — a 64 MiB body lost all but 1.7 MB
and the client got `ECONNRESET`. So the sequence is: (1) WS clients get a `1001`
close frame; (2) wait for in-flight responses, *without touching the listener*
(new requests on existing sockets already get 503 from the `draining` flag);
(3) hang up non-WS sockets with `socket.end()` (FIN, not `destroy` — an RST
discards bytes the client still has buffered); (4) only then `server.close()`, and
force-terminate if a peer overstays the budget. `close()` is idempotent, because a
listen failure, a signal handler and a fiber dispose all call it.
`tests/gateway-limits.test.ts` (8 cases) pins all of it, including the 64 MiB
slow-reader case that fails if step 4 ever moves back before step 2.

**3. Errors carry prose AND a key.** `RpcError` gained optional `messageKey` /
`messageParams` (wire fields of the same name), so the host keeps its own wording
for the log, the CLI and a bug report, while a client renders the key in the
user's language and falls back to the prose when it does not know the key. The
code→text table is now DERIVED from `RpcCode`, and `tests/i18n.test.ts` asserts
every code resolves in every shipped locale — the invariant that the hand-written
table had already broken. Migrated: the base's own ACL refusals (keys live in
`CORE_MESSAGES`, they are neutral), plus `settings.set` and `plugins.*` as product
examples (their keys live with the panel that owns those strings). Adoption is
incremental: an unmigrated message behaves exactly as before.

## Consequences

- The panel layer renders errors through `ctx.i18n.errorText`, so an ACL refusal
  now reads as "Read-only mode refuses state-changing methods" instead of Chinese
  prose inside an English UI — with the code still visible, because the code is
  what a bug report and the host log share.
- `@mediabase/protocol` finally has its own test file, so every base package has
  direct coverage; that file also guards the neutral vocabulary (no product
  concept in an exported name, no `node:` import, one home for
  `CONTROL_PROTOCOL_VERSION`).
- What remains base-scope is now only the two big items: an OS-level permission
  sandbox for plugin children (they still run as the same user), and zero-copy
  frame transport (shared-memory ring + handle handshake) on top of the existing
  pull/push data plane.
