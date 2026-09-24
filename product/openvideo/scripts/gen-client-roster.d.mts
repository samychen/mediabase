// Types for the product's `gen-client-roster.mjs` (same contract as the base
// generator's d.mts): a TS consumer uses the SAME parsing the generator does
// instead of re-implementing it.

/** The product UI bundle's directory, resolved from `apps/web`. */
export function uiBundleDir(): string

/** One roster row: a client plugin's id and the package it names. */
export interface RosterRow {
  id: string
  name: string
  config?: Record<string, unknown>
}

/** The roster, in mount order, read from the bundle's `client.yml`. */
export function readRoster(): RosterRow[]

/** The generated module's source for these rows (static imports, in order). */
export function renderRoster(rows: RosterRow[]): string
