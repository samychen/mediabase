// product/highlight / scripts / verify.mjs — end-to-end smoke.
//
// Boots the product host (or talks to a running one via VHL_URL), then walks the
// whole surface a client and an agent use: health, the capability manifest, the
// engine handshake, probe, the analyze lifecycle, cancel semantics, the clip
// byte route (with a Range window), EDL export, the drift gates and the page.
//
// Engine under test: the REAL Python bridge when python3 + ffmpeg are present
// (that is the product's promise), otherwise the Node double. Force either with
// VHL_ENGINE=real|fake.
//
// Run:  pnpm run verify:highlight
//       VHL_URL=http://127.0.0.1:3093 node product/highlight/scripts/verify.mjs

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checker, connect } from '../../../scripts/lib/host-rpc.mjs'
import { hasFfmpeg, makeFixture } from './lib/media.mjs'

const PRODUCT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const FAKE_BRIDGE = fileURLToPath(new URL('../tests/support/fake-bridge.mjs', import.meta.url))
const REAL_BRIDGE = fileURLToPath(new URL('../engine/vhl_bridge.py', import.meta.url))
const checks = checker()

const has = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' }).status === 0

const pythonOk = has(process.env.VHL_PYTHON ?? 'python3', ['-c', 'import sys; print(sys.version)'])
const ffmpegOk = hasFfmpeg()
// `--engine=real|fake` is the cross-platform switch (no inline env assignment
// in package.json, which breaks on Windows shells); VHL_ENGINE still works.
const engineArg = process.argv.slice(2).find((arg) => arg.startsWith('--engine='))
const forced = engineArg?.slice('--engine='.length) ?? process.env.VHL_ENGINE
const useReal = forced === 'real' || (forced !== 'fake' && pythonOk && ffmpegOk)

const freePort = () => new Promise((resolve) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})

const waitForHealth = async (base, timeoutMs = 60_000) => {
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

/** The synthetic 12s clip lives in scripts/lib/media.mjs (shared with verify-ui). */

const externalUrl = process.env.VHL_URL
let child = null
let home = null
let fixture = null
/** What the fixture was encoded as: { codec, browserPlayable }. */
let fixtureMedia = null
let base = externalUrl?.replace(/\/+$/, '')

if (base === undefined) {
  const port = await freePort()
  home = mkdtempSync(join(tmpdir(), 'vhl-verify-'))
  mkdirSync(join(home, 'media'), { recursive: true })
  base = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    VHL_HOME: home,
    PORT: String(port),
    VHL_LOG_LEVEL: 'warn',
    VHL_STRICT_CAPABILITIES: '1',
    VHL_WORK_DIR: join(home, 'jobs'),
    VHL_ENGINE_AUTO_RESTART: '0',
    // One slot, so the backpressure check below is deterministic: the second
    // concurrent start MUST be refused rather than silently queued.
    VHL_MAX_QUEUE: '1',
  }
  if (useReal) {
    env.VHL_PYTHON = process.env.VHL_PYTHON ?? 'python3'
    env.VHL_ENGINE_SCRIPT = REAL_BRIDGE
  } else {
    env.VHL_PYTHON = process.execPath
    env.VHL_ENGINE_SCRIPT = FAKE_BRIDGE
  }
  if (ffmpegOk) {
    fixture = join(home, 'media', 'fixture.mp4')
    fixtureMedia = makeFixture(fixture)
  }
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
  checks.expect('引擎选择', useReal ? useReal && pythonOk && ffmpegOk : true,
    useReal ? `real bridge (python=${pythonOk}, ffmpeg=${ffmpegOk})` : 'fake bridge')

  const health = await waitForHealth(base)
  checks.expect('GET /api/health', health?.ok === true)
  checks.expect('health 报告 highlight 引擎', typeof health?.highlight === 'object' && health.highlight !== null,
    JSON.stringify(health?.highlight ?? null))

  const rpc = connect(base, {})
  await rpc.open()

  const info = await rpc.call('server.info')
  checks.expect('server.info 握手', typeof info === 'object' && info !== null)

  const reports = await rpc.call('capabilities.verify')
  const broken = (Array.isArray(reports) ? reports : []).filter((r) => !r.ok)
  checks.expect('capabilities.verify 全部一致(strict 启动)', broken.length === 0, JSON.stringify(broken))

  const methods = (await rpc.call('api.list')).map((m) => m.name)
  for (const wanted of [
    'highlight.hello', 'highlight.engine.state', 'highlight.probe', 'highlight.start',
    'highlight.status', 'highlight.cancel', 'highlight.jobs.list', 'highlight.export.edl',
    'highlight.models', 'highlight.options', 'highlight.metrics',
  ]) {
    checks.expect(`控制面含 ${wanted}`, methods.includes(wanted))
  }
  const tools = (await rpc.call('tools.list')).map((t) => t.name)
  for (const wanted of ['highlight.probe', 'highlight.start', 'highlight.status', 'highlight.cancel', 'highlight.export.edl']) {
    checks.expect(`工具注册表含 ${wanted}`, tools.includes(wanted))
  }

  // ---- protocol contract: single source of truth --------------------------- //
  {
    const contract = JSON.parse(readFileSync(join(PRODUCT_ROOT, 'protocol/contract.json'), 'utf8'))
    const generated = readFileSync(join(PRODUCT_ROOT, 'engine/protocol_generated.py'), 'utf8')
    const fake = readFileSync(FAKE_BRIDGE, 'utf8')
    for (const verb of Object.keys(contract.verbs)) {
      checks.expect(`生成的 Python 协议表包含 ${verb}`, generated.includes(`"${verb}"`))
      checks.expect(`测试替身实现 ${verb}`, fake.includes(`'${verb}'`))
    }
    checks.expect('协议版本为 1(与 @mediabase/engine-client 一致)', contract.protocolVersion === 1)
  }

  const hello = await rpc.call('highlight.hello')
  checks.expect('引擎 hello 协议版本=1', hello?.protocol === 1, JSON.stringify(hello))
  checks.expect('引擎标识可见', typeof hello?.engine === 'string' && hello.engine !== '', JSON.stringify(hello))

  const state = await rpc.call('highlight.engine.state')
  checks.expect('监督状态可读', typeof state?.running === 'boolean', JSON.stringify(state))
  checks.expect('引擎在跑', state?.running === true, JSON.stringify(state))

  const models = await rpc.call('highlight.models')
  checks.expect('models 带许可证标识', typeof models?.detector?.license === 'string' && models.detector.license.includes('Apache-2.0'),
    JSON.stringify(models?.detector ?? null))

  // ---- option catalogue: capability discovery ----------------------------- //
  {
    const catalog = await rpc.call('highlight.options')
    const byKey = new Map((Array.isArray(catalog) ? catalog : []).map((option) => [option.key, option]))
    checks.expect('options 目录覆盖引擎能力(≥20 项)', byKey.size >= 20, String(byKey.size))
    for (const key of ['frameAccurate', 'enableClipGuidance', 'enableFaceDetection', 'whisperModelSize', 'keywords', 'fastStreamCopy']) {
      checks.expect(`options 含 ${key}`, byKey.has(key))
    }
    checks.expect('options 声明类型与范围',
      byKey.get('maxHighlights')?.type === 'int' && byKey.get('maxHighlights')?.max === 50,
      JSON.stringify(byKey.get('maxHighlights') ?? null))
    checks.expect('需要模型的选项标注依赖', byKey.get('enableClipGuidance')?.requires === 'clip',
      JSON.stringify(byKey.get('enableClipGuidance') ?? null))
    // Availability is a claim about THIS deployment; it must be a decision, not a
    // default. (The value differs by machine — only its presence is assertable.)
    checks.expect('options 如实报告可用性', typeof byKey.get('clipPrompt')?.available === 'boolean',
      JSON.stringify(byKey.get('clipPrompt') ?? null))
    // The composite knob carries its sub-keys, so neither the UI nor an agent
    // has to guess which signals this engine fuses.
    const weightFields = Object.keys(byKey.get('weights')?.fields ?? {})
    checks.expect('options 暴露权重子键(7 个信号)',
      byKey.get('weights')?.type === 'weights' && weightFields.length === 7,
      JSON.stringify(weightFields))
  }

  // ---- option contract: rejected before a job exists ---------------------- //
  if (fixture !== null) {
    const rejected = async (options, label) => {
      try {
        await rpc.call('highlight.start', { input: fixture, options })
        checks.expect(label, false, '调用竟然成功了')
      } catch (error) {
        checks.expect(label, error?.code === -32602, `${error?.code} ${error?.message ?? ''}`)
      }
    }
    await rejected({ maxHighlights: 999 }, '越界选项被拒绝(INVALID_PARAMS)')
    await rejected({ frameSkip: 'many' }, '类型错误的选项被拒绝')
    await rejected({ whisperModelSize: 'gigantic' }, '枚举外取值被拒绝')
    await rejected({ weights: { notASignal: 0.5 } }, '未知权重子键被拒绝')
    // All-zero is the dangerous one: the engine would silently substitute its
    // defaults, so the request would look applied and change nothing.
    await rejected({ weights: { audioRms: 0, sceneCut: 0 } }, '全零权重被拒绝')
    await rejected({ weights: { audioRms: 3 } }, '权重越界被拒绝')
  }

  // ---- probe -------------------------------------------------------------- //
  if (fixture !== null) {
    const media = await rpc.call('highlight.probe', { path: fixture })
    // The fake bridge fabricates metadata, so only the wire shape is assertable
    // there; a real probe must agree with the fixture we just encoded.
    const shape = media?.durationSec > 0 && media?.fps > 0 && media?.width > 0 && media?.height > 0
    checks.expect(useReal ? 'probe 返回时长/帧率/分辨率' : 'probe 返回时长/帧率/分辨率(假引擎:仅校验形态)',
      useReal ? shape && media?.width === 320 && media?.height === 180 : shape,
      JSON.stringify(media))
    if (useReal) {
      checks.expect('probe 读出的编码与片源一致', media?.videoCodec === fixtureMedia?.codec,
        `probe=${media?.videoCodec} fixture=${fixtureMedia?.codec}`)
    }
    checks.expect('probe 报告音频轨与编码', typeof media?.hasAudio === 'boolean' &&
      typeof media?.videoCodec === 'string' && media.videoCodec !== '', JSON.stringify(media))
  } else {
    console.log('· 没有 ffmpeg,跳过 probe 与真实分析(只验证假引擎路径)')
  }

  // ---- analyze lifecycle -------------------------------------------------- //
  if (fixture !== null) {
    const started = await rpc.call('highlight.start', {
      input: fixture,
      topK: 2,
      clipDurationSec: 3,
      output: join(home, 'jobs', 'verify', 'highlight.mp4'),
    })
    checks.expect('start 返回任务 ID 与初始状态',
      typeof started?.jobId === 'string' && started.jobId !== '' &&
      ['queued', 'running'].includes(started?.state),
      JSON.stringify(started))

    let job = started
    for (let i = 0; i < 240 && !['succeeded', 'failed', 'cancelled'].includes(job?.state); i += 1) {
      await new Promise((r) => setTimeout(r, 250))
      job = await rpc.call('highlight.status', { jobId: started.jobId })
    }
    checks.expect('任务最终成功', job?.state === 'succeeded', JSON.stringify({ state: job?.state, error: job?.error }))
    checks.expect('产出片段', (job?.segmentCount ?? 0) > 0, JSON.stringify(job?.segments ?? []))
    checks.expect('进度收口到 1', job?.progress === 1, String(job?.progress))
    if (useReal) {
      checks.expect('成片文件已落盘', typeof job?.output === 'string' && existsSync(job.output) && statSync(job.output).size > 1000,
        String(job?.output))
      // A file that merely exists is not a clip. Probe the artifact itself: the
      // render path stream-copies by default, so the output must still carry the
      // source codec and geometry — a truncated concat would fail here.
      const clip = await rpc.call('highlight.probe', { path: job.output })
      checks.expect('成片可被解码且与片源同编码',
        clip?.durationSec > 0 && clip?.width === 320 && clip?.videoCodec === fixtureMedia?.codec,
        JSON.stringify(clip))
      // ---- clip byte route (data plane) ---------------------------------- //
      checks.expect('成片可回放(路由已注册)', typeof job?.clipUrl === 'string' && job.clipUrl.startsWith('/api/'),
        String(job?.clipUrl))
    }
    if (typeof job?.clipUrl === 'string' && job.clipUrl !== '') {
      const full = await fetch(`${base}${job.clipUrl}`)
      checks.expect('GET 成片路由 200 + video/mp4',
        full.status === 200 && (full.headers.get('content-type') ?? '').includes('video/mp4'),
        `HTTP ${full.status} ${full.headers.get('content-type')}`)
      checks.expect('路由支持 Range(accept-ranges)',
        (full.headers.get('accept-ranges') ?? '') === 'bytes')
      const partial = await fetch(`${base}${job.clipUrl}`, { headers: { range: 'bytes=0-1023' } })
      checks.expect('Range 请求返回 206 + content-range',
        partial.status === 206 && (partial.headers.get('content-range') ?? '').startsWith('bytes 0-1023/'),
        `HTTP ${partial.status} ${partial.headers.get('content-range')}`)
    }

    // ---- artifact data plane: the report is what makes a score auditable --- //
    if (typeof job?.reportUrl === 'string' && job.reportUrl !== '') {
      const report = await fetch(`${base}${job.reportUrl}`)
      const contentType = report.headers.get('content-type') ?? ''
      const text = await report.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* asserted below */ }
      checks.expect('报告路由 200 + application/json',
        report.status === 200 && contentType.includes('application/json') && parsed !== null,
        `HTTP ${report.status} ${contentType}`)
      // The explainability claim is only true if the payload carries the signals.
      checks.expect('报告含片段选择与信号序列',
        Array.isArray(parsed?.selected_highlights) && Array.isArray(parsed?.timeline_series),
        Object.keys(parsed ?? {}).join(','))
    } else {
      checks.expect('任务成功后报告路由已注册', false, 'reportUrl 为空')
    }

    // ---- weights reach the scorer, not just the validator ----------------- //
    if (useReal) {
      // One signal, everything else zero: the normalised weights in the report
      // then have exactly one true statement, so "the knob was applied" is
      // assertable without asserting anything about the media.
      const weighted = await rpc.call('highlight.start', {
        input: fixture,
        topK: 1,
        clipDurationSec: 3,
        output: join(home, 'jobs', 'verify', 'weighted.mp4'),
        options: {
          weights: {
            audioRms: 1, sceneCut: 0, visualMotion: 0, objectSaliency: 0,
            faceSaliency: 0, clipGuidance: 0, keywordMatch: 0,
          },
        },
      })
      let wjob = weighted
      for (let i = 0; i < 240 && !['succeeded', 'failed', 'cancelled'].includes(wjob?.state); i += 1) {
        await new Promise((r) => setTimeout(r, 250))
        wjob = await rpc.call('highlight.status', { jobId: weighted.jobId })
      }
      checks.expect('带权重的任务成功', wjob?.state === 'succeeded',
        JSON.stringify({ state: wjob?.state, error: wjob?.error }))
      if (typeof wjob?.reportUrl === 'string' && wjob.reportUrl !== '') {
        const report = await (await fetch(`${base}${wjob.reportUrl}`)).json()
        const applied = report?.config?.weights ?? {}
        checks.expect('报告回显归一后的权重(参数真的进了评分)',
          Math.abs((applied.audio_rms ?? -1) - 1) < 1e-6 && (applied.scene_cut ?? -1) === 0,
          JSON.stringify(applied))
      }
    }

    if ((job?.srtPath ?? '') !== '' && typeof job?.subtitleUrl === 'string' && job.subtitleUrl !== '') {
      const subtitle = await fetch(`${base}${job.subtitleUrl}`)
      const vtt = await subtitle.text()
      checks.expect('字幕路由 200 + WebVTT(SRT 已转换)',
        subtitle.status === 200 && (subtitle.headers.get('content-type') ?? '').includes('text/vtt') &&
        vtt.startsWith('WEBVTT'),
        `HTTP ${subtitle.status} ${subtitle.headers.get('content-type')}`)
    } else {
      console.log('· 本次没有字幕产物(未装 faster-whisper 或未启用转写),跳过字幕路由')
    }

    // ---- EDL export ------------------------------------------------------ //
    const edlPath = join(home, 'jobs', 'verify', 'highlight.edl')
    const written = await rpc.call('highlight.export.edl', { jobId: job.jobId, path: edlPath })
    // The engine resolves symlinks, so compare resolved paths — on macOS the
    // temp dir is /var/… while the filesystem reports /private/var/…
    let expected = edlPath
    try { expected = realpathSync(edlPath) } catch { /* not written yet */ }
    checks.expect('export.edl 返回落盘路径', written === expected || written === edlPath, String(written))
    const edl = existsSync(edlPath) ? readFileSync(edlPath, 'utf8') : ''
    checks.expect('EDL 是 CMX3600 形态', edl.startsWith('TITLE:') && edl.includes('FCM: NON-DROP FRAME') && edl.includes('  C  '),
      edl.slice(0, 120))
    const events = edl.split('\n').filter((line) => /^\d{3}\s+AX\s+V\s+C\s+\d{2}:\d{2}:\d{2}:\d{2}/.test(line))
    checks.expect('EDL 事件数 = 片段数', events.length === (job?.segmentCount ?? -1),
      `events=${events.length} segments=${job?.segmentCount}`)

    // ---- cancel: no half-rendered artifact ------------------------------ //
    const cancelledOut = join(home, 'jobs', 'verify', 'cancelled.mp4')
    const second = await rpc.call('highlight.start', {
      input: fixture,
      output: cancelledOut,
    })
    await rpc.call('highlight.cancel', { jobId: second.jobId })
    let final = null
    for (let i = 0; i < 80; i += 1) {
      final = await rpc.call('highlight.status', { jobId: second.jobId })
      if (['succeeded', 'failed', 'cancelled'].includes(final?.state)) break
      await new Promise((r) => setTimeout(r, 200))
    }
    checks.expect('取消后任务终止(cancelled 或 failed)',
      ['cancelled', 'failed'].includes(final?.state), JSON.stringify({ state: final?.state, error: final?.error }))
    checks.expect('取消不留半成品成片', !existsSync(cancelledOut), cancelledOut)

    const metrics = await rpc.call('highlight.metrics')
    checks.expect('metrics 记录任务启动', (metrics?.jobsStarted ?? 0) >= 2, JSON.stringify(metrics))
    checks.expect('metrics 记录成功与取消',
      (metrics?.succeeded ?? 0) >= 1 && (metrics?.cancelled ?? 0) + (metrics?.failed ?? 0) >= 1,
      JSON.stringify(metrics))

    // ---- Prometheus exposition -------------------------------------------- //
    const scrape = await fetch(`${base}/api/metrics`)
    const exposition = await scrape.text()
    checks.expect('GET /api/metrics 回 Prometheus 文本',
      scrape.status === 200 && (scrape.headers.get('content-type') ?? '').includes('text/plain; version=0.0.4'),
      `HTTP ${scrape.status} ${scrape.headers.get('content-type')}`)
    const sampleOf = (name) => {
      const row = exposition.split('\n').find((line) => line.startsWith(`${name} `))
      return row === undefined ? null : Number(row.slice(name.length + 1))
    }
    // Two exits, one truth: the JSON API and the scrape must not drift apart.
    checks.expect('抓取值与 highlight.metrics 一致',
      sampleOf('vhl_jobs_started_total') === metrics?.jobsStarted,
      `scrape=${sampleOf('vhl_jobs_started_total')} rpc=${metrics?.jobsStarted}`)
    checks.expect('引擎就绪与任务耗时直方图已上报',
      sampleOf('vhl_engine_ready') === 1 && (sampleOf('vhl_job_duration_seconds_count') ?? 0) >= 1,
      exposition.split('\n').filter((l) => l.startsWith('vhl_engine_ready') || l.startsWith('vhl_job_duration_seconds_count')).join(' | '))
    // VHL_MAX_QUEUE=1 above: the exposure must echo the CONFIGURED ceiling, not a
    // default, otherwise the gauge is decoration.
    checks.expect('队列容量随配置上报(不是猜的)', sampleOf('vhl_queue_capacity') === 1,
      String(sampleOf('vhl_queue_capacity')))
    checks.expect('指标里没有 jobId 之类的高基数标签',
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(exposition),
      exposition.slice(0, 200))

    // ---- backpressure: the queue is bounded, and it says so --------------- //
    const blocker = await rpc.call('highlight.start', {
      input: fixture,
      output: join(home, 'jobs', 'verify', 'busy.mp4'),
    })
    let conflict = null
    try {
      await rpc.call('highlight.start', {
        input: fixture,
        output: join(home, 'jobs', 'verify', 'overflow.mp4'),
      })
    } catch (error) {
      conflict = error
    }
    checks.expect('队列满时回 CONFLICT(可重试,不是黑洞)',
      conflict?.code === -32004,
      conflict === null ? '第二次 start 竟然被接受' : `${conflict.code} ${conflict.message}`)
    // The refusal must name the same ceiling the host configured and exports.
    checks.expect('拒绝文本里的容量与配置一致(1/1)',
      typeof conflict?.message === 'string' && conflict.message.includes('(1/1)'),
      String(conflict?.message))
    const pressured = await rpc.call('highlight.metrics')
    checks.expect('metrics 暴露队列深度',
      typeof pressured?.queueDepth === 'number' && pressured.queueDepth >= 1,
      JSON.stringify(pressured))
    await rpc.call('highlight.cancel', { jobId: blocker.jobId })
  }

  // ---- drift gates -------------------------------------------------------- //
  for (const [label, script, args] of [
    ['协议表与 contract.json 一致', 'product/highlight/scripts/gen-protocol.mjs', ['--check']],
    ['客户端名册与 client.yml 一致', 'product/highlight/scripts/gen-client-roster.mjs', ['--check']],
  ]) {
    const run = spawnSync(process.execPath, [join(REPO_ROOT, script), ...args], { encoding: 'utf8', cwd: REPO_ROOT })
    checks.expect(label, run.status === 0, `${run.stdout}${run.stderr}`.trim())
  }

  // ---- page (only when the static build exists) --------------------------- //
  const dist = join(PRODUCT_ROOT, 'apps/web/dist/index.html')
  if (existsSync(dist)) {
    const page = await fetch(`${base}/`)
    const html = await page.text()
    checks.expect('GET / 返回宿主页面', page.ok)
    checks.expect('页面是 VHL 页面', html.includes('VHL') || html.includes('vhl'), html.slice(0, 200))
  } else {
    console.log('· apps/web/dist 不存在,跳过页面检查(先运行 pnpm run build:highlight)')
  }

  rpc.close()
} catch (e) {
  checks.fail('冒烟执行', e instanceof Error ? e.stack ?? e.message : String(e))
}

exitCode = checks.summary('VHL OK')
if (child !== null) {
  child.kill('SIGTERM')
  await new Promise((r) => child.once('exit', r))
}
if (home !== null) rmSync(home, { recursive: true, force: true })
process.exit(exitCode)
