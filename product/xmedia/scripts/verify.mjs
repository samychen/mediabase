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
// The offline bake (HTML→MP4) is exercised too: with the fake engine it runs
// end to end (the fake writes the output file); with a REAL engine it needs
// the CEF toolchain (XMEDIA_BUILD_CEF=1 built xmedia-bake). A real engine
// WITHOUT the bake binary must fail bake.start with a coded, honest refusal —
// that refusal is asserted, never skipped silently. A real bake of a real
// page needs XMEDIA_BAKE_HTML=<page.html> (e.g. the kit's
// tests/testdata/hf_gsap_smoke.html).
//
// Run:  pnpm run verify:xmedia
//       XMEDIA_URL=http://127.0.0.1:3092 node product/xmedia/scripts/verify.mjs

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // The known-good path is a plain recvonly SDP POST + setRemoteDescription,
  // with the Location session DELETEd on teardown. Trickle ICE / forced data
  // channel experiments regressed real playback — do not reintroduce them.
  checks.expect('WHEP 客户端用 SDP POST 建会话并用 DELETE 回收',
    !!a?.includes("'content-type': 'application/sdp'") &&
    !!a?.includes("method: 'POST'") && !!a?.includes("method: 'DELETE'") &&
    !!a?.includes('setRemoteDescription') &&
    !a?.includes('trickle-ice-sdpfrag'))

  // MediaMTX's WHEP answer is a FIXED Baseline (profile-level-id=42e01f). A
  // High+B-frame live stream connects ICE but never decodes a frame in the
  // browser. The bridge MUST align libx264 live output to Baseline/no-B-frames;
  // regressing this reintroduces the "connected but black" bug.
  const bridgeSrc = fileURLToPath(new URL('../engine/src/mediabase_bridge.cc', import.meta.url))
  const bridge = existsSync(bridgeSrc) ? readFileSync(bridgeSrc, 'utf8') : null
  checks.expect('实时推流强制 libx264 Baseline/无B帧以对齐 WHEP 协商',
    !!bridge?.includes('"profile", "baseline"') &&
    !!bridge?.includes('"bf", "0"') &&
    !!bridge?.includes('IsNetworkUrl(output)'))

  // Kicking one RTMP publisher drops its TCP socket; librtmp's next write()
  // raises SIGPIPE whose default action kills the WHOLE bridge process — every
  // sibling publish dies too. The bridge MUST ignore SIGPIPE process-wide so a
  // kicked stream fails only its own job. Regression = "kick one, all stop".
  checks.expect('bridge 忽略 SIGPIPE(踢一路不会拖垮其他推流)',
    !!bridge?.includes('signal(SIGPIPE, SIG_IGN)'))

  // Rebuilding the bridge while a host still holds the old inode silently
  // replays the 87s "End of file" bug. engine.state must expose mtime vs child
  // start, and the live plugin must surface the warning before publishing.
  const hostEngineSrc = fileURLToPath(new URL('../packages/host/engine/src/index.ts', import.meta.url))
  const hostEngine = existsSync(hostEngineSrc) ? readFileSync(hostEngineSrc, 'utf8') : null
  checks.expect('engine.state 报告 bridge 二进制新旧以发现未重启的旧进程',
    !!hostEngine?.includes('binaryMtimeMs') &&
    !!hostEngine?.includes('engineStartedAtMs') &&
    !!hostEngine?.includes('binaryStale'))
  const liveSrcPath = fileURLToPath(new URL('../apps/web/dist/plugins/live.js', import.meta.url))
  const liveSrc = existsSync(liveSrcPath) ? readFileSync(liveSrcPath, 'utf8') : null
  checks.expect('实时预览在开播前拦截未重启的旧 bridge',
    !!liveSrc?.includes('checkEngineStale') &&
    !!liveSrc?.includes('binaryStale') &&
    !!liveSrc?.includes('请重启宿主服务后再开播'))

  // 回放/同步回放 needs the upstream playback server AND fMP4 recording. If
  // either is disabled the two panels render but list zero windows — which
  // reads to the user as "no entry point". Guard the config that makes them real.
  const mtxCfgPath = fileURLToPath(new URL('../mediamtx.yml', import.meta.url))
  const mtxCfg = existsSync(mtxCfgPath) ? readFileSync(mtxCfgPath, 'utf8') : null
  checks.expect('MediaMTX 开启 playback + fMP4 录制以支持回放/同步回放',
    !!mtxCfg && /^playback:\s*true/m.test(mtxCfg) &&
    /^pathDefaults:[\s\S]*?^\s*record:\s*yes/m.test(mtxCfg) &&
    /^pathDefaults:[\s\S]*?^\s*recordFormat:\s*fmp4/m.test(mtxCfg))

  // The FLV→librtmp reassembler lives in xmedia-kit, outside this repo. This
  // fix is load-bearing: without it long RTMP publishes die with AVERROR_EOF
  // at ~87s. NEVER silently skip — a green XMEDIA OK that cannot see the kit
  // source is exactly the false assurance we must avoid. If the kit tree is
  // not visible, fail loudly and tell the caller how to point at it.
  const cachePath = fileURLToPath(new URL('../engine/build/CMakeCache.txt', import.meta.url))
  let kitSource = process.env.XMEDIA_KIT_SOURCE_DIR
  if (!kitSource && existsSync(cachePath)) {
    const cached = readFileSync(cachePath, 'utf8')
    const match = /^XMEDIA_KIT_SOURCE_DIR:PATH=(.+)$/m.exec(cached)
    if (match?.[1]) kitSource = match[1].trim()
  }
  if (!kitSource || !existsSync(kitSource)) {
    checks.fail('xmedia-kit 源码不可见,无法验证 FLV tag 重组补丁',
      '设置 XMEDIA_KIT_SOURCE_DIR=<kit 路径> 后重跑;不能因看不见就默认补丁存在')
  } else {
    const muxerPath = join(kitSource, 'media/transcode/ffmpeg_encode_muxer.cc')
    const headerPath = join(kitSource, 'media/transcode/flv_rtmp_reassembler.h')
    const testPath = join(kitSource, 'tests/unit/media_transcode/flv_rtmp_reassembler_unittest.cc')
    const muxer = existsSync(muxerPath) ? readFileSync(muxerPath, 'utf8') : null
    const header = existsSync(headerPath) ? readFileSync(headerPath, 'utf8') : null
    const unitTest = existsSync(testPath) ? readFileSync(testPath, 'utf8') : null
    // Boundary logic was extracted into FlvRtmpReassembler (header-only) so it
    // can be unit-tested; the muxer keeps only the AVIO thin wrapper. Accept
    // the older inline form (11 + body + 4) too, so a working fix is not
    // rejected just for living in the .cc.
    const reassemblePresent = !!header
      ? header.includes('FlvRtmpReassembler') &&
        header.includes('kTagHeaderBytes') &&
        header.includes('kMaxStashBytes') &&
        header.includes("'F'")
      : !!muxer && muxer.includes('11 + body + 4') && muxer.includes('16u << 20')
    checks.expect('xmedia-kit RTMP 输出按完整 FLV tag 重组写入,避免 librtmp 缓冲边界 EOF',
      !!muxer &&
      muxer.includes('WriteFlvTagsToRtmp') &&
      muxer.includes('WriteRawToUrl') &&
      !muxer.includes('AVIO_FLAG_DIRECT') &&
      reassemblePresent)
    checks.expect('xmedia-kit FLV tag 边界补丁有对应单元测试(切碎 header/body 不早吐)',
      !!unitTest &&
      unitTest.includes('SplitTagHeaderStillYieldsOneWholeTag') &&
      unitTest.includes('SplitBodyAcrossWrites') &&
      unitTest.includes('RejectsOversizedStash'))
  }
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
    'xmedia.bake.start', 'xmedia.bake.status', 'xmedia.bake.cancel',
    'xmedia.studio.state', 'xmedia.studio.url', 'xmedia.studio.restart',
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

  // Capability-level composition: the in-repo @xmedia/host-mtx-bridge package is
  // mounted by the xmedia bundle, so the whole mediamtx.* control plane and
  // agent tools exist HERE (health key `mediamtx`, no data-plane routes).
  for (const wanted of ['mediamtx.info', 'mediamtx.paths.list', 'mediamtx.sessions.list']) {
    checks.expect(`MediaMTX 桥已组合进控制面: ${wanted}`, methods.includes(wanted))
  }
  checks.expect('MediaMTX 桥已组合进工具表: mediamtx.paths.list', tools.includes('mediamtx.paths.list'))
  // 一键清空录像：bridge 暴露聚合 RPC（confirm 字面量保护 + 按段聚合原语），
  // stream.js 两步确认后才调用；缺任何一半都会变成"按钮点了没反应"或误删。
  const mtxBridgePath = fileURLToPath(new URL('../packages/host/mtx-bridge/src/index.ts', import.meta.url))
  const mtxBridgeSrc = existsSync(mtxBridgePath) ? readFileSync(mtxBridgePath, 'utf8') : null
  checks.expect('MediaMTX 桥暴露 mediamtx.recordings.deleteAll(confirm 保护 + 按段聚合)',
    methods.includes('mediamtx.recordings.deleteAll') &&
    !!mtxBridgeSrc?.includes("'mediamtx.recordings.deleteAll'") &&
    mtxBridgeSrc.includes('z.const(true).required()') &&
    mtxBridgeSrc.includes('/v3/recordings/segments/delete'))
  // ALL eight protocols are kickable in v1.21.1 (official openapi). The old
  // table had rtmp:null and flat aliases that 404 for rtsp/srt/moq — so RTMP
  // publishers never got a 踢出 button and even webRTC's button hit a legacy
  // path. Pin every route to the canonical nested endpoint.
  const mtxProtocolPath = fileURLToPath(new URL('../packages/host/mtx-protocol/src/index.ts', import.meta.url))
  const mtxProtocolSrc = existsSync(mtxProtocolPath) ? readFileSync(mtxProtocolPath, 'utf8') : null
  checks.expect('kick 路由表覆盖全部 8 协议(含 rtmp)且为官方规范路径',
    !!mtxProtocolSrc?.includes("rtmp: '/v3/rtmp/conns/kick/'") &&
    mtxProtocolSrc.includes("rtmps: '/v3/rtmps/conns/kick/'") &&
    mtxProtocolSrc.includes("rtsp: '/v3/rtsp/sessions/kick/'") &&
    mtxProtocolSrc.includes("rtsps: '/v3/rtsps/sessions/kick/'") &&
    mtxProtocolSrc.includes("webrtc: '/v3/webrtc/sessions/kick/'") &&
    mtxProtocolSrc.includes("srt: '/v3/srt/conns/kick/'") &&
    mtxProtocolSrc.includes("moq: '/v3/moq/sessions/kick/'") &&
    !/rtmps?: null/.test(mtxProtocolSrc))
  const healthNow = await (await fetch(`${base}/api/health`)).json()
  checks.expect('health 携带 MediaMTX 桥的 mediamtx 键',
    healthNow && typeof healthNow.mediamtx === 'object', JSON.stringify(healthNow?.mediamtx))

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

    // Transcode monitor verbs against the fake engine (the REAL engine's
    // pause is exercised end to end by the gated offline block below —
    // a live RTMP job is left untouched here to keep its timing intact).
    if (!realEngine) {
      const paused = await rpc.call('xmedia.publish.pause', { jobId })
      checks.expect('publish.pause 置起暂停标志且任务仍在池中',
        paused?.running === true && paused?.paused === true, JSON.stringify(paused))
      const rows = await rpc.call('xmedia.publish.jobs')
      const mine = Array.isArray(rows) ? rows.find((r) => r?.jobId === jobId) : null
      checks.expect('publish.list 返回含 jobId 的全池快照',
        Array.isArray(rows) && mine?.running === true && mine?.paused === true,
        JSON.stringify(rows))
      const resumed = await rpc.call('xmedia.publish.resume', { jobId })
      checks.expect('publish.resume 清除暂停标志', resumed?.paused === false,
        JSON.stringify(resumed))
    }

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

  // ---- real-engine offline pause end to end (XMEDIA_MEDIA gate) --------------
  // Proves the KIT-level cooperative pause with a real TranscodeJob: start a
  // file→file job, park it mid-run, watch progress FREEZE, resume it to a real
  // completion. This is the monitoring feature's load-bearing path; the fake
  // engine above only mirrors the wire shape.
  if (realEngine && mediaUri !== undefined) {
    const offlineOut = join(tmpdir(), `xmedia-verify-offline-${Date.now()}.mp4`)
    try {
      // A real RE-ENCODE, not copy: stream copy runs at memcpy speed and the
      // job would finish before any pause could land. libx264 keeps the run
      // in the seconds — wide enough to park it mid-flight. (The pinned kit
      // FFmpeg carries libx264; a build without it surfaces as a coded
      // publish.start failure here, which is also honest.)
      const started = await rpc.call('xmedia.publish.start', {
        input: mediaUri, output: offlineOut, realtime: false, videoCodec: 'libx264',
      })
      const jobId = started?.jobId
      checks.expect('离线转码启动(file→file)', started?.running === true, JSON.stringify(started))

      // Catch the job mid-run: progress must be past the first packet but the
      // job must NOT be done yet, or the pause below would be a no-op on a
      // finished pool entry.
      let progressAtPause = -1
      for (let i = 0; i < 600; i += 1) {
        const s = await rpc.call('xmedia.publish.status', { jobId })
        if (s?.done === true) { progressAtPause = -2; break }
        if ((s?.progress ?? 0) >= 1) { progressAtPause = s?.progress; break }
        await new Promise((r) => setTimeout(r, 100))
      }
      checks.expect('离线转码进入实际运行(progress>=1 且未完成)', progressAtPause >= 1,
        `progressAtPause=${progressAtPause}`)

      const paused = await rpc.call('xmedia.publish.pause', { jobId })
      checks.expect('离线转码暂停置起 paused 标志', paused?.paused === true, JSON.stringify(paused))
      await new Promise((r) => setTimeout(r, 600))  // let the park actually land
      const frozenA = await rpc.call('xmedia.publish.status', { jobId })
      await new Promise((r) => setTimeout(r, 600))
      const frozenB = await rpc.call('xmedia.publish.status', { jobId })
      checks.expect('暂停期间进度冻结',
        frozenA?.paused === true && frozenA?.progress === frozenB?.progress,
        `A=${JSON.stringify(frozenA)}\nB=${JSON.stringify(frozenB)}`)

      const resumed = await rpc.call('xmedia.publish.resume', { jobId })
      checks.expect('恢复清除暂停标志', resumed?.paused === false, JSON.stringify(resumed))

      let final = null
      for (let i = 0; i < 240 && !(final?.done); i += 1) {
        await new Promise((r) => setTimeout(r, 500))
        final = await rpc.call('xmedia.publish.status', { jobId })
      }
      checks.expect('恢复后离线转码跑完且成功',
        final?.done === true && final?.ok === true && final?.paused === false,
        JSON.stringify(final))
      checks.expect('离线转码输出文件真实存在', existsSync(offlineOut))
    } finally {
      rmSync(offlineOut, { force: true })
    }
  } else if (realEngine) {
    console.log('· 真实引擎但未设置 XMEDIA_MEDIA,跳过离线暂停端到端')
  }

  // ---- bake control plane (offline HTML→MP4) ---------------------------------
  {
    const idle = await rpc.call('xmedia.bake.status')
    checks.expect('bake.status 返回结构化烘焙状态',
      idle?.kind === 'bake' && typeof idle?.running === 'boolean' &&
      typeof idle?.stage === 'string' && typeof idle?.progress === 'number',
      JSON.stringify(idle))
    checks.expect('工具注册表含 xmedia.bake.start', tools.includes('xmedia.bake.start'))

    // Where is the real bake binary? Sibling of the bridge (macOS: .app bundle).
    const bakeBinCandidates = realEngine
      ? [
          join(engineBin, '..', 'xmedia-bake.app', 'Contents', 'MacOS', 'xmedia-bake'),
          join(engineBin, '..', 'xmedia-bake'),
        ]
      : []
    const bakeBin = bakeBinCandidates.find((p) => existsSync(p)) ?? null
    const bakeHtml = process.env.XMEDIA_BAKE_HTML ?? ''
    const bakeOut = join(tmpdir(), `xmedia-verify-bake-${Date.now()}.mp4`)

    if (!realEngine || bakeBin !== null) {
      // Fake engine: the fake "encodes" by writing the output file. Real engine
      // with the CEF toolchain: a REAL bake of a real page. The bridge refuses
      // a non-existent local page before spawning, so the smoke writes one.
      const smokeHtml = join(tmpdir(), `xmedia-verify-bake-page-${Date.now()}.html`)
      writeFileSync(smokeHtml,
        '<!doctype html><html><body style="margin:0"><h1 style="font-size:40px">xmedia bake verify</h1></body></html>')
      const params = {
        htmlPath: realEngine && bakeHtml !== '' ? bakeHtml : smokeHtml,
        output: bakeOut,
        seconds: 1, fps: 10, width: 320, height: 240,
        ...(realEngine ? { audio: false } : {}),
      }
      const started = await rpc.call('xmedia.bake.start', params)
      const jobId = started?.jobId
      checks.expect('bake.start 启动烘焙任务',
        typeof jobId === 'string' && started?.running === true && started?.kind === 'bake',
        JSON.stringify(started))
      let done = null
      for (let i = 0; i < 120; i += 1) {
        done = await rpc.call('xmedia.bake.status', { jobId })
        if (done?.done) break
        await new Promise((r) => setTimeout(r, 500))
      }
      checks.expect('烘焙任务收口(done)', done?.done === true, JSON.stringify(done))
      checks.expect('烘焙成功且进度收口 100', done?.ok === true && done?.progress === 100,
        JSON.stringify(done))
      checks.expect('成片拉取路由出现', typeof done?.url === 'string' && done.url.startsWith('/api/xmedia.bake.'),
        JSON.stringify(done?.url))
      if (done?.url) {
        const clipUrl = `${base}${done.url}`
        const full = await fetch(clipUrl)
        checks.expect('成片路由 200 且可 Range 流式读取',
          full.status === 200 && full.headers.get('accept-ranges') === 'bytes',
          `HTTP ${full.status}`)
        const sizeHeader = full.headers.get('content-length')
        const ranged = await fetch(clipUrl, { headers: { Range: 'bytes=0-15' } })
        checks.expect('成片路由 Range 206',
          ranged.status === 206 && (ranged.headers.get('content-range') ?? '').includes(`/${sizeHeader ?? ''}`),
          `HTTP ${ranged.status} · ${ranged.headers.get('content-range')}`)
      }
      if (realEngine && existsSync(bakeOut)) {
        // Real bake: prove the file is a DECODABLE MP4 container (not just a
        // written file) — ffprobe reads duration/codec.
        const probe = spawn('ffprobe', ['-v', 'error', '-show_entries',
          'format=format_name,duration', '-of', 'json', bakeOut], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        probe.stdout.on('data', (d) => { out += d })
        await new Promise((r) => probe.once('exit', r))
        checks.expect('真实烘焙产物可被 ffprobe 解码',
          /"format_name"/.test(out) && /mp4|matroska|avi/.test(out), out.slice(0, 200))
        // And prove it is NOT BLACK. The element composer draws only data-*
        // element quads, so a page without contract elements used to bake to
        // pure black while every ffprobe/route check stayed green (measured).
        // The bake CLI now composites the full frame as a background layer for
        // element-less pages; assert the pixels prove it. Only asserted for the
        // built-in smoke page — a caller-supplied page may legitimately be dark.
        if (bakeHtml === '') {
          const gray = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
            '-i', bakeOut, '-frames:v', '1', '-vf', 'scale=160:90',
            '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
          const pixels = gray.stdout ?? []
          const mean = pixels.length > 0
            ? pixels.reduce((a, b) => a + b, 0) / pixels.length
            : 0
          checks.expect('烘焙产物非全黑(首帧均值亮度 > 2)',
            pixels.length > 0 && mean > 2, `mean=${mean.toFixed(2)} pixels=${pixels.length}`)
        }
      }
      await rpc.call('xmedia.bake.cancel', { jobId }).catch(() => undefined)
      rmSync(bakeOut, { force: true })
      rmSync(smokeHtml, { force: true })
    } else {
      // Real engine WITHOUT the bake binary: bake.start must refuse with an
      // honest refusal naming the cause — a missing capability is a coded
      // rejection, never a silent zero.
      const refused = await rpc.call('xmedia.bake.start', {
        htmlPath: '/tmp/xmedia-verify-page.html', output: bakeOut,
      }).catch((e) => e)
      const detail = refused instanceof Error ? `${refused.message}` : JSON.stringify(refused)
      checks.expect('无烘焙工具链时 bake.start 诚实拒绝并指名原因',
        detail.includes('bake binary not found'), detail.slice(0, 200))
      console.log('· 真实引擎未构建 xmedia-bake(需 XMEDIA_BUILD_CEF=1),烘焙按诚实拒绝断言')
    }
  }

  // ---- HF Studio web app (its own loopback server; the browser connects
  // directly — the host hands out the URL and never proxies studio bytes) ------
  {
    const studioUrl = (await rpc.call('xmedia.studio.url'))?.url
    checks.expect('HF Studio 入口 URL 指向 loopback',
      typeof studioUrl === 'string' && studioUrl.startsWith('http://127.0.0.1:'),
      JSON.stringify(studioUrl))
    const pyOk = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0
    const studioState = await rpc.call('xmedia.studio.state')
    if (pyOk) {
      // The studio server is its own python process: it may still be binding
      // its port when state flips to running. A cold-start connection refused
      // is a race, not a broken boundary — poll briefly instead.
      let projects = null
      let lastErr = null
      for (let i = 0; i < 32 && (projects === null || projects.status !== 200); i += 1) {
        try { projects = await fetch(`${studioUrl}api/projects`) }
        catch (e) { lastErr = e }
        if (projects?.status !== 200) await new Promise((r) => setTimeout(r, 250))
      }
      checks.expect('HF Studio /api/projects 可达(浏览器直连边界)',
        projects?.status === 200,
        projects === null ? `fetch failed: ${lastErr?.message}` : `HTTP ${projects.status} at ${studioUrl}api/projects`)
    } else {
      checks.expect('无 python3 时 Studio 如实报告未运行',
        studioState?.running === false, JSON.stringify(studioState))
    }
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
  checks.expect('监督状态报告 bridge 新旧与子进程启动时间',
    typeof state?.binaryMtimeMs === 'number' || state?.binaryMtimeMs === null,
    JSON.stringify(state))
  checks.expect('engine.state.binaryStale 为布尔值',
    typeof state?.binaryStale === 'boolean', JSON.stringify(state))
  checks.expect('当前运行的 bridge 不是旧二进制',
    state?.binaryStale !== true,
    `binary=${state?.binary} mtime=${state?.binaryMtimeMs} started=${state?.engineStartedAtMs}`)

  // The page is a SHELL + ESM plugins: index.html only carries the loader/
  // registry chrome; every view (live/monitor/bake/studio/engine) lives in its
  // own file under plugins/ and is registered through plugins/manifest.json.
  // Assertions therefore check the shell once and each plugin file separately.
  const page = await fetch(`${base}/`)
  const html = await page.text()
  checks.expect('GET / 返回宿主页面', page.ok)
  checks.expect('壳加载插件清单并暴露运行时 ctx（对齐基座 mediabaseCtx 惯例）',
    html.includes('plugins/manifest.json') && html.includes('xmediaCtx') &&
    html.includes('ui.register'))

  const manifest = await (await fetch(`${base}/plugins/manifest.json`)).json()
  const BUILTIN = ['live.js', 'monitor.js', 'stream.js', 'player.js', 'sync.js', 'bake.js', 'config.js', 'studio.js', 'engine.js']
  checks.expect('插件清单合法且含全部内置插件',
    Array.isArray(manifest?.plugins) && BUILTIN.every((f) => manifest.plugins.includes(f)),
    JSON.stringify(manifest))

  const pluginSrc = {}
  for (const file of manifest.plugins) {
    pluginSrc[file] = await (await fetch(`${base}/plugins/${file}`)).text()
  }
  const all = Object.values(pluginSrc).join('\n')

  checks.expect('stream 一键清空录像: 两步确认 + confirm:true + 清掉失效链',
    pluginSrc['stream.js'].includes('id="rec-clear"') &&
    pluginSrc['stream.js'].includes("call('mediamtx.recordings.deleteAll', { confirm: true })") &&
    pluginSrc['stream.js'].includes('再点一次确认清空') &&
    pluginSrc['stream.js'].includes('录像已全部清空'))
  // 清空必须广播到已挂载的回放插件——否则录像回放/同步墙继续持有指向已删除
  // 段的旧链，切回页面还能看到旧片段（点了必然失败）。三个插件都要接线。
  checks.expect('清空录像广播清台: stream emit + player/sync 订阅',
    pluginSrc['stream.js'].includes("ctx.emit('xmedia:recordings-cleared'") &&
    pluginSrc['player.js'].includes("ctx.on('xmedia:recordings-cleared'") &&
    pluginSrc['sync.js'].includes("ctx.on('xmedia:recordings-cleared'"))
  // 会话表要标出 publish/read 角色，否则"2 rtmp + 1 webrtc"被误读为异常。
  checks.expect('会话表标注推流/观看角色(解释 rtmp+webrtc 来源)',
    pluginSrc['stream.js'].includes('/publish/i.test(d)') &&
    pluginSrc['stream.js'].includes('/read/i.test(d)') &&
    pluginSrc['stream.js'].includes('两路推流 + 一个观看者'))

  // live: WHEP client is the SHARED module (single source of truth), not an
  // inline copy; self-heal markers; re-encode explanation.
  checks.expect('live 插件从共享模块 ../whep.js 引入 WHEP 客户端',
    pluginSrc['live.js'].includes("import { startWhep, nativeHlsSupported } from '../whep.js'") &&
    !all.includes('async function startWhep(') && !all.includes('function nativeHlsSupported('))
  // A finite file source ends its realtime publish and MediaMTX drops the path;
  // the page must still recover (check status → republish → retry WHEP) instead
  // of dumping "no stream is available" on the user.
  checks.expect('live 插件具备无活跃流自愈与首帧重试',
    pluginSrc['live.js'].includes('ensurePublishing') && pluginSrc['live.js'].includes('/no stream/i') &&
    pluginSrc['live.js'].includes('自动重新发布'))
  // Finite-source looping is OPT-IN. Guard against the old "click 开播 ⇒ loop
  // forever" behaviour: the checkbox is the only switch, starts unchecked, and
  // neither 开播 nor page reload may flip loopIntent back on by itself.
  checks.expect('live 循环推流默认关闭且由复选框控制',
    pluginSrc['live.js'].includes('<input id="loop" type="checkbox">循环推流') &&
    pluginSrc['live.js'].includes('默认不循环') &&
    pluginSrc['live.js'].includes('syncLoopIntent') &&
    !pluginSrc['live.js'].includes('loopIntent = true'))
  checks.expect('live HLS 自动回退不吞掉用户的循环选择',
    pluginSrc['live.js'].includes('function playHls(text, isError, keepLoop = false)') &&
    pluginSrc['live.js'].includes(', false, true)'))
  // The page must auto-connect an already-running publish on load. A late
  // first frame is only surfaced as a hint — the WHEP session must NOT be
  // torn down (that regressed playback that previously worked).
  checks.expect('live 页面刷新自动接流且首帧异常只提示不掐断会话',
    pluginSrc['live.js'].includes('const initialize = async () =>') &&
    pluginSrc['live.js'].includes('status.running') &&
    pluginSrc['live.js'].includes('waitForFrames') &&
    pluginSrc['live.js'].includes('videoWidth > 0') &&
    pluginSrc['live.js'].includes('迟迟未出现画面') &&
    !pluginSrc['live.js'].includes('WHEP 已握手但未收到可解码画面'))
  // 职责收敛：自有流与 stream 指来的就绪路径共用一个 watch(path)，HLS 回退只写一份。
  checks.expect('live 只有一个观看入口 watch(path) 且 HLS 回退共用 playHls',
    !pluginSrc['live.js'].includes('watchPath') &&
    pluginSrc['live.js'].includes('async function watch(path)') &&
    (pluginSrc['live.js'].match(/playHls\(/g) ?? []).length >= 3)
  // 多路并发：每次开播用独立 jobId，status/stop 按 jobId 路由，并提供任务池快照。
  // 缺了这些，"推第二个流"会被 lastJobId 静默合并成第一路（已实测复现）。
  checks.expect('live 多路推流:独立 jobId + 按 jobId 路由 + 任务池快照',
    pluginSrc['live.js'].includes('const jobId = genJobId()') &&
    pluginSrc['live.js'].includes('const params = { input, jobId, path }') &&
    pluginSrc['live.js'].includes("call('xmedia.publish.status', jobParam())") &&
    pluginSrc['live.js'].includes("call('xmedia.publish.stop', { jobId: currentJobId })") &&
    pluginSrc['live.js'].includes("call('xmedia.publish.jobs')") &&
    pluginSrc['live.js'].includes('const started = await startPublish()') &&
    pluginSrc['live.js'].includes('data-pool-watch'))
  // 多路可见性：留空 path 时每路必须用独立路径，否则 MediaMTX 把多路合并成一条，
  // 推流状态只剩一行、录像只产生一路，"同步回放"退化为单路播放器（已实测复现）。
  checks.expect('live 多路推流:留空 path 自动生成独立路径(避免 MediaMTX 合并)',
    pluginSrc['live.js'].includes('const genPath = () => `live-') &&
    pluginSrc['live.js'].includes("const path = $id('path').value.trim() || genPath()") &&
    pluginSrc['live.js'].includes('placeholder="留空自动生成（多路必填不同）"'))
  checks.expect('live 插件注明实时预览默认重编码', pluginSrc['live.js'].includes('默认重新编码'))
  // 一键开播（单一主行动）+ 状态徽章/进度 + 剪贴板复制 + 渐进披露，零依赖原生实现。
  checks.expect('live 一键开播 + 状态可视化 + 地址可复制 + 渐进披露',
    pluginSrc['live.js'].includes('▶ 开播') &&
    pluginSrc['live.js'].includes("id=\"go\"") && !pluginSrc['live.js'].includes('id=\"publish\"') &&
    pluginSrc['live.js'].includes('id=\"live-badge\"') && pluginSrc['live.js'].includes('id=\"live-progress\"') &&
    pluginSrc['live.js'].includes('navigator.clipboard.writeText') &&
    pluginSrc['live.js'].includes('<details') && pluginSrc['live.js'].includes('<datalist'))
  checks.expect('monitor 插件含转码任务监控区(任务池快照 + 暂停/继续操作)',
    pluginSrc['monitor.js'].includes('转码任务监控') && pluginSrc['monitor.js'].includes('xmedia.publish.jobs') &&
    pluginSrc['monitor.js'].includes('新建转码') && pluginSrc['monitor.js'].includes('data-act="pause"'))
  checks.expect('stream 插件消费组合进来的 mediamtx 控制面(路径/会话/录制/回放/指标/endpoints)',
    pluginSrc['stream.js'].includes('mediamtx.paths.list') && pluginSrc['stream.js'].includes('mediamtx.info') &&
    pluginSrc['stream.js'].includes('mediamtx.sessions.kick') && pluginSrc['stream.js'].includes('mediamtx.recordings.list') &&
    pluginSrc['stream.js'].includes('mediamtx.playback.list') && pluginSrc['stream.js'].includes('mediamtx.endpoints') &&
    pluginSrc['stream.js'].includes('mediamtx.config.paths.add'))
  checks.expect('live/stream 插件含本地流服务状态灯与启动入口',
    pluginSrc['live.js'].includes('mediamtx.status') && pluginSrc['live.js'].includes('mediamtx.start') &&
    pluginSrc['stream.js'].includes('mediamtx.status') && pluginSrc['stream.js'].includes('mediamtx.start'))
  checks.expect('录像回放/同步回放/config 插件接入 MSE 链/同步墙/配置编辑器',
    pluginSrc['player.js'].includes('MsePlayer') && pluginSrc['sync.js'].includes('locateInSlot') &&
    pluginSrc['config.js'].includes('configDiff'))
  // 同步回放入口与单路回放的区分:动态"已接入 N 路"徽章让多路对齐状态一眼可见,
  // 避免用户误以为它只是「录像回放」的另一个播放器。
  checks.expect('sync 动态显示已接入路数(与单路录像回放区分)',
    pluginSrc['sync.js'].includes('id="sy-count"') &&
    pluginSrc['sync.js'].includes('已接入 ${active.length} 路') &&
    pluginSrc['sync.js'].includes('active.length >= 2'))
  // CRITICAL: renderGrid() does grid.innerHTML = '' — it recreates EVERY <video>.
  // Detaching only identity-changed cells leaves the earlier cell's player bound
  // to the removed element, so its brand-new <video> stays black forever.
  checks.expect('sync 全量重建格子时拆掉所有播放器(避免旧 video 黑屏)',
    pluginSrc['sync.js'].includes("grid.innerHTML = ''") &&
    pluginSrc['sync.js'].includes("identities[i] = i < layout ? cellId(slots[i], i) : ''") &&
    pluginSrc['sync.js'].includes('detachCell(i)'))
  // The toggle is disabled in markup. reflow() must clear it when a valid
  // timeline exists, or the wall shows a clock but cannot be played at all.
  checks.expect('sync 算出时间线后启用播放按钮(整墙可播)',
    pluginSrc['sync.js'].includes("$id('sy-toggle').disabled = false") &&
    pluginSrc['sync.js'].includes("$id('sy-toggle').disabled = true"))
  // Streams are published one after another, so their recording windows start
  // at different wall-clock times. Wall alignment alone left every cell but the
  // earliest black ("only first window plays"). Default sequential alignment
  // starts every cell at its own first window; wall mode stays opt-in; and a
  // cell outside its footage must show a note instead of a silent black tile.
  const syncMathSrc = await (await fetch(`${base}/plugins/lib/sync-math.js`)).text()
  checks.expect('sync 顺序对齐: 默认各路从头一起播 + 墙钟模式可选 + 无画面格显式提示',
    syncMathSrc.includes('export function locateInChain') &&
    pluginSrc['sync.js'].includes("locateInChain") &&
    pluginSrc['sync.js'].includes("let align = 'chain'") &&
    pluginSrc['sync.js'].includes('id="sy-align"') &&
    pluginSrc['sync.js'].includes("e.target.value === 'wall' ? 'wall' : 'chain'") &&
    pluginSrc['sync.js'].includes('align === \'wall\'\n      ? locateInSlot(globalMs, slot)') &&
    pluginSrc['sync.js'].includes("notes[i] = '该时段无录像'") &&
    pluginSrc['sync.js'].includes("notes[i] = align === 'chain' ? '本路已播完' : '录像间隙'") &&
    pluginSrc['sync.js'].includes('paintBadge(i)'))
  // sync 的外部实时流:直链交给编码引擎转推进 MediaMTX,浏览器 WHEP/HLS 直连;
  // 实时格不参与录像时间线,移除/清空只停本面板创建的任务,清录像不牵连直播。
  checks.expect('sync 可添加外部实时流(转推/WHEP/回收任务/实时格不参与录像时间线)',
    pluginSrc['sync.js'].includes("import { startWhep, nativeHlsSupported } from '../whep.js'") &&
    pluginSrc['sync.js'].includes('id="sy-ext-url"') &&
    pluginSrc['sync.js'].includes('id="sy-ext-add"') &&
    pluginSrc['sync.js'].includes("call('xmedia.publish.start', { input: raw, path, jobId })") &&
    pluginSrc['sync.js'].includes("call('xmedia.publish.viewers', { path: slot.path })") &&
    pluginSrc['sync.js'].includes('startWhep(url, video, { audio: false })') &&
    pluginSrc['sync.js'].includes('nativeHlsSupported()') &&
    pluginSrc['sync.js'].includes("call('xmedia.publish.stop', { jobId: old.jobId })") &&
    pluginSrc['sync.js'].includes('slot.live === true') &&
    pluginSrc['sync.js'].includes('liveOnly: true') &&
    pluginSrc['sync.js'].includes('slots[i].live !== true') &&
    pluginSrc['player.js'].includes('MsePlayer') && !pluginSrc['player.js'].includes('startWhep'))
  // CRITICAL: 'ended' must come from the <video>'s NATIVE ended event (real
  // playback completion), NEVER from finish()/fetch-drain. On a fast local
  // fetch, reporting ended at drain (~90ms into a 19s clip) made the consumer
  // clear the stage / pause the wall while the picture was still playing —
  // the "one frame then black" / "sync all black" bug. Guard both halves:
  // finish() only calls endOfStream(); onNativeEnded is the sole onState('ended').
  const mseSrcPath = fileURLToPath(new URL('../apps/web/dist/plugins/lib/mse.js', import.meta.url))
  const mseSrc = existsSync(mseSrcPath) ? readFileSync(mseSrcPath, 'utf8') : null
  checks.expect('MsePlayer: ended 只由 video 原生事件上报(非 fetch 读完)',
    !!mseSrc?.includes('this.onNativeEnded = () =>') &&
    !!mseSrc?.includes("video.addEventListener('ended', this.onNativeEnded)") &&
    !!mseSrc?.includes('this.onState(\'ended\')') &&
    !!mseSrc?.includes('this.dataEnded = true') &&
    !!mseSrc?.includes('if (this.dataEnded || this.disposed || streamDone === false) return') &&
    // finish() must NOT report ended itself: after stripping comment lines,
    // the only onState('ended') call must be the one in onNativeEnded.
    (() => {
      const code = (mseSrc ?? '').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
      return (code.match(/this\.onState\('ended'\)/g) ?? []).length === 1
    })() &&
    !!mseSrc?.includes('play\\(\\) request was interrupted'))
  // 职责收敛：player 只做单路录像回放，实时 WHEP/HLS 由 live 独占；sync 引导单路去录像回放。
  checks.expect('player 专注录像回放(无 WHEP/HLS 实时管线，标题为「录像回放」)',
    pluginSrc['player.js'].includes("title: '录像回放'") &&
    !pluginSrc['player.js'].includes('startWhep') && !pluginSrc['player.js'].includes('nativeHlsSupported') &&
    !pluginSrc['player.js'].includes("value=\"whep\"") && !pluginSrc['player.js'].includes("value=\"hls\""))
  checks.expect('sync 引导单路用「录像回放」', pluginSrc['sync.js'].includes('单路回放请用「录像回放」'))
  // 职责收敛：stream 的写操作是「接入外部拉流源」(source 必填)，本地推流归 live。
  checks.expect('stream 只接外部拉流源(必填 source)，本地推流引导去「实时预览」',
    pluginSrc['stream.js'].includes('<h2>接入拉流源</h2>') &&
    pluginSrc['stream.js'].includes("source === ''") &&
    pluginSrc['stream.js'].includes('params = { name, record, source }') &&
    pluginSrc['stream.js'].includes('本地推流请用「实时预览」'))
  checks.expect('studio 插件含 HF Studio 入口区', pluginSrc['studio.js'].includes('HF Studio 编辑器'))
  checks.expect('页面用 <video> 播放,不再有 MJPEG 帧订阅',
    pluginSrc['live.js'].includes('<video') && !all.includes('xmedia.frames'))
  checks.expect('页面不含 C++ 引擎自检区块与 snapshot 抓帧',
    !all.includes('引擎自检') && !all.includes('xmedia.snapshot'))
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
