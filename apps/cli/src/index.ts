// mediabase / apps/cli — host bootstrap (Mode B)
//
// Thin entry: discover deployment knowledge, pass this product's IDENTITY into
// `@mediabase/boot`, enforce capability manifests, dispose on SIGINT/SIGTERM.
// Composition mechanism, dump-config, drop-ins and flag parsing live in the boot package.

import { fileURLToPath } from 'node:url'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import {
  describeBootFailure,
  launchFlags,
  runDumpConfig,
  runProfile,
  verifyComposedCapabilities,
  type BootIdentity,
} from '@mediabase/boot'
import { resolveIdentity } from './identity.ts'

/** Repo root in dev; the packaged app overrides every path via MEDIABASE_*. */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** This app's package.json — the installation anchor for bare row / bundle resolution. */
const ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** Report what composed, then enforce the manifests (strict mode refuses to serve). */
function announce(
  ctx: CordisContext,
  detail: Record<string, unknown>,
  strict: boolean,
  identity: BootIdentity,
): void {
  const caps = ctx.capabilities.list()
  ctx.log.info(`已组合 ${ctx.api.list().length > 0 ? '能力' : '空'}树(其中 ${caps.length} 个登记 manifest)`, {
    api: ctx.api.list().length,
    tools: ctx.tools.list().length,
    ...detail,
  })
  verifyComposedCapabilities(ctx, strict, identity.envPrefix)
}

/** Graceful shutdown: dispose the whole tree (root fiber), which owns every effect. */
function installShutdown(ctx: CordisContext): void {
  let stopping = false
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    ctx.log.info(`收到 ${signal},正在销毁插件树…`)
    await ctx.fiber.dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
}

async function main(): Promise<void> {
  const env = process.env
  // One identity decides the prefix, the home directory and the name; `${prefix}ENV_PREFIX`
  // can replace the vocabulary wholesale (tests, embedding).
  const identity = resolveIdentity(env)
  const strict = env[`${identity.envPrefix}STRICT_CAPABILITIES`] === '1'
  const flags = launchFlags(process.argv.slice(2), env, identity)

  // A dump answers "what would boot" from the files alone: nothing is mounted, no capability
  // is imported, no `!!js` is evaluated, and no port is bound.
  if (flags.dump !== 'none') {
    await runDumpConfig(
      { profile: flags.profile, patchFiles: flags.patchFiles, root: ROOT, env, identity, anchor: ANCHOR },
      { bundlesOnly: flags.dump === 'bundles-only' },
    )
    return
  }

  const { ctx, profile, layerFiles, pluginManifest } = await runProfile({
    profile: flags.profile,
    patchFiles: flags.patchFiles,
    root: ROOT,
    env,
    identity,
    anchor: ANCHOR,
  })
  announce(ctx, {
    组合: 'patch 层',
    profile: profile.name,
    layers: layerFiles.length,
    layerFiles,
    // A single-file host composes from its own bundled modules; say so, because "which
    // code is running" is exactly what a packaged host must be able to answer.
    ...(pluginManifest === undefined ? {} : { 封闭运行时: pluginManifest }),
  }, strict, identity)
  installShutdown(ctx)
}

main().catch((e) => {
  // Last resort before ctx.log is ready (or after a strict-verify refusal).
  console.error('[mediabase] boot failed:', describeBootFailure(e))
  process.exit(1)
})
