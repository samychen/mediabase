# OpenVideo on mediabase

**OpenVideo** is the first product layer built on this repo's base (mediabase):
an **agent-friendly video editor**. A project is a plain-JSON **EDL (edit
decision list)** — a person cuts it on the timeline, an AI agent reads and
changes the same document through the same **checked operations**. Ported from
[clawnify/OpenVideo](https://github.com/clawnify/OpenVideo) (MIT, see
`NOTICE.md`) and reshaped to the conventions in the root `AGENTS.md`.

中文：[README.zh.md](README.zh.md)。Full integration rationale (zh):
[INTEGRATION.zh.md](INTEGRATION.zh.md); agent guide: [AGENT.md](AGENT.md);
attributions: [NOTICE.md](NOTICE.md).

## What it is

- **Timeline editing**: the main track is an ordered array (the sequence IS the
  order) — trim / split / reorder / delete; text and image overlays float on
  the output timeline; music mixes underneath.
- **Live preview**: one master clock drives stacked `<video>`/`<img>`/DOM
  layers (the upstream scheme — the preview shows cuts, layout and timing;
  pixel-exact rendering is the export's job).
- **Media library**: chunked browser upload (over the control plane, ≤ 512 KiB
  chunks), import by host path, **fetch a network URL into the library**
  (`assets.fetch`, http/https — full parity afterwards: probing, transcripts,
  proxies, export), duration backfill, `.vtt` transcript sidecars (captions
  follow every trim, split and reorder). EDL documents also accept direct
  `https://` sources (preview plays them through, the client probes their
  length; export needs CORS on the remote).
- **Ask for a change**: goes through the base's `agent.run` — the model calls
  the fixed set of checked `openvideo.*` tools; one instruction, one undo. No
  `OPENVIDEO_LLM_KEY` configured → a coded error, never a blocked editor.
- **Export to MP4/WebM**: browser-side canvas + MediaRecorder, real time (the
  local replacement for the upstream managed edit service; draft-grade — see
  Boundaries).
- **One-click skins**: the base's `@mediabase/theme` (dark/midnight/light design-token skins, header picker, remembered per browser; this product defaults to midnight via its roster row).
- **Agent-ready**: EDL validation errors carry a JSON pointer
  (`/main/elements/2/trimStart`), so an agent's read → transform → save loop
  self-corrects. Guide: [AGENT.md](AGENT.md).

## Quickstart

```sh
pnpm install                 # at the repo root (product + base share one workspace)
pnpm run build:openvideo     # generate the roster + build the page
pnpm run dev:openvideo       # host on http://127.0.0.1:3090 (serves the page)
```

For development, run them separately: `pnpm run host:openvideo` +
`pnpm --filter @openvideo/web dev` (Vite :5174, proxying to :3090).

Default identity: `bin=openvideo` · env prefix `OPENVIDEO_` · home
`~/.openvideo` (`media/` library, `projects/` documents). The product layer
defaults the port to **3090** (its bundle overrides the `server` row), so the
base host (`pnpm run host`, :3088) can run beside it.

Environment (all prefixed `OPENVIDEO_`, plus the environment-owned `PORT`):

| Variable | Purpose |
|---|---|
| `OPENVIDEO_HOME` | state dir (default `~/.openvideo`) |
| `OPENVIDEO_MEDIA_DIR` / `OPENVIDEO_PROJECT_DIR` | override library / project dirs |
| `OPENVIDEO_MAX_UPLOAD_BYTES` | one browser upload's ceiling (default 512 MB) |
| `OPENVIDEO_FFMPEG_PATH` | ffmpeg binary for proxy transcoding (default `ffmpeg` on PATH; when the probe finds none, proxies degrade with a coded error and everything else is unaffected) |
| `OPENVIDEO_LLM_KEY` / `OPENVIDEO_LLM_BASE` / `OPENVIDEO_LLM_MODEL` | the LLM behind "Ask for a change" (read by the base agent row) |
| `OPENVIDEO_STRICT_CAPABILITIES=1` | a lying manifest fails the boot |
| `OPENVIDEO_READONLY=1` | refuse every `mutates` method |

## Verification

```sh
pnpm run typecheck:openvideo        # host + client + test planes
pnpm run test:openvideo             # 9 suites: EDL / ops / split / captions / text layout / host integration / roster / i18n / store
pnpm run verify:openvideo:compose   # composition gate (base layer + product layer + client roster)
pnpm run build:openvideo            # the page build
pnpm run verify:openvideo           # smoke: boot the host, walk the whole RPC / data-plane / page surface
```

## Layout (and where each piece hooks into the base)

```
product/openvideo/
  packages/
    edl/           @openvideo/edl        pure: the EDL format + validation (JSON pointers)
                                         + the checked operation set + split/captions/
                                         textLayout/transcript + the derived timeline
    host/media/    @openvideo/host-media host capability `openvideo`: library + project
                                         shelf (files ARE the data), 16 api methods, one
                                         data-plane route per asset, 17 agent tools,
                                         manifest + health
    client/editor/ @openvideo/ui-editor  client capability: 6 panels (header status /
                                         projects / media / inspector / player / timeline),
                                         one store, every string in messages.ts
    bundle/app/    @openvideo/bundle-app host composition layer: insert the `openvideo`
                                         row + override `server` by id (port 3090)
    bundle/ui/     @openvideo/bundle-ui  browser roster: base registries → editor →
                                         shell last (title: OpenVideo)
  apps/
    cli/           @openvideo/cli        identity + thin entry (profile template:
                                         base bundle → product bundle)
    web/           @openvideo/web        Vite page (generated roster.generated.ts)
  scripts/         gen-client-roster.mjs (the product's own copy, as HANDOFF requires)
                   verify.mjs (smoke)
  tests/           the product's suites (vitest, own config)
```

Where the conventions land (against the root `AGENTS.md`):

- **Pixels/rendering live in the product layer**: preview and export are in the
  product's client package; `@mediabase/*` knows nothing about them.
- **A capability registers its own surface**: methods, routes, tools, manifest
  and health all register inside `@openvideo/host-media` — zero edits to the
  base server or shell.
- **Composition is data**: a new capability = a package + a bundle row; a page =
  a roster row; `verify:compose` and the boot pre-flight guard both.
- **Validate at the boundary**: params and results are schemas; an EDL refusal
  carries the JSON pointer; application errors are `RpcError` codes +
  `messageKey` (the client dictionary renders them).
- **Every side effect is a fiber effect**: the upload-session sweep and the
  per-asset route registrations live in `ctx.effect`.
- **i18n**: no string in a component; zh-CN and en in parallel; host errors
  localize by key (guarded by tests/i18n.test.ts).
- **Control plane ≠ data plane**: bytes travel over
  `GET /api/openvideo.asset.<id>`; uploads come in as chunks over the control
  plane (bound by the 1 MB frame cap).

## Boundaries (deliberate deltas from the upstream app)

| Upstream (Clawnify managed) | This product |
|---|---|
| MP4 export on the managed edit service | browser-side canvas + MediaRecorder, real time (draft-grade; container depends on the browser — Chromium usually webm, newer builds mp4). **Decoding is browser-dependent too**: unsupported codecs (HEVC/H.265…) are probed up front and refused loudly (library badge, stage overlay, export refusal) — never a silent black screen |
| Google Drive import | import by host path + browser upload (the local trust boundary) |
| managed transcription / footage analysis | `.vtt` transcript sidecars (attach what you have); `clean_up_clip` and autocut are not ported |
| the managed media service's transcode/HLS | **local ffmpeg proxy transcoding** (optional; probed by execution, coded degradation without ffmpeg) — one click makes a webm (VP9/Opus) proxy for anything the browser cannot decode; preview and export switch to it automatically, the original stays untouched |
| D1 + R2 storage | the filesystem: `~/.openvideo/media` + `projects` (the project document IS the JSON) |
| its own instruct LLM loop (OpenRouter) | the base `agent.run` over the same checked operations |
| Range requests on the data plane | base routes answer whole bodies; fine for local clips — point `OPENVIDEO_MEDIA_DIR` at fast storage for big footage |
| filmstrips / waveforms | not ported (the preview focuses on cut semantics) |

## Licensing

Product code is MIT (with the base). Ported portions come from
clawnify/OpenVideo (MIT) — attribution and licence text in
[NOTICE.md](NOTICE.md). The integration adds **no new third-party npm runtime
dependencies** — the base NOTICE.md is unchanged.
