// bake 插件 —— HTML 烘焙（离线出片 · HyperFrames 对齐）。
// 页面经 CEF 离屏渲染 + GL 元素合成为 MP4；未构建 xmedia-bake 时调用会得到
// 明确的拒绝说明（诚实降级，绝不静默 0）。成片经 /api/xmedia.bake.<jobId> 回放。
export default {
  id: 'bake',
  title: 'HTML 烘焙',
  area: 'sidebar',
  group: '媒体面',
  order: 30,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v5"/></svg>',

  mount(el, ctx) {
    const { call, show } = ctx
    const query = new URLSearchParams(location.search).has('token')
      ? `?token=${encodeURIComponent(new URLSearchParams(location.search).get('token'))}` : ''
    el.innerHTML = `
      <header class="view-head">
        <h1>HTML 烘焙</h1>
        <p>离线出片 · HyperFrames 对齐。页面经 CEF 离屏渲染 + GL 元素合成为 MP4，确定性 VirtualTime 时钟逐帧烘焙，输出可复现。
          需要 <strong>xmedia-bake</strong> 工具链（XMEDIA_BUILD_CEF=1 构建）；未构建时本区调用会得到明确的拒绝说明。
          成片经 <code>/api/xmedia.bake.&lt;jobId&gt;</code> 拉取路由回放。</p>
      </header>

      <div class="panel">
        <h2>烘焙任务</h2>
        <div class="row">
          <span class="label">页面</span>
          <input id="bake-html" class="grow" size="44" placeholder="/path/to/page.html 或 file:///…（file:// 页面需内联脚本）">
        </div>
        <div class="row" style="margin-top: 8px">
          <span class="label">输出</span>
          <input id="bake-out" class="grow" size="44" placeholder="/path/to/out.mp4（绝对路径）">
          <button id="bake-start" class="btn primary">开始烘焙</button>
          <button id="bake-cancel" class="btn">取消</button>
        </div>
        <div class="row" style="margin-top: 8px">
          <span class="label">时长(s)</span><input id="bake-seconds" size="6" value="2">
          <span class="label">fps</span><input id="bake-fps" size="4" value="24">
          <span class="label">宽</span><input id="bake-width" size="6" value="1280">
          <span class="label">高</span><input id="bake-height" size="6" value="720">
          <label class="label"><input type="checkbox" id="bake-audio" checked> 音频</label>
          <label class="label"><input type="checkbox" id="bake-hf"> HF 秒制时序</label>
        </div>
        <video id="bake-video" controls style="display:none; margin-top:12px"></video>
        <pre id="bake-state" style="margin-top: 12px">尚未启动烘焙任务</pre>
      </div>`

    const $id = (id) => el.querySelector('#' + id)
    let bakeJobId = null
    let bakeTimer = null

    const renderBakeState = (value) => {
      const node = $id('bake-state')
      if (!value || value.error) {
        node.textContent = value?.error ? `烘焙状态读取失败: ${JSON.stringify(value.error)}` : '尚未启动烘焙任务'
        return
      }
      const phase = value.running ? `运行中(${value.stage})`
        : (value.done ? (value.ok ? '已完成' : (value.cancelled ? '已取消' : '失败')) : '空闲')
      node.textContent =
        `${phase} · 进度 ${value.progress}% · 耗时 ${(value.elapsedMs / 1000).toFixed(1)}s\n` +
        `页面  ${value.html || '—'}\n输出  ${value.output || '—'}\n` +
        (value.error ? `错误  ${value.error}\n` : '') +
        (value.ok && bakeJobId ? `回放  /api/xmedia.bake.${bakeJobId}` : '')
    }

    const attachBakeVideo = (url) => {
      const v = $id('bake-video')
      v.src = `${url}${query}`
      v.style.display = 'block'
      v.play().catch(() => undefined)
    }

    const refreshBake = async () => {
      if (!bakeJobId) return
      const value = await call('xmedia.bake.status', { jobId: bakeJobId })
      renderBakeState(value)
      if (value && !value.error && value.done && value.ok && value.url) {
        attachBakeVideo(value.url)
        if (bakeTimer !== null) { clearInterval(bakeTimer); bakeTimer = null }
      } else if (value && !value.error && value.done && bakeTimer !== null) {
        clearInterval(bakeTimer); bakeTimer = null
      }
      return value
    }

    $id('bake-start').addEventListener('click', async () => {
      const htmlPath = $id('bake-html').value.trim()
      const output = $id('bake-out').value.trim()
      if (!htmlPath || !output) { show({ error: '烘焙需要页面路径与输出绝对路径' }); return }
      const params = { htmlPath, output }
      const num = (id) => { const v = parseFloat($id(id).value); return Number.isFinite(v) ? v : undefined }
      if (num('bake-seconds') !== undefined) params.seconds = num('bake-seconds')
      if (num('bake-fps') !== undefined) params.fps = num('bake-fps')
      if (num('bake-width') !== undefined) params.width = num('bake-width')
      if (num('bake-height') !== undefined) params.height = num('bake-height')
      if (!$id('bake-audio').checked) params.audio = false
      if ($id('bake-hf').checked) params.hfSeconds = true
      const result = await call('xmedia.bake.start', params)
      show(result)
      if (result && !result.error && result.jobId) {
        bakeJobId = result.jobId
        $id('bake-video').style.display = 'none'
        renderBakeState({ ...result, url: '' })
        if (bakeTimer === null) bakeTimer = setInterval(() => { void refreshBake() }, 1000)
      }
    })
    $id('bake-cancel').addEventListener('click', async () => {
      if (!bakeJobId) { show({ error: '没有进行中的烘焙任务' }); return }
      const result = await call('xmedia.bake.cancel', { jobId: bakeJobId })
      show(result)
      void refreshBake()
    })
  },
}
