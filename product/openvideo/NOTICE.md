# OpenVideo product notices

> The base's root `NOTICE.md` covers the base's own runtime dependencies (this
> product adds none — every dependency is a workspace link or already in the
> base tree). This file covers the product layer's derivations.

## Derived work

Portions of this product layer are derived from
[clawnify/OpenVideo](https://github.com/clawnify/OpenVideo), Copyright (c) 2025
Clawnify, licensed under the MIT License.

Exact provenance (the upstream snapshot every ported file was taken from):

- Repository: `https://github.com/clawnify/OpenVideo` (default branch `main`)
- Commit: `b30f75fd02c7cb3daed159e81d90f4efdc396348`
  ("Import from Google Drive through the Google Drive integration (#11)",
  committed 2026-09-22T16:03:06Z)
- Cloned for this integration on 2026-09-23; the reference checkout was
  deliberately NOT vendored — this table plus the "Derived from …" header in
  each ported source file is the provenance of record.
- Licence text: reproduced in full below; identical to the upstream `LICENSE`
  at that commit.

The derived files, and what each carries over:

| Here | From there | What carried over |
|---|---|---|
| `packages/edl/src/edl.ts` | `src/server/edl.ts` | the EDL document format, limits, and `validateEdl`'s JSON-pointer contract (re-implemented on `@mediabase/schema`; strictness walker added) |
| `packages/edl/src/split.ts` | `src/shared/split.ts` | clip-splitting semantics (play window vs trims) |
| `packages/edl/src/textLayout.ts` | `src/shared/textLayout.ts` | line wrapping / block height / fit-top math |
| `packages/edl/src/transcript.ts` | `src/shared/transcript.ts` | WebVTT parsing and caption chunking |
| `packages/edl/src/captions.ts` | `src/shared/captions.ts` | project-caption timeline and placement |
| `packages/edl/src/ops.ts` | `src/server/instruct.ts` | the checked operation set (`apply`) and `describeEdl` |
| `packages/edl/src/timeline.ts` | `src/client/edit.tsx` | `mainDur` / `mainSegments` placement math |
| `packages/client/editor/src/panels/*` | `src/client/edit.tsx` | preview/player scheme (master clock, stacked elements, drift-corrected seeks), projects-home and editor interactions — rebuilt for the base's panel contract (React 18, no Tailwind, no Clawnify platform deps) |
| `tests/{split,captions,textLayout}.test.ts` | `test/{split,captions,textLayout}.test.ts` | the ported expectations |
| `packages/client/theme/src/tokens.ts` (base repo, `studio` / `studio-light` skins) | `src/client/styles.css` | the warm-neutral palettes (dark + light), rose identity accent and ink-primary convention (color values only) |
| page component recipes (`apps/web/index.html`, `product/openvideo/apps/web/index.html`, `packages/client/editor/src/styles.css`) | `src/client/ui.tsx` + `src/client/styles.css` | button/field/card grammar (ink primary, ring-edged secondary, ghost row actions, inset-ring fields with a tinted focus glow, cards edged — never drop-shadowed), the type scale, and the track-category hues (video blue / text purple / audio orange) |

Everything else (the host capability, the composition layers, the store, the
export recorder, the rosters, the verify script) is original to this repo.

## MIT License (clawnify/OpenVideo)

```
MIT License

Copyright (c) 2025 Clawnify

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

None beyond the workspace: `@openvideo/*` and `@mediabase/*` links, plus the
React/Vite/cordis versions the base tree already pins. The root `NOTICE.md`
(`pnpm run notice`) remains the authority for distributed builds and is
unchanged by this product.
