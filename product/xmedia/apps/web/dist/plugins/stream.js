// stream 插件 —— 推流状态与流服务枢纽（只读为主 + 两个受控写操作）。底层引擎是
// 开源流服务器 MediaMTX，能力经本仓宿主桥（@xmedia/host-mtx-bridge）组合进本宿主：
// 凭据留宿主侧，字节不过桥。写操作仅两处：路径增删（引导推流源）与踢会话（readonly
// 策略下会被拒）。深度管理（全局配置/多服务器）走「流服务配置」插件或 agent 工具。
import { fmtBytes, fmtClock, fmtDay, fmtDur, tracksSummary } from './lib/_lib.js'

export default {
  id: 'stream',
  title: '推流状态',
  area: 'sidebar',
  group: '媒体面',
  order: 25,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>',

  mount(el, ctx) {
    const { call, show } = ctx
    el.innerHTML = `
      <header class="view-head">
        <h1>推流状态</h1>
        <p>发布出去的流在流服务器上的就绪态、会话与录制。底层引擎是开源流服务器 MediaMTX
          （能力经本仓宿主桥组合，凭据留宿主侧，字节不过桥）。
          路径增删与踢会话是本视图的写操作；完整深度管理走「流服务配置」插件或 agent 工具。</p>
      </header>

      <div class="panel">
        <h2>服务器与指标</h2>
        <pre id="stream-info">读取中…</pre>
        <pre id="stream-metrics" style="margin-top: 8px"></pre>
        <pre id="stream-endpoints" style="margin-top: 8px"></pre>
      </div>

      <div class="panel">
        <h2>新增推流路径（拉流源 / 发布点）</h2>
        <div class="row">
          <input id="add-name" size="14" placeholder="路径名 (cam3)">
          <input id="add-source" class="grow" placeholder="拉流源 URL（如 rtsp://摄像头；留空 = 发布点，供 xmedia/推流工具往里推）" style="font-family: var(--xm-mono)">
          <label class="label"><input type="checkbox" id="add-record"> 录制</label>
          <button id="add-submit" class="btn primary">新增</button>
        </div>
        <p class="hint" id="add-msg" style="color: var(--xm-muted)"></p>
      </div>

      <div class="panel">
        <h2>流路径</h2>
        <div class="row" style="margin-bottom: 8px">
          <button id="stream-refresh" class="btn">刷新</button>
          <span class="label">每 5s 自动刷新（服务器/路径/会话/指标/录制）</span>
        </div>
        <table class="jobs" id="stream-table">
          <thead>
            <tr><th>路径</th><th>就绪</th><th>源</th><th>轨道</th><th>观看者</th><th>录制</th><th>操作</th></tr>
          </thead>
          <tbody id="stream-body"><tr><td colspan="7">读取中…</td></tr></tbody>
        </table>
        <p class="hint">
          「就绪」表示有发布者在线且首帧已到达；「观看」切到播放器直连该路径。
          删除会把路径下线（其发布/观看随之中断）。
        </p>
      </div>

      <div class="panel">
        <h2>会话</h2>
        <table class="jobs" id="sess-table">
          <thead>
            <tr><th>类型</th><th>远端</th><th>路径</th><th>建立于</th><th>字节</th><th>操作</th></tr>
          </thead>
          <tbody id="sess-body"><tr><td colspan="6">读取中…</td></tr></tbody>
        </table>
        <p class="hint">rtmp 会话上游不允许踢出（按钮只对 kickable 会话出现）；readonly 策略下同样会被拒。</p>
      </div>

      <div class="panel">
        <h2>录制回放</h2>
        <div class="row" style="margin-bottom: 8px">
          <select id="rec-path" style="font: inherit; padding: 6px 8px; border: 1px solid var(--xm-border); border-radius: 8px; background: #fff; flex: 1 1 260px">
            <option value="">— 选择有录像的路径 —</option>
          </select>
          <button id="rec-refresh" class="btn">刷新</button>
        </div>
        <div id="rec-days"></div>
        <p class="hint">
          「从此播放」把该窗口连同其后的窗口串成一条链交给「播放器」自动跨窗前进；
          「加入同步」把同一条链放上同步回放墙的第一个空格。
        </p>
      </div>`

    const $id = (id) => el.querySelector('#' + id)
    const unreachable = (msg) => `MediaMTX API 不可达 —— 确认 MediaMTX 已启动（默认 127.0.0.1:9997）\n${msg}`

    // ---- 服务器 + 指标 + endpoints ---------------------------------------------
    const renderInfo = (value) => {
      const node = $id('stream-info')
      if (!value || value.error) {
        node.textContent = unreachable(value?.error ? JSON.stringify(value.error) : '')
        return
      }
      node.textContent = `版本 ${value.info?.version ?? '—'} · 启动于 ${value.info?.started ?? '—'}\nAPI  ${value.info?.apiBase ?? '—'}`
    }

    const renderMetrics = (value) => {
      const node = $id('stream-metrics')
      if (!value || value.error) { node.textContent = ''; return }  // 指标可缺（metrics 功能未开）
      const lines = [
        `就绪路径 ${value.pathsReady ?? 0} · 未就绪 ${value.pathsNotReady ?? 0} · 观看者合计 ${value.totalReaders ?? 0}`,
        ...(value.perPath ?? []).map((p) =>
          `  ${p.name}: ${p.state} · 观看者 ${p.readers} · 进 ${fmtBytes(p.inboundBytes)} · 出 ${fmtBytes(p.outboundBytes)}`),
      ]
      node.textContent = lines.join('\n')
    }

    const renderEndpoints = (value) => {
      const node = $id('stream-endpoints')
      if (!value || value.error) { node.textContent = ''; return }
      const eps = value.endpoints ?? {}
      const rows = Object.entries(eps).filter(([, url]) => url !== null).map(([k, url]) => `  ${k.padEnd(9)} ${url}`)
      node.textContent = rows.length > 0 ? `浏览器/推流端连接地址：\n${rows.join('\n')}` : ''
    }

    // ---- 流路径（含增删） ---------------------------------------------------------
    const renderPaths = (value) => {
      const body = $id('stream-body')
      if (!value || value.error) {
        body.innerHTML = `<tr><td colspan="7">MediaMTX API 不可达 —— 确认 MediaMTX 已启动（默认 127.0.0.1:9997）</td></tr>`
        return
      }
      const paths = Array.isArray(value.paths) ? value.paths : []
      if (paths.length === 0) {
        body.innerHTML = '<tr><td colspan="7">没有任何流路径 —— 上方表单新增拉流源，或点「实时预览」开始发布</td></tr>'
        return
      }
      body.innerHTML = paths.map((p) => `<tr>
        <td class="path">${p.name}</td>
        <td><span class="badge ${p.ready ? 'done' : 'pause'}">${p.ready ? '就绪' : '未就绪'}</span></td>
        <td class="path">${p.sourceType ?? '—'}</td>
        <td>${tracksSummary(p.tracks)}</td>
        <td>${p.readers ?? 0}</td>
        <td>${p.record ? '开' : '关'}</td>
        <td>${p.ready ? `<button class="btn" data-watch="${p.name}">观看</button>` : ''}
            <button class="btn" data-del="${p.name}">删除</button></td>
      </tr>`).join('')
    }

    // ---- 会话 -----------------------------------------------------------------
    const renderSessions = (value) => {
      const body = $id('sess-body')
      if (!value || value.error) {
        body.innerHTML = `<tr><td colspan="6">MediaMTX API 不可达</td></tr>`
        return
      }
      const sessions = Array.isArray(value.sessions) ? value.sessions : []
      if (sessions.length === 0) {
        body.innerHTML = '<tr><td colspan="6">没有活跃会话</td></tr>'
        return
      }
      body.innerHTML = sessions.map((s) => `<tr>
        <td><span class="badge run">${s.kind}</span></td>
        <td class="path">${s.remoteAddr ?? '—'}</td>
        <td class="path">${s.path ?? '—'}</td>
        <td>${(s.created ?? '—').replace('T', ' ').slice(0, 19)}</td>
        <td>${s.bytes == null ? '—' : fmtBytes(s.bytes)}</td>
        <td>${s.kickable ? `<button class="btn" data-kick-kind="${s.kind}" data-kick-id="${s.id}">踢出</button>` : '—'}</td>
      </tr>`).join('')
    }

    // ---- 录制回放 -----------------------------------------------------------------
    let recPaths = []
    let recPath = null
    let recEntries = []

    const renderRecPaths = (value) => {
      const sel = $id('rec-path')
      if (!value || value.error) {
        sel.innerHTML = '<option value="">录制索引不可达</option>'
        return
      }
      recPaths = (value.recordings ?? []).map((r) => r.name)
      sel.innerHTML = '<option value="">— 选择有录像的路径 —</option>' +
        recPaths.map((n) => `<option value="${n}" ${n === recPath ? 'selected' : ''}>${n}</option>`).join('')
    }

    const renderRecEntries = (value) => {
      const wrap = $id('rec-days')
      if (!value || value.error) {
        wrap.innerHTML = `<p class="hint" style="color: var(--xm-danger)">回放窗口读取失败: ${JSON.stringify(value?.error ?? value)}</p>`
        return
      }
      recEntries = Array.isArray(value.entries) ? value.entries : []
      if (recEntries.length === 0) {
        wrap.innerHTML = '<p class="hint">该路径没有可回放窗口（需开启 playback 且有录像段）</p>'
        return
      }
      // 按天分桶（与 console 一致）。
      const groups = new Map()
      for (const entry of recEntries) {
        const day = fmtDay(entry.startIso)
        if (!groups.has(day)) groups.set(day, [])
        groups.get(day).push(entry)
      }
      wrap.innerHTML = [...groups.entries()].map(([day, entries]) => `
        <div style="margin-bottom: 10px">
          <div class="label" style="margin-bottom: 4px">${day}</div>
          <table class="jobs"><tbody>${entries.map((e) => `<tr>
            <td class="path">${fmtClock(e.startIso)}</td>
            <td>${fmtDur(e.durationSeconds)}</td>
            <td>
              <button class="btn" data-chain="${recEntries.indexOf(e)}">从此播放</button>
              <button class="btn" data-sync="${recEntries.indexOf(e)}">加入同步</button>
            </td>
          </tr>`).join('')}</tbody></table>
        </div>`).join('')
    }

    const chainFrom = (globalIndex) => recEntries.slice(globalIndex < 0 ? 0 : globalIndex).filter((e) => e.url !== '')
    const chainLabel = (entry) => `${recPath ?? '?'} · ${fmtClock(entry.startIso)} · ${fmtDur(entry.durationSeconds)}`

    const loadRecEntries = async (name) => {
      $id('rec-days').innerHTML = '<p class="hint">回放窗口读取中…</p>'
      const value = await call('mediamtx.playback.list', { name })
      renderRecEntries(value)
    }

    // ---- 事件与轮询 ---------------------------------------------------------------
    $id('stream-table').addEventListener('click', async (event) => {
      const watchBtn = event.target.closest('button[data-watch]')
      if (watchBtn !== null) {
        // 先激活后发事件：目标插件懒挂载时才订阅总线，顺序反了事件会丢。
        ctx.activate('live')
        ctx.emit('xmedia:watch', { path: watchBtn.dataset.watch })
        return
      }
      const delBtn = event.target.closest('button[data-del]')
      if (delBtn !== null) {
        show(await call('mediamtx.config.paths.delete', { name: delBtn.dataset.del }))
        void refresh()
      }
    })
    $id('sess-table').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-kick-id]')
      if (btn === null) return
      show(await call('mediamtx.sessions.kick', { kind: btn.dataset.kickKind, id: btn.dataset.kickId }))
      void refreshSessions()
    })
    $id('rec-days').addEventListener('click', (event) => {
      const playBtn = event.target.closest('button[data-chain]')
      const syncBtn = event.target.closest('button[data-sync]')
      const gi = playBtn !== null ? Number(playBtn.dataset.chain) : Number(syncBtn?.dataset.sync)
      if (!Number.isFinite(gi)) return
      const entry = recEntries[gi]
      if (entry === undefined || entry.url === '' || recPath === null) return
      const entries = chainFrom(gi)
      if (entries.length === 0) return
      if (playBtn !== null) {
        ctx.activate('player')   // 先激活（懒挂载+订阅），再发事件
        ctx.emit('xmedia:play-chain', { path: recPath, entries, index: 0, label: chainLabel(entry) })
      } else {
        ctx.activate('sync')
        ctx.emit('xmedia:sync-add', { slot: { path: recPath, entries } })
      }
    })
    $id('add-submit').addEventListener('click', async () => {
      const name = $id('add-name').value.trim()
      const source = $id('add-source').value.trim()
      const record = $id('add-record').checked
      if (name === '') { $id('add-msg').textContent = '路径名必填'; $id('add-msg').style.color = 'var(--xm-danger)'; return }
      const params = { name, record }
      if (source !== '') params.source = source
      const res = await call('mediamtx.config.paths.add', params)
      $id('add-msg').style.color = res && res.error ? 'var(--xm-danger)' : ''
      $id('add-msg').textContent = res && res.error
        ? `新增失败: ${res.error.message ?? JSON.stringify(res.error)}`
        : `已新增 ${name}${source !== '' ? `（拉流源 ${source}）` : '（发布点）'}`
      if (!(res && res.error)) {
        $id('add-name').value = ''
        $id('add-source').value = ''
        $id('add-record').checked = false
        void refresh()
      }
    })
    $id('rec-path').addEventListener('change', (e) => {
      recPath = e.target.value === '' ? null : e.target.value
      if (recPath !== null) void loadRecEntries(recPath)
    })
    $id('rec-refresh').addEventListener('click', async () => {
      await refreshRecordings()
      if (recPath !== null) void loadRecEntries(recPath)
    })
    $id('stream-refresh').addEventListener('click', async () => show(await refresh()))

    const refreshInfo = async () => renderInfo(await call('mediamtx.info'))
    const refreshPaths = async () => renderPaths(await call('mediamtx.paths.list'))
    const refreshSessions = async () => renderSessions(await call('mediamtx.sessions.list'))
    const refreshMetrics = async () => renderMetrics(await call('mediamtx.metrics'))
    const refreshEndpoints = async () => renderEndpoints(await call('mediamtx.endpoints'))
    const refreshRecordings = async () => renderRecPaths(await call('mediamtx.recordings.list'))

    const refresh = async () => {
      const results = await Promise.allSettled([
        refreshInfo(), refreshPaths(), refreshSessions(), refreshRecordings(), refreshMetrics(), refreshEndpoints(),
      ])
      return { refreshed: true, failed: results.filter((r) => r.status === 'rejected').length }
    }

    void refresh()
    setInterval(() => { void refresh() }, 5000)
  },
}
