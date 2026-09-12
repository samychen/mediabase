// @mediabase/boot — launcher flags (`--profile`, `--patch`, `--dump-config`).
//
// Identity-parameterized: the product passes its BootIdentity so `${prefix}PROFILE` and
// the default profile name resolve correctly without this package naming a product.

import type { CapabilityEnv } from '@mediabase/protocol'
import type { BootIdentity } from './identity.ts'

/**
 * Launcher flags, ahead of any app flags: `--profile <name>`, `--patch <file>`, and the
 * boot-free diagnostics `--dump-config` / `--dump-default-config`.
 */
export function launchFlags(
  argv: readonly string[],
  env: CapabilityEnv,
  identity: BootIdentity,
): {
  profile: string
  patchFiles: string[]
  dump: 'none' | 'composed' | 'bundles-only'
} {
  let profile = env[`${identity.envPrefix}PROFILE`] ?? identity.defaultProfile
  const patchFiles: string[] = []
  let dump: 'none' | 'composed' | 'bundles-only' = 'none'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--profile' && argv[i + 1] !== undefined) {
      profile = argv[i + 1]!
      i++
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else if (arg === '--patch' && argv[i + 1] !== undefined) {
      patchFiles.push(argv[i + 1]!)
      i++
    } else if (arg.startsWith('--patch=')) {
      patchFiles.push(arg.slice('--patch='.length))
    } else if (arg === '--dump-config') {
      dump = dump === 'bundles-only' ? 'bundles-only' : 'composed'
    } else if (arg === '--dump-default-config') {
      dump = 'bundles-only'
    }
  }
  return { profile, patchFiles, dump }
}
