// mediabase / apps/cli — boot identity: the ONE place THIS product's vocabulary is decided.
//
// Shared boot logic lives in `@mediabase/boot`. This file only states mediabase's defaults
// so the CLI (and tests) can pass them in.

import type { CapabilityEnv } from '@mediabase/protocol'
import { resolveIdentity as resolveBootIdentity, type BootIdentity } from '@mediabase/boot'

export type { BootIdentity }

/** This repository's identity when run as the neutral base. */
export const IDENTITY: BootIdentity = {
  bin: 'mediabase',
  envPrefix: 'MEDIABASE_',
  homeDir: '.mediabase',
  defaultProfile: 'web',
  profileKey: 'mediabase',
}

/** Honour `${prefix}ENV_PREFIX` against mediabase's defaults. */
export function resolveIdentity(env: CapabilityEnv, base: BootIdentity = IDENTITY): BootIdentity {
  return resolveBootIdentity(env, base)
}

/** Diagnostic prefix for this product (kept as a named export for local messages). */
export const BIN = IDENTITY.bin
