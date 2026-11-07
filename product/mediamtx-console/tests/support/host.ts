// The product's harness: the control-plane primitives (Rpc / expectError /
// waitFor / freePort / health / bootCliHost) are the shared @mediabase/test-host
// ones; this file adds only the product identity — MTXCONSOLE_HOME, product
// entry cwd.
//
// ALSO owns the MediaMTX server lifecycle for live tests: `spawnMtx` starts a
// real MediaMTX binary (MTX_BIN env, or a sandbox-known path) with a throwaway
// config on free ports — when no binary exists the live suites skip with a
// reason instead of failing, so CI without the binary still runs everything
// that does not need a server.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootCliHost, freePort, waitFor, type BootedHost } from '@mediabase/test-host'

export const PRODUCT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export { freePort, waitFor, health, Rpc, expectError } from '@mediabase/test-host'
export type { WireError, BootedHost } from '@mediabase/test-host'

/**
 * Spawn the product CLI and wait until /api/health answers. MTXCONSOLE_HOME is
 * always a throwaway directory: a test must never touch the developer's own
 * ~/.mtxconsole.
 */
export function bootMtxconsole(env: Record<string, string> = {}): Promise<BootedHost> {
  return bootCliHost({
    cwd: PRODUCT_ROOT,
    homeEnv: 'MTXCONSOLE_HOME',
    homePrefix: 'mtxconsole-test-home-',
    label: 'mtxconsole',
    env,
  })
}

// ---- a REAL MediaMTX, when the binary is available ----------------------------

const CANDIDATE_BINS = [
  process.env.MTX_BIN ?? '',
  '/tmp/mtx/mediamtx',
  '/usr/local/bin/mediamtx',
  'mediamtx',
]

/** True when the candidate exists: absolute paths directly, bare names via PATH. */
function binExists(candidate: string): boolean {
  if (candidate.includes('/')) return existsSync(candidate)
  return (process.env.PATH ?? '').split(':').some((dir) => dir !== '' && existsSync(join(dir, candidate)))
}

export function mtxBin(): string | null {
  for (const candidate of CANDIDATE_BINS) {
    if (candidate !== '' && binExists(candidate)) return candidate
  }
  return null
}

export interface MtxServer {
  apiUrl: string
  /** The playback server base (the config enables it on a free port). */
  playbackUrl: string
  stop(): Promise<void>
}

/** Start a throwaway MediaMTX: API + metrics + playback on free ports, media
 * servers off (tests exercise the control plane; WHEP playback is a browser
 * concern, and the recording chain needs a publisher — covered by verify.mjs
 * against a real setup instead). */
export async function spawnMtx(): Promise<MtxServer> {
  const bin = mtxBin()
  if (bin === null) throw new Error('no mediamtx binary')
  const apiPort = await freePort()
  const metricsPort = await freePort()
  const playbackPort = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'mtxconsole-mtx-'))
  const conf = join(dir, 'mediamtx.yml')
  writeFileSync(conf, [
    'logLevel: error',
    'api: yes',
    `apiAddress: 127.0.0.1:${apiPort}`,
    'metrics: yes',
    `metricsAddress: 127.0.0.1:${metricsPort}`,
    'webrtc: no',
    'hls: no',
    'rtsp: no',
    'rtmp: no',
    'srt: no',
    'moq: no',
    'playback: yes',
    `playbackAddress: 127.0.0.1:${playbackPort}`,
    'paths:',
    '  seeded:',
    '',
  ].join('\n'))
  const child = spawn(bin, [conf], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout!.on('data', (d: Buffer) => { log += d.toString() })
  child.stderr!.on('data', (d: Buffer) => { log += d.toString() })
  const apiUrl = `http://127.0.0.1:${apiPort}`
  try {
    await waitFor(async () => {
      try {
        const r = await fetch(`${apiUrl}/v3/info`)
        return r.ok
      } catch {
        return false
      }
    }, 15_000)
  } catch (e) {
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`mediamtx did not start:\n${log}`, { cause: e })
  }
  return {
    apiUrl,
    playbackUrl: `http://127.0.0.1:${playbackPort}`,
    async stop() {
      child.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (child.exitCode === null) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
