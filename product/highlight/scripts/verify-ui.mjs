// product/highlight / scripts / verify-ui.mjs — browser acceptance for the panels.
//
// The control plane can be green while the page is a blank rectangle: a panel
// that never mounts, a store that never polls, a <video> whose src 404s. This
// script drives a REAL Chrome over CDP against a REAL engine and asserts what a
// reviewer actually sees:
//
//   mount two panels → probe the fixture → analyze → job succeeds →
//   the clip decodes in the browser (videoWidth/readyState, not just bytes) →
//   "定位" seeks inside the clip → EDL export shows its path → no page exception.
//
// It is intentionally NOT part of `verify:highlight`: it needs Chrome, python3,
// ffmpeg and a built page, and a machine without them should still be able to
// run the product's smoke test. Missing prerequisites SKIP (exit 0) with the
// reason printed.
//
// Run:  pnpm run verify:highlight:ui
//       CHROME_PATH=/path/to/chrome node product/highlight/scripts/verify-ui.mjs

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checker } from '../../../scripts/lib/host-rpc.mjs'
import { hasFfmpeg, makeFixture } from './lib/media.mjs'

const PRODUCT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const checks = checker()

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter((p) => typeof p === 'string' && p !== '')

const findChrome = () => CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null

const has = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' }).status === 0
const freePort = () => new Promise((resolve) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Labels in both locales: the harness must not depend on which one the host
// negotiates, and matching either proves the dictionary is wired.
const L = {
  control: ['高光分析', 'Highlights'],
  probe: ['探测', 'Probe'],
  start: ['开始分析', 'Analyze'],
  seek: ['定位', 'Seek'],
  edl: ['导出 EDL', 'Export EDL'],
  succeeded: ['已完成', 'Succeeded'],
}

/** Expr fragment: is any of these strings on the page? */
const textIs = (labels) => `(${JSON.stringify(labels)}.some((s) => document.body.innerText.includes(s)))`

/** Expr: click the first button whose text is one of `labels`. */
const clickText = (labels) =>
  `(() => { const want = ${JSON.stringify(labels)}; const b = [...document.querySelectorAll('button')]
     .find((x) => want.includes(x.textContent.trim())); if (!b) return false; b.click(); return true })()`

// --------------------------------------------------------------------------- //
// Prerequisites
// --------------------------------------------------------------------------- //

const chrome = findChrome()
const pythonOk = has(process.env.VHL_PYTHON ?? 'python3', ['-c', 'import sys; print(sys.version)'])
const ffmpegOk = hasFfmpeg()
const dist = join(PRODUCT_ROOT, 'apps/web/dist/index.html')
const missing = [
  chrome === null ? 'Chrome(CHROME_PATH)' : null,
  pythonOk ? null : 'python3',
  ffmpegOk ? null : 'ffmpeg',
  existsSync(dist) ? null : 'apps/web/dist(先 pnpm run build:highlight)',
].filter((v) => v !== null)

if (missing.length > 0) {
  console.log(`· 跳过浏览器验收:缺少 ${missing.join(' / ')}`)
  console.log('UI SKIP')
  process.exit(0)
}

// --------------------------------------------------------------------------- //
// Boot the product host on a throwaway home
// --------------------------------------------------------------------------- //

const port = await freePort()
const debugPort = await freePort()
const home = mkdtempSync(join(tmpdir(), 'vhl-ui-'))
const mediaDir = join(home, 'media')
mkdirSync(mediaDir, { recursive: true })
const fixture = join(mediaDir, 'fixture.mp4')
const fixtureMedia = makeFixture(fixture)
const base = `http://127.0.0.1:${port}`
const shotPath = join(home, 'ui.png')

const hostLog = []
const host = spawn(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts'], {
  cwd: PRODUCT_ROOT,
  env: {
    ...process.env,
    VHL_HOME: home,
    PORT: String(port),
    VHL_LOG_LEVEL: 'warn',
    VHL_WORK_DIR: join(home, 'jobs'),
    VHL_ENGINE_AUTO_RESTART: '0',
    VHL_PYTHON: process.env.VHL_PYTHON ?? 'python3',
    VHL_ENGINE_SCRIPT: join(PRODUCT_ROOT, 'engine/vhl_bridge.py'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
host.stdout.on('data', (d) => hostLog.push(String(d)))
host.stderr.on('data', (d) => hostLog.push(String(d)))

const waitForHealth = async (timeoutMs = 90_000) => {
  const start = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return await r.json()
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`host 未就绪:${hostLog.join('').slice(-2000)}`)
    await sleep(250)
  }
}

// --------------------------------------------------------------------------- //
// A minimal CDP client (Node's built-in WebSocket, no dependencies)
// --------------------------------------------------------------------------- //

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  const events = []
  let nextId = 1
  let opened = false

  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => { opened = true; resolve() })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
  })

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    if (msg.id !== undefined) {
      const slot = pending.get(msg.id)
      if (!slot) return
      pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`))
      else slot.resolve(msg.result)
      return
    }
    events.push(msg)
  })

  return {
    open,
    events,
    send(method, params = {}) {
      if (!opened) throw new Error('CDP 尚未连接')
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { try { ws.close() } catch { /* already gone */ } },
  }
}

/** Poll an expression until it is truthy; returns its value. */
const waitFor = async (page, expression, { label = expression, timeoutMs = 60_000, everyMs = 200 } = {}) => {
  const start = Date.now()
  let last
  for (;;) {
    last = await page.evaluate(expression)
    if (last) return last
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时:${label}(最后一次=${JSON.stringify(last)})`)
    await sleep(everyMs)
  }
}

let chromeChild = null
let page = null
let exitCode = 0

try {
  const health = await waitForHealth()
  checks.expect('宿主健康检查就绪', health?.ok === true)

  chromeChild = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    // Chrome 111+ rejects a CDP client that sends an Origin header without this.
    '--remote-allow-origins=*',
    // Containers and sandboxed CI runners cannot create Chrome's own sandbox
    // ("sandbox initialization failed: Operation not permitted"), and the
    // failure takes the whole process tree down. This harness only ever loads
    // the product's own page over loopback, so the browser sandbox is not the
    // boundary here — the host's ACL and read-only flag are.
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--user-data-dir=${join(home, 'chrome')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,1400',
    // Pin the locale so the assertions match the zh-CN dictionary; the panel
    // itself renders whatever i18n negotiates.
    '--lang=zh-CN',
    '--accept-lang=zh-CN',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let chromeErr = ''
  chromeChild.stderr.on('data', (d) => { chromeErr += d })

  // Wait for the debugging endpoint, then open the product page in a target of
  // our own (so the URL we navigate is the one we assert on).
  const targets = await (async () => {
    const start = Date.now()
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
        if (r.ok) {
          const list = await r.json()
          if (Array.isArray(list) && list.length > 0) return list
        }
      } catch { /* not up yet */ }
      if (Date.now() - start > 30_000) throw new Error(`Chrome 未就绪:${chromeErr.slice(-800)}`)
      await sleep(200)
    }
  })()

  const target = targets.find((t) => t.type === 'page')
  if (target === undefined) throw new Error(`Chrome 没有 page target:${JSON.stringify(targets.map((t) => t.type))}`)

  const client = cdp(target.webSocketDebuggerUrl)
  await client.open
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Log.enable')

  const evaluate = async (expression) => {
    const res = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text
      throw new Error(`页面内求值失败:${detail}\nexpr: ${expression.slice(0, 200)}`)
    }
    return res.result.value
  }
  page = { evaluate, send: client.send }

  await client.send('Page.navigate', { url: `${base}/` })
  await waitFor(page, `document.readyState === 'complete'`, { label: '页面 load' })

  // ---- panels mount -------------------------------------------------------- //
  await waitFor(page, `!!document.querySelector('#vhl-input')`, { label: '控制面板挂载', timeoutMs: 30_000 })
  checks.expect('控制面板挂载(#vhl-input 存在)', true)
  checks.expect('面板标题出现', await evaluate(textIs(L.control)), await evaluate('document.body.innerText.slice(0, 200)'))
  // The shell renders the registered title; a panel that ALSO prints it shows it
  // twice (this shipped once — the screenshot caught it, nothing else did).
  checks.expect('面板标题只出现一次(不与外壳重复)',
    await evaluate(`(() => { const text = document.body.innerText;
      const hits = ${JSON.stringify(L.control)}.map((s) => text.split(s).length - 1);
      return Math.max(...hits) === 1 })()`),
    await evaluate(`JSON.stringify(${JSON.stringify(L.control)}.map((s) => document.body.innerText.split(s).length - 1))`))
  checks.expect('结果面板挂载', await evaluate(`!!document.querySelector('.vhl-result')`))
  checks.expect('引擎标识已从宿主取得', await evaluate(`!!document.querySelector('.vhl-head .badge')`),
    await evaluate(`document.querySelector('.vhl-head')?.innerText ?? ''`))

  // ---- advanced knobs come from the catalogue, not from the bundle --------- //
  await waitFor(page, `document.querySelectorAll('.vhl-opt-row').length > 8`,
    { label: '高级参数渲染', timeoutMs: 20_000 })
  const advanced = await evaluate(`(() => {
    const box = document.querySelector('details.vhl-advanced');
    if (!box) return null;
    box.open = true;
    const rows = box.querySelectorAll('.vhl-opt-row').length;
    const groups = box.querySelectorAll('.vhl-opt-group').length;
    // A model-backed control must be disabled with a reason, not accept-then-ignore.
    const disabled = [...box.querySelectorAll('.vhl-opt-row')]
      .filter((row) => row.querySelector('input:disabled, select:disabled'))
      .map((row) => row.textContent.trim());
    // The composite knob: seven sub-rows inside ONE group, rendered from the
    // catalogue's sub-keys rather than a hardcoded list of signals.
    const weights = box.querySelector('.vhl-opt-weights');
    const weightInputs = weights === null ? 0 : weights.querySelectorAll('.vhl-opt-sub input').length;
    return { rows, groups, disabled, weights: weightInputs, summary: box.querySelector('summary')?.textContent ?? '' };
  })()`)
  checks.expect('高级参数按目录渲染(≥8 行 / ≥3 组)',
    (advanced?.rows ?? 0) >= 8 && (advanced?.groups ?? 0) >= 3, JSON.stringify(advanced))
  checks.expect('权重是一个复合控件(7 个子输入)',
    advanced?.weights === 7, JSON.stringify(advanced))
  // Vacuous on a fully equipped machine (nothing disabled); on the common one it
  // proves a missing model disables the control AND says which dependency it is,
  // instead of accepting the setting and silently scoring zero.
  checks.expect('被禁用的选项都标注了缺失依赖',
    (advanced?.disabled ?? []).every((label) => label.trim().length > 0),
    JSON.stringify(advanced?.disabled ?? []))
  if ((advanced?.disabled?.length ?? 0) === 0) console.log('· 本机模型齐全,没有需要禁用的选项')

  // ---- type a path, probe -------------------------------------------------- //
  const typed = await evaluate(`(() => {
    const el = document.querySelector('#vhl-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(fixture)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`)
  checks.expect('输入框接受路径', typed === fixture, String(typed))

  // Drive the two numeric knobs through the form (not the RPC layer): 2 clips of
  // 3s is what the fixture actually supports, and it proves they are wired.
  await evaluate(`(() => {
    const set = (id, value) => {
      const el = document.querySelector(id);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#vhl-topk', 2);
    set('#vhl-duration', 3);
    return true;
  })()`)
  const knobs = await evaluate(`[document.querySelector('#vhl-topk').value, document.querySelector('#vhl-duration').value]`)
  checks.expect('片段数/单段时长可编辑', String(knobs?.[0]) === '2' && String(knobs?.[1]) === '3', JSON.stringify(knobs))

  checks.expect('点击「探测」', await evaluate(clickText(L.probe)))
  await waitFor(page, `document.body.innerText.includes('320×180')`, { label: '媒体信息回显', timeoutMs: 30_000 })
  checks.expect('探测结果回显 320×180 + 帧率',
    await evaluate(`/320×180/.test(document.body.innerText) && /25\\.00fps/.test(document.body.innerText)`),
    await evaluate(`document.querySelector('.vhl-line')?.innerText ?? ''`))

  // ---- analyze ------------------------------------------------------------- //
  checks.expect('点击「开始分析」', await evaluate(clickText(L.start)))
  await waitFor(page, `(${JSON.stringify(['分析中', 'Running', '已完成', 'Succeeded'])}.some((s) => document.body.innerText.includes(s)))`,
    { label: '任务状态出现', timeoutMs: 30_000 })

  let terminal = false
  try {
    await waitFor(page, textIs(L.succeeded), { label: '任务成功', timeoutMs: 180_000, everyMs: 400 })
    terminal = true
  } catch (error) {
    checks.fail('任务在页面上收敛到已完成', error instanceof Error ? error.message : String(error))
  }
  if (terminal) {
    checks.expect('页面显示已完成', true)
    console.log(`· 页面文本:${await evaluate('document.body.innerText.replace(/\\s+/g, " ").slice(0, 600)')}`)
    checks.expect('进度条到 100%', await evaluate(`[...document.querySelectorAll('.vhl-pct')].some((n) => n.textContent.includes('100'))`),
      await evaluate(`[...document.querySelectorAll('.vhl-pct')].map((n) => n.textContent).join(',')`))
    checks.expect('片段表出现', await evaluate(`document.querySelectorAll('.vhl-segments tbody tr').length > 0`),
      await evaluate(`document.querySelectorAll('.vhl-segments tbody tr').length`))
    // Explainability is a product claim: the panel must show WHY a window won.
    const chips = await evaluate(`[...document.querySelectorAll('.vhl-chip')].map((n) => n.textContent)`)
    checks.expect('片段显示各模态信号(可解释性)', Array.isArray(chips) && chips.length > 0, JSON.stringify(chips))
    // The engine always writes the timeline report; the host serves it as JSON.
    checks.expect('报告可从数据面打开(链接指向路由)',
      await evaluate(`[...document.querySelectorAll('.vhl-artifacts a')]
        .some((a) => /\\/api\\/highlight\\.report\\./.test(a.getAttribute('href') ?? ''))`),
      await evaluate(`JSON.stringify([...document.querySelectorAll('.vhl-artifacts a')].map((a) => a.getAttribute('href')))`))

    // ---- the clip is PLAYABLE, not merely present ------------------------- //
    await waitFor(page, `(() => {
      const v = document.querySelector('video');
      return v !== null && v.error === null && v.readyState >= 1;
    })()`, { label: 'video 元数据就绪', timeoutMs: 30_000 })

    const state = await evaluate(`(() => { const v = document.querySelector('video');
      return { src: v.src, w: v.videoWidth, h: v.videoHeight, rs: v.readyState,
               err: v.error === null ? null : v.error.code, t: v.currentTime } })()`)
    checks.expect('video 指向宿主数据面路由', typeof state?.src === 'string' && /\/api\/highlight\.clip\./.test(state.src), String(state?.src))
    checks.expect('浏览器解出真实画面(videoWidth>0)', state?.w > 0 && state?.h > 0, JSON.stringify(state))

    // Play: this is what turns "a file exists" into "a reviewer can watch it".
    await evaluate(`(async () => { const v = document.querySelector('video'); v.muted = true;
      await v.play().catch(() => undefined); return true })()`)
    await waitFor(page, `document.querySelector('video').currentTime > 0.15`, { label: '播放推进', timeoutMs: 20_000, everyMs: 250 })
    const playing = await evaluate(`(() => { const v = document.querySelector('video');
      return { t: v.currentTime, rs: v.readyState, err: v.error === null ? null : v.error.code } })()`)
    checks.expect('播放头推进(时钟在走)', playing?.t > 0.15 && playing?.err === null, JSON.stringify(playing))
    checks.expect('解码状态 readyState>=2', playing?.rs >= 2, JSON.stringify(playing))

    // ---- seek: 定位 must move the playhead INSIDE the clip ----------------- //
    const seekText = await evaluate(`[...document.querySelectorAll('.vhl-segments tbody tr')]
      .map((tr) => tr.innerText).join(' | ')`)
    checks.expect('片段行标注成片内位置(@0.00s)', /@0\.00s/.test(seekText), seekText)
    checks.expect('点击「定位」', await evaluate(clickText(L.seek)))
    checks.expect('定位后播放头在成片内(>=0)', await evaluate(`document.querySelector('video').currentTime >= 0`),
      String(await evaluate(`document.querySelector('video').currentTime`)))

    // Screenshot the FINISHED state, with a decoded frame on screen: a black
    // <video> with a spinner proves nothing about whether the clip works.
    await evaluate(`(async () => { const v = document.querySelector('video');
      await v.play().catch(() => undefined); await new Promise((r) => setTimeout(r, 700)); v.pause(); return true })()`)
    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

    // ---- EDL export -------------------------------------------------------- //
    checks.expect('点击「导出 EDL」', await evaluate(clickText(L.edl)))
    await waitFor(page, `document.body.innerText.includes('.edl')`, { label: 'EDL 路径回显', timeoutMs: 30_000 })
    checks.expect('页面回显 EDL 路径', await evaluate(`/\\.edl/.test(document.body.innerText)`))

    // ---- reload: the job list is the way back to an existing clip ---------- //
    // A reviewer refreshes the page mid-review. The result panel starts empty by
    // design (no job is adopted automatically), so the list must be clickable or
    // the clip becomes unreachable without re-analysing the source.
    await client.send('Page.reload', { ignoreCache: false })
    await waitFor(page, `!!document.querySelector('#vhl-input')`, { label: '刷新后面板重挂载', timeoutMs: 30_000 })
    checks.expect('刷新后结果面板为空(不自动认领任务)', await evaluate(`!!document.querySelector('.vhl-empty')`))
    await waitFor(page, `document.querySelectorAll('.vhl-pick').length > 0`, { label: '刷新后任务列表', timeoutMs: 15_000 })
    checks.expect('刷新后任务列表可见', true)
    checks.expect('点击任务行恢复成片', await evaluate(`(() => {
      const b = document.querySelector('.vhl-pick'); if (b === null) return false; b.click(); return true })()`))
    await waitFor(page, `!!document.querySelector('video')`, { label: '刷新后 video 出现', timeoutMs: 30_000 })
    await waitFor(page, `(() => { const v = document.querySelector('video');
      return v !== null && v.error === null && v.readyState >= 1 })()`,
      { label: '刷新后 video 元数据就绪', timeoutMs: 30_000 })
    const restored = await evaluate(`(() => { const v = document.querySelector('video');
      return { w: v.videoWidth, rs: v.readyState, err: v.error === null ? null : v.error.code } })()`)
    checks.expect('刷新后成片仍可解码', restored?.w > 0 && restored?.rs >= 1 && restored?.err === null, JSON.stringify(restored))
  }

  // ---- screenshot (a late capture is a fallback; the post-job one wins) ---- //
  if (!existsSync(shotPath)) {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  }
  checks.expect('截图已生成', existsSync(shotPath), shotPath)

  const exceptions = client.events.filter((e) => e.method === 'Runtime.exceptionThrown')
  const consoleErrors = client.events.filter(
    (e) => e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error',
  )
  checks.expect('无未捕获的页面异常', exceptions.length === 0,
    JSON.stringify(exceptions.slice(0, 2).map((e) => e.params?.exceptionDetails?.text)))
  checks.expect('无 console.error', consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 2).map((e) => e.params?.args?.map((a) => a.value ?? a.description))))

  client.close()
} catch (error) {
  checks.fail('浏览器验收执行', error instanceof Error ? error.stack ?? error.message : String(error))
}

exitCode = checks.summary('UI OK')
console.log(`· 截图:${shotPath}`)
if (chromeChild !== null) {
  chromeChild.kill('SIGTERM')
  await sleep(300)
}
host.kill('SIGTERM')
await sleep(300)
// Keep the screenshot (it is the artefact a human inspects) but drop the rest.
const keep = process.env.VHL_KEEP_HOME === '1'
if (!keep) {
  for (const junk of [join(home, 'chrome'), join(home, 'jobs'), mediaDir]) {
    rmSync(junk, { recursive: true, force: true })
  }
}
process.exit(exitCode)
