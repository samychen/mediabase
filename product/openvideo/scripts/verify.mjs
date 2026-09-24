// product/openvideo / scripts / verify.mjs — the product's neutral smoke test.
//
// Boots the OpenVideo host (or talks to a running one via OPENVIDEO_URL), then
// walks the whole surface a client and an agent use: health, handshake, the
// tool registry, the media library (chunked upload + import + byte route),
// the project shelf (create / invalid-EDL pointer / checked operations /
// in-use refusal / delete), and the built page.
//
// Run:  pnpm run verify:openvideo
//       OPENVIDEO_URL=http://127.0.0.1:3090 node product/openvideo/scripts/verify.mjs

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checker, connect } from '../../../scripts/lib/host-rpc.mjs'

const PRODUCT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const checks = checker()

const freePort = () => new Promise((resolve) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})

const waitForHealth = async (base, timeoutMs = 45_000) => {
  const start = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return await r.json()
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`host did not become ready at ${base}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Expect a call to fail with one exact code; returns the wire error. */
const expectError = async (rpc, method, params, code) => {
  try {
    await rpc.call(method, params)
  } catch (e) {
    checks.expect(`${method} 拒绝(code ${code})`, e.code === code, `收到 code=${e.code ?? '?'} message=${e.message}`)
    return e
  }
  checks.fail(`${method} 拒绝(code ${code})`, '调用竟然成功了')
  return null
}

const externalUrl = process.env.OPENVIDEO_URL
let child = null
let home = null
let base = externalUrl?.replace(/\/+$/, '')

if (base === undefined) {
  const port = await freePort()
  home = mkdtempSync(join(tmpdir(), 'openvideo-verify-'))
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts'], {
    cwd: PRODUCT_ROOT,
    env: { ...process.env, OPENVIDEO_HOME: home, PORT: String(port), OPENVIDEO_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`host exited early (code ${code}):\n${log}`)
      process.exit(1)
    }
  })
}

const scratchDirs = []
let exitCode = 0
try {
  const health = await waitForHealth(base)
  checks.expect('GET /api/health', health?.ok === true)
  checks.expect('health 报告 openvideo 能力', typeof health?.openvideo === 'object' && health.openvideo !== null,
    JSON.stringify(health?.openvideo ?? null))

  const rpc = connect(base, {})
  await rpc.open()

  // ---- handshake + registries
  const info = await rpc.call('server.info')
  checks.expect('server.info 握手', typeof info === 'object' && info !== null)
  const tools = await rpc.call('tools.list')
  const toolNames = (Array.isArray(tools) ? tools : tools?.tools ?? []).map((t) => t.name)
  for (const wanted of ['openvideo.assets.list', 'openvideo.projects.save_edl', 'openvideo.add_text', 'openvideo.trim_clip', 'openvideo.set_aspect']) {
    checks.expect(`工具注册表含 ${wanted}`, toolNames.includes(wanted))
  }

  // ---- media library: chunked upload
  const payload = Buffer.from('openvideo verify payload — 视频库冒烟测试\n'.repeat(64))
  const began = await rpc.call('openvideo.assets.upload.begin', {
    name: 'verify.txt', size: payload.byteLength, contentType: 'text/plain',
  })
  checks.expect('upload.begin 返回会话', typeof began?.uploadId === 'string' && began.chunkBytes > 0)
  let index = 0
  for (let off = 0; off < payload.byteLength; off += began.chunkBytes) {
    const slice = payload.subarray(off, off + began.chunkBytes)
    await rpc.call('openvideo.assets.upload.chunk', { uploadId: began.uploadId, index, data: slice.toString('base64') })
    index += 1
  }
  const ended = await rpc.call('openvideo.assets.upload.end', { uploadId: began.uploadId })
  checks.expect('upload.end 收录素材', ended?.asset?.size === payload.byteLength, `id=${ended?.asset?.id}`)
  const assetId = ended.asset.id

  // out-of-order chunk is refused
  const began2 = await rpc.call('openvideo.assets.upload.begin', { name: 'x.txt', size: 8 })
  await expectError(rpc, 'openvideo.assets.upload.chunk', { uploadId: began2.uploadId, index: 1, data: Buffer.from('01234567').toString('base64') }, -32004)
  await rpc.call('openvideo.assets.upload.cancel', { uploadId: began2.uploadId })

  // ---- data plane: the asset's bytes
  const served = await fetch(`${base}/api/openvideo.asset.${assetId}`)
  const servedBody = Buffer.from(await served.arrayBuffer())
  checks.expect('数据面路由回读字节', served.ok && servedBody.equals(payload), `${served.status} ${servedBody.length}B`)
  checks.expect('数据面路由带 content-type', served.headers.get('content-type') === 'text/plain', served.headers.get('content-type'))

  // ---- import by path (a temp file of our own — works against an external host too)
  const scratch = mkdtempSync(join(tmpdir(), 'openvideo-verify-src-'))
  scratchDirs.push(scratch)
  const importFile = join(scratch, 'imported.txt')
  writeFileSync(importFile, 'imported by path')
  const imported = await rpc.call('openvideo.assets.import', { path: importFile })
  checks.expect('assets.import 复制入库', imported?.asset?.name === 'imported.txt')

  // ---- projects: create, invalid EDL, checked ops
  const created = await rpc.call('openvideo.projects.create', { name: '冒烟项目', brief: 'verify' })
  const pid = created?.project?.id
  checks.expect('projects.create 返回起步文档', typeof pid === 'string' && created.project.edl?.version === 1)

  const badUpdate = await expectError(rpc, 'openvideo.projects.update', {
    id: pid,
    edl: { ...created.project.edl, main: { elements: [{ id: 'x', type: 'video', src: `asset:${assetId}`, trimStar: 1 }] } },
  }, -32602)
  checks.expect('坏 EDL 拒绝并带 JSON 指针', badUpdate?.data?.path === '/main/elements/0/trimStar', `path=${badUpdate?.data?.path}`)
  checks.expect('坏 EDL 带 messageKey', badUpdate?.messageKey === 'openvideo.edlInvalid')

  const opClip = await rpc.call('openvideo.projects.op', { id: pid, op: 'add_clip', args: { src: `asset:${assetId}`, kind: 'video', duration: 4 } })
  checks.expect('op add_clip 生效', typeof opClip?.said === 'string' && opClip.project.edl.main.elements.length === 1, opClip?.said)
  const opText = await rpc.call('openvideo.projects.op', { id: pid, op: 'add_text', args: { text: '你好 OpenVideo', start: 0.5, seconds: 2 } })
  checks.expect('op add_text 生效', (opText?.project.edl.overlays?.[0]?.elements?.length ?? 0) === 1, opText?.said)
  const opBad = await expectError(rpc, 'openvideo.projects.op', { id: pid, op: 'trim_clip', args: { clip: 9 } }, -32602)
  checks.expect('越界 op 拒绝并带 key', opBad?.messageKey === 'openvideo.opFailed')

  // ---- in-use refusal, then cleanup
  const inUse = await expectError(rpc, 'openvideo.assets.remove', { id: assetId }, -32004)
  checks.expect('在用素材拒绝删除并点名项目', inUse?.messageKey === 'openvideo.assetInUse' && Array.isArray(inUse?.data?.projects), JSON.stringify(inUse?.data))
  await rpc.call('openvideo.projects.remove', { id: pid })
  const removed = await rpc.call('openvideo.assets.remove', { id: assetId })
  checks.expect('项目删除后素材可删', removed?.ok === true)
  // After the asset dies its route is disposed; an unknown /api name falls
  // through to the SPA (or 404 without a built page) — either way, no bytes.
  const routeGone = await fetch(`${base}/api/openvideo.asset.${assetId}`)
  const goneType = routeGone.headers.get('content-type') ?? ''
  checks.expect('素材删除后不再供字节', routeGone.status === 404 || goneType.startsWith('text/html'), `status=${routeGone.status} type=${goneType}`)

  // ---- the page (when built)
  const distIndex = join(PRODUCT_ROOT, 'apps/web/dist/index.html')
  try {
    readFileSync(distIndex)
    const page = await fetch(`${base}/`)
    const html = await page.text()
    checks.expect('GET / 返回产品页面', page.status === 200 && html.includes('<div id="root">'), `status=${page.status}`)
  } catch {
    console.log('· 跳过 GET /(未构建页面:先运行 pnpm run build:openvideo)')
  }

  rpc.close()
  exitCode = checks.summary('verify:openvideo 全部通过 ✔')
} catch (e) {
  checks.fail('冒烟流程', e?.stack ?? String(e))
  exitCode = checks.summary('verify:openvideo 全部通过 ✔')
} finally {
  if (child !== null) child.kill('SIGTERM')
  if (home !== null) rmSync(home, { recursive: true, force: true })
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
}
process.exit(exitCode)
