# MediaMTX Console (product layer)

The **second product** built on this repo's base (mediabase): an agent-friendly
management console for [MediaMTX](https://github.com/bluenviron/mediamtx)
(MIT), the streaming server that ingests cameras/publishers and serves them
over RTSP/RTMP/SRT/HLS/WebRTC. `@mtxconsole/*` scope, its own bundle layers and
identity (`MTXCONSOLE_` / `~/.mtxconsole` / port 3091); the base packages stay
neutral and untouched.

> **Clean room**: this product contains no derived third-party code. Interface
> knowledge comes from live observation of a real MediaMTX v1.21 server and its
> published route table; the reference project MinChanSike/mediamtx-client
> (which has NO LICENSE) was analyzed at README-feature level only — its source
> was never read. See [NOTICE.md](./NOTICE.md).

中文文档:[README.zh.md](./README.zh.md)。

## What it is

MediaMTX ships a full HTTP API but no official UI. This product is that UI —
and it is an **agent-facing** UI: every panel action is a schema-checked RPC
method, and the same methods are registered as base-agent tools ("put camera 3
on the server" is one sentence away).

M1 scope:

- **Dashboard**: server version/uptime, the listener map (derived from the
  server's own config), and a metrics summary parsed from Prometheus
  `/metrics` (ready/idle paths, viewers, per-path byte counters);
- **Streams**: normalized path roster (live state, source, viewers, tracks,
  bitrates, record flag); add a pull source (an rtsp:// camera goes on air
  immediately), patch config, delete;
- **Preview player**: WHEP (WebRTC) low-latency playback, browser **direct** to
  MediaMTX (media bytes never traverse the host); HLS as a fallback only where
  the browser plays playlists natively (Safari/iOS) — zero new runtime deps;
- **Sessions**: all eight protocols (rtsp/rtsps/rtmp/rtmps/hls/webrtc/srt/moq)
  normalized into one table, with kick where upstream supports it;
- **Coded degradation**: with the server unreachable every call answers
  `UNAVAILABLE + messageKey` — panels say "unreachable" instead of going blank.

M2 scope:

- **Recording playback**: a right-column panel browses playback windows per
  path (day-grouped, start time + duration); Play puts the window on the main
  stage, fed to MSE straight from the playback server's fMP4 stream (browser
  **direct** to :9996 — media bytes still never traverse the host). The init
  segment codec parser (avc1/hvc1/mp4a) is built in: **zero new dependencies**
  (no hls.js/mse.js/mp4box);
- **Control plane for the chain**: the new RPC method `mediamtx.playback.list`
  normalizes the `/list` window array and rewrites each `/get` URL's origin to
  the browser-reachable base (upstream echoes the Host *it* saw); playback
  disabled/unreachable are coded errors carrying the config hint, never a
  blank panel.

M3 scope:

- **Sync playback wall**: park recording windows into a 1/4/9 video grid (a
  button on every recordings row, or drag-and-drop); each occupied cell
  streams its own window through MSE and all cells share ONE wall-clock
  timeline — an rAF master clock in the panel maps global time to each cell's
  own seconds, so several recordings of the same incident play (and scrub)
  side by side. The declarative grid state lives in the shared store (the
  recordings panel and the wall talk through the same seam as everything
  else); the 60fps clock deliberately does NOT — a tick must never re-emit
  the snapshot six other panels render from. Zero new dependencies; media
  bytes still flow browser ⇄ :9996 directly.
- **Cross-window chaining**: Play on a recordings row now means "from here" —
  the clicked window plus every window after it form a chain the main stage
  auto-advances through (position badge `i/N`); no more click-per-window.
- **Multi-server**: the host keeps a persisted registry of MediaMTX servers
  (the env-seeded default plus operator additions through the config panel);
  `mediamtx.servers.switch` re-routes EVERY method to the picked server, the
  panels drop their now-stale views, and the agent gets `servers.list` /
  `servers.switch` as tools (add/remove stay operator-only RPC — credentials
  are not model input). Upstream auth grows a static bearer/JWT token beside
  basic-auth (bearer wins when both are set).
- **Global config form**: the bottom drawer shows the whole flat config
  (~122 keys) as the server reports it, bucketed by key-name prefix; scalars
  are editable, composite values render read-only JSON (their honest editor
  is mediamtx.yml). Save sends ONLY the diff through
  `mediamtx.config.global.patch`, then re-reads the config — the server
  normalizes values and listener changes take effect immediately, so the
  panel shows the server's truth, never a stale draft.

M4 scope (this milestone):

- **Wall chaining**: a sync-wall cell now holds a whole CHAIN of a path's
  consecutive windows ("Add to sync" / drag takes the clicked window plus
  every window after it — the main stage's "from here" semantics). The master
  clock locates every tick inside each cell's chain (which window, which
  media second — `locateInSlot` in sync.ts, pinned by tests); crossing a
  window boundary re-attaches that cell's MSE stream to the next window, the
  only honest move against a Range-less `/get`. A recording GAP parks the
  cell, paused, until the clock reaches the next window. The drag payload is
  versioned up (v2, schema-checked): an M3 tab cannot drop a single-window
  payload into an M4 wall.
- **Whole-chain transport**: the stage grows a second scrubber spanning the
  playlist's total playing time (the native one still scrubs inside the
  current window). Dragging across a window boundary RE-STREAMS the target
  window from its first byte and applies the in-window target as soon as
  buffer exists — no Range upstream, no lies downstream. Position painting
  rides the video's own `timeupdate`: no rAF, no re-renders.

## Quick start

```sh
# 1) run a MediaMTX (bring your own binary)
mediamtx   # API defaults to 127.0.0.1:9997

# 2) run this product's host (another terminal)
pnpm run build:mtxconsole   # roster + page
pnpm run dev:mtxconsole     # http://127.0.0.1:3091

# point at another server / with auth:
MTXCONSOLE_SERVER_URL=http://192.168.1.10:9997 \
MTXCONSOLE_USERNAME=admin MTXCONSOLE_PASSWORD=… \
pnpm run host:mtxconsole
# bearer/JWT instead of basic (takes precedence):
MTXCONSOLE_SERVER_TOKEN=eyJ… pnpm run host:mtxconsole
# more servers need no env: register them in the Config panel (persisted
# under ~/.mtxconsole/mtxconsole-servers.json) and switch at runtime.
```

Recording playback needs two settings on the MediaMTX side (`mediamtx.yml`):

```yaml
pathDefaults:
  record: yes        # or record: yes per path
playback: yes        # the playback server (:9996); CORS is open by default (playbackAllowOrigins ["*"])
```

Restart mediamtx afterwards. The browser talks to the playback server
**directly** for media, so its port must be reachable from your browser (same
rule as WHEP/HLS); the control plane (`/list` normalization) goes through the
host bridge.

Gates:

```sh
pnpm run typecheck:mtxconsole       # three planes
pnpm run test:mtxconsole            # units + host integration (auto-LIVE when a mediamtx binary exists)
pnpm run verify:mtxconsole          # end-to-end smoke (LIVE/DEGRADED modes)
pnpm run verify:mtxconsole:compose  # composition-file gate
```

## Architecture: three layers, one layering rule

```
browser panels (@mtxconsole/ui-console)       ← pixels/playback/forms
   │  WS JSON-RPC (control plane: commands & rows, never bytes)
host bridge (@mtxconsole/host-bridge)         ← credentials/CORS/normalization/tools
   │  HTTP (MediaMTX v3 API + /metrics + playback /list)
MediaMTX server (third-party, MIT, operator-run)
   ▲
   └── browser-direct: WHEP (:8889) / HLS (:8888) / recording fMP4 (:9996)
       ← media bytes go here
```

- `@mtxconsole/protocol` (pure, both planes): normalized wire shapes + the
  upstream adapters (`toPathRow`/`toSessionRow`), the Prometheus parser,
  endpoint derivation, error classification. An upstream field rename lands in
  ONE adapter function instead of rippling through panels.
- **Why a host bridge** when the browser could call the API directly: API
  credentials stay host-side, cross-origin is solved once, and panels/agents
  consume one normalized vocabulary (eight session shapes → one row each).
  The control plane carries commands and rows only — media bytes never cross
  the host. That is the base's layering rule, kept.
- **Composition is data**: `packages/bundle/app/cordis.patch.yml` (host layer:
  insert the bridge, move the front door to 3091) and
  `packages/bundle/ui/client.yml` (browser roster: registries → panels → base
  shell LAST; branding is the shell row's `title` config). No custom shell:
  the base `@mediabase/ui-web` already renders header/sidebar/monitor/bottom.

## Agent surface

Registered into the base tool registry (`tools.run` direct; a model reaches
them through `agent.run`):

| Tool | Does |
|---|---|
| `mediamtx.info` | server version / start time |
| `mediamtx.endpoints` | where viewers connect (WHEP/HLS/RTSP/…) |
| `mediamtx.paths.list` | normalized roster (state/source/viewers) |
| `mediamtx.path.add` | **put a camera on air**: `source` = pull, omitted = publish-point |
| `mediamtx.path.delete` | take a path down |
| `mediamtx.sessions.kick` | kick one viewer/publisher |

See [AGENT.md](./AGENT.md).

## Known edges (M3)

- chains play window-by-window — on the main stage AND in every wall cell:
  one rebuffer per hop (the playback server's `/get` has no Range support, so
  a window can only start from its first byte); the stage's native scrubber
  still spans only the current window (the chain transport is what jumps
  across them). Seeking stays honest about the missing Range: instant inside
  the buffered range, forward seeks wait for the sequential stream, evicted
  tail cannot be recovered;
- recording playback requires browser MSE (all modern desktop browsers and
  iOS 17.1+; older Safari gets an explicit "unsupported" message instead of a
  black screen). HEVC codec strings follow the standard formula but have not
  been verified against real HEVC hardware;
- the config form edits scalars only — composite keys (`pathDefaults`,
  `authInternalUsers`…) stay read-only by design (mediamtx.yml is their
  editor; a partial-object patch would silently drop siblings);
- operator-registered server credentials persist in PLAINTEXT under the host
  home (`mtxconsole-servers.json` — the base settings.json pattern; they
  never cross the wire), and the env-seeded server always wins its name;
- the sync wall has no test coverage for its clock/DOM half — `sync.ts` (the
  timeline math and the drop payload contract) and the store actions are
  pinned by `tests/sync.test.ts`, but the rAF loop and the per-cell MSE
  wiring need a browser to exercise (the repo's other browser-bound legs are
  covered the same way: `verify.mjs` walks them LIVE);
- WHEP relies on the browser's native `RTCPeerConnection`; the HLS fallback
  only exists where native (no hls.js — zero new runtime deps is a hard
  constraint of this product);
- upstream auth: basic or a STATIC bearer token (`MTXCONSOLE_SERVER_TOKEN`,
  or per-server `token`); no refresh/expiry handling — an expired JWT
  surfaces as the coded upstream 401 (`UNAVAILABLE`).
