# @mediabase/server

Host plugin: the HTTP + WS front door (Mode B endpoint) — and **nothing else**.

- `WS   /rpc` — JSON-RPC over `ctx.api.methodMap()`
- `WS   /stream` — byte streams over `ctx.api.streamMap()` (data plane, push)
- `GET  /api/<name>` — raw byte routes from `ctx.api.routeMap()`
- `GET  /api/health` — `{ok:true, ...ctx.api.healthPayload()}`
- everything else — the built client, with DSH `frontend-static` semantics:
  traversal outside the dist root is 403, any miss falls back to index.html (200).

`server.info` is also the **handshake**: it reports `protocol`
(`CONTROL_PROTOCOL_VERSION`), the host/port actually bound, live stream subscribers
and the access policy in force.

The composition row owns the env vocabulary (`!!js ctx.env.str('TOKEN')` … →
`${prefix}TOKEN`), and `Config` validates it: token auth, `${prefix}READONLY=1`,
`${prefix}ACL_ALLOW`/`ACL_DENY` (exact names or `prefix.*`) — all enforced in
`ctx.api`, not here. `inject: ['api', 'capabilities', 'log']` — **no capability
names appear in this file**. Product capabilities each register their own methods,
routes and health payloads. Outbound notifications are forwarded for event names a
capability declared in its manifest (`capabilities.subscribe()` picks up late mounts).
