// Proxy transcoding: the local answer to "this browser cannot decode that".
//
// The browser's codec support is a hard ceiling (MSE/WebCodecs do not raise
// it), so the product transcodes a PLAYBACK PROXY on the host with the user's
// own ffmpeg — the local equivalent of the upstream managed media service.
// The original file stays untouched; preview and export switch to the proxy
// automatically once it is ready and the original is undecodable here.
//
// Conventions this module keeps:
//   - the optional environment is probed BY EXECUTION (`ffmpeg -version`);
//     absent ffmpeg degrades to a coded UNAVAILABLE, never a broken boot;
//   - every child process is owned by the capability's fiber — dispose kills
//     in-flight jobs (a supervised process, not a leaked one);
//   - one job per asset, a small queue, progress parsed from `-progress`
//     key=value lines (no stderr scraping guesswork);
//   - outputs are written as `.part` and renamed on success, so a killed job
//     can never leave a half file that looks ready.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type ProxyTarget = 'webm' | 'mp4'

export interface ProxyInfo {
  status: 'none' | 'queued' | 'running' | 'ready' | 'failed'
  target: ProxyTarget | null
  /** 0..1 while running; null otherwise. */
  progress: number | null
  error: string | null
}

export interface ProxyManagerOptions {
  /** Where proxies live (`<mediaDir>/proxies`). */
  dir: string
  /** ffmpeg executable path, or null when the probe found none. */
  ffmpeg: string | null
  /** ffmpeg version string from the probe (for info/health). */
  ffmpegVersion: string | null
  log: { info(msg: string, extra?: unknown): void; warn(msg: string, extra?: unknown): void }
  /** Total seconds of the source, when known (drives the progress fraction). */
  durationOf: (assetId: string) => number | null
}

interface Job {
  assetId: string
  target: ProxyTarget
  child: ChildProcess
  progress: number
  error: string | null
}

/** Encode recipes per target: both are what browsers decode WITHOUT optional
  * codec packages — vp9/opus everywhere, h264/aac where the browser has it. */
const RECIPES: Record<ProxyTarget, string[]> = {
  webm: ['-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '128k'],
  mp4: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
}

export class ProxyError extends Error {
  constructor(readonly kind: 'unavailable' | 'conflict' | 'not_found' | 'failed', message: string) {
    super(message)
    this.name = 'ProxyError'
  }
}

export class ProxyManager {
  private readonly jobs = new Map<string, Job>()
  private readonly queue: Array<{ assetId: string; target: ProxyTarget; src: string }> = []
  private readonly failures = new Map<string, string>()
  private readonly opts: ProxyManagerOptions
  private disposed = false

  constructor(opts: ProxyManagerOptions) {
    this.opts = opts
    mkdirSync(opts.dir, { recursive: true })
  }

  /** What this machine can do — answered from the executed probe, never assumed. */
  info(): { ffmpeg: boolean; version: string | null; targets: ProxyTarget[] } {
    return {
      ffmpeg: this.opts.ffmpeg !== null,
      version: this.opts.ffmpegVersion,
      targets: ['webm', 'mp4'],
    }
  }

  proxyPath(assetId: string, target: ProxyTarget): string {
    return join(this.opts.dir, `${assetId}.${target}`)
  }

  /** Existing proxy for an asset (webm preferred), regardless of any job state. */
  readyFile(assetId: string): { target: ProxyTarget; path: string } | null {
    for (const target of ['webm', 'mp4'] as const) {
      const path = this.proxyPath(assetId, target)
      if (existsSync(path)) return { target, path }
    }
    return null
  }

  statusOf(assetId: string): ProxyInfo {
    const job = this.jobs.get(assetId)
    if (job !== undefined) {
      return { status: 'running', target: job.target, progress: job.progress, error: null }
    }
    if (this.queue.some((q) => q.assetId === assetId)) {
      return { status: 'queued', target: null, progress: null, error: null }
    }
    const ready = this.readyFile(assetId)
    if (ready !== null) {
      return { status: 'ready', target: ready.target, progress: 1, error: null }
    }
    const failed = this.failures.get(assetId)
    if (failed !== undefined) {
      return { status: 'failed', target: null, progress: null, error: failed }
    }
    return { status: 'none', target: null, progress: null, error: null }
  }

  /** Start (or queue) a proxy transcode; idempotent — ready stays ready. */
  ensure(assetId: string, srcPath: string, target: ProxyTarget): ProxyInfo {
    if (this.opts.ffmpeg === null) {
      throw new ProxyError('unavailable', 'ffmpeg was not found on this host — install it (e.g. `sudo apt install ffmpeg`) and restart the host')
    }
    const status = this.statusOf(assetId)
    if (status.status === 'ready' || status.status === 'running' || status.status === 'queued') return status
    if (!existsSync(srcPath)) throw new ProxyError('not_found', `source file is gone: ${srcPath}`)
    this.failures.delete(assetId)
    this.queue.push({ assetId, target, src: srcPath })
    this.pump()
    return this.statusOf(assetId)
  }

  cancel(assetId: string): boolean {
    const queued = this.queue.findIndex((q) => q.assetId === assetId)
    if (queued >= 0) {
      this.queue.splice(queued, 1)
      return true
    }
    const job = this.jobs.get(assetId)
    if (job !== undefined) {
      job.child.kill('SIGTERM')
      return true
    }
    return false
  }

  /** Kill everything — called from the capability's fiber effect. */
  dispose(): void {
    this.disposed = true
    for (const job of this.jobs.values()) job.child.kill('SIGKILL')
    this.jobs.clear()
    this.queue.length = 0
  }

  activeJobs(): number {
    return this.jobs.size + this.queue.length
  }

  private static readonly MAX_CONCURRENT = 1

  private pump(): void {
    if (this.disposed) return
    while (this.jobs.size < ProxyManager.MAX_CONCURRENT) {
      const next = this.queue.shift()
      if (next === undefined) return
      this.start(next.assetId, next.src, next.target)
    }
  }

  private start(assetId: string, src: string, target: ProxyTarget): void {
    const ffmpeg = this.opts.ffmpeg
    if (ffmpeg === null) return
    const out = `${this.proxyPath(assetId, target)}.part`
    rmSync(out, { force: true })
    const duration = this.opts.durationOf(assetId)
    const args = [
      '-hide_banner', '-nostdin',
      '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?',
      // Even dimensions: encoders reject odd ones; a proxy must never fail on shape.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ...RECIPES[target],
      '-progress', 'pipe:1', '-nostats',
      '-y', out,
    ]
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const job: Job = { assetId, target, child, progress: 0, error: null }
    this.jobs.set(assetId, job)
    this.opts.log.info(`代理转码开始: ${assetId} → ${target}`, { src, duration })

    let stdoutBuf = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString()
      let idx = stdoutBuf.indexOf('\n')
      while (idx >= 0) {
        const line = stdoutBuf.slice(0, idx)
        stdoutBuf = stdoutBuf.slice(idx + 1)
        idx = stdoutBuf.indexOf('\n')
        const m = /^out_time_us=(\d+)$/.exec(line)
        if (m !== null && duration !== null && duration > 0) {
          job.progress = Math.max(0, Math.min(1, Number(m[1]) / 1e6 / duration))
        }
      }
    })
    let stderrTail = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000)
    })
    child.on('exit', (code, signal) => {
      this.jobs.delete(assetId)
      if (this.disposed) {
        rmSync(out, { force: true })
        this.pump()
        return
      }
      if (code === 0 && existsSync(out)) {
        renameSync(out, this.proxyPath(assetId, target))
        this.opts.log.info(`代理就绪: ${assetId} (${target})`)
      } else {
        rmSync(out, { force: true })
        const why = `ffmpeg exited code=${String(code)} signal=${String(signal)}: ${stderrTail.split('\n').filter(Boolean).pop() ?? 'no stderr'}`
        this.failures.set(assetId, why)
        this.opts.log.warn(`代理失败: ${assetId}`, { code, signal })
      }
      this.pump()
    })
    child.on('error', (e) => {
      this.jobs.delete(assetId)
      rmSync(out, { force: true })
      this.failures.set(assetId, `spawn failed: ${e.message}`)
      this.opts.log.warn(`代理无法启动: ${assetId}`, { error: e.message })
      this.pump()
    })
  }
}

/** Probe ffmpeg BY EXECUTION (never by path guessing): version string or null. */
export function probeFfmpeg(bin: string): { path: string; version: string } | null {
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    if (r.status !== 0) return null
    const first = (r.stdout ?? '').split('\n')[0]?.trim() ?? ''
    return { path: bin, version: first === '' ? 'unknown' : first }
  } catch {
    return null
  }
}
