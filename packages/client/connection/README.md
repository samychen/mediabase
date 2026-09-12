# @mediabase/connection

Client plugin (runs in the browser): opens the WS `/rpc` channel to the host and
provides:

- `ctx.rpc` — JSON-RPC client over that socket, with auto-reconnect; emits
  `connection.status` `{ connected, protocol, compatible }`. On open it handshakes
  `server.info` and compares `protocol` with `CONTROL_PROTOCOL_VERSION`: a mismatch is
  reported (`rpc.handshake()`) and shown in the header badge instead of failing method
  by method.
- `ctx.streams` — data-plane **push** subscriber: `open(channel, handlers)` returns
  a handle with `status()`/`close()`, reconnects while open, and reports
  `onDropped` when the host sheds frames under backpressure. Frames arrive as
  `onFrame(meta, bytes)`; the envelope is `meta` (text) then the raw payload
  (binary), so nothing has to be parsed off the hot path.

Uses the shared `makeClient` from `@mediabase/protocol`, so client and host speak one
wire format (same trick as DSH's shared JSON-RPC SDK).

`openStream()`/`streamUrl()` are exported separately, so a non-cordis consumer (a
test, a script) can subscribe without the plugin.

`ctx.net` gives `apiUrl(path)` / `wsUrl(path)` / `token()`: when the host enforces
`AVSTUDIO_TOKEN`, the token is taken from `?token=` (then remembered in
localStorage) and appended to the RPC socket, the stream socket and every `/api/*`
fetch a panel makes itself.

A UI that can paint from either transport should listen to `onStatus` and fall
back to the pull route while not `live` — see `@avstudio/ui-media`'s monitor,
which polls `/api/preview.rgb` only while the stream is down and shows which
transport is in use.
