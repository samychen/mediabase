// @mediabase/boot — shared host boot surface.
//
// Products import this package and pass their own BootIdentity (+ installation anchor).
// This repo's CLI keeps a local IDENTITY and is otherwise a thin wrapper.

export type { BootIdentity } from './identity.ts'
export { resolveIdentity } from './identity.ts'

export type { DropInCapability } from './dropins.ts'
export { discoverCapabilities } from './dropins.ts'

export { launchFlags } from './flags.ts'
export { verifyComposedCapabilities } from './verify-capabilities.ts'
export { runDumpConfig, loadDump } from './dump-config.ts'

export {
  PROFILES_DIR,
  PROFILE_ROOT_FILENAME,
  PROFILE_PATCH_FILENAME,
  HOME_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  deploymentEnv,
  resolveHome,
  resolveProfileDir,
  initProfile,
  loadPatches,
  resolveBundleDir,
  bundledBundleDirs,
  loadProfile,
  insertedRows,
  assertEntriesLoaded,
  assertEntriesActivated,
  describeBootFailure,
  resolveRowSpecifiers,
  loadPluginManifest,
  absolutizeRowSpecifiers,
  applyPluginManifest,
  planComposition,
  runProfile,
} from './profile-boot.ts'

export type {
  DeploymentEnv,
  ProfileTemplate,
  BundleLayer,
  Profile,
  RunProfileOptions,
  BootedProfile,
  PluginManifest,
  CompositionLayer,
  CompositionPlan,
} from './profile-boot.ts'
