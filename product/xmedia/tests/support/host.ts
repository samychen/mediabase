// The product's harness: the control-plane primitives come from
// @mediabase/test-host; this file only adds the product identity and points
// ENGINE_BIN at the Node-based fake engine so the suites run without a C++
// toolchain. A real xmedia-bridge can be substituted with XMEDIA_ENGINE_BIN.

import { fileURLToPath } from 'node:url'
import { bootCliHost, type BootedHost } from '@mediabase/test-host'

export const PRODUCT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const FAKE_ENGINE = fileURLToPath(new URL('./fake-engine.mjs', import.meta.url))

export { freePort, waitFor, health, Rpc, expectError } from '@mediabase/test-host'
export type { WireError, BootedHost } from '@mediabase/test-host'

/**
 * Spawn the product CLI and wait until /api/health answers. XMEDIA_HOME is
 * always a throwaway directory unless the caller passes one explicitly.
 */
export function bootXmedia(env: Record<string, string> = {}): Promise<BootedHost> {
  return bootCliHost({
    cwd: PRODUCT_ROOT,
    homeEnv: 'XMEDIA_HOME',
    homePrefix: 'xmedia-test-home-',
    label: 'xmedia',
    env: {
      XMEDIA_ENGINE_BIN: process.execPath,
      XMEDIA_ENGINE_ARGS: FAKE_ENGINE,
      XMEDIA_LOG_LEVEL: 'warn',
      ...env,
    },
  })
}
