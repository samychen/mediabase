// Re-export the shared, dependency-free WHEP client — the single source of truth
// lives at libs/whep/whep.js (also imported by xmedia's static page). This file
// keeps only the TS-only helpers; the runtime (startWhep / nativeHlsSupported)
// comes straight from the shared module so the two products cannot drift.
//
// Upstream error contract observed on MediaMTX v1.21: JSON
// `{ "error": "no stream is available on path 'cam1'" }` — surfaced verbatim so
// the operator sees WHY (usually: nobody is publishing).

export {
  startWhep,
  nativeHlsSupported,
  type WhepHandle,
} from '../../../../../../libs/whep/whep.js'

export interface WhepError {
  status: number
  detail: string
}

export function isWhepError(e: unknown): e is WhepError {
  return typeof e === 'object' && e !== null && typeof (e as WhepError).status === 'number'
}
