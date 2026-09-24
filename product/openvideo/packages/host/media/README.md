# @openvideo/host-media

Host capability `openvideo`: the media library and the project shelf behind
the OpenVideo editor. Derived from the server half of
[clawnify/OpenVideo](https://github.com/clawnify/OpenVideo) (MIT) — its REST
API (`/api/assets`, `/api/projects`) reborn as mediabase registries:

- **Methods** (`ctx.api`, `openvideo.*`): assets list / import-by-path /
  chunked browser upload / duration probe / transcript sidecar / remove
  (refused with a CONFLICT naming the projects while one still references the
  asset), projects list / get / create / update (EDL validated on save; a
  refusal carries the JSON pointer) / remove / **op** (one checked operation,
  one save, one undo).
- **Data plane** (`ctx.api.route`): `GET /api/openvideo.asset.<id>` serves the
  bytes with the asset's content type. One route per asset, registered when
  the asset lands, disposed when it dies — the gateway resolves routes per
  request, so late assets are immediately playable.
- **Agent tools** (`ctx.tools`): the five CRUD tools plus one tool per checked
  operation from `@openvideo/edl` (`OPS`). "Ask for a change" and any
  `agent.run` prompt act through these — the model calls fixed, checked
  operations; it never writes the document blind.
- **Manifest** (`ctx.capabilities`): exactly the methods and tools above, so
  `${prefix}STRICT_CAPABILITIES=1` audits the claim at boot.
- **Health**: asset/project/upload counts merged into `GET /api/health`.

Storage is plain files under the identity home (`~/.openvideo` by default):
`media/<assetId><ext>` + `media/assets.json` + `media/transcripts/<id>.vtt`,
`projects/<projectId>.json` (the EDL document itself — the same JSON a person
edits on the timeline and an agent edits through the tools). Writes are atomic
(tmp + rename).

**Not ported** (managed-service dependencies of the upstream app, replaced by
local seams): Google Drive import, hosted HLS media/transcription/analysis,
and the hosted MP4 export — export runs in the browser instead (see
`@openvideo/ui-editor`).
