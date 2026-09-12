# Note: a local trust boundary, least-privilege plugins, and one audit point

Status: implemented

## Problem

Two holes, both about honesty more than features:

1. The host served every API, stream and health endpoint to *any* process that
   could reach the port. Fine for a single-user desktop app on loopback, but the
   framework stance ("a host other apps can build on") needs at least a switch.
2. Runtime plugins got the full root context: `ctx.plugin(mod)` and the module
   could touch any service the host had — including services it had no business
   in — while `provides` only documented what it *contributed*.

## Decisions

**1. `AVSTUDIO_TOKEN` is a local trust boundary, and is described as one.** When
set, `/api/*` (health included) and both WS endpoints require `?token=` (query is
the primary path because browsers cannot set headers on WebSocket); the static SPA
shell stays public because it carries no data. Comparison is `timingSafeEqual`, and
a missing token fails the WS upgrade with a 401 before the handshake so the client
can say why.

Rejected: sessions, users, TLS, cookies. All of that is a *deployment* concern and
half-implementing it would be worse than stating the boundary. Both AGENTS.md and
the gateway README say plainly: no TLS, no user model, needs a real auth layer in
front for anything beyond localhost.

**2. The client carries the token for everything.** `@mediabase/connection` resolves
it from `?token=` (remembering it in localStorage) and exposes `ctx.net`:
`apiUrl()`, `wsUrl()`, `token()`. The RPC socket, the stream socket and the polls a
panel does itself all go through those helpers, so a token-protected host works by
opening the UI once with `?token=…`. The Electron shell passes it in the window URL
when `AVSTUDIO_TOKEN` is set, so the packaged app keeps working.

**3. Least privilege for runtime plugins via `requires`.** A catalog entry may
declare the services a plugin is allowed to use. The manager then hands the module
a Proxy over its own fiber context that allows the framework members
(`effect`/`reflect`/`events`/`get`/`plugin`/`isolate` …) plus the declared names and
refuses everything else — with an error that names the declaration to add. Two
subtleties came out of writing the tests:
- refusal must happen BEFORE touching the target, otherwise cordis' own
  `cannot get property "x" without inject` fires first and says nothing about the
  plugin's declaration;
- a plugin's own `inject` list must fit inside `requires`, because cordis resolves
  `inject` for the plugin — an entry that allows nothing but a module that injects
  `media` was otherwise a declaration that quietly meant nothing.

`ctx.get(name)` remains available for probing an optional service, and entries that
omit `requires` keep the old full-context behaviour (backwards compatible).

**NOT a sandbox, and said so everywhere.** The plugin runs in the host process with
the host's rights; `require('node:fs')` is still reachable. Real isolation (worker
or child process with an RPC bridge, serializable contracts only) remains on the
list; calling the current mechanism a sandbox would be a lie.

**4. One audit point.** `ctx.api.call()` logs success at debug (method, ms) and
failure at warn (method, ms, code, message), so `AVSTUDIO_LOG_LEVEL=debug` yields a
request trail for every control-plane call without a single capability doing
anything. The plugin manager logs load/unload (module, requires, provides) at info
under `avstudio.plugins`.

## Evidence

- `tests/access-control.test.ts` (6): 401 on `/api/*` + health without/with a wrong
  token and 200 with the right one; the SPA shell public; both WS endpoints refused
  without and accepted with the token; plugin with `inject` beyond `requires`
  refused; direct undeclared service access refused with the fix named; a declared
  plugin loads, is audited, and its service disappears on unload; api audit records
  exist at debug/warn with codes.
- `tests/host.integration.test.ts` (+1): a real host booted with
  `AVSTUDIO_TOKEN=it-secret` — shell public, health/preview 401 without the token,
  200 with it, unauthenticated `/rpc` upgrade refused, authenticated `media.ping`
  answered, and the boot log states token checking is on.
