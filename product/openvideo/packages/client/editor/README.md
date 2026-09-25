# @openvideo/ui-editor

Client capability: the OpenVideo editor panels. Derived from the client half
of [clawnify/OpenVideo](https://github.com/clawnify/OpenVideo) (MIT), rebuilt
for this base's panel contract — five panels registered into `ctx.ui` (the
shell renders them by AREA; no shell edit), every string in `messages.ts`
(zh-CN + en), host calls over `ctx.rpc`, asset bytes pulled from the
capability's data-plane routes. The projects home screen and the four-pane
grid live in the product's own shell, `@openvideo/ui-shell`.

- `status` (header): save state + the last gesture's outcome.
- `media` (sidebar / left rail): chunked browser upload, import by host path,
  fetch a network URL, transcript sidecars, proxy transcoding, add-to-track.
- `player` (monitor / center): the master-clock preview (stacked
  `<video>`/`<img>`/DOM layers, drift-corrected seeks — the upstream scheme)
  + the browser-side export (canvas + MediaRecorder).
- `inspector` (right): the selected element's fields, or the project itself —
  identity, output shape, captions, the EDL JSON, media relink, and "Ask for
  a change" (the base `agent.run` over the checked `openvideo.*` tools).
- `timeline` (bottom): main-track chips in play order (drag/chevrons to
  reorder, split, trim via inspector), overlay and audio lanes,
  click-to-seek ruler.

One observable store (`src/store.ts`) behind all panels: debounced saves,
whole-document undo steps, adoption of host-saved documents. Panels read it
through `ctx.get('openvideoEditor')`; the base `view` contract
(`@mediabase/ui`) is provided while a project is open.
