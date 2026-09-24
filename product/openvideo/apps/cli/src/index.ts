// product/openvideo / apps/cli — host bootstrap.
//
// Thin entry, the same four jobs the base CLI does: state the identity, state
// the anchor, report what composed, and dispose on signals. Composition
// mechanism, --dump-config, drop-ins and flag parsing all live in
// `@mediabase/boot`. The product's ONLY composition decision is which bundle
// layers a fresh profile starts with: the base layer, then this product's.

import { fileURLToPath } from 'node:url'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import {
  describeBootFailure,
  launchFlags,
  runDumpConfig,
  runProfile,
  verifyComposedCapabilities,
  type BootIdentity,
  type ProfileTemplate,
} from '@mediabase/boot'
// Type-only: the registry services this entry announces are declared by the
// base capability packages; the imports keep this file compilable alone.
import type {} from '@mediabase/api'
import type {} from '@mediabase/log'
import type {} from '@mediabase/tools'
import { resolveIdentity } from './identity.ts'

/** Product root in dev: distIndex defaults and relative paths resolve from here. */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** This app's package.json — the installation anchor for bare row / bundle resolution. */
const ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** First boot writes these bundle layers into the profile — the product layer stacks AFTER the base. */
const TEMPLATES: Record<string, ProfileTemplate> = {
  web: { bundles: ['@mediabase/bundle-app', '@openvideo/bundle-app'] },
  headless: { bundles: ['@mediabase/bundle-app', '@openvideo/bundle-app'] },
}

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
  const identity = resolveIdentity(env)
  const strict = env[`${identity.envPrefix}STRICT_CAPABILITIES`] === '1'
  const flags = launchFlags(process.argv.slice(2), env, identity)

  if (flags.dump !== 'none') {
    await runDumpConfig(
      { profile: flags.profile, patchFiles: flags.patchFiles, root: ROOT, env, identity, anchor: ANCHOR, templates: TEMPLATES },
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
    templates: TEMPLATES,
  })
  announce(ctx, {
    组合: 'patch 层',
    profile: profile.name,
    layers: layerFiles.length,
    layerFiles,
    ...(pluginManifest === undefined ? {} : { 封闭运行时: pluginManifest }),
  }, strict, identity)
  installShutdown(ctx)
}

main().catch((e) => {
  console.error('[openvideo] boot failed:', describeBootFailure(e))
  process.exit(1)
})
