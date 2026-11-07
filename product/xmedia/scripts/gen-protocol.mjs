// gen-protocol.mjs — generate engine/src/xmedia_protocol.h from protocol/contract.json.
//
// This is the bridge between the single-source JSON contract and the C++ side.
// The header is committed to the tree so the C++ build does not hard-require
// Node; CMake regenerates it when Node is present (see engine/CMakeLists.txt).
//
// Usage:  node scripts/gen-protocol.mjs <contract.json> <out.h>

import { readFileSync, writeFileSync } from 'node:fs'

const [contractPath, outPath] = process.argv.slice(2)
if (!contractPath || !outPath) {
  console.error('usage: gen-protocol.mjs <contract.json> <out.h>')
  process.exit(2)
}

const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
const { protocolVersion, verbs } = contract

const pascal = (s) => s
  .replace(/[^a-zA-Z0-9]+/g, ' ')
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .split(' ')
  .filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join('')
const enumName = (verb, dir) => `${pascal(verb)}${dir === 'request' ? 'Req' : 'Res'}`

function columnsEnum(verb, dir) {
  const cols = verbs[verb][dir] ?? []
  const name = enumName(verb, dir)
  const body = cols.map((c, i) => `  k${pascal(c)} = ${i},`).join('\n')
  return `enum class ${name} : int {\n${body}\n};`
}

const verbConsts = Object.keys(verbs)
  .map((v) => `inline constexpr std::string_view k${pascal(v)} = "${v}";`)
  .join('\n')

const framingConsts = Object.entries(verbs)
  .map(([v, def]) => `inline constexpr Framing kFraming_${pascal(v)} = Framing::${def.framing === 'verb' ? 'kVerb' : 'kOk'};`)
  .join('\n')

const columnEnums = Object.keys(verbs)
  .flatMap((v) => [columnsEnum(v, 'request'), columnsEnum(v, 'response')])
  .join('\n\n')

const header = `// GENERATED from ${contractPath.split('/').slice(-2).join('/')} — do not edit by hand.
// Re-run: node scripts/gen-protocol.mjs <contract.json> <out.h>
#pragma once
#include <string_view>

namespace xmedia_protocol {

inline constexpr int kProtocolVersion = ${protocolVersion};

// How a verb's reply is framed on the wire.
enum class Framing { kVerb, kOk };

// Verb string literals (single source of truth).
${verbConsts}

// Framing per verb (kVerb: reply starts with the verb token, e.g. "hello\\t1\\t..";
// kOk: reply starts with "ok\\t", e.g. "ok\\t{...}").
${framingConsts}

// Request / response column indices, per verb. Indices are 0-based over the
// PAYLOAD columns only: a wire line is "<verb>\\t<col0>\\t<col1>…" (request) or
// "ok\\t<col0>\\t…" (response), so col0 sits at parts[1], NOT parts[0].
// A reader that indexes split parts with these values directly is off by one.
${columnEnums}

}  // namespace xmedia_protocol
`

writeFileSync(outPath, header)
console.log(`wrote ${outPath} (${Object.keys(verbs).length} verbs)`)
