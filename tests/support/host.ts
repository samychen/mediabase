// Shared harness for host-level tests: boot the real CLI on a free port and talk
// to it over WS JSON-RPC / HTTP, exactly like a client would.
//
// Extracted so both the integration suite and the capability-loading suite drive
// the host the same way (and so a boot failure is reported identically).

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

export function waitFor<T>(fn: () => T | false | Promise<T | false>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now()
    const tick = async (): Promise<void> => {
      const v = await fn()
      if (v) return resolve(v)
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(() => void tick(), 200)
    }
    void tick()
  })
}

export async function health(port: number, token?: string): Promise<boolean> {
  try {
    const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`
    const r = await fetch(`http://127.0.0.1:${port}/api/health${query}`)
    return r.ok
  } catch {
    return false
  }
}

/** Minimal JSON-RPC client over the host's /rpc socket. */
export class Rpc {
  private ws: WebSocket
  private id = 1
  private readonly pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  readonly notifs: Array<{ method: string; params: unknown }> = []

  constructor(port: number, token?: string) {
    const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/rpc${query}`)
    this.ws.addEventListener('message', (e) => {
      const r = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: WireError }
      if (r.id === undefined || r.id === null) {
        if (r.method) this.notifs.push({ method: r.method, params: r.params })
        return
      }
      const slot = this.pending.get(r.id)
      if (!slot) return
      this.pending.delete(r.id)
      if (r.error) {
        // Keep the whole wire error: messageKey/messageParams are part of the
        // contract a client renders from (the real client does the same).
        slot.rej(Object.assign(new Error(r.error.message), r.error))
      }
      else slot.res(r.result)
    })
  }

  async open(): Promise<void> {
    if (this.ws.readyState === 1) return
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true })
      this.ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true })
    })
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((res, rej) => {
      const id = this.id++
      this.pending.set(id, { res: (v) => res(v as T), rej })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        rej(new Error(`rpc timeout: ${method}`))
      }, 45_000)
    })
  }

  close(): void {
    this.ws.close()
  }
}

/** Call and return the wire error instead of throwing (code assertions). */
export interface WireError {
  code: number
  message: string
  /** Localization seam: the host's key + params for `message` (see @mediabase/rpc). */
  messageKey?: string
  messageParams?: Record<string, string | number>
  data?: unknown
}

export async function expectError(rpc: Rpc, method: string, params?: unknown): Promise<WireError> {
  try {
    await rpc.call(method, params)
  } catch (e) {
    const err = e as WireError & { code?: number }
    return {
      code: err.code ?? 0,
      message: err.message,
      ...(err.messageKey !== undefined ? { messageKey: err.messageKey } : {}),
      ...(err.messageParams !== undefined ? { messageParams: err.messageParams } : {}),
      ...(err.data !== undefined ? { data: err.data } : {}),
    }
  }
  throw new Error(`expected ${method} to fail`)
}

export interface BootedHost {
  port: number
  child: ChildProcess
  rpc: Rpc
  /** Everything the process wrote to stdout/stderr so far. */
  output(): string
  stop(): Promise<void>
}

/**
 * Spawn `apps/cli` and wait until /api/health answers (or throw with its log).
 *
 * `MEDIABASE_HOME` defaults to a throwaway directory: the default composition reads a
 * PROFILE (and creates it on first boot), and a test must never depend on — or write to —
 * the developer's own `~/.mediabase`. A caller that wants a profile of its own passes its
 * own home and keeps it.
 */
export async function bootHost(
  env: Record<string, string> = {},
  opts: { timeoutMs?: number; token?: string } = {},
): Promise<BootedHost> {
  const port = await freePort()
  const home = env['MEDIABASE_HOME'] ?? mkdtempSync(join(tmpdir(), 'mediabase-host-home-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, MEDIABASE_HOME: home, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout!.on('data', (d: Buffer) => { log += d.toString() })
  child.stderr!.on('data', (d: Buffer) => { log += d.toString() })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const timeoutMs = opts.timeoutMs ?? 30_000

  const ready = await Promise.race([
    waitFor(async () => (await health(port, opts.token)) && true, timeoutMs).then(() => true).catch(() => false),
    exited.then(() => false),
  ])
  if (!ready) {
    const code = child.exitCode
    if (code !== null) child.kill('SIGKILL')
    throw new Error(`host did not become ready (exit=${String(code)}):\n${log}`)
  }

  const rpc = new Rpc(port, opts.token)
  try {
    await rpc.open()
  } catch (e) {
    // The host can start listening and then fail boot (strict capability verify):
    // surface its log instead of a bare "ws connect failed".
    throw new Error(
      `host stopped before the control plane was usable: ${e instanceof Error ? e.message : String(e)}\n${log}`,
      { cause: e },
    )
  }
  return {
    port,
    child,
    rpc,
    output: () => log,
    async stop(): Promise<void> {
      rpc.close()
      if (child.exitCode === null) {
        const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        await Promise.race([done, new Promise((r) => setTimeout(r, 3_000))])
      }
      // Only the home this helper created; a caller's profile is the caller's.
      if (env['MEDIABASE_HOME'] === undefined) rmSync(home, { recursive: true, force: true })
    },
  }
}
