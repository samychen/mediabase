# @mtxconsole/ui-console

Client plugin: the five console panels, registered into `ctx.ui` (the shell
renders them — no shell edit). Every string lives in `messages.ts` (zh-CN +
en, kept parallel by the i18n test); host calls go over `ctx.rpc`; ONE shared
store (provided on the context as `mtxConsole`) so five panels poll the server
once, not five times.

Panels (area / order):

| id | area | what |
|---|---|---|
| `mtx.status` | header | reachability dot + version, inline in the title row |
| `mtx.dashboard` | monitor 10 | server card, listener map, metrics tiles |
| `mtx.player` | monitor 20 | WHEP preview (HLS where native), session torn down on every switch/unmount |
| `mtx.streams` | sidebar | normalized roster + the add-path form (the director's gesture) |
| `mtx.sessions` | bottom | all 8 protocols in one table + kick |

The store polls every 3s (paths/sessions/metrics each cycle; info/endpoints
every fifth — identity doesn't change while you watch), pauses while the tab
is hidden, and stops with the plugin (`ctx.effect` cleanup). It is a plain
observable (immutable snapshot + `subscribe`) consumed through
`useSyncExternalStore` — the same contract the openvideo editor store uses.

Playback: `whep.ts` is a ~100-line standard WHEP client over the browser's
native `RTCPeerConnection` (recvonly offer → POST SDP → answer → `Location`
session URL → DELETE on teardown). The upstream refusal contract
(`{"status":"error","error":"no stream is available on path 'cam1'"}`) is
surfaced verbatim — the operator sees WHY. HLS is offered only where
`canPlayType('application/vnd.apple.mpegurl')` succeeds; no hls.js, zero new
runtime dependencies.

Styles: `.mx-*` classes on the shared design tokens (`@mediabase/theme`), so
every skin works without edits.
