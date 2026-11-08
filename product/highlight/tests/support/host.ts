// The product's harness: the control-plane primitives come from
// @mediabase/test-host; this file only adds the product identity and points the
// engine at the Node-based fake bridge so the suites run without Python or
// FFmpeg. The real bridge is exercised by scripts/verify.mjs when python3 and
// ffmpeg are present.

import { fileURLToPath } from 'node:url'
import { bootCliHost, type BootedHost } from '@mediabase/test-host'

export const PRODUCT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const FAKE_BRIDGE = fileURLToPath(new URL('./fake-bridge.mjs', import.meta.url))

export { freePort, waitFor, health, Rpc, expectError } from '@mediabase/test-host'
export type { WireError, BootedHost } from '@mediabase/test-host'

/**
 * Spawn the product CLI and wait until /api/health answers. VHL_HOME is always a
 * throwaway directory unless the caller passes one explicitly.
 *
 * `VHL_PYTHON=process.execPath` + `VHL_ENGINE_SCRIPT=fake-bridge.mjs` is the
 * seam: the capability spawns whatever interpreter/script pair it is told, so a
 * Node double speaks the same protocol with no Python on the machine.
 */
export function bootHighlight(env: Record<string, string> = {}): Promise<BootedHost> {
  return bootCliHost({
    cwd: PRODUCT_ROOT,
    homeEnv: 'VHL_HOME',
    homePrefix: 'vhl-test-home-',
    label: 'vhl',
    env: {
      VHL_PYTHON: process.execPath,
      VHL_ENGINE_SCRIPT: FAKE_BRIDGE,
      VHL_LOG_LEVEL: 'warn',
      ...env,
    },
  })
}
