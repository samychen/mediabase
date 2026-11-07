// verify-protocol.mjs — assert the C++ header is in sync with contract.json.
//
// The wire protocol has ONE source of truth (protocol/contract.json). The C++
// side consumes it through the generated engine/src/xmedia_protocol.h. This
// check fails (exit 1) if the committed header is missing any verb literal, so
// a drift between the two sides is caught in CI, not at runtime.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const contractPath = `${root}protocol/contract.json`
const headerPath = `${root}engine/src/xmedia_protocol.h`

const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
const header = readFileSync(headerPath, 'utf8')

const verbs = Object.keys(contract.verbs)
const missing = verbs.filter((v) => !header.includes(`"${v}"`))

let ok = true
if (contract.protocolVersion !== 1) {
  console.error(`✗ protocolVersion expected 1, got ${contract.protocolVersion}`)
  ok = false
}
if (missing.length > 0) {
  console.error(`✗ generated header is missing verbs: ${missing.join(', ')}`)
  ok = false
}

if (ok) {
  console.log(`✓ protocol contract consistent (${verbs.length} verbs, version ${contract.protocolVersion})`)
  process.exit(0)
} else {
  console.error('  regenerate with: pnpm run gen:protocol')
  process.exit(1)
}
