// @vhl/protocol — the TypeScript side of the single-source wire contract.
//
// The contract lives at product/highlight/protocol/contract.json. It is imported
// here directly (resolveJsonModule) and read by the Python bridge through
// engine/contract.py, so the two sides cannot drift apart silently: adding a
// verb means editing that ONE file.
//
// The bridge's replies are column-based; this module names the columns so a call
// site reads as `cols[JOB_JSON]` instead of `parts[1]` (the off-by-one that
// column indexes invite).

import contract from '../../../../protocol/contract.json'

interface VerbDef {
  framing: string
  request: string[]
  response: string[]
}

const verbs = contract.verbs as unknown as Record<string, VerbDef>

/** Wire protocol version this host speaks (must equal the bridge's hello). */
export const PROTOCOL_VERSION: number = contract.protocolVersion

function toUpperSnake(value: string): string {
  return value.replace(/\./g, '_').toUpperCase()
}

const verbMap: Record<string, string> = {}
for (const verb of Object.keys(verbs)) verbMap[toUpperSnake(verb)] = verb

interface VerbConst {
  HELLO: 'hello'
  PING: 'ping'
  PROBE: 'probe'
  ANALYZE_START: 'analyze.start'
  ANALYZE_STATUS: 'analyze.status'
  ANALYZE_CANCEL: 'analyze.cancel'
  JOBS_LIST: 'jobs.list'
  EXPORT_EDL: 'export.edl'
  MODELS_LIST: 'models.list'
  OPTIONS_LIST: 'options.list'
  QUIT: 'quit'
}

for (const key of ['HELLO', 'PING', 'PROBE', 'ANALYZE_START', 'ANALYZE_STATUS', 'ANALYZE_CANCEL', 'JOBS_LIST', 'EXPORT_EDL', 'MODELS_LIST', 'OPTIONS_LIST', 'QUIT']) {
  if (!(key in verbMap)) throw new Error(`protocol: VERB.${key} missing from contract.json`)
}

export const VERB = verbMap as unknown as VerbConst

/** The verb type: exactly the literals the contract declares, nothing wider. */
export type VerbName = (typeof VERB)[keyof typeof VERB]

/** Every verb in the contract, in file order (for messages and diagnostics). */
export const VERB_NAMES: string[] = Object.keys(verbs)

const KNOWN_VERBS = new Set(VERB_NAMES)

/**
 * Is this one of the contract's verbs?
 *
 * The host OWNS the contract; the engine merely implements it. So a verb outside
 * this set is a defect on this side — a cast, a typo, a string assembled at
 * runtime — and letting it onto the wire turns a local mistake into
 * `未知动词: …` in the engine's voice, one process away from the line that
 * caused it. `call()` takes a `VerbName` so the ordinary case cannot happen;
 * this answers the case that reached it anyway.
 */
export function isKnownVerb(verb: string): boolean {
  return KNOWN_VERBS.has(verb)
}

/**
 * Host-side refusal for a verb outside the contract.
 *
 * Quotes the verb and states its length because the message this replaces could
 * not be acted on: `未知动词: nalyze.status` reads like a typo in the caller and
 * leaves the actual question — was the string truncated in transit, or is the
 * engine running an older verb table? — with no answer. A count and a quote make
 * both visible at a glance (`'nalyze.status' (13 字符)` is visibly not
 * `analyze.status`), and the sentence says which side refused.
 */
export function unknownVerbMessage(verb: string): string {
  return `highlight: 动词 '${verb}'(${verb.length} 字符)不在 contract 里(共 ${VERB_NAMES.length} 个);`
    + '宿主拒绝发送,引擎未收到任何请求'
}

// --------------------------------------------------------------------------- //
// Option catalogue (the analyze.start knob table)
// --------------------------------------------------------------------------- //

/**
 * Knob types.
 *
 * `weights` is a composite: one option whose value is a map of sub-keys, because
 * the engine normalises the seven signal weights against each other. Exposing
 * them as seven unrelated knobs would let a UI submit 0.9/0.9/0.9 and imply an
 * absolute effect that the normaliser immediately cancels out.
 */
export type OptionType = 'float' | 'int' | 'bool' | 'str' | 'strs' | 'weights'

export interface OptionFieldSpec {
  /** ScoringWeights attribute the sub-key maps to. */
  field: string
  default: number
}

export interface OptionSpec {
  field: string
  type: OptionType
  default?: unknown
  min?: number
  max?: number
  enum?: unknown[]
  requires?: string
  group: string
  special?: boolean
  /** Sub-keys of a `weights` option (absent for scalar knobs). */
  fields?: Record<string, OptionFieldSpec>
}

const options = (contract.options ?? {}) as unknown as Record<string, unknown>

/** Every knob the engine accepts, with the limits the engine enforces too. */
export const OPTION_SPECS: Readonly<Record<string, OptionSpec>> = Object.fromEntries(
  Object.entries(options).filter(([key]) => key !== 'comment'),
) as Record<string, OptionSpec>

export function optionKeys(): string[] {
  return Object.keys(OPTION_SPECS)
}

/** The default value for every knob (what a UI shows before the user touches it). */
export function optionDefaults(): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(OPTION_SPECS)) {
    if (spec.special === true) continue
    defaults[key] = spec.default
  }
  return defaults
}

/**
 * Zero-based index of a response PAYLOAD column inside a split reply line.
 *
 * The reply is `ok\t<col0>\t<col1>…`, so field 0 is the framing token and this
 * helper returns the FIELD index (already +1) — the only correct way to index
 * `parts` after `split('\t')`.
 */
export function responseField(verb: string, column: string): number {
  const def = verbs[verb]
  if (def === undefined) throw new Error(`protocol: unknown verb "${verb}"`)
  const index = def.response.indexOf(column)
  if (index < 0) throw new Error(`protocol: ${verb} has no response column "${column}"`)
  return index + 1
}

/** Column names of a verb's reply (payload only, in wire order). */
export function responseColumns(verb: string): readonly string[] {
  const def = verbs[verb]
  if (def === undefined) throw new Error(`protocol: unknown verb "${verb}"`)
  return def.response
}

/** How a verb's reply is framed: `verb` = starts with the verb token. */
export function framingOf(verb: string): string {
  const def = verbs[verb]
  if (def === undefined) throw new Error(`protocol: unknown verb "${verb}"`)
  return def.framing
}

/** Every verb the contract declares (used by the drift check in verify.mjs). */
export const ALL_VERBS: readonly string[] = Object.keys(verbs)
