# @openvideo/bundle-ui

The product's BROWSER roster: the base registries (connection → i18n → ui),
the editor panels (`@openvideo/ui-editor`), and the shell LAST
(`@mediabase/ui-web`, titled "OpenVideo" through its row config — branding is
data, not code). `product/openvideo/scripts/gen-client-roster.mjs` turns this
file into `apps/web/src/roster.generated.ts`; `tests/roster.test.ts` fails when
the generated file is stale.
