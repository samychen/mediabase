// Chunked uploads: the door browser bytes come through.
//
// The base front door is GET-only on the data plane and caps control-plane
// frames (1 MB default), so a file travels as sequential base64 chunks over
// `openvideo.assets.upload.*` and is appended straight to a tmp file — no
// chunk is ever held in memory, and a session that stops feeding is reaped
// by the TTL sweep (registered as a fiber effect by the capability).

import { appendFileSync, closeSync, existsSync, openSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface UploadSession {
  id: string
  name: string
  contentType: string
  /** Declared total size in bytes; `end` refuses a different count. */
  size: number
  duration: number | null
  received: number
  chunks: number
  path: string
  createdAt: number
}

export class UploadError extends Error {
  constructor(readonly kind: 'not_found' | 'conflict' | 'too_large', message: string) {
    super(message)
    this.name = 'UploadError'
  }
}

export interface UploadManagerOptions {
  /** Directory for in-flight tmp files (created on demand). */
  tmpDir: string
  maxUploadBytes: number
  /** A session idle longer than this is reaped (ms). */
  ttlMs: number
}

export class UploadManager {
  private readonly sessions = new Map<string, UploadSession>()
  private readonly opts: UploadManagerOptions

  constructor(opts: UploadManagerOptions) {
    this.opts = opts
  }

  begin(meta: { name: string; contentType: string; size: number; duration: number | null }): UploadSession {
    if (!Number.isInteger(meta.size) || meta.size <= 0) throw new UploadError('conflict', 'size must be a positive integer')
    if (meta.size > this.opts.maxUploadBytes) {
      throw new UploadError('too_large', `upload of ${meta.size} bytes exceeds the ${this.opts.maxUploadBytes} byte ceiling`)
    }
    const id = randomBytes(8).toString('hex')
    const path = join(this.opts.tmpDir, `upload-${id}.part`)
    const fd = openSync(path, 'w')
    closeSync(fd)
    const session: UploadSession = {
      id,
      name: meta.name,
      contentType: meta.contentType,
      size: meta.size,
      duration: meta.duration,
      received: 0,
      chunks: 0,
      path,
      createdAt: Date.now(),
    }
    this.sessions.set(id, session)
    return session
  }

  /** Append one base64 chunk; chunks must arrive in order (WS is ordered). */
  chunk(id: string, index: number, dataBase64: string): UploadSession {
    const session = this.must(id)
    if (index !== session.chunks) {
      throw new UploadError('conflict', `chunk ${index} out of order (expected ${session.chunks})`)
    }
    const data = Buffer.from(dataBase64, 'base64')
    if (session.received + data.byteLength > session.size) {
      throw new UploadError('conflict', 'chunk overruns the declared size')
    }
    appendFileSync(session.path, data)
    session.received += data.byteLength
    session.chunks += 1
    session.createdAt = Date.now()
    return session
  }

  /** Finish: hands over the tmp file (the caller adopts it as an asset). */
  end(id: string): UploadSession {
    const session = this.must(id)
    if (session.received !== session.size) {
      throw new UploadError('conflict', `incomplete: ${session.received} of ${session.size} bytes`)
    }
    this.sessions.delete(id)
    return session
  }

  cancel(id: string): void {
    const session = this.sessions.get(id)
    if (session === undefined) return
    this.sessions.delete(id)
    rmSync(session.path, { force: true })
  }

  /** Reap stale sessions; returns how many were dropped. */
  sweep(): number {
    const cutoff = Date.now() - this.opts.ttlMs
    let dropped = 0
    for (const session of [...this.sessions.values()]) {
      if (session.createdAt < cutoff) {
        this.cancel(session.id)
        dropped += 1
      }
    }
    return dropped
  }

  active(): number {
    return this.sessions.size
  }

  /** Move a finished session's tmp file to its final home. */
  static adopt(session: UploadSession, destPath: string): number {
    renameSync(session.path, destPath)
    return statSync(destPath).size
  }

  private must(id: string): UploadSession {
    const session = this.sessions.get(id)
    if (session === undefined || !existsSync(session.path)) throw new UploadError('not_found', `no such upload session "${id}"`)
    return session
  }
}
