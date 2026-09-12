// examples/plugins/sandboxed-demo.ts
//
// The same example as hello.ts, but written for PROCESS ISOLATION: the host runs
// this file in a child process and the only things available are the sandbox API
// (log / events / declared services / exported `api`). It imports nothing from the
// workspace, which is the point — a sandboxed plugin cannot reach host objects.
//
// Catalog entry (the bundle row → @mediabase/plugins): isolation 'process', with
// a confinement policy — see @mediabase/confine and packages/host/plugins.

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { connect } from 'node:net'
import { Worker } from 'node:worker_threads'

export const name = 'sandboxed-demo'

/**
 * What this plugin is allowed to touch, reported BY THE CHILD. This is the point of
 * `@mediabase/confine`: the plugin runs with Node's permission model (filesystem
 * limited to the declared roots, no subprocesses/workers/addons) plus an OS layer
 * where one is available (network denial). Ask it from the API console:
 *
 *   plugins.call('sandboxed-demo', 'probeConfinement')
 *
 * Each row says what the CHILD experienced (allowed / denied + the error code), so
 * the answer cannot be more confident than the enforcement.
 */
export const api = {
  sum: (values: number[]): number => values.reduce((a, b) => a + b, 0),
  describe: (): string => 'sandboxed plugin: no host context, only messages',
  probeConfinement: async (): Promise<Array<{ what: string; allowed: boolean; detail: string }>> => {
    const dataDir = process.env['MEDIABASE_PLUGIN_DATA_DIR'] ?? ''
    const rows: Array<{ what: string; allowed: boolean; detail: string }> = []
    const attempt = async (what: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
      try {
        const value = await fn()
        rows.push({ what, allowed: true, detail: typeof value === 'string' ? value : 'ok' })
      } catch (e) {
        const err = e as { code?: string; message?: string }
        rows.push({ what, allowed: false, detail: err.code ?? err.message ?? String(e) })
      }
    }
    await attempt('read-outside', () => readFileSync('/etc/hosts', 'utf8').length)
    await attempt('read-app', () => readFileSync(new URL(import.meta.url).pathname, 'utf8').length)
    await attempt('write-data-dir', () => writeFileSync(join(dataDir, 'probe.txt'), 'ok'))
    await attempt('write-outside', () => writeFileSync('/tmp/avstudio-should-not-exist.txt', 'x'))
    await attempt('spawn', () => execSync('echo should-not-run'))
    await attempt('worker', () => new Worker('1', { eval: true }))
    // Network needs an OS mechanism (Node's permission model has no network
    // control), so this row reports what the OS did: a refused CONNECTION still means
    // the child was allowed to open a socket, which is the distinction that matters.
    await attempt('network', () => new Promise((resolve, reject) => {
      const socket = connect(1, '127.0.0.1')
      socket.on('connect', () => { socket.destroy(); resolve('connected') })
      socket.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ECONNREFUSED') resolve('socket allowed (nothing listening on port 1)')
        else reject(e)
      })
    }))
    return rows
  },
}

interface SandboxContext {
  id: string
  log: {
    info(msg: string, data?: Record<string, unknown>): void
    warn(msg: string, data?: Record<string, unknown>): void
  }
  events: {
    emit(name: string, payload?: unknown): void
    on(name: string, handler: (payload: unknown) => void): () => void
  }
  /** Declared services only (this entry declares none, so this stays unused). */
  services: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
  effect(fn: () => void): void
}

export function apply(ctx: SandboxContext): void {
  ctx.log.info('沙箱示例插件已启动(独立进程)', { instance: ctx.id })
  ctx.events.emit('sandbox.demo.ready', { id: ctx.id })

  // Host→plugin events need no service permission: subscribing is enough.
  let ticks = 0
  ctx.events.on('media.play.tick', (payload) => {
    ticks++
    if (ticks % 10 === 0) ctx.log.info(`收到 ${ticks} 次播放进度`, { payload })
  })

  ctx.effect(() => ctx.log.info('沙箱示例插件清理完成'))
}
