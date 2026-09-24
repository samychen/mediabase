# @openvideo/bundle-app

The product's HOST composition layer, stacked after `@mediabase/bundle-app`
(the profile template in `@openvideo/cli` states that order). It inserts the
`openvideo` capability row and overrides the base `server` row BY ID — a patch
replaces the whole config, so every field is restated; only the default port
differs (3090, so a base host on 3088 can run beside the product).

Rows resolve from THIS manifest (`@openvideo/host-media` is its dependency);
`pnpm run verify:openvideo:compose` checks the layer statically, and the boot
pre-flight repeats the check at mount time.
