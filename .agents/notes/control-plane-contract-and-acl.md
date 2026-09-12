# Note: a versioned control plane and a method-level ACL

Status: implemented

## Problem

Two gaps that only matter once someone other than the author talks to the host:

1. The control plane had no version. A UI built against an older host discovered the
   difference method by method — button by button — instead of once, up front. (The
   engine boundary already had `hello`; the host boundary did not.)
2. Access control was all-or-nothing: a token gated the door, and then the caller
   could do anything. There was no way to hand someone a read-only host, nor to deny
   a single dangerous method, and no user-visible way to know why a call was refused.

## Decisions

**1. The handshake rides the method a client needs anyway.** `server.info` gained
`protocol` (from `CONTROL_PROTOCOL_VERSION` in `@mediabase/protocol`) alongside the port
and stream subscribers; `@mediabase/connection` calls it once on open, compares, and
emits `connection.status { protocol, compatible }`. The header badge shows
"协议不兼容(宿主 v… / 前端 v…)" instead of a UI that half-works. `ctx.rpc.handshake()`
exposes the same state to panels.

Why not a dedicated `hello` method (like the engine)? Because the client already
wanted everything `server.info` returns, and a second round trip plus a second source
of truth is worse than one method that is explicitly the handshake (renamed in its
description accordingly).

**2. `mutates` is declared by the capability, because only it knows.** The registry
cannot infer that `media.decode` changes the preview while `media.ping` does not, so
`ApiMethod.mutates` is part of registration and shows up in `api.list` (a UI can
disable mutating buttons). 16 methods across media/settings/plugins/python/workflow/
agent/tools now declare it; `tools.run` and `agent.run` do because they execute
arbitrary registered behaviour.

**3. The policy lives in `ctx.api.call()`, not in a transport.** Consequences:
- it holds for every client (WS today, anything later) and for in-host callers;
- refusals are audited at the same choke point that already logs every call;
- the transport stays ignorant — the server just sets the policy from config.
`allow`/`deny` accept exact names or `prefix.*`; deny wins; `readonly` refuses exactly
the `mutates` methods. Refusals are `RpcCode.FORBIDDEN` (-32021) with the policy
attached as `data`, so a client can explain the refusal instead of parsing prose.

Rejected: an ACL file with per-user rules (there is no user model — the token is the
identity), and per-capability ACLs (the host is one trust domain; the policy is
host-wide and declared by the operator).

**4. The gateway earned its own tests.** It carried the most machinery per line
(SPA semantics, upgrade routing, raw routes, health merge, auth, stream backpressure)
while being covered only through whole-host tests. `tests/gateway.test.ts` (9) pins
the behaviours a host depends on. Writing it immediately produced a correction: a
plain `../` in a URL is normalized by the WHATWG parser before the gateway sees it
(so it becomes a harmless SPA fallback), while the percent-encoded `%2e%2e%2f` form
is what actually reaches the 403 guard — the test now asserts both shapes, because
"traversal is blocked" was only half true as stated.

## Evidence

- `tests/api-registry.test.ts`: deny/allow/wildcard refusals with `FORBIDDEN` +
  attached policy, read-only refusing exactly `mutates` methods (and `api.list`
  exposing the flag), refusals audited at warn under scope `avstudio.api`.
- `tests/host.integration.test.ts`: `server.info.protocol === 1`; `api.list` marks
  `media.play`/`settings.set`/`plugins.load`/`agent.run` as mutating but not
  `media.ping`/`api.list`/`server.info`; a host booted with `AVSTUDIO_READONLY=1` +
  `AVSTUDIO_ACL_DENY=media.samples` reads fine, refuses playback (message names
  read-only mode) and refuses the denied method (message names the deny list), and
  logs the refusal.
- `tests/gateway.test.ts`: static fallback + both traversal shapes, 405, JSON-RPC
  dispatch and late registrations, broadcast, raw-route 404/200 + health merge,
  port/ready/idempotent close, unknown WS path refused.
- `tests/ui-composition.test.tsx`: the panel suite caught that the new badge assumed
  `rpc.handshake()` exists — the badge now degrades gracefully (`?.handshake?.()`)
  and the stubs provide it, so both paths are covered.
