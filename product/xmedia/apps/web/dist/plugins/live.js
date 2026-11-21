// live 插件 —— 实时预览 + 编码/发布任务。媒体字节不经过 Host：xmedia-kit 直接推
// MediaMTX，浏览器经 WHEP/HLS 直连播放（WHEP 客户端来自仓库级共享模块的镜像）。
import { startWhep, nativeHlsSupported } from '../whep.js'

export default {
  id: 'live',
  title: '实时预览',
  area: 'sidebar',
  group: '媒体面',
  order: 10,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>',

  mount(el, ctx) {
    const { call, show } = ctx
    el.innerHTML = `
      <header class="view-head">
        <h1>实时预览</h1>
        <p>xmedia-kit 编码/转码 → RTMP 实时推流 → MediaMTX → 浏览器 &lt;video&gt; 直连 WHEP/HLS。
          <strong>媒体字节不经过 Host</strong>：没有 MJPEG、没有帧轮询、没有每帧文件 I/O，也没有 C++ 播放自检管线。</p>
      </header>

      <div class="panel">
        <h2>实时画面（浏览器原生播放）</h2>
        <video id="video" controls autoplay playsinline muted></video>
        <div id="player-state">未播放 · 先启动编码发布，再点「观看」</div>
        <div id="urls">观看地址读取中…</div>
        <div class="row" style="margin-top: 12px">
          <button id="watch" class="btn primary">观看（WHEP）</button>
          <button id="unwatch" class="btn">停止观看</button>
          <button id="hls" class="btn">HLS 回退</button>
        </div>
      </div>

      <div class="panel">
        <h2>编码 / 发布任务</h2>
        <div class="row">
          <span class="label">输入源</span>
          <input id="input" class="grow" size="46" placeholder="/path/to/video.mp4、https://… 或 FFmpeg 设备 URI">
        </div>
        <div class="row" style="margin-top: 8px">
          <span class="label">流路径</span>
          <input id="path" size="18" placeholder="xmedia">
          <button id="publish" class="btn primary">开始发布</button>
          <button id="cancel" class="btn">停止发布</button>
          <button id="refresh" class="btn">刷新状态</button>
        </div>
        <pre id="publish-state" style="margin-top: 12px">任务状态读取中…</pre>
        <p class="hint">
          实时推流<strong>默认重新编码</strong>（macOS 用 h264_videotoolbox），保证规律关键帧——
          直接 stream copy 长 GOP 片源时 WebRTC 等不到 IDR，画面会一直黑。
          同时只保留视频：MediaMTX 的 WHEP 不支持 AAC 音轨，带音频会让整路会话被拒。
          离线转码到本地文件时两轨都保留（那才是本产品的主业）。<br>
          有限时长的文件片源按实时配速推完就会<strong>断开推流</strong>，MediaMTX 随即移除该 path；观看中会自动重新发布并重连，点「停止观看」或「停止发布」结束。若需真正不间断的画面，请用屏幕采集等持续输入源。
        </p>
      </div>`

    // WHEP client: imported from ../whep.js (the shared, dependency-free module).
    // xmedia publishes video-only, so { audio: false } below — MediaMTX rejects
    // the WHEP session otherwise.
    const $id = (id) => el.querySelector('#' + id)

    let viewers = null
    let whep = null
    let statusTimer = null

    const note = (text, isError) => {
      $id('player-state').textContent = text
      $id('player-state').style.color = isError ? 'var(--xm-danger)' : ''
    }

    const renderUrls = () => {
      if (!viewers) { $id('urls').textContent = '观看地址读取中…'; return }
      $id('urls').textContent =
        `推流  ${viewers.publish}\nWHEP  ${viewers.whep}\nHLS   ${viewers.hls}`
    }

    const renderPublishState = (value) => {
      if (!value || value.error) {
        $id('publish-state').textContent = value?.error
          ? `状态读取失败: ${JSON.stringify(value.error)}` : '任务状态读取中…'
        return
      }
      const phase = value.running ? '运行中' : (value.done ? (value.ok ? '已完成' : '失败') : '空闲')
      $id('publish-state').textContent =
        `${phase} · 进度 ${value.progress}% · 耗时 ${(value.elapsedMs / 1000).toFixed(1)}s\n` +
        `输入  ${value.input || '—'}\n输出  ${value.output || '—'}\n` +
        (value.videoCodec ? `编码  ${value.videoCodec}${value.videoCodec === 'copy' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value.output || '') ? '（长 GOP 片源的 WHEP 可能黑屏）' : ''}\n` : '') +
        (value.error ? `错误  ${value.error}\n` : '') +
        `观看  ${value.viewers?.whep ?? viewers?.whep ?? '—'}`
    }

    function stopViewer() {
      if (whep) { whep.close(); whep = null }
      $id('video').removeAttribute('src')
      $id('video').load()
      note('已停止观看', false)
    }

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // MediaMTX only holds a path while the publisher is CONNECTED. A finite file
    // source is paced in realtime, so the path disappears the moment it finishes;
    // clicking watch afterwards answers "no stream is available on path '...'".
    // The identical message appears in the short window before the first frame
    // arrives. Handle BOTH: make sure a publish job is running, then retry while
    // the stream is being established.
    async function ensurePublishing() {
      const status = await call('xmedia.publish.status')
      if (status && !status.error && status.running) return { running: true }
      if (!$id('input').value.trim()) {
        return {
          running: false,
          reason: '当前没有活跃推流：MediaMTX 上该 path 不存在。请填写输入源后点「开始发布」；片源播完流会自动断开，需要重新发布。',
        }
      }
      note('当前无活跃流，正在自动重新发布输入源…', false)
      const result = await startPublish()
      if (!result || result.error) {
        return { running: false, reason: `自动发布失败: ${JSON.stringify(result?.error ?? result)}` }
      }
      return { running: true, auto: true }
    }

    // HLS 回退播放：自动回退与手动按钮共用一份（两者都要求 viewers 已就绪）。
    function playHls(text, isError) {
      note(text, isError)
      $id('video').src = viewers.hls
      $id('video').play().catch(() => undefined)
    }

    // 唯一的观看入口。path 省略 = 看自己发布的流（自动发布/首帧重试/播完重连）；
    // 传入 path = 看 stream 插件指过来的就绪路径（已在 MediaMTX 就绪，跳过发布自检）。
    async function watch(path) {
      const external = typeof path === 'string' && path !== ''
      if (external) {
        const v = await call('xmedia.publish.viewers', { path })
        if (!v || v.error) { note(`观看地址获取失败: ${JSON.stringify(v?.error ?? v)}`, true); return }
        viewers = v
        renderUrls()
      }
      if (!viewers) { note('观看地址尚未就绪', true); return }
      stopViewer()

      // 自己的流可能已断（片源播完 path 被移除）：先确保有活跃发布。
      let ready = { running: true }
      if (!external) {
        ready = await ensurePublishing()
        if (!ready.running) { note(ready.reason, true); return }
      }
      note(`等待首帧并连接 WHEP… ${viewers.whep}`, false)

      const deadline = Date.now() + 12000
      // A freshly (re)started job may not show running=true on the very next poll,
      // while its first frame needs another moment to reach MediaMTX. Do not
      // mistake that window for "the stream already ended".
      const startGrace = ready.auto ? Date.now() + 3000 : 0
      let detail = ''
      while (Date.now() < deadline) {
        try {
          whep = await startWhep(viewers.whep, $id('video'), { audio: false })
          note(`WHEP 播放中（低延迟，媒体直连 MediaMTX）· ${viewers.path ?? path}${ready.auto ? ' · 已自动重启发布' : ''}`, false)
          return
        } catch (e) {
          whep = null
          detail = e.message || String(e)
          // Codec/ICE 等非 no-stream 错误重试无益，直接给 HLS 回退。
          if (!/no stream/i.test(detail)) break
          // 外部路径“已在 MediaMTX 就绪”却报 no stream：多半刚断开，不自检发布，直接回退。
          if (external) break
          const status = await call('xmedia.publish.status')
          if ((!status || status.error || !status.running) && Date.now() >= startGrace) {
            detail = '推流已结束（片源播完）'
            break
          }
          note(`等待首帧到达 MediaMTX… ${detail}`, false)
          await wait(400)
        }
      }

      // HLS 与 WHEP 是同一条 live path：发布已结束时 playlist 同样不存在。
      if (nativeHlsSupported()) {
        playHls(`${external ? 'WHEP 失败' : 'WHEP 无可用流'}：${detail} · 自动回退原生 HLS（流带 AAC 时 WHEP 会被拒，HLS 延迟更高）· ${viewers.hls}`, false)
      } else {
        const hint = external ? '该路径可能已断开。'
          : '片源播完后 MediaMTX 会移除该 path，请重新点「开始发布」；若需持续画面请用屏幕采集等无限输入源。'
        note(`WHEP 无可用流/失败：${detail}。${hint} 此浏览器不支持原生 HLS 回退。`, true)
      }
    }

    function watchHls() {
      if (!viewers) { note('观看地址尚未就绪', true); return }
      stopViewer()
      if (!nativeHlsSupported()) {
        note('此浏览器不支持原生 HLS（Chrome/Firefox 请用 WHEP；本项目不引入 hls.js）', true)
        return
      }
      playHls(`HLS 原生播放（延迟高于 WHEP）· ${viewers.hls} · 若提示无流，请先重新「开始发布」`, false)
    }

    // 推流状态(stream)插件的「观看」按钮：切到本视图并直接连接该路径。
    ctx.on('xmedia:watch', ({ path }) => {
      ctx.activate('live')
      void watch(path)
    })

    const refreshViewers = async () => {
      const value = await call('xmedia.publish.viewers', viewers?.path ? { path: viewers.path } : {})
      if (value && !value.error) { viewers = value; renderUrls() }
      return value
    }

    const refreshPublish = async () => {
      const value = await call('xmedia.publish.status')
      renderPublishState(value)
      if (value && !value.error) {
        viewers = value.viewers ?? viewers
        renderUrls()
        if (!value.running && statusTimer !== null) { clearInterval(statusTimer); statusTimer = null }
        // Watching a FINITE file source: realtime pacing ends the job, MediaMTX
        // drops the path and the WHEP session goes dark. Restart the same job and
        // reconnect so the acceptance picture keeps rolling. Only a SUCCESSFUL
        // completion triggers this — a failed job must never loop. Point "停止观看"
        // or "停止发布" clears whep and ends the cycle.
        if (whep && !value.running && value.done && value.ok) {
          whep = null
          note('片源已播完，自动重新发布并重连 WHEP…', false)
          void watch()
        }
      }
      return value
    }

    async function startPublish() {
      const input = $id('input').value.trim()
      if (!input) { show({ error: '请输入输入源' }); return { error: '请输入输入源' } }
      const params = { input }
      if ($id('path').value.trim()) params.path = $id('path').value.trim()
      const result = await call('xmedia.publish.start', params)
      show(result)
      if (result && !result.error) {
        viewers = result.viewers
        renderUrls()
        renderPublishState(result)
        if (statusTimer === null) statusTimer = setInterval(() => { void refreshPublish() }, 2000)
        note('编码发布已启动；点「观看」会自动等待首帧到达 MediaMTX', false)
      }
      return result
    }

    $id('watch').addEventListener('click', watch)
    $id('unwatch').addEventListener('click', stopViewer)
    $id('hls').addEventListener('click', watchHls)
    $id('refresh').addEventListener('click', async () => show(await refreshPublish()))
    $id('publish').addEventListener('click', () => { void startPublish() })
    $id('cancel').addEventListener('click', async () => {
      stopViewer()
      show(await call('xmedia.publish.stop'))
      void refreshPublish()
    })

    void refreshViewers()
    void refreshPublish()
  },
}
