// @openvideo/host-media — host plugin: the OpenVideo capability.
//
// What the upstream app's Workers server did (assets, projects, exports),
// done the mediabase way: a capability that registers its OWN surface —
// methods and byte routes into ctx.api, the agent's operation set into
// ctx.tools, a manifest into ctx.capabilities — so the base server and shell
// never name it. Control plane carries commands; the asset BYTES travel on
// the data plane (`GET /api/openvideo.asset.<id>`), and browser uploads come
// in as ordered base64 chunks (the WS frame cap is 1 MB, so a file is many
// frames, never one).
//
// The API surface mirrors clawnify/OpenVideo's REST contract (MIT) method for
// method where it applies locally; the managed-service parts (Drive import,
// hosted transcription/analysis/export) are replaced by their local seams:
// import-by-path, transcript sidecars, and a browser-side export.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { parse, z, type Schema } from '@mediabase/schema'
import { RpcCode, RpcError } from '@mediabase/rpc'
import {
  OPS,
  applyOp,
  opArgs,
  starterEdl,
  validateEdl,
  type Edl,
} from '@openvideo/edl'
// Type-only: ctx.log / ctx.api / ctx.tools / ctx.capabilities are declared by
// the base packages; the imports keep this package compilable STANDALONE.
import type {} from '@mediabase/log'
import type {} from '@mediabase/api'
import type {} from '@mediabase/tools'
import { MediaStore, guessContentType, type AssetRow, type ProjectRow } from './store.ts'
import { startAssetsServer, type AssetsServer } from './assets-http.ts'
import { ProxyError, ProxyManager, probeFfmpeg, type ProxyInfo, type ProxyTarget } from './proxy.ts'
import { UploadManager, UploadError } from './uploads.ts'

export const name = 'openvideo'

export const inject = ['api', 'capabilities', 'tools', 'log'] as const

/** 512 KiB per chunk → ~700 KiB of base64 JSON, inside the 1 MB WS cap. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024

export interface OpenvideoConfig {
  /** Media library directory (default `<appPaths.home>/media`). */
  mediaDir?: string
  /** Project shelf directory (default `<appPaths.home>/projects`). */
  projectDir?: string
  /** Ceiling for one browser upload (default 512 MB). */
  maxUploadBytes?: number
  /** Preferred port of the Range-aware assets sidecar (default 3095). */
  assetsPort?: number
  /** ffmpeg executable for proxy transcoding (default `ffmpeg` on PATH). */
  ffmpegPath?: string
}

export const Config: Schema<OpenvideoConfig, OpenvideoConfig> = z.object({
  mediaDir: z.string().description('media library directory; default <appPaths.home>/media'),
  projectDir: z.string().description('project directory; default <appPaths.home>/projects'),
  maxUploadBytes: z.natural().default(512 * 1024 * 1024).description('upload ceiling in bytes'),
  assetsPort: z.natural().default(3095).description('Range-aware assets sidecar port'),
  ffmpegPath: z.string().default('ffmpeg').description('ffmpeg binary for proxy transcoding'),
})

// ---- wire schemas (results are validated too: a capability that breaks its
// own contract fails loudly instead of shipping a malformed payload) ---------

const nullS = z.const(null)
const assetFields = {
  id: z.string().required(),
  key: z.string().required(),
  name: z.string().required(),
  contentType: z.string().required(),
  size: z.natural().required(),
  createdAt: z.string().required(),
  // nullable: `.required()` in this dialect means non-null, so a null-able field stays unrequired.
  duration: z.union([z.number(), nullS]),
  hasTranscript: z.boolean().required(),
}
const ProxyS = z.object({
  status: z.union([z.const('none'), z.const('queued'), z.const('running'), z.const('ready'), z.const('failed')]).required(),
  target: z.union([z.const('webm'), z.const('mp4'), nullS]),
  progress: z.union([z.number(), nullS]),
  error: z.union([z.string(), nullS]),
})
const AssetS = z.object({ ...assetFields, proxy: ProxyS.required() })
const summaryFields = {
  id: z.string().required(),
  name: z.string().required(),
  brief: z.string().required(),
  createdAt: z.string().required(),
  updatedAt: z.string().required(),
  coverAsset: z.union([z.string(), nullS]),
  coverAt: z.union([z.number(), nullS]),
}
const SummaryS = z.object(summaryFields)
const ProjectS = z.object({
  ...summaryFields,
  // The document itself was validated on every write; re-validating on every
  // read would double the cost of a list refresh for no new honesty.
  edl: z.any().required(),
})
const OkS = z.object({ ok: z.const(true).required() })
/** One shared literal so every `{ ok: true }` handler satisfies the const schema's type. */
const OK: { ok: true } = { ok: true }
const AssetsS = z.object({ assets: z.array(AssetS).required() })
const AssetS1 = z.object({ asset: AssetS.required() })
const SummariesS = z.object({ projects: z.array(SummaryS).required() })
const ProjectS1 = z.object({ project: ProjectS.required() })
const OpS = z.object({ project: ProjectS.required(), said: z.string().required() })
const TranscriptS = z.object({
  status: z.union([z.const('ready'), z.const('no_speech'), z.const('unavailable')]).required(),
  vtt: z.string().required(),
})

/** Every method name this capability contributes (the manifest states exactly these). */
export const API_METHODS = [
  'openvideo.assets.endpoint',
  'openvideo.assets.list',
  'openvideo.assets.import',
  'openvideo.assets.upload.begin',
  'openvideo.assets.upload.chunk',
  'openvideo.assets.upload.end',
  'openvideo.assets.upload.cancel',
  'openvideo.assets.probe',
  'openvideo.assets.transcript',
  'openvideo.assets.transcript.set',
  'openvideo.assets.remove',
  'openvideo.projects.list',
  'openvideo.projects.get',
  'openvideo.projects.create',
  'openvideo.projects.update',
  'openvideo.projects.remove',
  'openvideo.projects.op',
  'openvideo.proxy.info',
  'openvideo.proxy.status',
  'openvideo.proxy.ensure',
  'openvideo.proxy.cancel',
] as const

/** The CRUD tools beside the operation tools (which come from OPS). */
export const CRUD_TOOLS = [
  'openvideo.assets.list',
  'openvideo.proxy.info',
  'openvideo.proxy.ensure',
  'openvideo.projects.list',
  'openvideo.projects.get',
  'openvideo.projects.create',
  'openvideo.projects.save_edl',
] as const

export function apply(ctx: Context, rawConfig: OpenvideoConfig): void {
  const config = parse(Config, rawConfig ?? {})
  const log = ctx.log.child(name)

  // The identity home decides where the product's files live (settings does
  // the same): ~/.openvideo for the product identity, whatever a deployment
  // moved it to otherwise — never a hardcoded product path in a base package.
  const appPaths = ctx.get('appPaths') as { home?: string } | undefined
  const home = appPaths?.home ?? join(homedir(), '.openvideo')
  const mediaDir = config.mediaDir ?? join(home, 'media')
  const projectDir = config.projectDir ?? join(home, 'projects')
  const tmpDir = join(mediaDir, '.uploads')

  const store = new MediaStore({ mediaDir, projectDir })
  store.ensure()
  mkdirSync(tmpDir, { recursive: true })

  // Proxy transcoding: probed BY EXECUTION, absent ffmpeg degrades to a coded
  // UNAVAILABLE on ensure() — never a broken boot, never a silent no-op.
  const ffmpegProbe = probeFfmpeg(config.ffmpegPath ?? 'ffmpeg')
  const proxies = new ProxyManager({
    dir: join(mediaDir, 'proxies'),
    ffmpeg: ffmpegProbe?.path ?? null,
    ffmpegVersion: ffmpegProbe?.version ?? null,
    log,
    durationOf: (id) => store.getAsset(id)?.duration ?? null,
  })
  if (ffmpegProbe === null) log.info('未检测到 ffmpeg — 代理转码不可用(其余功能不受影响)')

  // The Range-aware byte plane (see assets-http.ts): media elements need a
  // seekable response; the base gateway route answers whole bodies.
  let assetsServer: AssetsServer | null = null
  assetsServer = startAssetsServer({
    store,
    proxyFile: (id) => {
      const ready = proxies.readyFile(id)
      if (ready === null) return null
      return { path: ready.path, contentType: ready.target === 'mp4' ? 'video/mp4' : 'video/webm' }
    },
    port: config.assetsPort ?? 3095,
    onError: (e) => log.warn('素材边车首选端口被占,改用随机端口', {
      error: e instanceof Error ? e.message : String(e),
    }),
  })
  ctx.effect(() => () => {
    assetsServer?.close()
    assetsServer = null
  }, `${name}: assets sidecar`)

  const uploads = new UploadManager({
    tmpDir,
    maxUploadBytes: config.maxUploadBytes ?? 512 * 1024 * 1024,
    ttlMs: 30 * 60_000,
  })

  // ---- data plane: one byte route per asset --------------------------------
  // The gateway's route handler takes no request, so "which asset" is in the
  // route NAME; the registry is live, so an asset is servable the moment it
  // lands and its route dies with the asset (or the fiber).

  const routeDisposers = new Map<string, () => void>()
  const serveAsset = (row: AssetRow): void => {
    const routeName = `openvideo.asset.${row.id}`
    if (routeDisposers.has(routeName)) return
    const dispose = ctx.api.route({
      name: routeName,
      description: `bytes of asset ${row.id} (${row.name})`,
      handler: () => {
        const file = store.assetPath(row)
        if (!existsSync(file)) return { body: null }
        return {
          body: new Uint8Array(readFileSync(file)),
          // Lowercase keys: the gateway writes its own lowercase defaults into
          // the same head object — a capitalized duplicate would be sent twice.
          // Ids are never reused, so bytes under one id are immutable.
          headers: { 'content-type': row.contentType, 'cache-control': 'public, max-age=31536000' },
        }
      },
    })
    routeDisposers.set(routeName, dispose)
  }
  const unserveAsset = (id: string): void => {
    const routeName = `openvideo.asset.${id}`
    routeDisposers.get(routeName)?.()
    routeDisposers.delete(routeName)
  }
  for (const row of store.listAssets()) serveAsset(row)

  // Every side effect is a fiber effect: the sweep timer, the tmp dir and the
  // per-asset routes all die with this capability's fiber.
  ctx.effect(() => {
    const timer = setInterval(() => {
      const dropped = uploads.sweep()
      if (dropped > 0) log.info(`reaped ${dropped} stalled upload session(s)`)
    }, 60_000)
    return () => {
      clearInterval(timer)
      proxies.dispose()
      for (const dispose of routeDisposers.values()) dispose()
      routeDisposers.clear()
    }
  }, `${name}: upload sweep + asset routes + proxy jobs`)

  // ---- helpers --------------------------------------------------------------

  /** API rows carry the live proxy facet; the store keeps files-only truth. */
  const wire = (row: AssetRow): AssetRow & { proxy: ProxyInfo } => ({ ...row, proxy: proxies.statusOf(row.id) })

  const mustAsset = (id: string): AssetRow => {
    const row = store.getAsset(id)
    if (row === null) {
      throw RpcError.notFound(`no such asset "${id}"`, undefined, {
        messageKey: 'openvideo.assetNotFound',
        messageParams: { id },
      })
    }
    return row
  }

  const mustProject = (id: string): ProjectRow => {
    const row = store.getProject(id)
    if (row === null) {
      throw RpcError.notFound(`no such project "${id}"`, undefined, {
        messageKey: 'openvideo.projectNotFound',
        messageParams: { id },
      })
    }
    return row
  }

  /** Validate an incoming document; a refusal carries the JSON pointer. */
  const mustEdl = (input: unknown): Edl => {
    const v = validateEdl(input)
    if ('invalid' in v) {
      throw new RpcError(
        RpcCode.INVALID_PARAMS,
        `EDL invalid: ${v.invalid.detail}${v.invalid.path !== undefined ? ` @ ${v.invalid.path}` : ''}`,
        { detail: v.invalid.detail, ...(v.invalid.path !== undefined ? { path: v.invalid.path } : {}) },
        {
          messageKey: 'openvideo.edlInvalid',
          messageParams: {
            detail: v.invalid.detail,
            path: v.invalid.path ?? '—',
          },
        },
      )
    }
    return v.edl
  }

  /** Load → transform (checked op) → validate → save: one edit, one undo. */
  const runOp = (projectId: string, op: string, args: Record<string, unknown>): { project: ProjectRow; said: string } => {
    const project = mustProject(projectId)
    const draft = structuredClone(project.edl)
    const out = applyOp(draft, op, args)
    if ('error' in out) {
      throw new RpcError(RpcCode.INVALID_PARAMS, `${op}: ${out.error}`, { op, detail: out.error }, {
        messageKey: 'openvideo.opFailed',
        messageParams: { op, detail: out.error },
      })
    }
    const edl = mustEdl(draft)
    const updated: ProjectRow = { ...project, edl, updatedAt: new Date().toISOString() }
    store.saveProject(updated)
    return { project: updated, said: out.said }
  }

  const uploadError = (e: UploadError): RpcError => {
    if (e.kind === 'not_found') return RpcError.notFound(e.message)
    if (e.kind === 'too_large') {
      return new RpcError(RpcCode.CONFLICT, e.message, undefined, {
        messageKey: 'openvideo.uploadTooLarge',
        messageParams: { max: String(uploadsMax()) },
      })
    }
    return new RpcError(RpcCode.CONFLICT, e.message)
  }
  const uploadsMax = (): number => config.maxUploadBytes ?? 512 * 1024 * 1024

  // ---- control plane --------------------------------------------------------

  ctx.api.register({
    name: 'openvideo.assets.endpoint',
    description: '素材边车(base URL):支持 Range 的本地 HTTP,媒体元素应从这里拉字节',
    params: z.object({}),
    result: z.object({ base: z.string().required(), port: z.natural().required() }),
    handler: () => {
      const port = assetsServer?.port() ?? 0
      return { base: `http://127.0.0.1:${port}`, port }
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.list',
    description: '媒体库列表(名称/类型/大小/时长/是否有字幕稿)',
    params: z.object({}),
    result: AssetsS,
    handler: () => ({ assets: store.listAssets().map(wire) }),
  })

  ctx.api.register({
    name: 'openvideo.assets.import',
    description: '把宿主本机的一个文件复制进媒体库(本地信任边界;路径必须已存在)',
    mutates: true,
    params: z.object({
      path: z.string().min(1).description('absolute path on the host').required(),
      duration: z.number().min(0).description('seconds, when the caller already knows it'),
    }),
    result: AssetS1,
    handler: (p) => {
      if (!existsSync(p.path) || !statSync(p.path).isFile()) {
        throw new RpcError(RpcCode.INVALID_PARAMS, `not a readable file: ${p.path}`, undefined, {
          messageKey: 'openvideo.importNotFile',
          messageParams: { path: p.path },
        })
      }
      const asset = store.importFile(p.path, typeof p.duration === 'number' && p.duration > 0 ? p.duration : null)
      serveAsset(asset)
      log.info(`imported "${asset.name}" (${asset.size} bytes) as ${asset.id}`)
      return { asset: wire(asset) }
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.upload.begin',
    description: '开始一次浏览器分块上传;返回会话 id 与建议块大小',
    mutates: true,
    params: z.object({
      name: z.string().min(1).required(),
      size: z.natural().min(1).required(),
      contentType: z.string(),
      duration: z.number().min(0),
    }),
    result: z.object({ uploadId: z.string().required(), chunkBytes: z.natural().required() }),
    handler: (p) => {
      try {
        const session = uploads.begin({
          name: p.name,
          contentType: p.contentType ?? guessContentType(p.name),
          size: p.size,
          duration: typeof p.duration === 'number' && p.duration > 0 ? p.duration : null,
        })
        return { uploadId: session.id, chunkBytes: UPLOAD_CHUNK_BYTES }
      } catch (e) {
        throw e instanceof UploadError ? uploadError(e) : e
      }
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.upload.chunk',
    description: '追加一个 base64 块(必须按序;超出声明大小即拒绝)',
    mutates: true,
    params: z.object({
      uploadId: z.string().required(),
      index: z.natural().required(),
      data: z.string().description('base64 of at most chunkBytes').required(),
    }),
    result: z.object({ received: z.natural().required() }),
    handler: (p) => {
      try {
        return { received: uploads.chunk(p.uploadId, p.index, p.data).received }
      } catch (e) {
        throw e instanceof UploadError ? uploadError(e) : e
      }
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.upload.end',
    description: '结束上传:校验收满声明的字节数,把文件收进媒体库',
    mutates: true,
    params: z.object({ uploadId: z.string().required() }),
    result: AssetS1,
    handler: (p) => {
      try {
        const session = uploads.end(p.uploadId)
        const asset = store.addAsset(
          { name: session.name, contentType: session.contentType, size: session.size, duration: session.duration },
          session.path,
        )
        serveAsset(asset)
        log.info(`uploaded "${asset.name}" (${asset.size} bytes) as ${asset.id}`)
        return { asset: wire(asset) }
      } catch (e) {
        throw e instanceof UploadError ? uploadError(e) : e
      }
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.upload.cancel',
    description: '放弃一次进行中的上传',
    mutates: true,
    params: z.object({ uploadId: z.string().required() }),
    result: OkS,
    handler: (p) => {
      uploads.cancel(p.uploadId)
      return OK
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.probe',
    description: '回填客户端探测到的媒体时长(秒)',
    mutates: true,
    params: z.object({
      id: z.string().required(),
      duration: z.number().min(0).required(),
    }),
    result: AssetS1,
    handler: (p) => {
      mustAsset(p.id)
      const asset = store.setDuration(p.id, p.duration)
      if (asset === null) throw RpcError.notFound(`no such asset "${p.id}"`)
      return { asset: wire(asset) }
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.transcript',
    description: '取素材的字幕稿(用户附加的 .vtt 边车);没有则 unavailable',
    params: z.object({ id: z.string().required() }),
    result: TranscriptS,
    handler: (p): { status: 'ready' | 'no_speech' | 'unavailable'; vtt: string } => {
      mustAsset(p.id)
      const vtt = store.getTranscript(p.id)
      if (vtt === null) return { status: 'unavailable', vtt: '' }
      return vtt.trim() === '' ? { status: 'no_speech', vtt: '' } : { status: 'ready', vtt }
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.transcript.set',
    description: '给素材附加字幕稿(WebVTT 文本;空串清除)',
    mutates: true,
    params: z.object({
      id: z.string().required(),
      vtt: z.string().required(),
    }),
    result: OkS,
    handler: (p) => {
      mustAsset(p.id)
      store.setTranscript(p.id, p.vtt)
      return OK
    },
  })

  ctx.api.register({
    name: 'openvideo.assets.remove',
    description: '从媒体库删除;仍被项目引用时拒绝并点名(CONFLICT)',
    mutates: true,
    params: z.object({ id: z.string().required() }),
    result: OkS,
    handler: (p) => {
      mustAsset(p.id)
      // Deleting footage a project still uses would leave that project with a
      // clip pointing at nothing. Say where it is used.
      const users = store.projectsUsingAsset(p.id)
      if (users.length > 0) {
        throw new RpcError(
          RpcCode.CONFLICT,
          `still used in ${users.map((u) => `"${u}"`).join(', ')}`,
          { projects: users },
          { messageKey: 'openvideo.assetInUse', messageParams: { projects: users.join(', ') } },
        )
      }
      unserveAsset(p.id)
      store.removeAsset(p.id)
      return OK
    },
  })

  ctx.api.register({
    name: 'openvideo.projects.list',
    description: '项目列表(按更新时间倒序;封面=主轨第一个片段)',
    params: z.object({}),
    result: SummariesS,
    handler: () => ({ projects: store.listProjects() }),
  })

  ctx.api.register({
    name: 'openvideo.projects.get',
    description: '取一个项目(含完整 EDL 文档)',
    params: z.object({ id: z.string().required() }),
    result: ProjectS1,
    handler: (p) => ({ project: mustProject(p.id) }),
  })

  ctx.api.register({
    name: 'openvideo.projects.create',
    description: '新建项目;省略 edl 时为空的 720p 时间线',
    mutates: true,
    params: z.object({
      name: z.string().min(1).max(200).required(),
      brief: z.string().max(2000).description('what the video is for (the agent reads it)'),
      edl: z.any(),
    }),
    result: ProjectS1,
    handler: (p) => {
      const edl = p.edl === undefined ? starterEdl() : mustEdl(p.edl)
      const project = store.createProject({
        name: p.name.trim(),
        ...(p.brief !== undefined ? { brief: p.brief.trim() } : {}),
        edl,
      })
      log.info(`created project "${project.name}" (${project.id})`)
      return { project }
    },
  })

  ctx.api.register({
    name: 'openvideo.projects.update',
    description: '改名/改简介/存整份 EDL(存前校验;错误带 JSON 指针)',
    mutates: true,
    params: z.object({
      id: z.string().required(),
      name: z.string().min(1).max(200),
      brief: z.string().max(2000),
      edl: z.any(),
    }),
    result: ProjectS1,
    handler: (p) => {
      const project = mustProject(p.id)
      const edl = p.edl === undefined ? project.edl : mustEdl(p.edl)
      const updated: ProjectRow = {
        ...project,
        name: p.name !== undefined && p.name.trim() !== '' ? p.name.trim() : project.name,
        brief: p.brief !== undefined ? p.brief.trim() : project.brief,
        edl,
        updatedAt: new Date().toISOString(),
      }
      store.saveProject(updated)
      return { project: updated }
    },
  })

  ctx.api.register({
    name: 'openvideo.projects.remove',
    description: '删除项目(文件即删,无回收站)',
    mutates: true,
    params: z.object({ id: z.string().required() }),
    result: OkS,
    handler: (p) => {
      mustProject(p.id)
      store.removeProject(p.id)
      return OK
    },
  })

  ctx.api.register({
    name: 'openvideo.projects.op',
    description: '对项目应用一个受检操作(trim/split/add_text/…)并保存;一次调用一步可撤销',
    mutates: true,
    params: z.object({
      id: z.string().required(),
      op: z.string().min(1).required(),
      args: z.dict(z.any()).description('operation arguments (no project id)'),
    }),
    result: OpS,
    handler: (p) => runOp(p.id, p.op, p.args ?? {}),
  })

  // ---- proxy transcoding (the local answer to "this browser cannot decode that")

  const proxyError = (e: ProxyError, id: string): RpcError => {
    if (e.kind === 'unavailable') {
      return RpcError.unavailable(e.message, undefined, { messageKey: 'openvideo.proxyNoFfmpeg' })
    }
    if (e.kind === 'not_found') return RpcError.notFound(e.message)
    return new RpcError(RpcCode.CONFLICT, e.message, undefined, {
      messageKey: 'openvideo.proxyFailed',
      messageParams: { id, detail: e.message },
    })
  }

  ctx.api.register({
    name: 'openvideo.proxy.info',
    description: '代理转码能力:ffmpeg 是否可用(按执行探测)、支持的 targets、在跑的活',
    params: z.object({}),
    result: z.object({
      ffmpeg: z.boolean().required(),
      version: z.union([z.string(), nullS]),
      targets: z.array(z.string()).required(),
      jobs: z.natural().required(),
    }),
    handler: () => ({ ...proxies.info(), jobs: proxies.activeJobs() }),
  })

  ctx.api.register({
    name: 'openvideo.proxy.status',
    description: '一个素材的代理状态(none/queued/running/ready/failed + 进度)',
    params: z.object({ id: z.string().required() }),
    result: z.object({ proxy: ProxyS.required() }),
    handler: (p) => {
      mustAsset(p.id)
      return { proxy: proxies.statusOf(p.id) }
    },
  })

  ctx.api.register({
    name: 'openvideo.proxy.ensure',
    description: '为素材生成(或排队)浏览器友好的播放代理:webm=VP9/Opus(全平台),mp4=H.264/AAC;幂等',
    mutates: true,
    params: z.object({
      id: z.string().required(),
      target: z.union([z.const('webm'), z.const('mp4')]).description('default webm (decodable everywhere without codec packs)'),
    }),
    result: z.object({ proxy: ProxyS.required() }),
    handler: (p) => {
      const row = mustAsset(p.id)
      try {
        return { proxy: proxies.ensure(p.id, store.assetPath(row), (p.target ?? 'webm') as ProxyTarget) }
      } catch (e) {
        throw e instanceof ProxyError ? proxyError(e, p.id) : e
      }
    },
  })

  ctx.api.register({
    name: 'openvideo.proxy.cancel',
    description: '取消一个排队/进行中的代理转码',
    mutates: true,
    params: z.object({ id: z.string().required() }),
    result: OkS,
    handler: (p) => {
      mustAsset(p.id)
      proxies.cancel(p.id)
      return OK
    },
  })

  // ---- agent tools ----------------------------------------------------------
  //
  // "Ask for a change" and any agent.run prompt act through THESE, never by
  // writing the document: fixed, checked operations, each one save.

  ctx.tools.register({
    name: 'openvideo.assets.list',
    description: 'List the media library: [{ id, name, contentType, size, duration, hasTranscript }]. Projects reference a file as "asset:<id>".',
    execute: () => store.listAssets().map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size, duration: a.duration, hasTranscript: a.hasTranscript })),
  })

  ctx.tools.register({
    name: 'openvideo.projects.list',
    description: 'List video projects: [{ id, name, brief, updatedAt }].',
    execute: () => store.listProjects().map((p) => ({ id: p.id, name: p.name, brief: p.brief, updatedAt: p.updatedAt })),
  })

  ctx.tools.register({
    name: 'openvideo.projects.get',
    description: 'Read one project: its brief and the full EDL document (plain JSON — read it, transform it, save it back with openvideo_projects_save_edl).',
    params: z.object({ id: z.string().description('project id').required() }),
    execute: (args) => {
      const project = mustProject(String(args.id))
      return { id: project.id, name: project.name, brief: project.brief, edl: project.edl }
    },
  })

  ctx.tools.register({
    name: 'openvideo.projects.create',
    description: 'Create an empty video project (720p timeline) and return its id. `brief` says what the video is for.',
    params: z.object({
      name: z.string().min(1).max(200).required(),
      brief: z.string().max(2000),
    }),
    execute: (args) => {
      const project = store.createProject({
        name: String(args.name).trim(),
        ...(args.brief !== undefined ? { brief: String(args.brief).trim() } : {}),
        edl: starterEdl(),
      })
      return { id: project.id, name: project.name }
    },
  })

  ctx.tools.register({
    name: 'openvideo.projects.save_edl',
    description: 'Save a whole EDL document back onto a project. Validation errors answer with `path`, a JSON pointer like /main/elements/2/trimStart — fix that node and save again.',
    params: z.object({
      id: z.string().description('project id').required(),
      edl: z.any().description('the full document (version 1)').required(),
    }),
    execute: (args) => {
      const project = mustProject(String(args.id))
      const edl = mustEdl(args.edl)
      const updated: ProjectRow = { ...project, edl, updatedAt: new Date().toISOString() }
      store.saveProject(updated)
      return { ok: true, id: updated.id }
    },
  })

  ctx.tools.register({
    name: 'openvideo.proxy.info',
    description: 'Whether this host can transcode playback proxies (ffmpeg present?) and how many jobs are running.',
    execute: () => ({ ...proxies.info(), jobs: proxies.activeJobs() }),
  })

  ctx.tools.register({
    name: 'openvideo.proxy.ensure',
    description: 'Make a browser-friendly playback proxy for a library asset (webm VP9/Opus by default). Use it when a video cannot be decoded in the browser; preview and export switch to the proxy automatically once ready. Idempotent; poll openvideo.projects… assets list for status.',
    params: z.object({
      id: z.string().description('asset id').required(),
      target: z.union([z.const('webm'), z.const('mp4')]).description('default webm'),
    }),
    execute: (args) => {
      const id = String(args.id)
      const row = mustAsset(id)
      try {
        return proxies.ensure(id, store.assetPath(row), (args.target ?? 'webm') as ProxyTarget)
      } catch (e) {
        throw e instanceof ProxyError ? proxyError(e, id) : e
      }
    },
  })

  for (const op of OPS) {
    ctx.tools.register({
      name: `openvideo.${op.name}`,
      description: op.description,
      params: op.params,
      execute: (args) => {
        const { project, said } = runOp(String(args.project), op.name, opArgs(op.name, args))
        return { said, projectId: project.id }
      },
    })
  }

  // ---- manifest + health ----------------------------------------------------

  const manifest = {
    id: 'openvideo',
    title: 'OpenVideo 剪辑',
    description: '媒体库 + EDL 项目文档:时间线剪辑、受检操作集(agent 工具)、素材字节路由;渲染在浏览器端',
    api: [...API_METHODS],
    tools: [...CRUD_TOOLS, ...OPS.map((op) => `openvideo.${op.name}`)],
  }
  ctx.capabilities.register(manifest)

  ctx.api.health(() => ({
    openvideo: {
      assets: store.listAssets().length,
      assetsPort: assetsServer?.port() ?? 0,
      projects: store.listProjects().length,
      uploads: uploads.active(),
      proxy: { ffmpeg: ffmpegProbe !== null, jobs: proxies.activeJobs() },
      mediaDir,
      projectDir,
    },
  }))

  log.info(`媒体库 ${mediaDir} · 项目 ${projectDir} · 素材边车 :${assetsServer?.port() ?? '?'}`)
}
