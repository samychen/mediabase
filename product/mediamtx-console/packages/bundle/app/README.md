# @mtxconsole/bundle-app

The console's HOST composition layer, stacked AFTER `@mediabase/bundle-app`
(the profile's bundle order says so). Two moves, both data:

1. `insert` the `mediamtx` row (`@mtxconsole/host-bridge`) with its env-driven
   config — rows use SHORT names (`SERVER_URL`, `USERNAME`, `PASSWORD`,
   `TIMEOUT_MS`); the identity prefix `MTXCONSOLE_` is applied by the boot
   layer;
2. restate the base `server` row with the default port moved to **3091**, so a
   base host (:3088), the OpenVideo host (:3090) and this console (:3091) run
   side by side. A patch replaces the WHOLE config of its target row, hence
   the restatement — still overridable by the environment's own `PORT`.

`pnpm run verify:mtxconsole:compose` gates this file (bare package names must
be dependencies of this bundle, `!!js` only inside config, overridden ids must
exist).
