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
      'openvideo.projects.list',
      'openvideo.projects.get',
      'openvideo.projects.create',
      'openvideo.projects.save_edl',
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

  it('refuses to delete an asset a project still uses, naming the projects', async () => {
    const assets = await host!.rpc.call<{ assets: AssetWire[] }>('openvideo.assets.list')
    const projects = await host!.rpc.call<{ projects: { id: string; name: string }[] }>('openvideo.projects.list')
    const opProject = projects.projects.find((p) => p.name === 'op 项目')!
    const used = assets.assets[0]!
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
