// @mediabase/test-host — shared harness core for host-level tests: boot a CLI
// host on a free port and talk to it over WS JSON-RPC / HTTP, exactly like a
// client would.
//
// This is test infrastructure, NOT a runtime capability: it never appears in a
// bundle row and is never mounted. The base suite (tests/support/host.ts) and
// the in-repo products' suites (product/*/tests/support/host.ts) drive their
// hosts through these primitives, so a boot failure or a wire error looks the
// same everywhere and the three copies cannot drift apart again.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** The wire error shape a JSON-RPC failure carries (see @mediabase/rpc). */
export interface WireError {
  code: number
  message: string
  /** Localization seam: the host's key + params for `message` (see @mediabase/rpc). */
  messageKey?: string
  messageParams?: Record<string, string | number>
  data?: unknown
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
  /** The home the host ran with (the helper's throwaway when none was passed). */
  home: string
  child: ChildProcess
  rpc: Rpc
  /** Everything the process wrote to stdout/stderr so far. */
  output(): string
  stop(): Promise<void>
}

export interface BootCliHostOptions {
  /** Where the CLI lives: `apps/cli/src/index.ts` resolves under this root. */
  cwd: string
  /** The `${prefix}HOME` variable the boot identity reads. */
  homeEnv: string
  /** Temp-dir prefix for the throwaway home. */
  homePrefix: string
  /** Human label in the "did not become ready" error. */
  label: string
  /** Extra env for the child. Passing `env[homeEnv]` keeps THAT home — a caller's
   * profile is the caller's, and its cleanup stays the caller's. */
  env?: Record<string, string>
  timeoutMs?: number
  token?: string
}

/**
 * Spawn `apps/cli/src/index.ts` (tsx) and wait until /api/health answers, or
 * throw with the host's log. `env[homeEnv]` defaults to a throwaway directory:
 * a test must never depend on — or write to — the developer's own home.
 */
export async function bootCliHost(opts: BootCliHostOptions): Promise<BootedHost> {
  const port = await freePort()
  const passedHome = opts.env?.[opts.homeEnv]
  const home = passedHome ?? mkdtempSync(join(tmpdir(), opts.homePrefix))
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts'], {
    cwd: opts.cwd,
    env: { ...process.env, [opts.homeEnv]: home, PORT: String(port), ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout!.on('data', (d: Buffer) => { log += d.toString() })
  child.stderr!.on('data', (d: Buffer) => { log += d.toString() })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const timeoutMs = opts.timeoutMs ?? 45_000

  const ready = await Promise.race([
    waitFor(async () => (await health(port, opts.token)) && true, timeoutMs).then(() => true).catch(() => false),
    exited.then(() => false),
  ])
  if (!ready) {
    const code = child.exitCode
    if (code !== null) child.kill('SIGKILL')
    if (passedHome === undefined) rmSync(home, { recursive: true, force: true })
    throw new Error(`${opts.label} did not become ready (exit=${String(code)}):\n${log}`)
  }

  const rpc = new Rpc(port, opts.token)
  try {
    await rpc.open()
  } catch (e) {
    // The host can start listening and then fail boot (strict capability verify):
    // surface its log instead of a bare "ws connect failed".
    throw new Error(
      `${opts.label} stopped before the control plane was usable: ${e instanceof Error ? e.message : String(e)}\n${log}`,
      { cause: e },
    )
  }
  return {
    port,
    home,
    child,
    rpc,
    output: () => log,
    async stop(): Promise<void> {
      rpc.close()
      if (child.exitCode === null) {
        const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        await Promise.race([done, new Promise((r) => setTimeout(r, 5_000))])
        if (child.exitCode === null) child.kill('SIGKILL')
      }
      // Only the home this helper created; a caller's profile is the caller's.
      if (passedHome === undefined) rmSync(home, { recursive: true, force: true })
    },
  }
}
