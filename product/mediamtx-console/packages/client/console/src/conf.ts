// conf.ts — the pure half of the global-config panel (M3).
//
// MediaMTX's /v3/config/global/get is a FLAT dict of ~122 keys whose names
// are grouped by convention (rtspAddress, hlsAllowOrigin, recordFormat…).
// Rather than curating a subset that would drift with every upstream version,
// the panel renders ALL of it: keys are bucketed by name prefix, scalars
// become inputs, and anything composite (pathDefaults, authInternalUsers…)
// stays a read-only JSON view — the patch method takes a subset, so showing
// everything and SENDING only the diff is both honest and safe.
//
// Pure functions only; tests/conf.test.ts pins them without a browser.

/** What kind of editor a key's value gets. */
export type FieldKind = 'bool' | 'number' | 'string' | 'complex'

export function fieldKind(value: unknown): FieldKind {
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string' || value === null) return 'string'
  return 'complex'
}

/** One rendered key. `draft` panels edit scalars only. */
export interface ConfigField {
  key: string
  kind: FieldKind
  value: unknown
}

export interface ConfigGroup {
  /** Stable lowercase id (also the display word — protocol vocabulary). */
  group: string
  fields: ConfigField[]
}

/**
 * Prefix → group, checked IN ORDER (longest/most specific first). Anything
 * unmatched lands in 'general' — an upstream key this list has never seen
 * still shows up, still editable, just not perfectly categorized.
 */
const GROUP_RULES: ReadonlyArray<{ group: string; prefixes: readonly string[] }> = [
  { group: 'rtsp', prefixes: ['rtsp'] },
  { group: 'rtmp', prefixes: ['rtmp'] },
  { group: 'hls', prefixes: ['hls'] },
  { group: 'webrtc', prefixes: ['webrtc'] },
  { group: 'srt', prefixes: ['srt'] },
  { group: 'mqtt', prefixes: ['mqtt'] },
  { group: 'record', prefixes: ['record'] },
  { group: 'auth', prefixes: ['auth'] },
  { group: 'servers', prefixes: ['api', 'metrics', 'playback', 'pprof'] },
  { group: 'paths', prefixes: ['path'] },
]

/** Display order of the groups (unmatched keys: 'general' first, 'other' last). */
const GROUP_ORDER = ['general', 'servers', 'rtsp', 'rtmp', 'hls', 'webrtc', 'srt', 'mqtt', 'record', 'auth', 'paths', 'other']

function groupOf(key: string): string {
  const lower = key.toLowerCase()
  for (const rule of GROUP_RULES) {
    for (const prefix of rule.prefixes) {
      if (lower.startsWith(prefix)) return rule.group
    }
  }
  // logLevel, logDestinations, sessionTimeout, udpReadBufferSize… — the core.
  if (lower.startsWith('log') || lower.startsWith('session') || lower.startsWith('udp') || lower.startsWith('read')) return 'general'
  return 'other'
}

/** Bucket the flat config into ordered groups; keys sorted inside each. */
export function groupConfig(config: Record<string, unknown>): ConfigGroup[] {
  const buckets = new Map<string, ConfigField[]>()
  for (const key of Object.keys(config).sort()) {
    const group = groupOf(key)
    const fields = buckets.get(group)
    const field: ConfigField = { key, kind: fieldKind(config[key]), value: config[key] }
    if (fields === undefined) buckets.set(group, [field])
    else fields.push(field)
  }
  const known = GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => ({ group: g, fields: buckets.get(g)! }))
  // A group outside GROUP_ORDER (should not happen, but the config is upstream's):
  const extra = [...buckets.keys()].filter((g) => !GROUP_ORDER.includes(g)).sort().map((g) => ({ group: g, fields: buckets.get(g)! }))
  return [...known, ...extra]
}

/**
 * The editable draft: one entry per scalar key the operator touched. Complex
 * values never enter the draft (they render read-only).
 */
export type ConfigDraft = Record<string, string | number | boolean>

/** Seed a draft from the loaded config (scalars only). */
export function seedDraft(config: Record<string, unknown>): ConfigDraft {
  const draft: ConfigDraft = {}
  for (const [key, value] of Object.entries(config)) {
    const kind = fieldKind(value)
    if (kind === 'bool') draft[key] = value as boolean
    else if (kind === 'number') draft[key] = value as number
    else if (kind === 'string') draft[key] = (value ?? '') as string
  }
  return draft
}

/**
 * What Save sends: keys whose draft value differs from the loaded config.
 * A null upstream value edited to '' counts as untouched (nothing to say);
 * anything else is compared by value, with numbers compared numerically.
 */
export function configDiff(config: Record<string, unknown>, draft: ConfigDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, drafted] of Object.entries(draft)) {
    if (!(key in config)) continue // a key upstream dropped since load: not ours to invent
    const original = config[key]
    if (typeof drafted === 'boolean') {
      if (original !== drafted) out[key] = drafted
    } else if (typeof drafted === 'number') {
      if (typeof original !== 'number' || !Number.isFinite(drafted) || original !== drafted) {
        if (Number.isFinite(drafted)) out[key] = drafted
      }
    } else {
      // string draft
      const originalText = original === null ? '' : typeof original === 'string' ? original : null
      if (originalText === null) continue // original was not a string — refuse to coerce silently
      if (originalText !== drafted) out[key] = drafted
    }
  }
  return out
}
