// Shared harness for host-level tests: boot the real CLI on a free port and talk
// to it over WS JSON-RPC / HTTP, exactly like a client would.
//
// The primitives (Rpc / expectError / waitFor / freePort / health / bootCliHost)
// live in @mediabase/test-host — the in-repo products' suites drive THEIR hosts
// through the same ones. This file adds only THIS repo's identity (cwd,
// MEDIABASE_HOME) and stays the import surface for the base suites.

import { fileURLToPath } from 'node:url'
import { bootCliHost, type BootedHost } from '@mediabase/test-host'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export { freePort, waitFor, health, Rpc, expectError } from '@mediabase/test-host'
export type { WireError, BootedHost } from '@mediabase/test-host'

/**
 * Spawn `apps/cli` and wait until /api/health answers (or throw with its log).
 *
 * `MEDIABASE_HOME` defaults to a throwaway directory: the default composition reads a
 * PROFILE (and creates it on first boot), and a test must never depend on — or write to —
 * the developer's own `~/.mediabase`. A caller that wants a profile of its own passes its
 * own home and keeps it.
 */
export async function bootHost(
  env: Record<string, string> = {},
  opts: { timeoutMs?: number; token?: string } = {},
): Promise<BootedHost> {
  return bootCliHost({
    cwd: ROOT,
    homeEnv: 'MEDIABASE_HOME',
    homePrefix: 'mediabase-host-home-',
    label: 'host',
    env,
    timeoutMs: opts.timeoutMs ?? 30_000,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  })
}
