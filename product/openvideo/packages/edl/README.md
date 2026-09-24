# @openvideo/edl

The OpenVideo project document — an **EDL (edit decision list)**: plain JSON,
one ordered main track, overlay and audio tracks, times in seconds, positions
as canvas fractions. A person edits it on the timeline; an agent reads and
changes the same document through the checked operation set.

Derived from [clawnify/OpenVideo](https://github.com/clawnify/OpenVideo) (MIT):
`src/server/edl.ts`, `src/shared/{split,captions,textLayout,transcript}.ts` and
the operation set from `src/server/instruct.ts`. Ported to the repo's schema
dialect (`@mediabase/schema`) and extended where the local product needs it
(`add_clip` / `add_audio` / `remove_audio` / `set_captions`; unknown keys are
refused with a JSON pointer, which the dialect does not enforce by itself).

Pure: no DOM, no Node APIs — it typechecks in both planes and runs in the
host, the browser and the test suite unchanged.

- `validateEdl(input)` → `{ edl }` or `{ invalid: { error, detail, path } }`
  where `path` is a JSON pointer like `/main/elements/2/trimStart` — the
  contract an agent's read → transform → save loop self-corrects against.
- `applyOp(draft, name, args)` — one checked operation over a draft.
- `OPS` — the operation surface declared once (params as schemas); the host
  registers each as an agent tool from this list.
- `mainSegments` / `activeOverlays` / `activeAudio` — the derived timeline the
  preview, the panels and the export all read, so they cannot drift.
- `splitClip`, `captionTimeline`, `wrapLines`… — the shared pure logic.
