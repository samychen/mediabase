// The product's harness: the control-plane primitives (Rpc / expectError /
// waitFor / freePort / health / bootCliHost) are the shared @mediabase/test-host
// ones; this file adds only the product identity — OPENVIDEO_HOME, product entry
// cwd.

import { fileURLToPath } from 'node:url'
import { bootCliHost, type BootedHost } from '@mediabase/test-host'

export const PRODUCT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export { freePort, waitFor, health, Rpc, expectError } from '@mediabase/test-host'
export type { WireError, BootedHost } from '@mediabase/test-host'

/**
 * Spawn the product CLI and wait until /api/health answers. OPENVIDEO_HOME is
 * always a throwaway directory: a test must never touch the developer's own
 * ~/.openvideo.
 */
export function bootOpenvideo(env: Record<string, string> = {}): Promise<BootedHost> {
  return bootCliHost({
    cwd: PRODUCT_ROOT,
    homeEnv: 'OPENVIDEO_HOME',
    homePrefix: 'openvideo-test-home-',
    label: 'openvideo',
    env,
  })
}
