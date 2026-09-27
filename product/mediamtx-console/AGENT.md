# MediaMTX Console — agent guide

The promise: **the streaming server is a document you can act on**. An agent
reads the normalized state (paths, sessions, metrics) and changes it through a
fixed set of checked operations — never by inventing API shapes. Everything
below was derived clean-room from MediaMTX v1.21's own API (see NOTICE.md).

You reach the host two ways:

1. **As tools** (the normal way): the host's AI capability (`agent.run`) plans
   over `ctx.tools`; every operation below is a registered tool.
2. **As RPC methods** (direct): WS JSON-RPC on `/rpc` (JSON-RPC 2.0). Every
   method below is `mediamtx.*`. Upstream auth: basic (`MTXCONSOLE_USERNAME`/`PASSWORD`) or a static bearer
token (`MTXCONSOLE_SERVER_TOKEN`, or per-server `token` — bearer wins when
both are set). Smoke the whole surface from a shell:

   ```sh
   # with the console host running (it spawns its own MediaMTX if MTX_BIN is set)
   pnpm run verify:mtxconsole
   ```

## Reading the server

| Tool / method | Returns |
|---|---|
| `mediamtx.info` | `{ version, started, apiBase }` — which server you are talking to |
| `mediamtx.endpoints` | absolute viewer URLs: `{ webrtc, hls, rtsp, rtmp, srt, metrics, playback }`; `null` means that protocol is disabled upstream |
| `mediamtx.paths.list` | normalized rows: `{ name, ready, source, sourceType, readers, inboundBytes, outboundBytes, tracks[{type,codec,id}], record }` |
| RPC `mediamtx.sessions.list` `{kind?}` | one row per viewer/publisher across all 8 protocols (omit `kind` for everything) |
| RPC `mediamtx.metrics` | `{ pathsReady, pathsNotReady, totalReaders, perPath[] }` parsed from Prometheus |
| RPC `mediamtx.recordings.list` / `.get {name}` | recorded paths and their day/segment summaries |
| RPC `mediamtx.playback.list` `{name, start?, end?}` | playable windows `[{ startIso, durationSeconds, url }]` — `url` is a browser-fetchable fMP4 stream (origin already rewritten to the reachable playback base) |
| RPC `mediamtx.config.global.get` | the server's flat config (122 keys) for review |
| RPC `mediamtx.config.global.patch` `{values}` | subset-patch the global config (the config panel sends only the diff) |
| `mediamtx.servers.list` | managed-server registry `[{name,url,auth}]` + which is `active` — credentials never cross the wire |

`ready: false` is not an error — it means no publisher is connected yet.
`source` shows the configured pull URL once set (a path created without one
waits for a live push).

## Changing the server

| Tool / method | Effect |
|---|---|
| `mediamtx.path.add` `{name, source?, record?}` | **the director's gesture**: with `source` (e.g. `rtsp://user:pass@cam.local/stream1`) the server starts PULLING immediately; without it the path waits for a publisher. `record: true` persists it to disk. |
| `mediamtx.path.delete` `{name}` | take it off air |
| `mediamtx.sessions.kick` `{kind, id}` | drop one viewer/publisher (ids from `paths.list` readers / `sessions.list`) |
| RPC `mediamtx.config.paths.patch` `{name, source?, record?}` | re-point or re-arm a path |
| RPC `mediamtx.config.global.patch` `{values}` | subset-patch the global config — **handle with care**; changing listener addresses takes effect immediately |
| `mediamtx.servers.switch` `{name}` | route EVERY method to another registered server (panels drop their stale views) |
| RPC `mediamtx.servers.add` `{name,url,username?,password?,token?}` | register another MediaMTX server; credentials persist host-side only — **operator RPC, not a tool** |
| RPC `mediamtx.servers.remove` `{name}` | unregister a server (never the active one — switch away first) |

## Error contract (branch on `code`, not prose)

| Situation | Wire |
|---|---|
| server unreachable | `-32002 UNAVAILABLE`, `messageKey: mediamtx.unreachable` |
| upstream refused (duplicate path, bad value…) | code by status: 400→`-32602`, 404→`-32001`, 401/403→`-32002`, else `-32004`; `messageKey: mediamtx.upstream`, `messageParams.detail` carries MediaMTX's own words |
| protocol cannot be kicked (rtmp) | `-32602`, `messageKey: mediamtx.notKickable` |
| metrics disabled upstream | `-32002`, `messageKey: mediamtx.noMetrics` |
| playback server disabled upstream | `-32002`, `messageKey: mediamtx.playbackDisabled` (needs `playback: yes` in mediamtx.yml) |
| playback server unreachable | `-32002`, `messageKey: mediamtx.playbackUnreachable`, `messageParams.url` |
| duplicate server name / blank name / non-http(s) URL | `-32602`, `messageKey: mediamtx.serverExists` / `mediamtx.serverBadName` / `mediamtx.serverBadUrl` |
| unknown server name | `-32001`, `messageKey: mediamtx.serverUnknown` |
| removing the ACTIVE server | `-32004`, `messageKey: mediamtx.serverActive` |

## Recipes

- **"Put the lobby camera on air"**: `mediamtx.path.add {name:"lobby", source:"rtsp://…"}` → poll `mediamtx.paths.list` until `ready:true` (a source that never connects stays `ready:false` — say so, don't retry silently).
- **"Who's watching cam1?"**: `mediamtx.sessions.list` (or paths.list `readers`), filter `path==="cam1"`.
- **"Kick the stale WebRTC viewer"**: find the row (`kind:"webrtc"`), then `mediamtx.sessions.kick {kind, id}`.
- **"Is the server healthy?"**: `mediamtx.info` + `mediamtx.metrics`; report version, ready/idle counts, total viewers.
- **"What did cam1 record yesterday?"**: `mediamtx.playback.list {name:"cam1", start:"…T00:00:00Z", end:"…T23:59:59Z"}` → report windows as start + duration; an empty array means nothing was recorded (not an error).
- **"Check the office server instead"**: `mediamtx.servers.list` → `mediamtx.servers.switch {name:"office"}` → every following read (`paths.list`, `metrics`…) answers from the office server. Registering/removing servers is operator-only RPC — credentials are not model input.
- **"Give me a link to that recording"**: hand over the window's `url` — it streams fMP4 (`format` defaults to fmp4; append `&format=mp4` for a download-style MP4). A path that never recorded answers 400 upstream, which the bridge maps to `[]`; a path that does not exist is `-32602`.
