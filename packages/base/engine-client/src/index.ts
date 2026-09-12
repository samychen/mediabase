// @mediabase/engine-client — neutral line-protocol client for an engine subprocess.
//
// Transport contract only: the child answers strictly in request order, so
// pending calls are matched FIFO (exactly one response line per request).
// Diagnostics go to its stderr; stdout stays a clean protocol channel.
//
// Command verbs (decode/probe/…) and their response column layouts are NOT here
// — they belong to the capability package that owns the engine binary. This
// package only knows how to send tab-separated lines, match replies, exchange a
// byte blob through a scratch file, and **restart a dead child** so the
// capability above can supervise it (policy — backoff, attempt caps, what to do
// about in-flight playback — stays in the capability).

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// Engine failures use the same code vocabulary as the control plane: a client
// that sees ENGINE/UNAVAILABLE over RPC branches the same way it would here.
import { RpcCode, RpcError } from '@mediabase/rpc'

interface PendingCall {
  resolve: (parts: string[]) => void
  reject: (e: Error) => void
}

/** Why the child went away — handed to `onExit` so supervision can decide. */
export interface EngineExitInfo {
  code: number | null
  signal: string | null
  /** True when dispose()/restart() caused it; false means it died on its own. */
  expected: boolean
  /** Uptime in ms (a child that dies instantly is usually a broken binary). */
  uptimeMs: number
}

export interface EngineClientOptions {
  /**
   * Path handed to the engine by byte-producing commands. Deployment knowledge:
   * resolve it in the composition layer and pass it in — the neutral default
   * below exists only so the package stays usable standalone.
   */
  scratchFile?: string
  /** Per-call timeout in ms (default 20000). */
  callTimeoutMs?: number
  /** Route the child's stderr lines here instead of raw passthrough (e.g. ctx.log). */
  onStderr?: (line: string) => void
  /** Called once per child exit — the supervision hook. */
  onExit?: (info: EngineExitInfo) => void
}

const DEFAULT_CALL_TIMEOUT_MS = 20_000

/**
 * Wire protocol version this client speaks. The engine announces its own with
 * `hello`; a mismatch is refused rather than mis-parsed (see assertProtocol).
 */
export const ENGINE_PROTOCOL_VERSION = 1

/** Refuse an engine whose protocol version this client cannot speak. */
export function assertProtocol(info: { protocol: number }, supported = ENGINE_PROTOCOL_VERSION): void {
  if (info.protocol !== supported) {
    throw new RpcError(
      RpcCode.CONFLICT,
      `引擎协议版本不匹配:引擎=${info.protocol || '未知'},宿主支持=${supported}(重新构建引擎或升级宿主)`,
      { engine: info.protocol, host: supported },
      {
        messageKey: 'engine.protocolMismatch',
        messageParams: { engine: info.protocol || 'unknown', host: supported },
      },
    )
  }
}

export class EngineClient {
  private readonly binPath: string
  private readonly options: EngineClientOptions
  private readonly callTimeoutMs: number
  private proc: ChildProcess | null = null
  private queue: PendingCall[] = []
  private alive = false
  private startedAt = 0
  private disposed = false

  /** Byte-exchange path shared with the engine (see EngineClientOptions). */
  readonly scratchFile: string

  constructor(binPath: string, options: EngineClientOptions = {}) {
    this.binPath = binPath
    this.options = options
    this.scratchFile = options.scratchFile ?? join(tmpdir(), `engine-scratch-${process.pid}.bin`)
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.start()
  }

  /** True while the child is running and accepting commands. */
  get running(): boolean {
    return this.alive
  }

  /**
   * OS pid of the current child, or null when none is running. A supervisor (and a
   * test asserting "no orphan survived shutdown") needs to name the process it is
   * responsible for: counting machine-wide matches instead is a guess that any other
   * host on the machine can invalidate.
   */
  get pid(): number | null {
    return this.proc !== null && this.alive ? this.proc.pid ?? null : null
  }

  private start(): void {
    // stdio: ['pipe','pipe','pipe'] guarantees non-null stdin/stdout/stderr;
    // the `!` below only satisfies the loose ChildProcess types.
    const proc = spawn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.alive = true
    this.startedAt = Date.now()
    const { stdout, stderr } = proc

    let stdoutBuf = ''
    stdout!.setEncoding('utf8')
    stdout!.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let nl = stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        const slot = this.queue.shift()
        if (slot) slot.resolve(line.split('\t'))
        nl = stdoutBuf.indexOf('\n')
      }
    })
    stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (this.options.onStderr) this.options.onStderr(text.trimEnd())
      else process.stderr.write(`[engine] ${text}`)
    })
    proc.on('error', (e) => {
      // spawn failure (missing binary, not executable): same handling as exit.
      this.handleExit(proc, null, null, e)
    })
    proc.on('exit', (code: number | null, signal: string | null) => {
      this.handleExit(proc, code, signal)
    })
  }

  private handleExit(proc: ChildProcess, code: number | null, signal: string | null, spawnError?: Error): void {
    // A child we already replaced (restart) or stopped (dispose) must not be
    // reported as a crash — that would make supervision restart in a loop.
    if (proc !== this.proc) return
    if (!this.alive) return // already handled (error + exit can both fire)
    this.alive = false
    const info: EngineExitInfo = {
      code,
      signal,
      expected: this.disposed,
      uptimeMs: Date.now() - this.startedAt,
    }
    const err = new RpcError(
      RpcCode.UNAVAILABLE,
      spawnError
        ? `engine subprocess failed to start: ${spawnError.message}`
        : `engine subprocess exited (code=${code}, signal=${signal})`,
      { code, signal, uptimeMs: info.uptimeMs },
      {
        ...(spawnError ? { cause: spawnError } : {}),
        messageKey: spawnError ? 'engine.spawnFailed' : 'engine.exited',
        messageParams: spawnError
          ? { detail: spawnError.message }
          : { code: code ?? '', signal: signal ?? '' },
      },
    )
    // Every in-flight call must settle: the child is gone, responses can't come.
    const pending = this.queue
    this.queue = []
    for (const slot of pending) slot.reject(err)
    this.options.onExit?.(info)
  }

  /**
   * Spawn a fresh child after a crash. In-flight calls are already rejected by
   * the exit handler; callers decide whether to retry them.
   */
  restart(): void {
    if (this.disposed) return
    if (this.alive) {
      this.alive = false
      try {
        this.proc?.stdin?.end()
        this.proc?.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    this.start()
  }

  private send(parts: string[]): void {
    if (!this.alive || this.proc === null) {
      throw new RpcError(RpcCode.UNAVAILABLE, 'engine subprocess not running', undefined, {
        messageKey: 'engine.notRunning',
      })
    }
    this.proc.stdin!.write(`${parts.join('\t')}\n`)
  }

  /** Send one command; resolve with its tab-split response line. */
  call(parts: string[]): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const entry: PendingCall = { resolve, reject }
      this.queue.push(entry)
      try {
        this.send(parts)
      } catch (e) {
        const i = this.queue.indexOf(entry)
        if (i >= 0) this.queue.splice(i, 1)
        reject(e instanceof Error ? e : new RpcError(RpcCode.UNAVAILABLE, String(e), undefined, {
          messageKey: 'engine.writeFailed',
          messageParams: { detail: String(e) },
        }))
        return
      }
      setTimeout(() => {
        const i = this.queue.indexOf(entry)
        if (i < 0) return
        this.queue.splice(i, 1)
        reject(new RpcError(RpcCode.UNAVAILABLE, `engine timeout: ${parts[0] ?? ''}`, { command: parts[0] }, {
          messageKey: 'engine.timeout',
          messageParams: { command: parts[0] ?? '' },
        }))
      }, this.callTimeoutMs).unref?.()
    })
  }

  /** Send a command that must answer `ok`; a refusal becomes a coded ENGINE error. */
  async callOk(parts: string[]): Promise<string[]> {
    const r = await this.call(parts)
    if (r[0] !== 'ok') {
      throw new RpcError(RpcCode.ENGINE, r.slice(1).join(' '), { command: parts[0] }, {
        messageKey: 'engine.commandFailed',
        messageParams: { command: parts[0] ?? '', detail: r.slice(1).join(' ') },
      })
    }
    return r
  }

  /** Turn a non-`ok` response line into a coded ENGINE error. */
  protected engineFailure(parts: string[], command: string): RpcError {
    return new RpcError(RpcCode.ENGINE, parts.slice(1).join(' '), { command }, {
      messageKey: 'engine.commandFailed',
      messageParams: { command, detail: parts.slice(1).join(' ') },
    })
  }

  /** `hello` handshake: the child announces its protocol version (see README). */
  async hello(): Promise<{ protocol: number; engine: string }> {
    const r = await this.call(['hello'])
    if (r[0] !== 'hello') throw this.engineFailure(r, 'hello')
    const protocol = Number.parseInt(r[1] ?? '', 10)
    return { protocol: Number.isFinite(protocol) ? protocol : 0, engine: r[2] ?? '' }
  }

  /** Read the byte blob the engine just wrote to the scratch path. */
  readScratch(): Promise<Uint8Array> {
    return readFile(this.scratchFile)
  }

  ping(): Promise<boolean> {
    return this.call(['ping']).then((r) => r[0] === 'pong')
  }

  /** Stop the child and remove the scratch file. Idempotent; no restart after. */
  dispose(): void {
    this.disposed = true
    if (!this.alive) return
    this.alive = false
    try {
      this.proc?.stdin?.end()
    } catch {
      /* already closed */
    }
    try {
      this.proc?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    void unlink(this.scratchFile).catch(() => {})
  }
}
