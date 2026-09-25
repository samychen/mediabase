# @mtxconsole/protocol

The wire vocabulary between the host bridge and the console panels —
**normalized**, pure, usable from both planes.

Clean-room: every shape here was derived from a running MediaMTX v1.21 (MIT)
and its published route table; no third-party console code was read (see the
product `NOTICE.md`). The host owns normalization so an upstream field rename
lands in ONE adapter function instead of rippling through panels:

- `toPathRow` / `toSessionRow` / `toRecordingRow` — upstream → normalized rows
  (tolerant: garbage degrades to `null`, never throws);
- `addressToUrl` — MediaMTX address settings (`:8889`, `disable`) → absolute
  browser URLs, borrowing the API hostname for bare ports;
- `parseMetrics` — Prometheus text exposition → the handful of `paths*` series
  the dashboard shows;
- `SESSION_LIST_ROUTE` / `SESSION_KICK_ROUTE` — the 8-protocol route maps;
- `classifyUpstream` — the `{status:"error",error}` contract → RPC error kinds.

The schemas use the repo dialect (`@mediabase/schema`): fields MediaMTX
guarantees are required; everything that has shifted across versions is
optional (and nullable fields stay unrequired — in this dialect `.required()`
means non-null).
