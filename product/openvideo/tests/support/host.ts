// Shared harness for the product's host-level tests: boot the real OpenVideo
// CLI on a free port and talk to it over WS JSON-RPC / HTTP, exactly like a
// client would. Mirrors the base's tests/support/host.ts (same repo, same
// contract) with the product's identity: OPENVIDEO_HOME, product entry.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRODUCT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

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

export async function health(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`)
    return r.ok
  } catch {
    return false
  }
}

export interface WireError {
  code: number
  message: string
  messageKey?: string
  messageParams?: Record<string, string | number>
  data?: unknown
}

/** Minimal JSON-RPC client over the host's /rpc socket (whole wire errors). */
export class Rpc {
  private ws: WebSocket
  private id = 1
  private readonly pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
    this.ws.addEventListener('message', (e) => {
      const r = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: WireError }
      if (r.id === undefined || r.id === null) return
      const slot = this.pending.get(r.id)
      if (!slot) return
      this.pending.delete(r.id)
      if (r.error) slot.rej(Object.assign(new Error(r.error.message), r.error))
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
      }, 30_000)
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
  home: string
  child: ChildProcess
  rpc: Rpc
  output(): string
  stop(): Promise<void>
}

/**
 * Spawn the product CLI and wait until /api/health answers. OPENVIDEO_HOME is
 * always a throwaway directory: a test must never touch the developer's own
 * ~/.openvideo.
 */
export async function bootOpenvideo(env: Record<string, string> = {}): Promise<BootedHost> {
  const port = await freePort()
  const home = mkdtempSync(join(tmpdir(), 'openvideo-test-home-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts'], {
    cwd: PRODUCT_ROOT,
    env: { ...process.env, OPENVIDEO_HOME: home, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout!.on('data', (d: Buffer) => { log += d.toString() })
  child.stderr!.on('data', (d: Buffer) => { log += d.toString() })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  const ready = await Promise.race([
    waitFor(async () => (await health(port)) && true, 45_000).then(() => true).catch(() => false),
    exited.then(() => false),
  ])
  if (!ready) {
    const code = child.exitCode
    if (code !== null) child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
    throw new Error(`openvideo host did not become ready (exit=${String(code)}):\n${log}`)
  }

  const rpc = new Rpc(port)
  await rpc.open()

  return {
    port,
    home,
    child,
    rpc,
    output: () => log,
    async stop() {
      rpc.close()
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
      if (child.exitCode === null) child.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    },
  }
}
