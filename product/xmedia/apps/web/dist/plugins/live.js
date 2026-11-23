// live 插件 —— 一键开播：填输入源 → 点「开播」，编码推流与画面接通一步完成。
// 媒体字节不经过 Host：xmedia-kit 直接推 MediaMTX，浏览器经 WHEP/HLS 直连播放。
// 交互沿用成熟直播工具（OBS 的 Start Streaming / Restream 的 Go Live）的范式：
// 单一主行动 + 状态可视化 + 渐进披露，全部用零依赖 vanilla ESM 实现。
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
        <p>填输入源，点「开播」——编码推流与画面接通一步完成。媒体字节不经过 Host，浏览器直连 MediaMTX。</p>
      </header>

      <div class="panel">
        <h2>开播</h2>
        <div class="row">
          <span class="label">输入源</span>
          <input id="input" class="grow" size="46" list="live-presets" placeholder="本地文件、https://… 或 FFmpeg 设备 URI">
          <button id="pick-file" class="btn" title="选择本地文件">📁 选择文件</button>
          <datalist id="live-presets">
            <option value="/path/to/video.mp4">
            <option value="https://example.com/live.m3u8">
          </datalist>
        </div>
        <div class="row" style="margin-top:8px">
          <span class="label">流路径</span>
          <input id="path" size="18" placeholder="留空自动生成（多路必填不同）">
          <label class="label" style="display:inline-flex;align-items:center;gap:4px"
                 title="有限片源播完后自动重新发布并重新接通画面；每次循环起点会有短暂黑屏">
            <input id="loop" type="checkbox">循环推流
          </label>
          <button id="go" class="btn primary">▶ 开播</button>
          <button id="stop" class="btn" style="display:none">■ 停播</button>
          <button id="hls" class="btn">HLS 回退</button>
        </div>
        <div class="row" style="margin-top:8px">
          <span id="mtx-badge" class="badge pause" title="MediaMTX 流服务状态">流服务检测中…</span>
          <button id="mtx-start" class="btn" style="display:none">启动流服务</button>
          <button id="mtx-check" class="btn">检测状态</button>
          <span id="mtx-detail" class="label"></span>
        </div>
        <div class="row" style="margin-top:12px">
          <span id="live-badge" class="badge cancel">未开播</span>
          <div class="bar" style="width:110px"><i id="live-progress"></i></div>
          <span id="live-metric" class="label"></span>
        </div>
        <div id="player-state" class="hint">点「开播」后将自动等待首帧并接通画面</div>
      </div>

      <div class="panel">
        <h2>多流任务池</h2>
        <table class="jobs" id="pool-table">
          <thead><tr><th>任务 ID</th><th>路径</th><th>状态</th><th>进度</th><th>操作</th></tr></thead>
          <tbody id="pool-body"><tr><td colspan="5">读取中…</td></tr></tbody>
        </table>
        <p class="hint">
          每次「开播」都是一路独立任务，可同时推多路。每路按路径自动录制为 fMP4；
          录好的段在「推流状态 → 录制回放」里「加入同步」，即可在「同步回放」多画面时间线对齐播放。
        </p>
      </div>

      <div class="panel">
        <h2>实时画面</h2>
        <video id="video" controls autoplay playsinline muted></video>
        <details style="margin-top:10px">
          <summary class="label" style="cursor:pointer">观看地址（展开可复制）</summary>
          <div id="urls" style="margin-top:8px">观看地址读取中…</div>
          <button id="copy" class="btn" style="margin-top:8px">复制 WHEP 地址</button>
        </details>
      </div>

      <details class="panel">
        <summary class="label" style="cursor:pointer">原理与排查</summary>
        <p class="hint">
          实时推流<strong>默认重新编码（libx264）</strong>，保证规律关键帧——
          直接 stream copy 长 GOP 片源时 WebRTC 等不到 IDR，画面会一直黑；同时只保留视频，
          MediaMTX 的 WHEP 不支持 AAC 音轨。有限片源按实时配速推完会断开推流；
          <strong>默认不循环</strong>，勾选「循环推流」后才会自动重新发布并重连，
          直到取消勾选、点「停播」或关闭页面。
          每次循环起点有约 2–4 秒黑屏（重新发布到首帧到达）。若需完全无间断画面，请用屏幕采集
          等无限输入源（FFmpeg 设备 URI：macOS avfoundation / Linux x11grab / Windows gdigrab）。
        </p>
      </details>`

    const $id = (id) => el.querySelector('#' + id)

    let viewers = null
    let whep = null
    let statusTimer = null
    let playbackError = ''   // 画面层错误优先于推流状态徽章，避免“直播中+黑屏”
    let watchSeq = 0   // 每次新观看动作递增，作废旧 watch 循环（HLS 回退要打断 WHEP 重连）
    // 多流：本视图最近一次开播的任务 id。所有 status/stop 都带上它，否则后端
    // 的 lastJobId 会把第二路的操作错路由到第一路（"无法推第二个流"的根因）。
    let currentJobId = null
    const genJobId = () => globalThis.crypto?.randomUUID?.()
      ?? `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // 留空 path 时每次开播生成独立路径。若两路都用后端默认 publishPath(xmedia)，
    // MediaMTX 会把它们合并成一个 path：推流状态只显示一条、录像也只有一路，
    // 于是"同步回放"看起来和单路回放一样。jobId 隔离解决控流，path 隔离解决可见性。
    const genPath = () => `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const jobParam = () => currentJobId ? { jobId: currentJobId } : {}
    // A FINITE file source ends when realtime pacing reaches EOF; MediaMTX then
    // drops the path and the picture goes dark. Looping is OPT-IN via the
    // checkbox and defaults to OFF: a normal 开播 runs the source once. The
    // checkbox (not `whep`) is the source of truth — HLS fallback and teardown
    // null the viewer handle but must not silently re-enable looping.
    let loopIntent = false   // mirrors #loop.checked; true = re-publish on clean EOF
    const syncLoopIntent = () => { loopIntent = $id('loop').checked }

    const note = (text, isError) => {
      playbackError = isError ? text : ''
      $id('player-state').textContent = text
      $id('player-state').style.color = isError ? 'var(--xm-danger)' : ''
    }

    // bridge 二进制重建后，已运行的宿主进程仍持有旧 inode；此时开播看似正常，
    // 实则会复现刚修掉的写包错误。用 engine.state 的 mtime/启动时间对比提前预警。
    let engineStale = false
    const checkEngineStale = async () => {
      try {
        const state = await call('xmedia.engine.state')
        engineStale = state?.binaryStale === true
      } catch {
        engineStale = false  // 状态接口不可用时不要误报，保持原有流程
      }
    }

    // 流服务（MediaMTX）状态：API 可达是唯一的诚实判据。外部手工启动的
    // 实例也算在线——绝不重复拉起、也不在我们这里停掉它。
    const renderMtx = (s) => {
      const badge = $id('mtx-badge')
      if (!s) {
        badge.className = 'badge fail'
        badge.textContent = '流服务状态未知'
        $id('mtx-start').style.display = ''
        return
      }
      badge.className = s.online ? 'badge run' : 'badge cancel'
      badge.textContent = s.online
        ? (s.managed ? '流服务运行中' : '流服务运行中（外部）')
        : '流服务未运行'
      $id('mtx-start').style.display = s.online ? 'none' : ''
      const detail = s.online
        ? `${s.api}${s.pid ? ' · PID ' + s.pid : ''}`
        : (s.error || `未检测到服务：${s.api}`)
      $id('mtx-detail').textContent = engineStale
        ? `${detail} · ⚠ bridge 已重建，请重启宿主服务后再开播`
        : detail
      $id('mtx-detail').style.color = engineStale ? 'var(--xm-danger)' : ''
    }
    const checkMtx = async () => {
      await checkEngineStale()
      try {
        const value = await call('mediamtx.status')
        renderMtx(value?.status ?? null)
        return value?.status ?? null
      } catch (e) {
        renderMtx(null)
        $id('mtx-detail').textContent = String(e?.message ?? e).slice(0, 120)
        return null
      }
    }

    const renderUrls = () => {
      if (!viewers) { $id('urls').textContent = '观看地址读取中…'; return }
      $id('urls').textContent =
        `推流  ${viewers.publish}\nWHEP  ${viewers.whep}\nHLS   ${viewers.hls}`
    }

    // 状态可视化：一个徽章 + 进度条 + 一行关键指标，替代裸 <pre> dump。
    const setBadge = (text, kind) => {
      $id('live-badge').className = 'badge ' + kind
      $id('live-badge').textContent = text
    }

    const renderPublishState = (value) => {
      if (!value) {
        setBadge('状态未知', 'fail')
        $id('live-metric').textContent = ''
        return
      }
      // Restore the running job's source so a page reload can keep the same
      // finite source looping instead of republishing into an empty input.
      if (value.input && !$id('input').value.trim()) $id('input').value = value.input
      // value.error is the publish job's transcode error (empty string = none),
      // not an RPC read failure — show the real message so the user can act.
      if (value.error) {
        const cancelled = /cancel/i.test(value.error)
        setBadge(cancelled ? '已取消' : (value.done ? '失败' : '异常'), cancelled ? 'cancel' : 'fail')
        $id('live-progress').style.width = `${value.progress ?? 0}%`
        $id('live-metric').textContent = cancelled
          ? `${(value.elapsedMs / 1000).toFixed(1)}s · 已取消`
          : `${(value.elapsedMs / 1000).toFixed(1)}s · ${value.error}`
        $id('stop').style.display = value.running ? '' : 'none'
        return
      }
      const phase = value.running ? '直播中'
        : value.done ? (value.ok ? '已完成' : '失败') : '未开播'
      if (value.running && playbackError) setBadge('画面未接通', 'fail')
      else setBadge(phase, value.running ? 'done' : value.done ? (value.ok ? 'done' : 'fail') : 'cancel')
      $id('live-progress').style.width = `${value.progress ?? 0}%`
      $id('live-metric').textContent = value.running
        ? `进度 ${value.progress}% · ${(value.elapsedMs / 1000).toFixed(1)}s · ${value.videoCodec || '—'}`
        : value.done ? `${(value.elapsedMs / 1000).toFixed(1)}s · ${value.videoCodec || ''}` : ''
      $id('stop').style.display = value.running ? '' : 'none'
    }

    function stopViewer() {
      if (whep) { whep.close(); whep = null }
      const v = $id('video')
      v.srcObject = null
      v.removeAttribute('src')
      v.load()
      note('已停止观看', false)
    }

    // 每条传输管线(WHEP/HLS)附着前换一个干净的 <video>：WebRTC receiver 与
    // HLS demuxer 会在元素上残留状态，跨管线复用会走坏路径（HLS 尤其报
    // DEMUXER_ERROR_COULD_NOT_PARSE）。$id('video') 每次查 DOM，故替换后各处自动拿到新元素。
    function freshVideo() {
      const old = $id('video')
      const video = document.createElement('video')
      video.id = 'video'
      video.controls = true
      video.autoplay = true
      video.playsInline = true
      video.muted = true
      old.replaceWith(video)
      return video
    }

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // A WHEP POST can return 201/SDP answer while ICE never actually delivers
    // media — the <video> then stays 0x0 and black, which used to be reported
    // as "直播中". Only call a session healthy once the element has real
    // dimensions and a current frame; otherwise tear it down and surface the
    // reason instead of showing a fake-live black rectangle.
    const hasDecodableVideo = (video) =>
      !!video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
    async function waitForFrames(video, timeoutMs, stillActive) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && stillActive()) {
        if (hasDecodableVideo(video)) return true
        await wait(250)
      }
      return hasDecodableVideo(video)
    }

    // MediaMTX only holds a path while the publisher is CONNECTED. A finite file
    // source is paced in realtime, so the path disappears the moment it finishes;
    // clicking watch afterwards answers "no stream is available on path '...'".
    // The identical message appears in the short window before the first frame
    // arrives. Handle BOTH: make sure a publish job is running, then retry while
    // the stream is being established.
    async function ensurePublishing() {
      const status = await call('xmedia.publish.status', jobParam())
      if (status && !status.error && status.running) return { running: true }
      if (!$id('input').value.trim()) {
        return {
          running: false,
          reason: '请先填输入源再点「开播」。',
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
    // 递增 watchSeq 作废旧 watch 循环：否则点回退时先前开播的 WHEP 重连还在跑，
    // 会抢先 freshVideo() 换掉 HLS 元素并覆盖状态。
    function playHls(text, isError, keepLoop = false) {
      watchSeq += 1
      // 手动「HLS 回退」= 停止 WHEP 自动重连，同步取消勾选；
      // WHEP 失败后的自动 HLS 回退只是换传输，不改变用户的循环选择。
      if (!keepLoop) {
        $id('loop').checked = false
        syncLoopIntent()
      }
      if (whep) { whep.close(); whep = null }
      note(text, isError)
      const video = freshVideo()
      video.src = viewers.hls
      // 设 src 后立即 play() 在 Electron 上会抛 "no supported source"（元素还没
      // loadstart）。等 loadedmetadata 确认 demuxer 已解析再 play，失败才提示。
      const onReady = () => { video.play().catch((e) => note(`HLS 播放失败: ${e.message ?? String(e)}`, true)) }
      video.addEventListener('loadedmetadata', onReady, { once: true })
      video.addEventListener('error', () => {
        note(`HLS 加载失败: 流可能已断开，请重新「开播」或检查 MediaMTX`, true)
      }, { once: true })
    }

    // 唯一的观看入口。path 省略 = 看自己发布的流（自动发布/首帧重试/播完重连）；
    // 传入 path = 看 stream 插件指过来的就绪路径（已在 MediaMTX 就绪，跳过发布自检）。
    async function watch(path) {
      const seq = ++watchSeq
      const live = () => seq === watchSeq   // 被更新的观看动作/HLS 回退取代则作废
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
      while (Date.now() < deadline && live()) {
        try {
          const handle = await startWhep(viewers.whep, $id('video'), { audio: false })
          if (!live()) { handle.close(); return }   // 期间用户点了 HLS 回退，丢弃这次连接
          whep = handle
          // 握手成功即视为接通：是否出帧交给下面的观察器做「提示」，绝不能
          // 因为首帧晚到就掐断会话——裸 SDP + 浏览器 ICE 收敛常需数秒，早判
          // 失败会把本来能播的画面误杀成“画面未接通”（用户实测回归）。
          note(`直播中（低延迟，媒体直连 MediaMTX）· ${viewers.path ?? path}${ready.auto ? ' · 已自动重启发布' : ''}`, false)
          const observed = handle
          void waitForFrames($id('video'), 12000, () => live() && whep === observed).then((ok) => {
            if (ok || !live() || whep !== observed) return
            // 只提示、不 close：会话继续保留，晚到的帧仍会正常渲染。
            note('已连接但迟迟未出现画面（>12s）：请确认浏览器允许本地 WebRTC/UDP；若持续黑屏可换用支持原生 HLS 的浏览器。', true)
          })
          return
        } catch (e) {
          whep = null
          detail = e.message || String(e)
          // Codec/ICE 等非 no-stream 错误重试无益，直接给 HLS 回退。
          if (!/no stream/i.test(detail)) break
          // 外部路径“已在 MediaMTX 就绪”却报 no stream：多半刚断开，不自检发布，直接回退。
          if (external) break
          const status = await call('xmedia.publish.status', jobParam())
          if (!live()) return   // 回退已接管，别再写状态/触发回退
          if ((!status || status.error || !status.running) && Date.now() >= startGrace) {
            detail = '推流已结束（片源播完）'
            break
          }
          note(`等待首帧到达 MediaMTX… ${detail}`, false)
          await wait(400)
        }
      }

      if (!live()) return   // 期间用户已切到 HLS/别的观看，别抢状态
      // HLS 与 WHEP 是同一条 live path：发布已结束时 playlist 同样不存在。
      const streamEnded = /推流已结束|播完/.test(detail)
      if (nativeHlsSupported() && !streamEnded) {
        playHls(`${external ? 'WHEP 失败' : 'WHEP 无可用流'}：${detail} · 自动回退原生 HLS（流带 AAC 时 WHEP 会被拒，HLS 延迟更高）· ${viewers.hls}`, false, true)
      } else {
        const hint = external ? '该路径可能已断开。'
          : '片源播完后 MediaMTX 会移除该 path，请重新点「开播」；若需持续画面请用屏幕采集等无限输入源。'
        const hlsNote = (streamEnded || nativeHlsSupported()) ? '' : '（此浏览器不支持原生 HLS 回退）'
        note(`WHEP 无可用流/失败：${detail}。${hint} ${hlsNote}`, true)
      }
    }

    function watchHls() {
      if (!viewers) { note('观看地址尚未就绪', true); return }
      stopViewer()
      if (!nativeHlsSupported()) {
        note('此浏览器不支持原生 HLS（Chrome/Firefox 请用 WHEP；本项目不引入 hls.js）', true)
        return
      }
      playHls(`HLS 原生播放（延迟高于 WHEP）· ${viewers.hls} · 若提示无流，请先重新「开播」`, false)
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
      const value = await call('xmedia.publish.status', jobParam())
      // 页面刷新后 currentJobId 为空：后端会以 lastJobId 应答，把它的 id 认回来，
      // 后续 status/stop 才能精确路由到这一路（否则多路时会串台）。
      if (value && !value.error && value.jobId) currentJobId = value.jobId
      renderPublishState(value)
      if (!value) return value
      // A FAILED job used to fall through silently: the <video> froze on its
      // last frame and the badge alone changed, which reads as "状态未知 /
      // 画面停住". Surface the engine's real error in the picture area instead,
      // and stop polling so a failed job never loops. This is exactly what a
      // videotoolbox->FLV write failure looked like before the libx264 default.
      if (value.done && !value.ok && !value.running) {
        if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null }
        note(`推流已中断：${value.error || '编码/写包失败'}。请重新开播（实时推流默认用 libx264）。`, true)
        return value
      }
      if (!value.error) {
        viewers = value.viewers ?? viewers
        renderUrls()
        // 正常播完是唯一可重发的终态。默认（未勾选循环）只提示"片源已播完"，
        // 并停止轮询，避免无限刷新一个已完成的任务。勾选后才重新发布并重连；
        // 判据是复选框镜像 loopIntent，不是 whep（HLS 回退/拆会话会把它清空）。
        if (!value.running && value.done && value.ok) {
          if (!loopIntent) {
            if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null }
            stopViewer()
            note('片源已播完（未开启循环推流）。如需反复播放，请勾选「循环推流」后重新开播。', false)
            return value
          }
          note('片源已播完，自动重新发布并重连画面…', false)
          // startWhep's handle from the finished run is stale; drop the viewer
          // but NOT the loop intent, and re-enter watch() to publish + reconnect.
          if (whep) { whep.close(); whep = null }
          void watch()
          return value
        }
        // Running again (fresh re-publish) — nothing to do; keep polling.
        // Idle but NOT a completable job (e.g. never started): stop polling to
        // avoid a hot loop; an explicit 开播 will start a new timer.
        if (!value.running && !value.done && statusTimer !== null) {
          clearInterval(statusTimer); statusTimer = null
        }
      }
      return value
    }

    async function startPublish() {
      await checkEngineStale()
      if (engineStale) {
        const error = '引擎程序已重建但宿主仍在运行旧 bridge，请重启宿主服务后再开播'
        note(error, true)
        show({ error })
        return { error }
      }
      const input = $id('input').value.trim()
      if (!input) { show({ error: '请输入输入源' }); return { error: '请输入输入源' } }
      // Each 开播 starts a DISTINCT job with its own id. Without an explicit
      // id the host reuses lastJobId and the second stream silently targets
      // the first one. All later status/stop calls are routed via currentJobId.
      const jobId = genJobId()
      // 未显式填 path 时生成唯一路径，确保多路并发在 MediaMTX / 推流状态 / 录像里各自独立。
      const path = $id('path').value.trim() || genPath()
      const params = { input, jobId, path }
      const result = await call('xmedia.publish.start', params)
      if (result && !result.error && result.jobId) currentJobId = result.jobId
      show(result)
      if (result && !result.error) {
        viewers = result.viewers
        renderUrls()
        renderPublishState(result)
        if (statusTimer === null) statusTimer = setInterval(() => { void refreshPublish() }, 2000)
        note('编码发布已启动，正在接通画面…', false)
        void refreshPool()
      }
      return result
    }

    // 一键开播 = watch()：内部 ensurePublishing() 在空闲时自动发布，成功后接 WHEP。
    // 发布与观看合并为一个主行动，用户不再需要「先发布、再观看」两步。
    // 选择本地文件：调用宿主的系统文件对话框（osascript/zenity），返回完整路径。
    $id('pick-file').addEventListener('click', async () => {
      const result = await call('xmedia.files.pick')
      if (result && result.path) {
        $id('input').value = result.path
        $id('input').dispatchEvent(new Event('input', { bubbles: true }))
      }
    })

    // 点「开播」= 明确新建一路：先 publish.start（新 jobId），再接画面。
    // 绝不走 ensurePublishing 的"已有流在跑就复用"分支——那正是第二路推不出来的原因。
    const goLive = async () => {
      syncLoopIntent()
      const started = await startPublish()
      if (started && !started.error) await watch()
    }
    $id('loop').addEventListener('change', syncLoopIntent)
    $id('go').addEventListener('click', () => { void goLive() })
    $id('stop').addEventListener('click', async () => {
      watchSeq += 1   // 作废任何进行中的 WHEP 重连循环
      $id('loop').checked = false   // 显式停播也取消循环勾选，避免下次开播意外重发
      syncLoopIntent()
      stopViewer()
      if (currentJobId) {
        show(await call('xmedia.publish.stop', { jobId: currentJobId }))
        currentJobId = null
      } else {
        show({ ok: true, message: '没有正在运行的流' })
      }
      void refreshPublish()
    })
    $id('hls').addEventListener('click', watchHls)
    $id('copy').addEventListener('click', async () => {
      if (!viewers) { note('观看地址尚未就绪', true); return }
      try {
        await navigator.clipboard.writeText(viewers.whep)
        const btn = $id('copy')
        btn.textContent = '✓ 已复制'
        setTimeout(() => { btn.textContent = '复制 WHEP 地址' }, 1500)
      } catch {
        note('复制失败：浏览器未授权剪贴板，请展开地址手动复制', true)
      }
    })

    // ---- 多流任务池：一次调用拿全池(xmedia.publish.jobs)，行按钮按各自 jobId 路由 ----
    const poolPathOf = (row) => {
      try { return new URL(row.output).pathname.replace(/^\//, '') || '—' }
      catch { return '—' }
    }
    const renderPool = (rows) => {
      const body = $id('pool-body')
      if (!Array.isArray(rows)) {
        body.innerHTML = `<tr><td colspan="5">任务池读取失败：${JSON.stringify(rows?.error ?? rows)}</td></tr>`
        return
      }
      if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="5">暂无任务 —— 点「开播」推一路</td></tr>'
        return
      }
      body.innerHTML = rows.map((r) => {
        const path = poolPathOf(r)
        const state = r.running ? (r.paused ? '已暂停' : '直播中')
          : r.done ? (r.ok ? '已完成' : '失败') : '空闲'
        const kind = r.running ? (r.paused ? 'pause' : 'done') : r.done ? (r.ok ? 'done' : 'fail') : 'cancel'
        const job = String(r.jobId ?? '')
        const short = job.length > 10 ? job.slice(0, 10) + '…' : job
        const inputName = (r.input ?? '').split('/').pop() ?? ''
        return `<tr>
          <td class="path" title="${job}">${short}</td>
          <td class="path">${path}</td>
          <td><span class="badge ${kind}">${state}</span></td>
          <td>${r.running ? `${r.progress ?? 0}%` : ''}${r.error ? ' · ' + String(r.error).slice(0, 24) : ''}</td>
          <td>
            <button class="btn" data-pool-watch="${path}" data-pool-job="${job}" title="把这一路接到上方画面">观看</button>
            ${r.running ? `<button class="btn" data-pool-stop="${job}">停播</button>` : ''}
          </td>
        </tr>
        <tr><td colspan="5" class="hint" style="padding-top:0">${inputName}${inputName ? ' · ' : ''}${job}</td></tr>`
      }).join('')
    }
    const refreshPool = async () => {
      try { renderPool(await call('xmedia.publish.jobs')) }
      catch (e) { renderPool({ error: e.message ?? String(e) }) }
    }
    $id('pool-body').addEventListener('click', async (event) => {
      const stopBtn = event.target.closest('button[data-pool-stop]')
      if (stopBtn !== null) {
        const job = stopBtn.dataset.poolStop
        show(await call('xmedia.publish.stop', { jobId: job }))
        if (currentJobId === job) { stopViewer(); currentJobId = null; void refreshPublish() }
        void refreshPool()
        return
      }
      const watchBtn = event.target.closest('button[data-pool-watch]')
      if (watchBtn !== null) {
        currentJobId = watchBtn.dataset.poolJob || null
        const v = await call('xmedia.publish.viewers', { path: watchBtn.dataset.poolWatch })
        if (v && !v.error) { viewers = v; renderUrls() }
        void watch(watchBtn.dataset.poolWatch)
        void refreshPublish()
      }
    })

    $id('mtx-check').addEventListener('click', async () => { show(await checkMtx()) })
    $id('mtx-start').addEventListener('click', async () => {
      $id('mtx-detail').textContent = '正在启动流服务…'
      try {
        const value = await call('mediamtx.start')
        renderMtx(value?.status ?? null)
        note('流服务已就绪，点「开播」即可推流', false)
        void refreshViewers()
      } catch (e) {
        $id('mtx-detail').textContent = String(e?.message ?? e).slice(0, 160)
        note('流服务启动失败，详见状态提示', true)
      }
    })

    // 页面刷新/重新进入时，如果宿主机已有活跃发布，自动接通画面并延续循环。
    // 否则即使流是好的，<video> 也会停在初始黑屏，直到用户再次手点「开播」。
    const initialize = async () => {
      await checkMtx()
      await refreshViewers()
      await refreshPool()
      syncLoopIntent()   // 初始默认关闭；若用户已勾选才沿用循环意图
      const status = await refreshPublish()
      if (status && !status.error && status.running) {
        if (statusTimer === null) statusTimer = setInterval(() => { void refreshPublish() }, 2000)
        await watch()
      }
    }
    void initialize()
    setInterval(() => { void checkMtx() }, 5000)
    setInterval(() => { void refreshPool() }, 2500)
  },
}
