// product/openvideo / apps/cli — boot identity: the ONE place this product's
// vocabulary is decided. Shared boot logic lives in `@mediabase/boot`; this
// file only states OpenVideo's defaults so the CLI (and tests) can pass them
// in — the base never spells the product, and the product never forks
// profile-boot.

import type { CapabilityEnv } from '@mediabase/protocol'
import { resolveIdentity as resolveBootIdentity, type BootIdentity } from '@mediabase/boot'

export type { BootIdentity }

export const IDENTITY: BootIdentity = {
  bin: 'openvideo',
  envPrefix: 'OPENVIDEO_',
  homeDir: '.openvideo',
  defaultProfile: 'web',
  profileKey: 'openvideo',
}

/** Honour `${prefix}ENV_PREFIX` against the product's defaults. */
export function resolveIdentity(env: CapabilityEnv, base: BootIdentity = IDENTITY): BootIdentity {
  return resolveBootIdentity(env, base)
}

/** Diagnostic prefix for this product. */
export const BIN = IDENTITY.bin
