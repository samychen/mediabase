// product/xmedia / apps/cli — boot identity: the ONE place this product's
// vocabulary is decided. Shared boot logic lives in @mediabase/boot; this file
// only states xmedia's defaults so the CLI (and tests) can pass them in.

import type { CapabilityEnv } from '@mediabase/protocol'
import { resolveIdentity as resolveBootIdentity, type BootIdentity } from '@mediabase/boot'

export type { BootIdentity }

const IDENTITY: BootIdentity = {
  bin: 'xmedia',
  envPrefix: 'XMEDIA_',
  homeDir: '.xmedia',
  defaultProfile: 'web',
  profileKey: 'xmedia',
}

/** Honour `${prefix}ENV_PREFIX` against the product's defaults. */
export function resolveIdentity(env: CapabilityEnv, base: BootIdentity = IDENTITY): BootIdentity {
  return resolveBootIdentity(env, base)
}
