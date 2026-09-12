# @mediabase/server

Host plugin: the HTTP + WS front door (Mode B endpoint) — and **nothing else**.

- `WS   /rpc` — JSON-RPC over `ctx.api.methodMap()`
- `WS   /stream` — byte streams over `ctx.api.streamMap()` (data plane, push)
- `GET  /api/<name>` — raw byte routes from `ctx.api.routeMap()` (e.g. `preview.rgb`)
- `GET  /api/health` — `{ok:true, ...ctx.api.healthPayload()}`
- everything else — the built client, with DSH `frontend-static` semantics:
  traversal outside the dist root is 403, any miss falls back to index.html (200).

`server.info` is also the **handshake**: it reports `protocol`
(`CONTROL_PROTOCOL_VERSION`), the host/port actually bound (port 0 = any free port),
live stream subscribers and the access policy in force — so a client can detect a
protocol mismatch once, and tooling/tests never guess.

The composition row owns the env vocabulary (`!!js ctx.env.str('AVSTUDIO_TOKEN')` …),
and `Config` validates it: `AVSTUDIO_TOKEN` (auth), `AVSTUDIO_READONLY=1`,
`AVSTUDIO_ACL_ALLOW`/`AVSTUDIO_ACL_DENY` (exact names or `prefix.*`) — all enforced in
`ctx.api`, not here. `inject: ['api',
'capabilities', 'log']` — **no capability names appear in this file**. Media/python/workflow/… each register their own methods, routes and health
payloads, so adding a capability never touches the server. Outbound notifications
are forwarded for the event names a capability declared in its manifest
(`capabilities.subscribe()` picks up capabilities that mount later).

In DSH this would be split into a `webServer` Service plus `frontend-static` and
an RPC plugin registering onto it; the README notes where to promote the split
when a second host package needs HTTP.
