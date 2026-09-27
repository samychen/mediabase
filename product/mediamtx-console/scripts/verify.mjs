// product/mediamtx-console / scripts / verify.mjs — the product's smoke test.
//
// Boots the console host (or talks to a running one via MTXCONSOLE_URL), then
// walks the whole surface a client and an agent use: health, handshake, the
// tool registry, and the bridge — in two modes:
//
//   LIVE      a real MediaMTX is reachable (MTX_API=…, or a binary is found at
//             MTX_BIN / /tmp/mtx/mediamtx / PATH and spawned here): info,
//             endpoints, the full path lifecycle with the upstream error
//             contract mapped onto RPC codes, metrics, sessions, tools.run;
//
//   DEGRADED  no server anywhere: the capability still composes, and every
//             call fails with the CODED error (UNAVAILABLE + messageKey) the
//             panels branch on — an offline console must be honest, not blank.
//
// Run:  pnpm run verify:mtxconsole
//       MTX_API=http://127.0.0.1:9997 node product/mediamtx-console/scripts/verify.mjs

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// ---- MediaMTX: external URL, spawned binary, or nothing (degraded) -------------

const CANDIDATE_BINS = [process.env.MTX_BIN ?? '', '/tmp/mtx/mediamtx', '/usr/local/bin/mediamtx', 'mediamtx']
const binExists = (c) => c.includes('/') ? existsSync(c) : (process.env.PATH ?? '').split(':').some((dir) => dir !== '' && existsSync(join(dir, c)))
const findBin = () => CANDIDATE_BINS.find((c) => c !== '' && binExists(c)) ?? null

let mtxChild = null
let mtxDir = null
let mtxApi = process.env.MTX_API?.replace(/\/+$/, '') ?? null
if (mtxApi === null) {
  const bin = findBin()
  if (bin !== null) {
    const apiPort = await freePort()
    const metricsPort = await freePort()
    const playbackPort = await freePort()
    mtxDir = mkdtempSync(join(tmpdir(), 'mtxconsole-verify-mtx-'))
    const conf = join(mtxDir, 'mediamtx.yml')
    writeFileSync(conf, [
      'logLevel: error', 'api: yes', `apiAddress: 127.0.0.1:${apiPort}`,
      'metrics: yes', `metricsAddress: 127.0.0.1:${metricsPort}`,
      'playback: yes', `playbackAddress: 127.0.0.1:${playbackPort}`,
      'webrtc: no', 'hls: no', 'rtsp: no', 'rtmp: no', 'srt: no', 'moq: no',
      'paths:', '  seeded:', '',
    ].join('\n'))
    mtxChild = spawn(bin, [conf], { cwd: mtxDir, stdio: ['ignore', 'pipe', 'pipe'] })
    mtxApi = `http://127.0.0.1:${apiPort}`
    const start = Date.now()
    for (;;) {
      try {
        const r = await fetch(`${mtxApi}/v3/info`)
        if (r.ok) break
      } catch { /* not up yet */ }
      if (Date.now() - start > 15_000) { checks.fail('MediaMTX 自举', '15s 内未就绪'); mtxApi = null; break }
      await new Promise((r) => setTimeout(r, 200))
    }
    if (mtxApi !== null) console.log(`· 已自举 MediaMTX(${bin})→ ${mtxApi}`)
  }
}
const LIVE = mtxApi !== null

// ---- the console host ----------------------------------------------------------

const externalUrl = process.env.MTXCONSOLE_URL
let child = null
let home = null
let base = externalUrl?.replace(/\/+$/, '')

if (base === undefined) {
  const port = await freePort()
  home = mkdtempSync(join(tmpdir(), 'mtxconsole-verify-'))
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts'], {
    cwd: PRODUCT_ROOT,
    env: {
      ...process.env,
      MTXCONSOLE_HOME: home,
      PORT: String(port),
      MTXCONSOLE_LOG_LEVEL: 'warn',
      ...(LIVE ? { MTXCONSOLE_SERVER_URL: mtxApi } : { MTXCONSOLE_SERVER_URL: 'http://127.0.0.1:9' }),
    },
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

let exitCode = 0
try {
  const health = await waitForHealth(base)
  checks.expect('GET /api/health', health?.ok === true)
  checks.expect('health 报告 mediamtx 桥', typeof health?.mediamtx === 'object' && health.mediamtx !== null,
    JSON.stringify(health?.mediamtx ?? null))

  const rpc = connect(base, {})
  await rpc.open()

  // ---- handshake + registries
  const info = await rpc.call('server.info')
  checks.expect('server.info 握手', typeof info === 'object' && info !== null)
  const tools = await rpc.call('tools.list')
  const toolNames = (Array.isArray(tools) ? tools : tools?.tools ?? []).map((t) => t.name)
  for (const wanted of ['mediamtx.info', 'mediamtx.endpoints', 'mediamtx.paths.list', 'mediamtx.path.add', 'mediamtx.path.delete', 'mediamtx.sessions.kick']) {
    checks.expect(`工具注册表含 ${wanted}`, toolNames.includes(wanted))
  }

  if (LIVE) {
    console.log(`· LIVE 模式:对着真实 MediaMTX(${mtxApi})冒烟`)

    const srv = await rpc.call('mediamtx.info')
    checks.expect('mediamtx.info 返回版本', /^v?\d+\./.test(srv?.info?.version ?? ''), JSON.stringify(srv?.info ?? null))

    const eps = await rpc.call('mediamtx.endpoints')
    checks.expect('endpoints 推导 api', eps?.endpoints?.api === mtxApi, eps?.endpoints?.api)

    const seeded = await rpc.call('mediamtx.paths.list')
    checks.expect('paths.list 含种子路径', (seeded?.paths ?? []).some((p) => p.name === 'seeded'))

    await rpc.call('mediamtx.config.paths.add', { name: 'verify-cam', source: 'rtsp://127.0.0.1:1554/none' })
    const added = await rpc.call('mediamtx.paths.list')
    const row = (added?.paths ?? []).find((p) => p.name === 'verify-cam')
    checks.expect('path.add 上线路径', row?.source === 'rtsp://127.0.0.1:1554/none', JSON.stringify(row ?? null))

    const dup = await expectError(rpc, 'mediamtx.config.paths.add', { name: 'verify-cam' }, -32602)
    checks.expect('重复添加带 messageKey', dup?.messageKey === 'mediamtx.upstream', dup?.messageKey)

    await rpc.call('mediamtx.config.paths.patch', { name: 'verify-cam', record: true })
    checks.expect('path.patch 成功', true)
    await rpc.call('mediamtx.config.paths.delete', { name: 'verify-cam' })
    const gone = await rpc.call('mediamtx.paths.list')
    checks.expect('path.delete 生效', !(gone?.paths ?? []).some((p) => p.name === 'verify-cam'))
    const missing = await expectError(rpc, 'mediamtx.config.paths.delete', { name: 'verify-cam' }, -32001)
    checks.expect('删除不存在 → NOT_FOUND', missing?.code === -32001)

    let metrics = null
    try {
      metrics = await rpc.call('mediamtx.metrics')
    } catch (e) {
      console.log(`· metrics 不可用(${e?.messageKey ?? e?.message ?? '?'})——跳过摘要检查`)
    }
    if (metrics !== null) {
      checks.expect('metrics 摘要成形', typeof metrics?.pathsReady === 'number' && Array.isArray(metrics?.perPath), JSON.stringify(metrics ?? null).slice(0, 120))
    }

    const sessions = await rpc.call('mediamtx.sessions.list')
    checks.expect('sessions.list 返回数组', Array.isArray(sessions?.sessions))

    // ---- 回放链(M2):控制面走桥,媒体面浏览器直连 playback 服务器
    const pb = eps?.endpoints?.playback ?? null
    if (pb === null) {
      const off = await expectError(rpc, 'mediamtx.playback.list', { name: 'seeded' }, -32002)
      checks.expect('playback 未开启 → playbackDisabled 提示', off?.messageKey === 'mediamtx.playbackDisabled', off?.messageKey)
      console.log('· 该服务器未开 playback(mediamtx.yml 加 playback: yes 后录像回放可用)')
    } else {
      const pbPath = (seeded?.paths ?? [])[0]?.name ?? 'seeded'
      let list = null
      try {
        list = await rpc.call('mediamtx.playback.list', { name: pbPath })
      } catch (e) {
        list = e
      }
      checks.expect('playback.list 规范化为 entries 数组', Array.isArray(list?.entries),
        Array.isArray(list?.entries) ? `${list.entries.length} 个窗口` : `收到 ${list?.message ?? JSON.stringify(list)}`.slice(0, 120))
      if ((list?.entries ?? []).length > 0) {
        const get = await fetch(list.entries[0].url)
        const bytes = new Uint8Array(await get.arrayBuffer())
        const fourcc = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0)
        checks.expect('playback /get 返回 fMP4(ftyp 开头,MSE 可播)', get.status === 200 && fourcc === 'ftyp', `status=${get.status} box=${fourcc}`)
      } else {
        console.log(`· ${pbPath} 暂无录像 —— 给它推一段 record 流后重跑可验证 /get 全链`)
      }
    }

    const viaTool = await rpc.call('tools.run', { name: 'mediamtx.paths.list', args: {} })
    checks.expect('tools.run 直通桥能力', Array.isArray(viaTool) && viaTool.some((p) => p.name === 'seeded'))
  } else {
    console.log('· DEGRADED 模式:没有 MediaMTX(设置 MTX_API 或 MTX_BIN 可跑 LIVE)——验证带码降级')
    const err = await expectError(rpc, 'mediamtx.info', {}, -32002)
    checks.expect('不可达带 messageKey', err?.messageKey === 'mediamtx.unreachable', err?.messageKey)
    await expectError(rpc, 'mediamtx.paths.list', {}, -32002)
    const pbErr = await expectError(rpc, 'mediamtx.playback.list', { name: 'cam1' }, -32002)
    checks.expect('DEGRADED 下 playback.list 同样带码', pbErr?.messageKey === 'mediamtx.unreachable', pbErr?.messageKey)
    const notKick = await expectError(rpc, 'mediamtx.sessions.kick', { kind: 'rtmp', id: 'x' }, -32602)
    checks.expect('不可踢协议先行拒绝', notKick?.messageKey === 'mediamtx.notKickable', notKick?.messageKey)
  }

  // ---- 多服务器注册表(M3):登记/切换是宿主本地动作,不依赖活服务器
  const sList = await rpc.call('mediamtx.servers.list')
  checks.expect('servers.list 报告注册表与活动服务器',
    Array.isArray(sList?.servers) && typeof sList?.active === 'string' && sList.servers.some((x) => x.name === sList.active),
    JSON.stringify(sList ?? null).slice(0, 140))
  const originalActive = sList?.active ?? 'default'
  await rpc.call('mediamtx.servers.add', { name: 'verify-bogus', url: 'http://127.0.0.1:9/' })
  await rpc.call('mediamtx.servers.switch', { name: 'verify-bogus' })
  const bogusErr = await expectError(rpc, 'mediamtx.info', {}, -32002)
  checks.expect('切换后调用路由到新服务器', bogusErr?.messageParams?.url === 'http://127.0.0.1:9',
    JSON.stringify(bogusErr?.messageParams ?? null))
  const rmActive = await expectError(rpc, 'mediamtx.servers.remove', { name: 'verify-bogus' }, -32004)
  checks.expect('活动服务器不可移除(带码)', rmActive?.messageKey === 'mediamtx.serverActive', rmActive?.messageKey)
  await rpc.call('mediamtx.servers.switch', { name: originalActive })
  await rpc.call('mediamtx.servers.remove', { name: 'verify-bogus' })
  const restored = await rpc.call('mediamtx.servers.list')
  checks.expect('注册表恢复原状', restored?.active === originalActive && (restored?.servers ?? []).every((x) => x.name !== 'verify-bogus'))
  const viaTool = await rpc.call('tools.run', { name: 'mediamtx.servers.list', args: {} })
  checks.expect('tools.run 直通 servers.list', Array.isArray(viaTool?.servers))

  // ---- the page (when built)
  const distIndex = join(PRODUCT_ROOT, 'apps/web/dist/index.html')
  try {
    readFileSync(distIndex)
    const page = await fetch(`${base}/`)
    const html = await page.text()
    checks.expect('GET / 返回产品页面', page.status === 200 && html.includes('<div id="root">'), `status=${page.status}`)
  } catch {
    console.log('· 跳过 GET /(未构建页面:先运行 pnpm run build:mtxconsole)')
  }

  rpc.close()
  exitCode = checks.summary('verify:mtxconsole 全部通过 ✔')
} catch (e) {
  checks.fail('冒烟流程', e?.stack ?? String(e))
  exitCode = checks.summary('verify:mtxconsole 全部通过 ✔')
} finally {
  if (child !== null) child.kill('SIGTERM')
  if (mtxChild !== null) mtxChild.kill('SIGTERM')
  if (home !== null) rmSync(home, { recursive: true, force: true })
  if (mtxDir !== null) rmSync(mtxDir, { recursive: true, force: true })
}
process.exit(exitCode)
