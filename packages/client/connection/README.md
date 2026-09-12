# @mediabase/connection

Client plugin (runs in the browser): opens the WS `/rpc` channel to the host and
provides:

- `ctx.rpc` — JSON-RPC client over that socket, with auto-reconnect; emits
  `connection.status` `{ connected, protocol, compatible }`. On open it handshakes
  `server.info` and compares `protocol` with `CONTROL_PROTOCOL_VERSION`.
- `ctx.streams` — data-plane **push** subscriber: `open(channel, handlers)`.
- `ctx.net` — `apiUrl` / `wsUrl` / `token`: when the host enforces `${prefix}TOKEN`,
  the token is taken from `?token=` (then remembered) and appended to RPC, streams
  and `/api/*` fetches.

Uses the shared `makeClient` from `@mediabase/protocol`.

`openStream()`/`streamUrl()` are exported separately for non-cordis consumers.

A UI that can paint from either transport should listen to `onStatus` and fall
back to the pull route while not `live` — product monitors (e.g. in a consumer
repo) typically poll a preview route only while the stream is down.
