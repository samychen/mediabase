# @mtxconsole/bundle-ui

The console's browser roster (mount order), as DATA: base registries first
(`connection` → `i18n` → `ui`), the theme, then the product's panels
(`@mtxconsole/ui-console`), and the SHELL LAST — it mounts React and renders
whatever `ctx.ui` holds by then.

This product needs no custom shell: the base `@mediabase/ui-web` already
renders the header/sidebar/monitor/bottom areas and takes its branding from
the roster row (`title: MediaMTX Console` — branding is data). The manifest's
`mediabase.uiBundle` block names the roster file and the shell for the
composition gates.

`product/mediamtx-console/scripts/gen-client-roster.mjs` turns `client.yml`
into `apps/web/src/roster.generated.ts` (a browser bundle needs static
imports); `tests/roster.test.ts` fails when the generated file is stale or the
shell is not last.
