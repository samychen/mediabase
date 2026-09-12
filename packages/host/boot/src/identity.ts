// @mediabase/boot — boot identity types and resolution.
//
// The product (or this repo's CLI) supplies a BootIdentity at the entrypoint. This module
// never hardcodes a name or env prefix: callers pass their identity, and `resolveIdentity`
// only honour `${prefix}ENV_PREFIX` overrides.

import type { CapabilityEnv } from '@mediabase/protocol'

/** Everything a product changes about how the base boots. */
export interface BootIdentity {
  /** Diagnostic prefix and default name (`mediabase`, `avstudio`). */
  bin: string
  /** Environment vocabulary prefix, including the trailing underscore. */
  envPrefix: string
  /** State directory under `$HOME` (`~/.mediabase`, `~/.avstudio`). */
  homeDir: string
  /** Profile used when neither `--profile` nor the environment names one. */
  defaultProfile: string
  /**
   * package.json nesting key for profile manifests (`mediabase.profile.bundles` or
   * `avstudio.profile.bundles`). One host, one key — never dual-read.
   */
  profileKey: string
}

/**
 * The identity in force, honouring `${prefix}ENV_PREFIX`.
 *
 * The override replaces the prefix WHOLESALE (tests / embedding), so the host still has
 * exactly one vocabulary. `base` is required: this package never invents a product name.
 */
export function resolveIdentity(env: CapabilityEnv, base: BootIdentity): BootIdentity {
  const override = env[`${base.envPrefix}ENV_PREFIX`]
  return override === undefined || override === ''
    ? base
    : { ...base, envPrefix: override.endsWith('_') ? override : `${override}_` }
}
