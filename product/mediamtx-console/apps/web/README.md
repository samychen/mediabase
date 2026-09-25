# @mtxconsole/web

The console page (Vite): boots a client cordis context and composes the
product's browser roster from `roster.generated.ts` — generated from
`@mtxconsole/bundle-ui`'s `client.yml` by
`product/mediamtx-console/scripts/gen-client-roster.mjs` (the roster is data;
the generated file is checked by `tests/roster.test.ts`). The built `dist/` is
served by the console host on :3091; `vite dev` (:5175) proxies `/rpc` and
`/api` to it.
