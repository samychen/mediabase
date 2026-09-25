// The composed OpenVideo host, end to end: the product profile boots (base
// layer + product layer), the capability's manifest survives STRICT
// verification, and the whole surface a client uses answers over the control
// plane — including the coded errors (pointer-carrying EDL refusals, the
// in-use conflict) the UI and the agent branch on.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bootOpenvideo, expectError, type BootedHost } from './support/host.ts'

let host: BootedHost | null = null
afterAll(async () => {
  await host?.stop()
  host = null
})

interface AssetWire {
  id: string
  key: string
  name: string
  contentType: string
  size: number
  createdAt: string
  duration: number | null
  hasTranscript: boolean
  proxy?: { status: string; target: string | null; progress: number | null; error: string | null }
}
interface ProjectWire {
  id: string
  name: string
  brief: string
  createdAt: string
  updatedAt: string
  coverAsset: string | null
  coverAt: number | null
  edl: Record<string, unknown>
}

describe('the composed openvideo host', () => {
  it('boots the product profile and passes strict capability verification', async () => {
    // STRICT: a manifest that claims methods/tools it did not register fails
    // the boot — the product's claim is audited on every CI run.
    host = await bootOpenvideo({ OPENVIDEO_STRICT_CAPABILITIES: '1' })
    const health = await (await fetch(`http://127.0.0.1:${host.port}/api/health`)).json() as Record<string, unknown>
    expect(health.ok).toBe(true)
    expect(health.openvideo).toMatchObject({ assets: 0, projects: 0 })

    const reports = await host.rpc.call<{ id: string; ok: boolean; missing: unknown }[]>('capabilities.verify')
    const openvideo = reports.find((r) => r.id === 'openvideo')
    expect(openvideo?.ok, JSON.stringify(openvideo?.missing ?? null)).toBe(true)
  }, 90_000)

  it('registers the operation set as agent tools', async () => {
    const tools = await host!.rpc.call<{ name: string }[]>('tools.list')
    const names = tools.map((t) => t.name)
    for (const wanted of [
      'openvideo.assets.list',
      'openvideo.assets.fetch',
      'openvideo.projects.list',
      'openvideo.projects.get',
      'openvideo.projects.create',
      'openvideo.projects.save_edl',
      'openvideo.proxy.info',
      'openvideo.proxy.ensure',
      'openvideo.add_clip',
      'openvideo.trim_clip',
      'openvideo.split_clip',
      'openvideo.delete_clip',
      'openvideo.move_clip',
      'openvideo.set_clip_audio',
      'openvideo.add_text',
      'openvideo.remove_text',
      'openvideo.add_audio',
      'openvideo.remove_audio',
      'openvideo.set_captions',
      'openvideo.set_aspect',
    ]) {
      expect(names, `tool ${wanted}`).toContain(wanted)
    }
  })

  it('takes a browser upload in chunks and serves the bytes back', async () => {
    const payload = Buffer.from('a small clip stands in for footage\n'.repeat(100))
    const began = await host!.rpc.call<{ uploadId: string; chunkBytes: number }>('openvideo.assets.upload.begin', {
      name: 'clip.txt',
      size: payload.byteLength,
      contentType: 'text/plain',
    })
    let index = 0
    for (let off = 0; off < payload.byteLength; off += began.chunkBytes) {
      await host!.rpc.call('openvideo.assets.upload.chunk', {
        uploadId: began.uploadId,
        index,
        data: payload.subarray(off, off + began.chunkBytes).toString('base64'),
      })
      index += 1
    }
    const ended = await host!.rpc.call<{ asset: AssetWire }>('openvideo.assets.upload.end', { uploadId: began.uploadId })
    expect(ended.asset.size).toBe(payload.byteLength)
    expect(ended.asset.name).toBe('clip.txt')

    const served = await fetch(`http://127.0.0.1:${host!.port}/api/openvideo.asset.${ended.asset.id}`)
    expect(served.headers.get('content-type')).toBe('text/plain')
    expect(Buffer.from(await served.arrayBuffer()).equals(payload)).toBe(true)

    // the file really is under the identity home
    const onDisk = join(host!.home, 'media', ended.asset.key)
    expect(readFileSync(onDisk).equals(payload)).toBe(true)
  }, 60_000)

  it('serves asset bytes over the Range-aware sidecar (206 + CORS)', async () => {
    const ep = await host!.rpc.call<{ base: string; port: number }>('openvideo.assets.endpoint')
    expect(ep.port).toBeGreaterThan(0)
    const assets = await host!.rpc.call<{ assets: AssetWire[] }>('openvideo.assets.list')
    const a = assets.assets[0]!
    const full = await fetch(`${ep.base}/asset/${a.id}`)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('access-control-allow-origin')).toBe('*')
    const body = Buffer.from(await full.arrayBuffer())
    expect(body.length).toBe(a.size)
    const part = await fetch(`${ep.base}/asset/${a.id}`, { headers: { range: 'bytes=0-99' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${a.size}`)
    const slice = Buffer.from(await part.arrayBuffer())
    expect(slice.length).toBe(100)
    expect(slice.equals(body.subarray(0, 100))).toBe(true)
    const bad = await fetch(`${ep.base}/asset/${a.id}`, { headers: { range: `bytes=${a.size + 10}-${a.size + 20}` } })
    expect(bad.status).toBe(416)
  })

  it('imports by path, backfills a probed duration, and takes a transcript', async () => {
    const src = join(host!.home, 'on-disk.txt')
    writeFileSync(src, 'imported')
    const imported = await host!.rpc.call<{ asset: AssetWire }>('openvideo.assets.import', { path: src })
    expect(imported.asset.duration).toBeNull()

    const probed = await host!.rpc.call<{ asset: AssetWire }>('openvideo.assets.probe', { id: imported.asset.id, duration: 12.5 })
    expect(probed.asset.duration).toBe(12.5)

    await host!.rpc.call('openvideo.assets.transcript.set', { id: imported.asset.id, vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi' })
    const tr = await host!.rpc.call<{ status: string; vtt: string }>('openvideo.assets.transcript', { id: imported.asset.id })
    expect(tr.status).toBe('ready')
    expect(tr.vtt).toContain('WEBVTT')

    const missing = await host!.rpc.call<{ status: string }>('openvideo.assets.transcript', { id: 'ffffffffffffffff' })
      .catch(() => null)
    expect(missing).toBeNull() // unknown asset → coded NOT_FOUND, not a status
  })

  it('refuses an import of something that is not a file, with a key', async () => {
    const err = await expectError(host!.rpc, 'openvideo.assets.import', { path: '/definitely/not/here.mp4' })
    expect(err.code).toBe(-32602)
    expect(err.messageKey).toBe('openvideo.importNotFile')
  })

  it('validates the document on save and answers with a JSON pointer', async () => {
    const created = await host!.rpc.call<{ project: ProjectWire }>('openvideo.projects.create', { name: '测试项目', brief: 'integration' })
    const pid = created.project.id
    expect(created.project.edl.version).toBe(1)

    const badEdl = structuredClone(created.project.edl)
    const main = badEdl.main as { elements: unknown[] }
    main.elements = [{ id: 'x', type: 'video', src: 'asset:aaaaaaaaaaaaaaaa', trimStartt: 3 }]
    const err = await expectError(host!.rpc, 'openvideo.projects.update', { id: pid, edl: badEdl })
    expect(err.code).toBe(-32602)
    expect(err.messageKey).toBe('openvideo.edlInvalid')
    expect((err.data as { path?: string })?.path).toBe('/main/elements/0/trimStartt')
  })

  it('applies a checked operation as one save, and refuses a bad one with a key', async () => {
    const { project } = await host!.rpc.call<{ project: ProjectWire }>('openvideo.projects.create', { name: 'op 项目' })
    const pid = project.id
    const assets = await host!.rpc.call<{ assets: AssetWire[] }>('openvideo.assets.list')
    const asset = assets.assets[0]!
    const out = await host!.rpc.call<{ project: ProjectWire; said: string }>('openvideo.projects.op', {
      id: pid,
      op: 'add_clip',
      args: { src: `asset:${asset.id}`, kind: 'video', duration: 5 },
    })
    expect(out.said).toContain('Added video clip')
    expect((out.project.edl.main as { elements: unknown[] }).elements).toHaveLength(1)

    const err = await expectError(host!.rpc, 'openvideo.projects.op', { id: pid, op: 'move_clip', args: { clip: 0, to: 9 } })
    expect(err.code).toBe(-32602)
    expect(err.messageKey).toBe('openvideo.opFailed')

    // the same operation through the agent's tool registry
    const viaTool = await host!.rpc.call<{ said: string }>('tools.run', {
      name: 'openvideo.add_text',
      args: { project: pid, text: '标题', start: 0, seconds: 2 },
    })
    expect(viaTool.said).toContain('Added the text')
  })

  it('fetches network media into the library, with the same parity as any asset', async () => {
    const http = await import('node:http')
    const payload = Buffer.from('remote clip bytes\n'.repeat(50))
    const server = http.createServer((req, res) => {
      if (req.url === '/clip.bin') {
        res.writeHead(200, { 'content-type': 'video/webm', 'content-length': String(payload.length) })
        res.end(payload)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const out = await host!.rpc.call<{ asset: AssetWire }>('openvideo.assets.fetch', {
        url: `http://127.0.0.1:${port}/clip.bin`,
        name: 'remote.webm',
      })
      expect(out.asset.size).toBe(payload.length)
      expect(out.asset.contentType).toBe('video/webm')
      // parity: it is served by the ordinary data-plane route like any asset
      const served = await fetch(`http://127.0.0.1:${host!.port}/api/openvideo.asset.${out.asset.id}`)
      expect(Buffer.from(await served.arrayBuffer()).equals(payload)).toBe(true)

      const notFound = await expectError(host!.rpc, 'openvideo.assets.fetch', { url: `http://127.0.0.1:${port}/nope` })
      expect(notFound.code).toBe(-32602)
      expect(notFound.messageKey).toBe('openvideo.fetchFailed')
      const badScheme = await expectError(host!.rpc, 'openvideo.assets.fetch', { url: 'ftp://example/x.mp4' })
      expect(badScheme.code).toBe(-32602)
    } finally {
      server.close()
    }
  })

  it('answers proxy.info from an executed probe, and degrades with a coded error when ffmpeg is absent', async () => {
    const info = await host!.rpc.call<{ ffmpeg: boolean; version: string | null; targets: string[]; jobs: number }>('openvideo.proxy.info')
    expect(info.targets).toContain('webm')
    expect(typeof info.ffmpeg).toBe('boolean')
    const assets = await host!.rpc.call<{ assets: AssetWire[] }>('openvideo.assets.list')
    const id = assets.assets[0]!.id
    if (!info.ffmpeg) {
      const err = await expectError(host!.rpc, 'openvideo.proxy.ensure', { id })
      expect(err.code).toBe(-32002) // UNAVAILABLE, not a crash and not silence
      expect(err.messageKey).toBe('openvideo.proxyNoFfmpeg')
      return
    }
    const out = await host!.rpc.call<{ proxy: { status: string } }>('openvideo.proxy.ensure', { id, target: 'webm' })
    expect(['queued', 'running', 'ready']).toContain(out.proxy.status)
    await host!.rpc.call('openvideo.proxy.cancel', { id })
  })

  it('transcodes a real proxy when ffmpeg exists, and serves it with Range (skipped with a reason when not)', async () => {
    const info = await host!.rpc.call<{ ffmpeg: boolean }>('openvideo.proxy.info')
    if (!info.ffmpeg) {
      console.log('· 跳过完整代理转码(本机无 ffmpeg——按执行探测,不 reddening)')
      return
    }
    const { execFileSync } = await import('node:child_process')
    const { join } = await import('node:path')
    const srcFile = join(host!.home, 'tiny.mp4')
    execFileSync('ffmpeg', [
      '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=64x64:rate=10',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', srcFile,
    ], { timeout: 60_000 })
    const imported = await host!.rpc.call<{ asset: AssetWire }>('openvideo.assets.import', { path: srcFile })
    await host!.rpc.call('openvideo.proxy.ensure', { id: imported.asset.id, target: 'webm' })
    // poll until ready (a 1s 64x64 clip is quick; CI machines vary)
    const deadline = Date.now() + 60_000
    let status = ''
    while (Date.now() < deadline) {
      const s = await host!.rpc.call<{ proxy: { status: string; error: string | null } }>('openvideo.proxy.status', { id: imported.asset.id })
      status = s.proxy.status
      if (status === 'ready' || status === 'failed') {
        if (status === 'failed') throw new Error(`proxy failed: ${s.proxy.error}`)
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(status).toBe('ready')
    const ep = await host!.rpc.call<{ base: string }>('openvideo.assets.endpoint')
    const part = await fetch(`${ep.base}/proxy/${imported.asset.id}`, { headers: { range: 'bytes=0-99' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-type')).toBe('video/webm')
    expect((await part.arrayBuffer()).byteLength).toBe(100)
    // the asset row carries the ready facet
    const after = await host!.rpc.call<{ assets: AssetWire[] }>('openvideo.assets.list')
    expect(after.assets.find((a) => a.id === imported.asset.id)?.proxy?.status).toBe('ready')
  }, 120_000)

  it('refuses to delete an asset a project still uses, naming the projects', async () => {
    const projects = await host!.rpc.call<{ projects: { id: string; name: string }[] }>('openvideo.projects.list')
    const opProject = projects.projects.find((p) => p.name === 'op 项目')!
    // Resolve the ACTUAL referenced asset from the document (list order changed
    // once the fetch test added a newer asset — never guess by position).
    const full = await host!.rpc.call<{ project: ProjectWire }>('openvideo.projects.get', { id: opProject.id })
    const usedSrc = (full.project.edl.main as { elements: { src: string }[] }).elements[0]!.src
    const used = { id: usedSrc.slice(6) }
    const err = await expectError(host!.rpc, 'openvideo.assets.remove', { id: used.id })
    expect(err.code).toBe(-32004)
    expect(err.messageKey).toBe('openvideo.assetInUse')
    expect((err.data as { projects: string[] }).projects).toContain('op 项目')

    // after the project goes, the asset (and its route) go with it
    await host!.rpc.call('openvideo.projects.remove', { id: opProject.id })
    const removed = await host!.rpc.call<{ ok: boolean }>('openvideo.assets.remove', { id: used.id })
    expect(removed.ok).toBe(true)
    const served = await fetch(`http://127.0.0.1:${host!.port}/api/openvideo.asset.${used.id}`)
    const type = served.headers.get('content-type') ?? ''
    expect(served.status === 404 || type.startsWith('text/html')).toBe(true)
  })

  it('cleans up', async () => {
    // delete the leftovers so the home dir assertion below is meaningful
    const projects = await host!.rpc.call<{ projects: { id: string }[] }>('openvideo.projects.list')
    for (const p of projects.projects) await host!.rpc.call('openvideo.projects.remove', { id: p.id })
    const assets = await host!.rpc.call<{ assets: AssetWire[] }>('openvideo.assets.list')
    for (const a of assets.assets) await host!.rpc.call('openvideo.assets.remove', { id: a.id })
    const after = await host!.rpc.call<{ assets: AssetWire[] }>('openvideo.assets.list')
    expect(after.assets).toEqual([])
  })
})
