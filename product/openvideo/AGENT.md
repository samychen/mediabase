# OpenVideo — agent guide

Adapted from clawnify/OpenVideo's `agent.md` (MIT) for this base's surfaces.
The promise is unchanged: **a project is a plain-JSON EDL document**, and an
agent edits it through a fixed set of checked operations — never by inventing
document shapes.

You reach the host two ways:

1. **As tools** (the normal way): the host's AI capability (`agent.run`) plans
   over `ctx.tools`; every operation below is a registered tool
   (`openvideo_*` after name sanitization). In the editor UI this is the
   "Ask for a change" box.
2. **As RPC methods** (direct): WS JSON-RPC on `/rpc` (JSON-RPC 2.0). Every
   method below is `openvideo.*`. A one-liner from a shell:

   ```sh
   # with the host running on :3090
   OPENVIDEO_URL=http://127.0.0.1:3090 node product/openvideo/scripts/verify.mjs
   ```

   (or drive `/rpc` with any JSON-RPC client; `tools.run` executes one tool by
   name with `{ name, args }`.)

## Media library

Everything a project uses lives in the library.

| Tool / method | Purpose |
|---|---|
| `openvideo.assets.list` | `[{ id, name, contentType, size, duration, hasTranscript }]` |
| `openvideo.assets.import` *(method)* | `{ path }` — copy a file from the host's filesystem into the library |
| `openvideo.assets.upload.*` *(methods)* | chunked browser upload (begin → chunk… → end); agents normally do not need this |
| `openvideo.assets.probe` *(method)* | `{ id, duration }` — backfill a measured length |
| `openvideo.assets.transcript[.set]` *(methods)* | attach / read a `.vtt` transcript sidecar (the caption words) |
| `openvideo.assets.remove` *(method)* | refuses with `-32004` + the project names while any project references the asset |

A project references a file as `asset:<id>`. Bytes are served on the data
plane at `GET /api/openvideo.asset.<id>`.

## Projects

| Tool / method | Purpose |
|---|---|
| `openvideo.projects.list` | `[{ id, name, brief, updatedAt, coverAsset }]` |
| `openvideo.projects.get` | one project **with the full `edl` document** |
| `openvideo.projects.create` | `{ name, brief? }` → an empty 720p timeline |
| `openvideo.projects.save_edl` | `{ id, edl }` — save a whole document; validation errors answer with `path`, a JSON pointer like `/main/elements/2/trimStart`. Fix that node, save again |
| `openvideo.projects.update` *(method)* | `{ id, name?, brief?, edl? }` — same validation |
| `openvideo.projects.op` *(method)* | `{ id, op, args }` — one checked operation, validated + saved as a unit |
| `openvideo.projects.remove` *(method)* | delete a project |
| `openvideo.proxy.info` | is ffmpeg present (probed), which targets, jobs running |
| `openvideo.proxy.ensure` | `{ id, target?(webm\|mp4) }` — transcode a browser-decodable proxy for an asset (idempotent; poll `openvideo.assets.list` → `proxy.status`) |
| `openvideo.proxy.cancel` *(method)* | cancel a queued/running proxy job |

## The checked operations

Each is also its own tool (`openvideo.add_clip`, `openvideo.trim_clip`, …) —
prefer the individual tools; `projects.op` is the generic door. Times are
seconds; positions are canvas fractions (0..1); `clip` is the 0-based position
on the main track.

| Op | Args | What it does |
|---|---|---|
| `add_clip` | `src, kind?(video\|image), at?, duration?` | put a library asset on the main track (images need `duration`, default 3) |
| `trim_clip` | `clip, start?, seconds?` | play `seconds` starting `start` into the source |
| `split_clip` | `clip, at` | cut in two, `at` seconds into what the clip plays now |
| `delete_clip` | `clip` | remove from the main track |
| `move_clip` | `clip, to` | reorder (the sequence IS the array order) |
| `set_clip_audio` | `clip, muted?, volume?` | mute / level a clip's own sound (0..2) |
| `add_text` | `text, start, seconds, x?, y?, size?` | an on-screen title (default x 0.5, y 0.85, size 40) |
| `remove_text` | `track, index` | remove an overlay element by its document position |
| `add_audio` | `src, start?, seconds?, volume?` | music bed element |
| `remove_audio` | `track, index` | remove an audio element |
| `set_captions` | `enabled, lang?` | project captions (words come from attached transcripts) |
| `set_aspect` | `shape(landscape\|vertical\|square)` | 1280×720 / 720×1280 / 1080×1080 |

Every operation either returns what it did (`said`) or refuses with a reason —
and its result is validated as a whole document before it is saved.

## The document (EDL)

Rules that make editing easy to reason about (unchanged from upstream):

- **The main track is an ordered array** — clips play end-to-end in array
  order; reordering is moving elements, splicing is an insert.
- **Media is `asset:<id>`** (or `https://` / `data:` for small public media).
- **Times are seconds; positions and sizes are canvas fractions (0..1).**
- **Overlays and audio float on the output timeline** with `startTime` +
  `duration`; overlay tracks composite in array order (later = on top).
- Limits: ≤ 100 elements, ≤ 20 distinct sources, output ≤ 5 minutes,
  even output dimensions, fps ∈ {24, 30, 60}.

```json
{
  "version": 1,
  "output": { "width": 1280, "height": 720, "fps": 30, "background": "#000000" },
  "main": { "elements": [
    { "id": "intro", "type": "video", "src": "asset:3f9c2a1b8d4e6f70", "trimStart": 2 },
    { "id": "demo",  "type": "video", "src": "asset:9a1d4c7e2b5f8036", "duration": 12 },
    { "id": "outro", "type": "image", "src": "asset:5e8b1f4a7c2d9063", "duration": 3 }
  ]},
  "overlays": [{ "id": "titles", "elements": [
    { "id": "hook", "type": "text", "text": "Three features. One minute.", "fontSize": 72,
      "startTime": 0.5, "duration": 3, "x": 0.5, "y": 0.12, "align": "center" }
  ]}],
  "audio": [{ "id": "music", "elements": [
    { "id": "bed", "type": "audio", "src": "asset:7d2a5f8c1e4b9036", "startTime": 0, "volume": 0.35 }
  ]}],
  "captions": { "enabled": true, "lang": "en",
    "style": { "size": 0.055, "position": "bottom", "margin": 0.08,
               "background": true, "color": "#ffffff", "maxChars": 32 } }
}
```

Field notes: a video clip's `duration` is a PLAY WINDOW from `trimStart` (wins
over `trimEnd`); `fit` is `contain` (letterbox, default) or `cover` (crop);
`sourceAudio: false` mutes a clip; text overlays take `fontFamily`
(sans/serif/mono), `color`, boxed `background` (`#RRGGBBAA`), `align`.

## Worked example (read → transform → save)

"Cut the first 10 seconds off the intro, then title it":

```
openvideo_projects_get   { id: "<pid>" }            → read the edl
openvideo_trim_clip      { project: "<pid>", clip: 0, start: 10 }
openvideo_add_text       { project: "<pid>", text: "Product tour", start: 0.5, seconds: 3 }
```

Each op is one save and one undo step in the editor. To rewrite a document
wholesale instead, `openvideo_projects_save_edl` — and when it refuses, the
answer names the exact node:

```json
{ "code": -32602, "message": "EDL invalid: unknown field /main/elements/0/trimStar @ /main/elements/0/trimStar",
  "data": { "detail": "unknown field /main/elements/0/trimStar", "path": "/main/elements/0/trimStar" },
  "messageKey": "openvideo.edlInvalid" }
```

## Things agents should know

- **You cannot see or hear the footage.** Unlike the upstream's managed
  analysis, this local product has no `clean_up_clip`/autocut: work from names,
  durations and the user's words; ask the user when content matters.
- **Undecodable footage has a fix**: when a video cannot be decoded in the
  browser (HEVC and friends), call `openvideo_proxy_ensure` — the host
  transcodes a proxy with its own ffmpeg; once `proxy.status` is `ready` in
  `assets.list`, preview and export use it automatically. No ffmpeg on the
  host → `-32002` with `openvideo.proxyNoFfmpeg`: tell the user to install it.
- **Captions need transcripts**: `hasTranscript: true` in `assets.list` means a
  `.vtt` sidecar is attached; `set_captions` on footage without one produces
  no words (the setting is still valid).
- **Export is browser-side** (canvas + MediaRecorder, real time): there is no
  host export job to poll. Tell the user to press Export in the editor.
- **Errors are codes**: `-32602` invalid params/EDL/op (with `path` when it is
  a document), `-32001` not found, `-32004` conflict (in-use asset, upload
  ceiling, out-of-order chunk), `-32020` no LLM key for `agent.run`.
