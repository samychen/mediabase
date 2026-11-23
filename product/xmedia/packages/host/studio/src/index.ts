// @xmedia/host-studio — the capability that owns the HF Studio web app
// (the vendored Python stdlib server under product/xmedia/studio/).
//
// Boundary (the base's one layering rule, applied to this slice):
//   * the Studio serves ITS OWN editor UI + REST API on its own loopback
//     port; the browser talks to it DIRECTLY, like it talks to MediaMTX.
//     The host never proxies studio bytes — no data-plane routes here.
//   * control plane: process supervision (spawn / restart policy / events),
//     the deployment seams (bake binary env, projects root via the product
//     identity home ~/.xmedia — the Studio's upstream default aligns with it
//     on purpose), and the state/url surface the acceptance page links to.
//
// The child is a LONG-RUNNING `python3 hf_studio.py --serve --home` process —
// an HTTP server, NOT the engine line protocol, so this capability spawns it
// directly instead of using @mediabase/engine-client (which would impose a
// tab-line FIFO the Studio does not speak). Supervision policy still lives in
// the product: auto-restart with a cap, fast-death detection, ctx.effect
// cleanup — the same shape the engine capability applies.

import { spawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { RpcCode, RpcError } from '@mediabase/rpc'
import { parse, z, type Schema } from '@mediabase/schema'
import type {} from '@mediabase/api'
import type {} from '@mediabase/log'
import type {} from '@mediabase/tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** HF Studio web-app facade (the supervised Python server). */
    'xmedia-studio': XmediaStudioService
  }
}

export interface XmediaStudioState {
  running: boolean
  pid: number | null
  /** Loopback URL the browser opens: http://127.0.0.1:<port>/ */
  url: string
  port: number
  restarts: number
  script: string
  python: string
}

export interface XmediaStudioService {
  state(): XmediaStudioState
  url(): string
  restart(): Promise<XmediaStudioState>
}

export const name = 'xmedia-studio'

export const inject = ['api', 'capabilities', 'tools', 'log'] as const

export interface XmediaStudioConfig {
  /** Interpreter for the vendored Studio server. */
  pythonBin: string
  /** hf_studio.py path (the vendored copy, not the kit checkout). */
  scriptPath: string
  /** Loopback port the Studio binds (upstream default 8120). */
  port: number
  /** Serve the Home (project-management) page at `/`, not a single contract. */
  homeMode: boolean
  /** Absolute path handed to the Studio as XMEDIA_BAKE_BIN — its export and
   *  storyboard-frame features shell out to the bake CLI. Empty = the
   *  Studio's own bake_bin() seam (env > product sibling probe). */
  bakeBinary: string
  autoStart: boolean
  autoRestart: boolean
  maxRestarts: number
  restartDelayMs: number
}

export const Config: Schema<XmediaStudioConfig, XmediaStudioConfig> = z.object({
  pythonBin: z.string().default('python3').description('运行 Studio 服务器的解释器'),
  scriptPath: z.string().default('')
    .description('hf_studio.py 路径;空 = 组合层的 appPaths 默认(随产品分发)'),
  port: z.number().default(8120).description('Studio 绑定的 loopback 端口(仅 127.0.0.1)'),
  homeMode: z.boolean().default(true).description('以 --home 启动:/ 为项目管理页'),
  bakeBinary: z.string().default('')
    .description('烘焙 CLI 绝对路径,经 XMEDIA_BAKE_BIN 传给 Studio(导出/分镜帧);空 = Studio 自身 bake_bin 接缝'),
  autoStart: z.boolean().default(true).description('宿主启动时拉起 Studio'),
  autoRestart: z.boolean().default(true).description('Studio 进程退出后自动重启'),
  maxRestarts: z.number().default(3).description('重启次数上限'),
  restartDelayMs: z.number().default(500).description('重启延迟(ms)'),
})

/** Control-plane methods this capability registers (kept in one place for the manifest). */
export const API_NAMES = [
  'xmedia.studio.state',
  'xmedia.studio.url',
  'xmedia.studio.restart',
] as const

/** Tools exposed to the agent / MCP bridge (same verbs, one declaration). */
export const TOOL_NAMES = [
  'xmedia.studio.state',
  'xmedia.studio.url',
  'xmedia.studio.restart',
] as const

const StateParamsS = z.object({})

function isAlive(child: ChildProcess | null): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null
}

export function apply(ctx: Context, rawConfig: XmediaStudioConfig): void {
  const config = parse(Config, rawConfig)
  const log = ctx.log.child(name)
  const disposers: Array<() => void> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  let child: ChildProcess | null = null
  let restarts = 0
  let disposed = false

  function startStudio(): void {
    if (disposed) return
    const args = [config.scriptPath, '--serve', '--home', '--port', String(config.port)]
    // The Studio shells out to ffmpeg/ffprobe and the bake CLI; XMEDIA_BAKE_BIN
    // is its documented seam for the latter (vendored xmedia.py bake_bin()).
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (config.bakeBinary !== '') env.XMEDIA_BAKE_BIN = config.bakeBinary
    const spawned = spawn(config.pythonBin, args, {
      env,
      // stdout carries nothing load-bearing; diagnostics go to stderr and are
      // routed into the scoped logger like the engine's are.
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child = spawned
    log.info('hf-studio 已启动', { url: service.url(), pid: spawned.pid ?? null })
    ctx.events.emit('xmedia.studio', { phase: 'start', url: service.url(), pid: spawned.pid ?? null })
    spawned.stderr?.on('data', (chunk: Buffer) => {
      const line = String(chunk).trimEnd()
      if (line !== '') log.debug('[hf-studio]', { line })
    })
    spawned.on('exit', (code, signal) => {
      // A restart kills the old child and immediately starts a new one. The
      // old process's async "exit" must not clear the NEW child reference —
      // that made health report running=false right after a successful restart.
      if (child === spawned) child = null
      if (disposed) return
      log.warn('hf-studio 进程退出', { code, signal })
      ctx.events.emit('xmedia.studio', { phase: 'exit', code, signal })
      if (!config.autoRestart || restarts >= config.maxRestarts) return
      restarts += 1
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!disposed) startStudio()
      }, config.restartDelayMs)
      timers.add(timer)
    })
  }

  function stopStudio(): void {
    const target = child
    if (target !== null && isAlive(target)) target.kill('SIGTERM')
    if (child === target) child = null
  }

  const service: XmediaStudioService = {
    state(): XmediaStudioState {
      return {
        running: isAlive(child),
        pid: isAlive(child) ? child?.pid ?? null : null,
        url: service.url(),
        port: config.port,
        restarts,
        script: config.scriptPath,
        python: config.pythonBin,
      }
    },
    url(): string {
      return `http://127.0.0.1:${config.port}/`
    },
    async restart(): Promise<XmediaStudioState> {
      if (disposed) {
        throw new RpcError(RpcCode.ENGINE, 'xmedia-studio: capability already disposed')
      }
      stopStudio()
      startStudio()
      return service.state()
    },
  }
  ctx.reflect.provide('xmedia-studio', service)

  disposers.push(ctx.api.register({
    name: 'xmedia.studio.state',
    description: 'HF Studio 状态(运行/端口/浏览器入口 URL/重启计数)',
    params: StateParamsS,
    handler: () => service.state(),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.studio.url',
    description: 'HF Studio 浏览器入口(宿主不代理任何 Studio 字节,浏览器直连)',
    params: StateParamsS,
    handler: () => ({ url: service.url() }),
  }))
  disposers.push(ctx.api.register({
    name: 'xmedia.studio.restart',
    description: '重启 HF Studio 服务器(SIGTERM + 监督策略拉起)',
    mutates: true,
    params: StateParamsS,
    handler: () => service.restart(),
  }))

  const tool = (method: Parameters<typeof ctx.tools.register>[0]): void => {
    disposers.push(ctx.tools.register(method))
  }
  tool({
    name: 'xmedia.studio.state',
    description: '查询 HF Studio 状态与浏览器入口 URL',
    params: StateParamsS,
    execute: () => service.state(),
  })
  tool({
    name: 'xmedia.studio.url',
    description: '获取 HF Studio 浏览器入口 URL(项目/分镜/时间线/导出的编辑器)',
    params: StateParamsS,
    execute: () => ({ url: service.url() }),
  })
  tool({
    name: 'xmedia.studio.restart',
    description: '重启 HF Studio 服务器',
    mutates: true,
    params: StateParamsS,
    execute: () => service.restart(),
  })

  disposers.push(ctx.capabilities.register({
    id: name,
    title: 'HF Studio 编辑器',
    description: 'HyperFrames 对齐的视频创作工作台(Home 项目管理 / agent 对话 / 分镜叙事 / 时间线 / 导出),作为独立 Python 进程运行在 loopback 端口;浏览器直连,宿主只做监督与入口分发',
    services: [name],
    api: [...API_NAMES],
    tools: [...TOOL_NAMES],
    events: ['xmedia.studio'],
  }))
  disposers.push(ctx.api.health(() => ({
    studio: service.state(),
  })))

  if (config.autoStart) startStudio()

  ctx.effect(() => () => {
    disposed = true
    for (const dispose of disposers) dispose()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    stopStudio()
  }, `${name}: studio`)
}
