// @xmedia/protocol — the TypeScript side of the single-source wire contract.
//
// The contract lives at product/xmedia/protocol/contract.json. It is imported
// here directly (resolveJsonModule), and the C++ side consumes the SAME file
// through the generated engine/src/xmedia_protocol.h (see scripts/gen-protocol.mjs).
// Editing the JSON regenerates both; there is no third hand-maintained copy, so
// the C++ bridge and this capability can no longer drift apart silently.

import contract from '../../../../protocol/contract.json'

interface VerbDef {
  framing: string
  request: string[]
  response: string[]
}

/** Wire protocol version this host speaks (must equal kProtocolVersion in C++). */
export const PROTOCOL_VERSION: number = contract.protocolVersion

export type VerbName = keyof typeof contract.verbs
export type Framing = 'verb' | 'ok'

// Treat the (precise) JSON type as a flat map keyed by verb name. Using a mapped
// type (not an index signature) keeps verb access strongly typed and avoids
// noUncheckedIndexedAccess turning every lookup into `T | undefined`.
const verbs = contract.verbs as unknown as Record<VerbName, VerbDef>

/**
 * Verbs the host is allowed to send, as UPPER_SNAKE constants whose values are
 * the wire tokens: `VERB.PUBLISH_START === 'publish.start'`. Keys are declared
 * literally (not as an index signature) so access is strongly typed and free of
 * `undefined` even under noUncheckedIndexedAccess; a runtime guard below keeps
 * the map in sync with contract.json's verb set.
 */
function toUpperSnake(s: string): string {
  return s.replace(/\./g, '_').toUpperCase()
}

const verbMap: Record<string, string> = {}
for (const v of Object.keys(verbs)) verbMap[toUpperSnake(v)] = v

interface VerbConst {
  HELLO: 'hello'
  PING: 'ping'
  EVENTS: 'events'
  QUIT: 'quit'
  PUBLISH_START: 'publish.start'
  PUBLISH_STOP: 'publish.stop'
  PUBLISH_STATUS: 'publish.status'
}

for (const key of ['HELLO', 'PING', 'EVENTS', 'QUIT', 'PUBLISH_START', 'PUBLISH_STOP', 'PUBLISH_STATUS']) {
  if (!(key in verbMap)) throw new Error(`protocol: VERB.${key} missing from contract.json`)
}

export const VERB = verbMap as unknown as VerbConst

/** Request column names for a verb (in wire order). */
export function requestColumns(verb: VerbName): readonly string[] {
  return verbs[verb].request
}

/** Response column names for a verb (in wire order, after the `ok`/`verb` token). */
export function responseColumns(verb: VerbName): readonly string[] {
  return verbs[verb].response
}

/** Is the verb's reply framed as `<verb>\t...` (true) or `ok\t...` (false)? */
export function framingOf(verb: VerbName): Framing {
  return verbs[verb].framing as Framing
}

/**
 * Zero-based index of a request column among a verb's PAYLOAD columns.
 *
 * The wire line is `<verb>\t<col0>\t<col1>…`, so this index counts from the
 * first argument — it is NOT a field offset into the split line (`parts[0]` is
 * the verb). Add 1 if you are indexing a parsed line.
 */
export function requestIndex(verb: VerbName, column: string): number {
  const i = verbs[verb].request.indexOf(column)
  if (i < 0) throw new Error(`protocol: ${verb} has no request column "${column}"`)
  return i
}

/**
 * Zero-based index of a response column among a reply's PAYLOAD columns.
 *
 * The reply line is `ok\t<col0>\t…` (or `<verb>\t<col0>\t…`), so field 0 is
 * the framing token and this index starts at field 1.
 */
export function responseIndex(verb: VerbName, column: string): number {
  const i = verbs[verb].response.indexOf(column)
  if (i < 0) throw new Error(`protocol: ${verb} has no response column "${column}"`)
  return i
}

/** The `publish.*` verbs, exposed for call-site documentation. */
export const PUBLISH_VERBS = Object.freeze({
  START: VERB.PUBLISH_START,
  STOP: VERB.PUBLISH_STOP,
  STATUS: VERB.PUBLISH_STATUS,
})
