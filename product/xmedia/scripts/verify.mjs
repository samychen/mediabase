// product/xmedia / scripts / verify.mjs — end-to-end smoke.
//
// Boots the product host (or talks to a running one via XMEDIA_URL), then
// walks the whole surface a client and an agent use: health, the capability
// manifest, the engine handshake, the encode/publish control plane, agent
// tools, engine events, the retired-surface assertions and the static
// <video> page.
//
// Media bytes NEVER cross this script: the real publish goes straight from
// xmedia-kit to MediaMTX over RTMP, and the browser plays WHEP/HLS itself.
// There is NO Player self-check pipeline and NO data-plane byte route.
//
// By default it uses the Node fake engine (no C++ toolchain needed). To
// exercise the real xmedia-kit encode path:
//
//   XMEDIA_ENGINE_BIN=product/xmedia/engine/build/xmedia-bridge \
//   XMEDIA_MEDIA=/tmp/clip.mp4 pnpm run verify:xmedia
//
// To additionally prove a LIVE RTMP publish reached MediaMTX, start MediaMTX
// with scripts/mediamtx.yml and pass an ingest URL + its API base:
//
//   XMEDIA_ENGINE_BIN=.../xmedia-bridge XMEDIA_MEDIA=/tmp/clip.mp4 \
//   XMEDIA_PUBLISH_OUTPUT=rtmp://127.0.0.1:1935/verify \
//   XMEDIA_MTX_API=http://127.0.0.1:9997 pnpm run verify:xmedia
//
// Run:  pnpm run verify:xmedia
//       XMEDIA_URL=http://127.0.0.1:3092 node product/xmedia/scripts/verify.mjs

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checker, connect } from '../../../scripts/lib/host-rpc.mjs'

const PRODUCT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE_ENGINE = fileURLToPath(new URL('../tests/support/fake-engine.mjs', import.meta.url))
const checks = checker()

// The browser can only load modules served from the host's distRoot, so the
// shared WHEP client (libs/whep/whep.js) is mirrored into xmedia's web root.
// The two MUST stay byte-identical — edit the canonical and run `pnpm run
// sync:whep`. A drift here means the production page is serving a stale copy.
{
  const libWhep = fileURLToPath(new URL('../../../libs/whep/whep.js', import.meta.url))
  const distWhep = fileURLToPath(new URL('../apps/web/dist/whep.js', import.meta.url))
  const a = existsSync(libWhep) ? readFileSync(libWhep, 'utf8') : null
  const b = existsSync(distWhep) ? readFileSync(distWhep, 'utf8') : null
  checks.expect('dist/whep.js 是 libs/whep/whep.js 的字节一致镜像',
    a !== null && b !== null && a === b,
    `lib=${libWhep}\ndist=${distWhep}`)
}

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

// A minimal but VALID recvonly SDP offer, matching what the page's
// RTCPeerConnection generates for a video-only WHEP session. 201 + SDP answer
// proves the browser playback path, not just that the endpoint exists.
const WHEP_VIDEO_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-', 't=0 0', 'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=recvonly',
  'a=rtpmap:96 H264/90000', 'a=rtcp-fb:96 nack', 'a=rtcp-fb:96 nack pli',
  'a=ice-ufrag:EsAw', 'a=ice-pwd:abcdefghijklmnopqrstuvwx',
  `a=fingerprint:sha-256 ${Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')}`,
  'a=setup:actpass',
].join('\r\n') + '\r\n'

const realEngine = process.env.XMEDIA_ENGINE_BIN !== undefined
const engineBin = process.env.XMEDIA_ENGINE_BIN ?? process.execPath
const engineArgs = process.env.XMEDIA_ENGINE_ARGS ?? (realEngine ? undefined : FAKE_ENGINE)
const mediaUri = process.env.XMEDIA_MEDIA ?? (realEngine ? undefined : 'verify://clip.mp4')
const publishOutput = process.env.XMEDIA_PUBLISH_OUTPUT
const mtxApi = process.env.XMEDIA_MTX_API
// A real engine without a live peer must not start a doomed publish job.
const exercisePublish = !realEngine || publishOutput !== undefined

// Spawn the real binary with --sandbox and read one idle publish.status reply.
// Used by the (gated) sandbox assertion; returns the raw stdout collected.
function probeSandbox(bin) {
  return new Promise((resolve) => {
    const p = spawn(bin, ['--sandbox'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d.toString() })
    p.stdin.write('publish.status\t\n')
    setTimeout(() => {
      try { p.kill('SIGKILL') } catch { /* already gone */ }
      resolve(out)
    }, 800)
  })
}

const externalUrl = process.env.XMEDIA_URL
let child = null
let home = null
let base = externalUrl?.replace(/\/+$/, '')

if (base === undefined) {
  const port = await freePort()
  home = mkdtempSync(join(tmpdir(), 'xmedia-verify-'))
  base = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    XMEDIA_HOME: home,
    PORT: String(port),
    XMEDIA_LOG_LEVEL: 'warn',
    XMEDIA_STRICT_CAPABILITIES: '1',
    XMEDIA_ENGINE_BIN: engineBin,
    XMEDIA_ENGINE_AUTO_RESTART: '0',
  }
  if (engineArgs !== undefined) env.XMEDIA_ENGINE_ARGS = engineArgs
  else delete env.XMEDIA_ENGINE_ARGS
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts'], {
    cwd: PRODUCT_ROOT,
    env,
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
  checks.expect('health 报告 xmedia 引擎', typeof health?.xmedia === 'object' && health.xmedia !== null,
    JSON.stringify(health?.xmedia ?? null))
  checks.expect(`引擎二进制存在(${realEngine ? '真实 C++' : 'fake'})`,
    realEngine ? existsSync(engineBin) : true, engineBin)

  const rpc = connect(base, {})
  await rpc.open()

  const info = await rpc.call('server.info')
  checks.expect('server.info 握手', typeof info === 'object' && info !== null)

  const reports = await rpc.call('capabilities.verify')
  const broken = (Array.isArray(reports) ? reports : []).filter((r) => !r.ok)
  checks.expect('capabilities.verify 全部一致(strict 启动)', broken.length === 0, JSON.stringify(broken))

  const methods = (await rpc.call('api.list')).map((m) => m.name)
  for (const wanted of [
    'xmedia.hello', 'xmedia.events', 'xmedia.engine.state', 'xmedia.metrics',
    'xmedia.publish.start', 'xmedia.publish.stop', 'xmedia.publish.status',
    'xmedia.publish.viewers',
  ]) {
    checks.expect(`控制面含 ${wanted}`, methods.includes(wanted))
  }
  const tools = (await rpc.call('tools.list')).map((t) => t.name)
  // The C++ Player self-check pipeline, its JPEG/scratch byte route and the
  // earlier MJPEG preview surface are all retired. Assert on BOTH registries
  // so they cannot silently creep back in.
  for (const removed of [
    'xmedia.open', 'xmedia.play', 'xmedia.pause', 'xmedia.stop', 'xmedia.reset',
    'xmedia.seek', 'xmedia.rate', 'xmedia.volume', 'xmedia.mute',
    'xmedia.status', 'xmedia.info', 'xmedia.diagnostics', 'xmedia.snapshot',
    'xmedia.frame', 'xmedia.preview.state', 'xmedia.preview.rate',
  ]) {
    checks.expect(`引擎自检/预览面已移除 ${removed}`,
      !methods.includes(removed) && !tools.includes(removed))
  }
  const channels = await rpc.call('api.streams')
  checks.expect('不再注册 xmedia.frames 帧流通道',
    Array.isArray(channels) && !channels.some((c) => c.name === 'xmedia.frames'),
    JSON.stringify(channels))
  checks.expect('工具注册表含 xmedia.publish.start', tools.includes('xmedia.publish.start'))

  // ---- protocol contract: single source of truth ----------------------------
  // The verb/column vocabulary lives in protocol/contract.json. The C++ side
  // consumes it through the GENERATED engine/src/xmedia_protocol.h. Assert the
  // header actually carries every verb literal, so the two can never drift.
  {
    const contractPath = fileURLToPath(new URL('../protocol/contract.json', import.meta.url))
    const headerPath = fileURLToPath(new URL('../engine/src/xmedia_protocol.h', import.meta.url))
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
    const header = existsSync(headerPath) ? readFileSync(headerPath, 'utf8') : ''
    const verbs = Object.keys(contract.verbs)
    const missing = verbs.filter((v) => !header.includes(`"${v}"`))
    checks.expect('协议契约: 生成的 C++ 头覆盖全部动词', missing.length === 0, missing.join(','))
    checks.expect('协议契约: 版本号与基座一致(=1)', contract.protocolVersion === 1)
  }


  const hello = await rpc.call('xmedia.hello')
  checks.expect('引擎 hello 协议版本=1', hello?.protocol === 1, JSON.stringify(hello))

  // ---- viewer URLs: the ONLY thing the host knows about the media plane ----
  const viewers = await rpc.call('xmedia.publish.viewers')
  checks.expect('viewers 返回 RTMP/WHEP/HLS 三个地址',
    typeof viewers?.publish === 'string' && viewers.publish.startsWith('rtmp://') &&
    typeof viewers?.whep === 'string' && viewers.whep.endsWith('/whep') &&
    typeof viewers?.hls === 'string' && viewers.hls.endsWith('.m3u8'),
    JSON.stringify(viewers))

  const idle = await rpc.call('xmedia.publish.status')
  checks.expect('publish.status 返回结构化任务状态',
    typeof idle?.running === 'boolean' && typeof idle?.progress === 'number' &&
    typeof idle?.elapsedMs === 'number', JSON.stringify(idle))

  // ---- publish control plane ------------------------------------------------
  if (exercisePublish) {
    const params = { input: mediaUri ?? 'verify://clip.mp4', path: 'verify' }
    if (publishOutput !== undefined) { params.output = publishOutput; params.format = 'flv' }
    const started = await rpc.call('xmedia.publish.start', params)
    const jobId = started?.jobId
    checks.expect('publish.start 启动任务并返回任务 ID 与观看地址',
      typeof jobId === 'string' && started?.running === true && typeof started?.viewers?.whep === 'string',
      JSON.stringify(started))
    // A live output MUST be re-encoded: stream-copying a long-GOP source
    // leaves WHEP viewers at framesDecoded=0 (verified in a real browser).
    if (publishOutput === undefined || /^[a-z][a-z0-9+.-]*:\/\//i.test(publishOutput)) {
      checks.expect('实时输出默认重编码(避免长 GOP 黑屏)',
        typeof started?.videoCodec === 'string' && started.videoCodec !== 'copy',
        JSON.stringify(started?.videoCodec))
    }
    const running = await rpc.call('xmedia.publish.status', { jobId })
    checks.expect('publish.status 按 jobId 报告运行中', running?.running === true,
      JSON.stringify(running))

    // With a real engine + a live MediaMTX, prove the bytes actually arrived:
    // MediaMTX's v3 API lists a path as ready only when a publisher is feeding it.
    if (realEngine && publishOutput !== undefined && mtxApi !== undefined) {
      const mtxPath = publishOutput.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '')
      // MediaMTX only marks a path ready after the first keyframe arrives
      // (realtime pacing means that can take a second or two). Poll instead of
      // asserting on a race we would lose on a cold start.
      let path = null
      for (let i = 0; i < 40; i += 1) {
        const paths = await (await fetch(`${mtxApi}/v3/paths/list`)).json()
        path = Array.isArray(paths?.items) ? paths.items.find((p) => p.name === mtxPath) : null
        if (path?.ready === true) break
        await new Promise((r) => setTimeout(r, 250))
      }
      checks.expect(`MediaMTX 收到 ${mtxPath} 路实时流`,
        path?.ready === true && (path?.source?.type ?? '').includes('rtmp'),
        JSON.stringify(path))
      checks.expect('实时推流默认丢弃 AAC(WHEP 不支持音频轨)',
        Array.isArray(path?.tracks) && !path.tracks.some((t) => /AAC|MPEG-4 Audio/i.test(t)),
        JSON.stringify(path?.tracks))

      // Full WHEP handshake on the SAME MediaMTX path the RTMP publisher owns.
      // A 400 "codecs not supported by client" here would mean the live stream
      // cannot be played by a browser at all.
      const whepUrl = `${new URL(viewers.whep).origin}/${mtxPath}/whep`
      const whep = await fetch(whepUrl, {
        method: 'POST', headers: { 'content-type': 'application/sdp' }, body: WHEP_VIDEO_OFFER,
      })
      const answer = await whep.text()
      checks.expect('WHEP 握手返回 201 + SDP answer(浏览器可播)',
        whep.status === 201 && (whep.headers.get('content-type') ?? '').includes('application/sdp') &&
        answer.startsWith('v=0'),
        `HTTP ${whep.status} at ${whepUrl}: ${answer.slice(0, 120)}`)
      const session = whep.headers.get('location')
      if (session) {
        const absolute = session.startsWith('http') ? session : new URL(session, whepUrl).toString()
        await fetch(absolute, { method: 'DELETE' }).catch(() => undefined)
      }
    }

    const stopped = await rpc.call('xmedia.publish.stop', { jobId })
    if (!realEngine) {
      checks.expect('publish.stop 停止任务', stopped?.running === false && stopped?.done === true,
        JSON.stringify(stopped))
    } else {
      // Cancel() is cooperative: the worker stops at the NEXT packet boundary,
      // so a real job may still report running in the immediate reply.
      let final = stopped
      for (let i = 0; i < 20 && final?.running; i += 1) {
        await new Promise((r) => setTimeout(r, 250))
        final = await rpc.call('xmedia.publish.status', { jobId })
      }
      checks.expect('publish.stop 协作式取消最终生效',
        final?.running === false && final?.done === true, JSON.stringify(final))
    }

    // Metrics must reflect the job we just ran.
    const m = await rpc.call('xmedia.metrics')
    checks.expect('xmedia.metrics 返回结构化指标',
      typeof m?.jobsStarted === 'number' && Array.isArray(m?.recent),
      JSON.stringify(m))
    checks.expect('xmedia.metrics 至少记录 1 次任务启动', (m?.jobsStarted ?? 0) >= 1,
      JSON.stringify(m?.jobsStarted))
  } else {
    console.log('· 真实引擎但未设置 XMEDIA_PUBLISH_OUTPUT,跳过实时推流(避免启动注定失败的 job)')
  }

  // ---- sandbox probe (only when explicitly requested with a real binary) ------
  // Spawns the C++ engine directly with --sandbox and asks for an idle status;
  // the reply must report sandboxed=true. Gated so the default smoke (fake or
  // no-binary) stays green.
  if (process.env.XMEDIA_TEST_SANDBOX === '1' && realEngine) {
    const probed = await probeSandbox(engineBin)
    const m = /ok\t(\{.*\})/.exec(probed ?? '')
    let sandboxed = false
    try { sandboxed = m ? JSON.parse(m[1]).sandboxed === true : false } catch { /* parse error */ }
    // Honest by platform: seccomp engages on Linux (true); macOS's deprecated
    // sandbox_init cannot take an inline profile, so it reports false (the
    // baseline POSIX limits still apply). Either is correct — what we assert is
    // that the flag reflects reality and the engine did not crash.
    const expect = process.platform !== 'darwin'
    checks.expect('引擎 --sandbox 后 publish.status 报告 sandboxed 与平台能力一致',
      sandboxed === expect, (probed ?? '').slice(0, 120))
  }

  const events = await rpc.call('xmedia.events')
  checks.expect('xmedia.events 返回数组', Array.isArray(events))
  const state = await rpc.call('xmedia.engine.state')
  checks.expect('监督状态可读', typeof state?.running === 'boolean', JSON.stringify(state))

  const page = await fetch(`${base}/`)
  const html = await page.text()
  checks.expect('GET / 返回宿主页面', page.ok)
  checks.expect('页面用 <video> 播放,不再有 MJPEG 帧订阅',
    html.includes('<video') && html.includes('whep') && !html.includes('xmedia.frames'))
  // The WHEP client is the SHARED module (single source of truth), not an inline
  // copy. The page must import it from ./whep.js and must NOT redefine it inline.
  checks.expect('页面从共享模块 ./whep.js 引入 WHEP 客户端',
    html.includes("import { startWhep, nativeHlsSupported } from './whep.js'") &&
    !html.includes('async function startWhep(') && !html.includes('function nativeHlsSupported('))
  // A finite file source ends its realtime publish and MediaMTX drops the path;
  // the page must still recover (check status → republish → retry WHEP) instead
  // of dumping "no stream is available" on the user.
  checks.expect('页面具备无活跃流自愈与首帧重试',
    html.includes('ensurePublishing') && html.includes('/no stream/i') &&
    html.includes('自动重新发布'))
  checks.expect('页面注明实时预览默认重编码', html.includes('默认重新编码'))
  checks.expect('页面不含 C++ 引擎自检区块与 snapshot 抓帧',
    !html.includes('引擎自检') && !html.includes('xmedia.snapshot'))
  rpc.close()
} catch (e) {
  checks.fail('冒烟执行', e instanceof Error ? e.stack ?? e.message : String(e))
}

exitCode = checks.summary('XMEDIA OK')
if (child !== null) {
  child.kill('SIGTERM')
  await new Promise((r) => child.once('exit', r))
}
if (home !== null) rmSync(home, { recursive: true, force: true })
process.exit(exitCode)
