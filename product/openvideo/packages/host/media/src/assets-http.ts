// @openvideo/host-media — the assets sidecar: a tiny Range-aware HTTP server.
//
// WHY THIS EXISTS: the base gateway's data-plane routes answer whole bodies
// with no `Accept-Ranges` (its route handler receives no request at all — by
// design). That is fine for small one-shot payloads, but a media element
// pointed at a 250 MB file over a non-seekable response never becomes usable
// in Firefox (and wastes the wire everywhere): metadata/first-frame probing
// stalls, durations stay unknown, the clip renders nothing. Upstream never had
// this problem because its media lived on an HLS service.
//
// The product therefore owns its own byte plane: one localhost HTTP server,
// full Range/206 semantics, CORS-open (local trust boundary, same as the
// host), streaming from disk — no whole-file buffers. The control plane still
// owns commands; the base gateway route (`/api/openvideo.asset.<id>`) stays
// for small pulls and compatibility.

import { createReadStream, statSync } from 'node:fs'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MediaStore } from './store.ts'

export interface AssetsServer {
  port(): number
  close(): Promise<void>
}

export interface AssetsServerOptions {
  store: MediaStore
  /** Resolve a proxy file for an asset (null = no proxy). */
  proxyFile?: (assetId: string) => { path: string; contentType: string } | null
  /** Preferred port; when taken, the OS assigns one (discover via endpoint()). */
  port: number
  onError?: (e: unknown) => void
}

const ASSET_PATH = /^\/(asset|proxy)\/([0-9a-f]{16})$/

export function startAssetsServer(opts: AssetsServerOptions): AssetsServer {
  let server: Server | null = null

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // Local trust boundary, but the page may come from another origin in dev
    // (vite :5174) — CORS-open like every other local media server.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, HEAD, OPTIONS')
      res.statusCode = 204
      res.end()
      return
    }
    const match = ASSET_PATH.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (match === null || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.statusCode = 404
      res.end()
      return
    }
    const [, kind, id] = match
    let file: string
    let contentType: string
    if (kind === 'asset') {
      const row = opts.store.getAsset(id!)
      if (row === null) {
        res.statusCode = 404
        res.end()
        return
      }
      file = opts.store.assetPath(row)
      contentType = row.contentType
    } else {
      const proxy = opts.proxyFile?.(id!) ?? null
      if (proxy === null) {
        res.statusCode = 404
        res.end()
        return
      }
      file = proxy.path
      contentType = proxy.contentType
    }
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', contentType)
    // Proxies are re-generable and may be replaced: no long cache for them.
    res.setHeader('Cache-Control', kind === 'asset' ? 'public, max-age=31536000' : 'no-cache')

    const range = req.headers.range
    const parsed = range === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(range)
    if (range !== undefined && parsed === null) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    if (parsed !== null && (parsed[1] !== '' || parsed[2] !== '')) {
      const first = parsed[1] !== '' ? Number(parsed[1]) : size - Number(parsed[2])
      const last = parsed[1] !== '' && parsed[2] !== '' ? Number(parsed[2]) : size - 1
      if (!Number.isFinite(first) || !Number.isFinite(last) || first < 0 || first > last || last >= size) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${size}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${first}-${last}/${size}`)
      res.setHeader('Content-Length', String(last - first + 1))
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(file, { start: first, end: last }).pipe(res)
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Length', String(size))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  }

  server = createServer(handle)
  server.on('error', (e) => {
    opts.onError?.(e)
    // Preferred port busy: let the OS pick; endpoint() reports the truth.
    server?.listen(0, '127.0.0.1')
  })
  server.listen(opts.port, '127.0.0.1')

  return {
    port: () => (server?.address() as AddressInfo | null)?.port ?? 0,
    close: () => new Promise((resolve) => {
      if (server === null) return resolve()
      server.close(() => resolve())
      // Do not hang the fiber on keep-alive sockets.
      server.closeAllConnections?.()
    }),
  }
}
