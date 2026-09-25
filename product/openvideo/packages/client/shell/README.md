# @openvideo/ui-shell

The product's own shell — the roster's shell slot is DATA (the bundle manifest
names it), so OpenVideo ships its editor-shaped chrome without the base
knowing. Layout derived from clawnify/OpenVideo `src/client/edit.tsx` (MIT):

- **Projects home screen**: cards with 16:9 covers (the first main-track clip's
  frame via the assets sidecar + `#t=` media fragment), create/open/delete,
  and the empty state OUTSIDE any card ("an empty card reads as broken").
- **Four-region editor grid**: slim top bar (back · project name · header
  panels incl. status + theme picker), left rail (`sidebar` area), center
  player (`monitor`), right inspector (`right`), full-width timeline
  (`bottom`). Panels flow in from `ctx.ui` BY AREA — the shell names no
  capability; each pane is wrapped in an error boundary.

Same contract as `@mediabase/ui-web`: inject `['ui','i18n']`, brand via row
config (`title`), strings in `messages.ts` (zh-CN + en), colors from the
design tokens (any `@mediabase/theme` skin applies).
