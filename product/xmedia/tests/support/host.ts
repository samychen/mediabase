// The product's harness: the control-plane primitives come from
// @mediabase/test-host; this file only adds the product identity and points
// ENGINE_BIN at the Node-based fake engine (and STUDIO at the Node-based fake
// studio server) so the suites run without a C++ toolchain or python3. A real
// xmedia-bridge / hf_studio.py can be substituted with XMEDIA_ENGINE_BIN /
// XMEDIA_STUDIO_SCRIPT.

import { fileURLToPath } from 'node:url'
import { bootCliHost, freePort, type BootedHost } from '@mediabase/test-host'

export const PRODUCT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const FAKE_ENGINE = fileURLToPath(new URL('./fake-engine.mjs', import.meta.url))
export const FAKE_STUDIO = fileURLToPath(new URL('./fake-studio.mjs', import.meta.url))

export { freePort, waitFor, health, Rpc, expectError } from '@mediabase/test-host'
export type { WireError, BootedHost } from '@mediabase/test-host'

/**
 * Spawn the product CLI and wait until /api/health answers. XMEDIA_HOME is
 * always a throwaway directory unless the caller passes one explicitly. The
 * studio binds its own loopback port: a free one is allocated per boot unless
 * the caller pins XMEDIA_STUDIO_PORT (the fake studio receives it via --port).
 */
export async function bootXmedia(env: Record<string, string> = {}): Promise<BootedHost> {
  const studioPort = env.XMEDIA_STUDIO_PORT ?? String(await freePort())
  return bootCliHost({
    cwd: PRODUCT_ROOT,
    homeEnv: 'XMEDIA_HOME',
    homePrefix: 'xmedia-test-home-',
    label: 'xmedia',
    env: {
      XMEDIA_ENGINE_BIN: process.execPath,
      XMEDIA_ENGINE_ARGS: FAKE_ENGINE,
      XMEDIA_STUDIO_PYTHON: process.execPath,
      XMEDIA_STUDIO_SCRIPT: FAKE_STUDIO,
      XMEDIA_STUDIO_PORT: studioPort,
      XMEDIA_LOG_LEVEL: 'warn',
      ...env,
    },
  })
}
