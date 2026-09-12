// @mediabase/boot — `--dump-config`: print the composition WITHOUT booting it.
//
// Why it exists: a composition is patch layers, and "which layer put this row here, and what
// did it end up saying?" is the question every deployment debugging session starts with. A
// boot answers it only by running the thing; this answers it from the files alone.
//
// What it deliberately does NOT do — the same choice deepseek-harness makes — is evaluate
// `!!js`: the dump prints the layer-by-layer result of the include's OWN patch algorithm
// (`applyEntryPatches`, the function a boot mounts through), so a `deployment value` shows up
// as the expression it is, not as one machine's environment. It also never imports a
// capability, so it works on a composition whose packages are not installed yet.
//
// Output is the dialect the include mounts and can round-trip: pipe a dump back into
// `cordis.patch.yml` (or `--patch`) and you get the tree it printed.

import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { planComposition, type CompositionLayer, type RunProfileOptions } from './profile-boot.ts'

/** Where a composed row came from, and which later layers rewrote it. */
interface Provenance {
  origin: string
  patchedBy: string[]
}

/**
 * Compose the layers the way a boot does, snapshotting after each one.
 *
 * A snapshot after layer k is `applyEntryPatches(root, layers[1..k])` — the exact call the
 * include makes when it mounts — and comparing consecutive snapshots is what yields the
 * provenance comments. Patches are deep-cloned per call because the include pushes `insert`
 * rows BY REFERENCE, so a shared list would let a later snapshot mutate an earlier one.
 */
function composeWithProvenance(
  root: EntryOptions[],
  layers: readonly CompositionLayer[],
  bin: string,
  warn: (line: string) => void,
): { composed: EntryOptions[]; provenance: Provenance[] } {
  const provenance: Provenance[] = root.map(() => ({ origin: 'cordis.yml (空根)', patchedBy: [] }))
  let previous: EntryOptions[] = root
  let previousWarnings = 0
  let composed: EntryOptions[] = root

  for (let count = 1; count <= layers.length; count += 1) {
    const layer = layers[count - 1]!
    const warnings: string[] = []
    // One application of layers 1..k — the PREFIX, not just this layer. Applying a single
    // layer to the root would drop everything the earlier layers inserted (measured: an empty
    // user layer reset an eleven-row tree back to the anchor).
    const flattened = structuredClone(layers.slice(0, count).flatMap((item) => item.patches)) as PatchOptions[]
    composed = applyEntryPatches(structuredClone(root) as EntryOptions[], flattened, (message, ...args) => {
      // The include logs through cordis's printf-style logger (`%C` = code); a dump has no
      // logger, so substitute inline for a line a person can read.
      let index = 0
      warnings.push(String(message).replace(/%C/g, () => JSON.stringify(args[index++])))
    })
    for (const line of warnings.slice(previousWarnings)) warn(`${bin}: [${layer.label}] ${line}`)
    previousWarnings = warnings.length

    const before = previous.map((entry) => JSON.stringify(entry))
    for (let index = 0; index < composed.length; index += 1) {
      if (index >= before.length) provenance.push({ origin: layer.label, patchedBy: [] })
      else if (JSON.stringify(composed[index]) !== before[index]) provenance[index]?.patchedBy.push(layer.label)
    }
    previous = composed
  }
  return { composed, provenance }
}

/** Render the composed rows, grouped under one provenance comment per contiguous run. */
function renderRows(composed: readonly EntryOptions[], provenance: readonly Provenance[]): string {
  const lines: string[] = []
  let currentLabel: string | undefined
  let group: EntryOptions[] = []
  const flush = (): void => {
    if (currentLabel === undefined || group.length === 0) return
    lines.push(`# == ${currentLabel}`)
    lines.push(yaml.dump(group, { schema: entryListSchema, noRefs: true }).trimEnd())
    group = []
  }
  for (let index = 0; index < composed.length; index += 1) {
    const record = provenance[index]
    if (record === undefined) continue
    const label = record.patchedBy.length === 0
      ? record.origin
      : `${record.origin}, patched by ${record.patchedBy.join(', ')}`
    if (label !== currentLabel) {
      flush()
      currentLabel = label
    }
    group.push(composed[index]!)
  }
  flush()
  return `${lines.join('\n')}\n`
}

/**
 * Print a profile's composition to stdout and return (the caller exits 0).
 *
 * `bundlesOnly` is the recovery diagnostic (`--dump-default-config`): the profile's own
 * layer, the machine-local layer, the overlays and the drop-ins are never even parsed, so a
 * broken user layer cannot stop the dump that would explain it.
 */
export async function runDumpConfig(
  options: RunProfileOptions,
  { bundlesOnly = false, stdout = process.stdout, stderr = process.stderr } = {},
): Promise<void> {
  const bin = options.identity.bin
  const plan = await planComposition(options, { bundlesOnly })
  // The root the include mounts is an empty list; the dump anchors on the same file so the
  // two read the composition the same way.
  // The include's own root is an empty list; the dump shows it as a comment-only anchor row
  // so the reader sees where the tree was mounted from.
  const root = [{ id: 'include', name: 'cordis:include', config: { path: plan.rootConfigPath } }] as EntryOptions[]
  const { composed, provenance } = composeWithProvenance(
    root,
    plan.layers,
    bin,
    (line) => void stderr.write(`${line}\n`),
  )
  const header = [
    `# ${bin} --dump-config — ${plan.profile.name} profile${bundlesOnly ? ' (bundles only)' : ''}`,
    `# layers: ${plan.layers.length}`,
    ...plan.layers.map((layer, index) => `#   ${index + 1}. ${layer.label}`),
    `# ${plan.mountPatches === plan.patches ? 'no closed runtime (bare names resolve from the installation)' : 'closed runtime in use: bundled modules substituted for bare names'}`,
    '',
  ]
  stdout.write(`${header.join('\n')}\n`)
  stdout.write(renderRows(composed, provenance))
}

/** Read a dump back: the dialect round-trips, so a dump is also a valid patch file. */
export function loadDump(file: string, bin: string): EntryOptions[] {
  const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`${bin}: ${file} 不是 dump 出来的条目数组`)
  return parsed as EntryOptions[]
}
