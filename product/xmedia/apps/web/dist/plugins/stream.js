// stream 插件 —— 推流状态与流服务枢纽（只读为主 + 两个受控写操作）。底层引擎是
// 开源流服务器 MediaMTX，能力经本仓宿主桥（@xmedia/host-mtx-bridge）组合进本宿主：
// 凭据留宿主侧，字节不过桥。写操作仅两处：接入外部拉流源与踢会话（readonly 策略下
// 会被拒）。本地文件/设备的编码推流归「实时预览」；深度管理（全局配置/多服务器）
// 走「流服务配置」插件或 agent 工具。
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
          接入外部拉流源与踢会话是本视图的写操作；完整深度管理走「流服务配置」插件或 agent 工具。</p>
      </header>

      <div class="panel">
        <h2>服务器与指标</h2>
        <div class="row" style="margin-bottom:8px">
          <span id="mtx-badge" class="badge pause" title="MediaMTX 流服务状态">流服务检测中…</span>
          <button id="mtx-start" class="btn primary" style="display:none">启动流服务</button>
          <button id="mtx-check" class="btn">检测状态</button>
          <span id="mtx-detail" class="label"></span>
        </div>
        <pre id="stream-info">读取中…</pre>
        <pre id="stream-metrics" style="margin-top: 8px"></pre>
        <pre id="stream-endpoints" style="margin-top: 8px"></pre>
      </div>

      <div class="panel">
        <h2>接入拉流源</h2>
        <div class="row">
          <input id="add-name" size="14" placeholder="路径名 (cam3)">
          <input id="add-source" class="grow" placeholder="外部流 URL，如 rtsp://摄像头 —— MediaMTX 主动去拉" style="font-family: var(--xm-mono)">
          <label class="label"><input type="checkbox" id="add-record"> 录制</label>
          <button id="add-submit" class="btn primary">接入</button>
        </div>
        <p class="hint" id="add-msg" style="color: var(--xm-muted)"></p>
        <p class="hint">让 MediaMTX 主动拉取外部流源（IP 摄像头、其他推流端），本产品的编码引擎不参与。
          要把本地文件/设备推成流，请用「实时预览」的编码发布——MediaMTX 会自动创建路径，无需在这里先登记。</p>
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
          「就绪」表示有发布者在线且首帧已到达；「观看」切到「实时预览」直连该路径。
          删除会把该拉流源配置下线（其发布/观看随之中断）。
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
        <p class="hint">「类型」列的徽章标出角色：<strong>推流</strong>=一路正在发布的流（每路各占一个 rtmp/rtsp 会话），<strong>观看</strong>=一个播放者（如页面的 WHEP/webrtc 连接）。因此"2 个 rtmp + 1 个 webrtc"通常是两路推流 + 一个观看者，属正常。全部 8 种协议会话均可踢出（含 rtmp——它对应发布者连接，踢掉后该路直播会中断，已录制段保留）；readonly 策略下会被拒。踢 publisher 前请确认不再需要该路推流。</p>
      </div>

      <div class="panel">
        <h2>录制回放</h2>
        <div class="row" style="margin-bottom: 8px">
          <select id="rec-path" style="font: inherit; padding: 6px 8px; border: 1px solid var(--xm-border); border-radius: 8px; background: #fff; flex: 1 1 260px">
            <option value="">— 选择有录像的路径 —</option>
          </select>
          <button id="rec-refresh" class="btn">刷新</button>
          <button id="rec-clear" class="btn" title="删除所有路径下的全部录像段，不可恢复">清空全部录像</button>
        </div>
        <div id="rec-clear-msg" class="hint" style="display:none; color: var(--xm-danger)"></div>
        <div id="rec-days"></div>
        <p class="hint">
          「从此播放」把该窗口连同其后的窗口串成一条链交给「录像回放」自动跨窗前进；
          「加入同步」把同一条链放上同步回放墙的第一个空格。
          「清空全部录像」会删除所有路径的录像段（不可恢复），需连续点两次确认。
          每段时长不同是正常的：MediaMTX 按关键帧边界切段（默认约 10s 一段），
          实际时长取决于推流续断与关键帧位置；中间停推的空档不录制，所以段长从几秒到十几秒不等。
        </p>
      </div>`

    const $id = (id) => el.querySelector('#' + id)
    const unreachable = (msg) => `MediaMTX API 不可达 —— 确认 MediaMTX 已启动（默认 127.0.0.1:9997）\n${msg}`

    // ---- 本地 MediaMTX 进程：状态灯 + 按需启动 -----------------------------------
    // API 可达才算在线；外部手工启动的实例也算，绝不重复拉起或停掉它。
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
      $id('mtx-detail').textContent = s.online
        ? `${s.api}${s.pid ? ' · PID ' + s.pid : ''} · 配置 ${s.config}`
        : (s.error || `未检测到服务：${s.api}`)
    }

    const refreshMtx = async () => {
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
        body.innerHTML = '<tr><td colspan="7">没有任何流路径 —— 上方接入外部拉流源，或点「实时预览」把本地流推上来</td></tr>'
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
      // detail 是 bridge 归一化后的 "transport · state"，state 通常为 publish/read。
      // 显示角色：rtmp publish = 一路推流（每路各一个），webrtc read = 浏览器观看。
      // 这样"2 个 rtmp + 1 个 webrtc"就能一眼看懂：两路推流 + 一个观看者。
      const role = (s) => {
        const d = String(s.detail ?? '')
        if (/publish/i.test(d)) return { text: '推流', cls: 'done' }
        if (/read/i.test(d)) return { text: '观看', cls: 'run' }
        return { text: '会话', cls: 'pause' }
      }
      body.innerHTML = sessions.map((s) => {
        const r = role(s)
        return `<tr>
        <td><span class="badge run">${s.kind}</span> <span class="badge ${r.cls}" title="${s.detail ?? ''}">${r.text}</span></td>
        <td class="path">${s.remoteAddr ?? '—'}</td>
        <td class="path">${s.path ?? '—'}</td>
        <td>${(s.created ?? '—').replace('T', ' ').slice(0, 19)}</td>
        <td>${s.bytes == null ? '—' : fmtBytes(s.bytes)}</td>
        <td>${s.kickable ? `<button class="btn" data-kick-kind="${s.kind}" data-kick-id="${s.id}">踢出</button>` : '—'}</td>
      </tr>`}).join('')
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
      if (source === '') { $id('add-msg').textContent = '外部流 URL 必填（本地推流请用「实时预览」）'; $id('add-msg').style.color = 'var(--xm-danger)'; return }
      const params = { name, record, source }
      const res = await call('mediamtx.config.paths.add', params)
      $id('add-msg').style.color = res && res.error ? 'var(--xm-danger)' : ''
      $id('add-msg').textContent = res && res.error
        ? `接入失败: ${res.error.message ?? JSON.stringify(res.error)}`
        : `已接入 ${name}（拉流源 ${source}）`
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
    // 一键清空录像：两步内联确认（原生 confirm 在自动化/嵌入环境不可靠）。
    // 第一步只武装按钮并显示警告，第二步才发不可恢复的 deleteAll RPC。
    let clearArmed = false
    let clearTimer = 0
    let clearing = false
    const disarmClear = () => {
      clearArmed = false
      $id('rec-clear').textContent = '清空全部录像'
      const msg = $id('rec-clear-msg')
      msg.style.display = 'none'
      msg.textContent = ''
      if (clearTimer !== 0) { clearTimeout(clearTimer); clearTimer = 0 }
    }
    $id('rec-clear').addEventListener('click', async () => {
      if (clearing) return
      if (!clearArmed) {
        clearArmed = true
        $id('rec-clear').textContent = '再点一次确认清空'
        const msg = $id('rec-clear-msg')
        msg.textContent = '⚠ 即将删除所有路径的全部录像段，此操作不可恢复。5 秒内再次点击确认，或等待自动取消。'
        msg.style.display = ''
        clearTimer = setTimeout(disarmClear, 5000)
        return
      }
      clearing = true
      if (clearTimer !== 0) { clearTimeout(clearTimer); clearTimer = 0 }
      const btn = $id('rec-clear')
      btn.disabled = true
      btn.textContent = '正在清空…'
      const res = await call('mediamtx.recordings.deleteAll', { confirm: true })
      show(res)
      btn.disabled = false
      clearing = false
      disarmClear()
      if (res && res.error) return
      // 录像都没了：清掉当前选中链，避免播放器/同步墙继续指向已删除的 URL。
      recPath = null
      recEntries = []
      $id('rec-path').value = ''
      $id('rec-days').innerHTML = '<p class="hint">录像已全部清空。</p>'
      // 录像回放/同步回放可能已持有之前 emit 出去的链——它们指向已删除的段，
      // 必须广播清台，否则切回那些页面还能看到旧片段（点了必然播放失败）。
      ctx.emit('xmedia:recordings-cleared', {})
      await refreshRecordings()
    })
    $id('stream-refresh').addEventListener('click', async () => show(await refresh()))
    $id('mtx-check').addEventListener('click', async () => { show(await refreshMtx()); void refresh() })
    $id('mtx-start').addEventListener('click', async () => {
      $id('mtx-detail').textContent = '正在启动流服务…'
      try {
        const value = await call('mediamtx.start')
        renderMtx(value?.status ?? null)
        show(await refresh())
      } catch (e) {
        $id('mtx-detail').textContent = String(e?.message ?? e).slice(0, 160)
      }
    })

    const refreshInfo = async () => renderInfo(await call('mediamtx.info'))
    const refreshPaths = async () => renderPaths(await call('mediamtx.paths.list'))
    const refreshSessions = async () => renderSessions(await call('mediamtx.sessions.list'))
    const refreshMetrics = async () => renderMetrics(await call('mediamtx.metrics'))
    const refreshEndpoints = async () => renderEndpoints(await call('mediamtx.endpoints'))
    const refreshRecordings = async () => renderRecPaths(await call('mediamtx.recordings.list'))

    const refresh = async () => {
      const results = await Promise.allSettled([
        refreshInfo(), refreshPaths(), refreshSessions(), refreshRecordings(), refreshMetrics(), refreshEndpoints(), refreshMtx(),
      ])
      return { refreshed: true, failed: results.filter((r) => r.status === 'rejected').length }
    }

    void refresh()
    setInterval(() => { void refresh() }, 5000)
  },
}
