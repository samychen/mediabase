# @openvideo/web

The product page: a Vite app that mounts the generated CLIENT ROSTER
(`src/roster.generated.ts`, from `@openvideo/bundle-ui`) and nothing else —
the same shape as the base's `apps/web`. `dist/` is served by the product host
(the server row's `distIndex` default resolves under the product root);
`vite dev` proxies `/rpc` + `/api` to :3090.
