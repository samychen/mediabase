# @openvideo/ui-editor

Client capability: the OpenVideo editor panels. Derived from the client half
of [clawnify/OpenVideo](https://github.com/clawnify/OpenVideo) (MIT), rebuilt
for this base's panel contract — six panels registered into `ctx.ui` (the
shell renders them; no shell edit), every string in `messages.ts` (zh-CN + en),
host calls over `ctx.rpc`, asset bytes pulled from the capability's data-plane
routes.

- `status` (header): save state + the last gesture's outcome.
- `projects` (sidebar): create / open / delete — a project is a plain-JSON
  EDL document on the host.
- `media` (sidebar): chunked browser upload, import by host path, transcript
  sidecars, add-to-track.
- `player` (monitor): the master-clock preview (stacked `<video>`/`<img>`/DOM
  layers, drift-corrected seeks — the upstream scheme) + the browser-side
  export (canvas + MediaRecorder).
- `timeline` (monitor): main-track chips in play order (drag/◀▶ to reorder,
  ✂ split, trim via inspector), overlay and audio lanes, click-to-seek ruler.
- `inspector` (sidebar): the selected element's fields, or the project itself
  — identity, output shape, captions, the EDL JSON, and "Ask for a change"
  (the base `agent.run` over the checked `openvideo.*` tools).

One observable store (`src/store.ts`) behind all panels: debounced saves,
whole-document undo steps, adoption of host-saved documents. Panels read it
through `ctx.get('openvideoEditor')`; the base `view` contract
(`@mediabase/ui`) is provided while a project is open.
