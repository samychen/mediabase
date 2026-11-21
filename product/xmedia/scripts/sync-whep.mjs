// Mirrors the shared WHEP client into xmedia's static web root.
//
// The browser can only load modules served from the host's distRoot
// (apps/web/dist), but the real source of truth lives at libs/whep/whep.js so
// any product can import it too. This script copies the canonical file
// verbatim into dist/; verify.mjs asserts the two stay byte-identical.
//
// Run: pnpm run sync:whep   (after editing libs/whep/whep.js)

import { copyFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// scripts -> xmedia -> product -> repo root (mediabase)
const root = resolve(here, '..', '..', '..')
const src = resolve(root, 'libs', 'whep', 'whep.js')
const dest = resolve(root, 'product', 'xmedia', 'apps', 'web', 'dist', 'whep.js')

try {
  await access(src)
} catch {
  console.error(`cannot find canonical WHEP module at ${src}`)
  process.exit(1)
}

await copyFile(src, dest)
console.log(`synced ${src}\n    -> ${dest}`)
