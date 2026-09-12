// Types for `gen-client-roster.mjs`, so a TS consumer (the roster test) can use the same
// parsing the generator does instead of re-implementing it — a second implementation would be
// free to disagree with the file it is supposed to check.

/** The UI bundle's directory, resolved from `apps/web` (the app that composes it). */
export function uiBundleDir(): string

/** One roster row: a client plugin's id and the package it names. */
export interface RosterRow {
  id: string
  name: string
}

/** The roster, in mount order, read from the UI bundle's `client.yml`. */
export function readRoster(): RosterRow[]

/** The generated module's source for these rows (static imports, in order). */
export function renderRoster(rows: RosterRow[]): string
