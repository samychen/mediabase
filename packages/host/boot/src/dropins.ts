// @mediabase/boot — drop-in capabilities.
//
// A capability is installed by putting a file in a directory
// (`${envPrefix}CAPABILITY_DIR`, colon-separated): no host edit, same registries, same
// manifest verification as the built-ins.

import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CapabilityEnv } from '@mediabase/protocol'

/** One discovered module, with the identity its host registration will carry. */
export interface DropInCapability {
  /** `name` from the module (the id the manifest and CLI report), else the file name. */
  id: string
  /** Absolute path of the module file. */
  path: string
  /** The imported module (or its default export) — proven to have `apply()`. */
  plugin: unknown
}

/**
 * Discover every `*.mjs|*.cjs|*.js` module in the configured directories (`${envPrefix}CAPABILITY_DIR`),
 * in file-name order so the mount order is stable across machines.
 *
 * A missing directory is not an error (nothing to discover). A module that is not a
 * Cordis plugin IS: loading it would add a row that mounts nothing, which is exactly the
 * silent failure the manifest verification exists to prevent.
 */
export async function discoverCapabilities(env: CapabilityEnv, envPrefix: string): Promise<DropInCapability[]> {
  const dirs = (env[`${envPrefix}CAPABILITY_DIR`] ?? '').split(':').filter(Boolean)
  const found: DropInCapability[] = []
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await readdir(resolve(dir))
    } catch {
      continue // a missing directory is not an error: nothing to discover
    }
    for (const entry of entries.filter((e) => /\.(mjs|cjs|js)$/.test(e)).sort()) {
      const path = resolve(join(dir, entry))
      const mod = (await import(pathToFileURL(path).href)) as { name?: string; apply?: unknown; default?: unknown }
      const plugin = typeof mod.apply === 'function' ? mod : (mod.default as { apply?: unknown } | undefined)
      if (!plugin || typeof (plugin as { apply?: unknown }).apply !== 'function') {
        throw new Error(`capability module has no apply(): ${path}`)
      }
      found.push({ id: (plugin as { name?: string }).name ?? entry, path, plugin })
    }
  }
  return found
}
