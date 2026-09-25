# @mtxconsole/host-bridge

Host capability `mediamtx`: the MediaMTX bridge. A cordis plugin like every
other capability (`name` / `inject` / `Config` / `apply`).

WHY a host bridge (the browser could talk to MediaMTX directly): API
credentials stay host-side (the page never sees them), cross-origin is solved
once, and every panel/agent/tool consumes ONE normalized vocabulary instead of
eight per-protocol session shapes and a 122-key config blob. **Bytes do not
flow through here** — live media goes browser ⇄ MediaMTX directly (WHEP/HLS on
their own ports); the control plane stays commands-and-rows, as the base
demands.

Surface:

- 14 RPC methods (`mediamtx.info` / `.endpoints` / `.paths.*` /
  `.config.paths.*` / `.config.global.*` / `.sessions.*` / `.metrics` /
  `.recordings.*`), results schema-validated at the boundary;
- 6 agent tools (info, endpoints, paths.list, path.add, path.delete,
  sessions.kick) — `path.add` with a `source` is "put this camera on air";
- health payload `{server, version}` (version cached from the last successful
  `info` — health never probes);
- the whole upstream error contract in one place: `{status:"error",error}` +
  HTTP status → coded `RpcError` with `messageKey`/`messageParams`
  (`mediamtx.unreachable` / `mediamtx.upstream` / `mediamtx.noMetrics` /
  `mediamtx.notKickable`).

Config (env rows use SHORT names under the `MTXCONSOLE_` prefix):
`serverUrl` (`MTXCONSOLE_SERVER_URL`, default `http://127.0.0.1:9997`),
`username` / `password` (basic auth), `timeoutMs`.

Stateless proxy: no persistent side effects, so no fiber effects needed —
every call is one bounded `fetch` with an abort timeout.
