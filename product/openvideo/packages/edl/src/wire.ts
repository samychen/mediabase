// The rows the media capability answers with — the host shapes them, the
// client renders them. This package is their shared home on purpose: one
// declaration, both typecheck planes (no DOM, no Node APIs), so the two sides
// cannot drift apart again (the client copy already had: an extra `proxy`
// facet lived only on the client side).

import type { Edl } from './edl.ts'

export type AssetProxyTarget = 'webm' | 'mp4'

/** Live proxy facet: the API attaches it to every asset row it answers with
 * (the store's files-only rows and hosts predating proxies carry none). */
export interface AssetProxyInfo {
  status: 'none' | 'queued' | 'running' | 'ready' | 'failed'
  target: AssetProxyTarget | null
  /** 0..1 while running; null otherwise. */
  progress: number | null
  error: string | null
}

/** One library entry — the row the API answers with. */
export interface AssetRow {
  /** 16-hex id; projects reference the file as "asset:<id>". */
  id: string
  /** File name under the media dir (id + the original extension). */
  key: string
  name: string
  contentType: string
  size: number
  createdAt: string
  /** Seconds, probed by the client from media metadata; null until known. */
  duration: number | null
  hasTranscript: boolean
  proxy?: AssetProxyInfo
}

export interface ProjectSummary {
  id: string
  name: string
  brief: string
  createdAt: string
  updatedAt: string
  /** The first main-track clip's asset id (the project's cover), or null. */
  coverAsset: string | null
  /** Where in that source the cover frame sits. */
  coverAt: number | null
}

export interface ProjectRow extends ProjectSummary {
  edl: Edl
}
