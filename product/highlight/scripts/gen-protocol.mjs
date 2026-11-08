// gen-protocol.mjs — generate engine/protocol_generated.py from protocol/contract.json.
//
// The contract is the single source of truth. The TypeScript side imports the
// JSON directly; Python cannot (a packaged engine may run outside the product
// tree), so it gets a GENERATED module that is committed and used as the
// fallback when the JSON is absent. `--check` fails when the committed file is
// stale, so a contract edit that forgets to regenerate fails CI instead of
// surfacing as a mystifying "unknown verb" at runtime.
//
// Usage:  node scripts/gen-protocol.mjs            # write
//         node scripts/gen-protocol.mjs --check    # verify only

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONTRACT = `${ROOT}protocol/contract.json`
const OUT = `${ROOT}engine/protocol_generated.py`

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
const verbs = Object.entries(contract.verbs)

function pyLiteral(value) {
  return JSON.stringify(value)
    .replaceAll('true', 'True')
    .replaceAll('false', 'False')
    .replaceAll('null', 'None')
}

const rows = verbs
  .map(([verb, def]) => {
    const request = `[${def.request.map((c) => pyLiteral(c)).join(', ')}]`
    const response = `[${def.response.map((c) => pyLiteral(c)).join(', ')}]`
    return `    ${pyLiteral(verb)}: {"framing": ${pyLiteral(def.framing)}, "request": ${request}, "response": ${response}},`
  })
  .join('\n')

// Options are generated too, for the same reason as verbs: the bridge must
// reject an unknown knob even when it runs outside the product tree, and two
// hand-maintained knob tables is exactly the drift this file exists to prevent.
const optionEntries = Object.entries(contract.options ?? {}).filter(([key]) => !key.startsWith('comment'))
const optionRows = optionEntries
  .map(([key, def]) => `    ${pyLiteral(key)}: (${pyLiteral(def.field)}, ${pyLiteral(def.type)}),`)
  .join('\n')
const metaRows = optionEntries
  .map(([key, def]) => `    ${pyLiteral(key)}: ${pyLiteral(def)},`)
  .join('\n')

const rendered = `"""
GENERATED from product/highlight/protocol/contract.json — DO NOT EDIT BY HAND.

Regenerate:  node product/highlight/scripts/gen-protocol.mjs
Why it exists: the bridge must still know its verbs when it runs outside the
product tree (a packaged engine, a test double), and a hand-maintained second
copy of the verb table is exactly the drift this contract design removed.

SPDX-License-Identifier: Apache-2.0
"""

PROTOCOL_VERSION = ${contract.protocolVersion}

VERBS = {
${rows}
}

# key -> (HighlightConfig attribute, coercion). Options flagged 'special' are
# handled by the bridge itself and never reach HighlightConfig.
OPTIONS = {
${optionRows}
}

# The full declaration (min/max/enum/requires/group/default) as declared in the
# contract; both sides validate against it and the UI renders from it.
OPTION_META = {
${metaRows}
}
`

const check = process.argv.includes('--check')
const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''

if (check) {
  if (current !== rendered) {
    console.error('gen-protocol: engine/protocol_generated.py 与 contract.json 不一致 —— 运行 node product/highlight/scripts/gen-protocol.mjs')
    process.exit(1)
  }
  console.log(`gen-protocol: 已是最新(${verbs.length} 个动词, 协议 v${contract.protocolVersion})`)
} else if (current === rendered) {
  console.log(`gen-protocol: 无需改动(${verbs.length} 个动词)`)
} else {
  writeFileSync(OUT, rendered)
  console.log(`gen-protocol: 已写入 engine/protocol_generated.py(${verbs.length} 个动词, 协议 v${contract.protocolVersion})`)
}
