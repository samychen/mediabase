// sync 插件 —— 同步回放墙（M3 wall, M4 chaining）：多条录像链共用一条墙钟时间线。
// （纯数学在 lib/sync-math.js，MSE 在 lib/mse.js。）
//
// A cell holds a path's consecutive windows (SyncSlot); the rAF master clock
// maps wall-clock milliseconds to (which window, which media second) per cell
// — crossing a window boundary re-attaches that cell's MsePlayer to the next
// window's stream: the ONLY honest move, since /get answers Accept-Ranges:
// none. Gaps between windows park the cell (paused) until the clock reaches
// the next one. The clock deliberately lives OUTSIDE the declarative state: a
// 60fps tick must not re-render the wall.
//
// 链的来源：推流状态(stream)录制面板的「加入同步」/拖放（payload 版本校验），
// 以及总线 `xmedia:sync-add`。
//
// 实时格（slot.live=true）：外部流直链经 xmedia.publish.start 转推进 MediaMTX，
// 浏览器用 WHEP（或原生 HLS）直连观看。实时流没有录像窗口、不可拖动，因此不参与
// 时间线定位，只跟随墙的播放/暂停；本面板接入的任务在格子移除/清空时停掉。

import { startWhep, nativeHlsSupported } from '../whep.js'
import { MsePlayer } from './lib/mse.js'
import {
  chainSeconds,
  firstFreeSlot,
  locateInSlot,
  locateInChain,
  parseSyncPayload,
  syncRange,
  encodeSyncPayload,
  SYNC_MAX_SLOTS,
} from './lib/sync-math.js'
import { fmtClock, fmtDur } from './lib/_lib.js'

/** How far a video may drift from the master clock before it gets snapped. */
const DRIFT_S = 0.4
/** A fresh WHEP endpoint can be up before the first frame reaches MediaMTX. */
const LIVE_CONNECT_RETRIES = 8
const LIVE_RETRY_MS = 1000

export default {
  id: 'sync',
  title: '同步回放',
  area: 'sidebar',
  group: '媒体面',
  order: 35,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',

  mount(el, ctx) {
    const { call } = ctx
    el.innerHTML = `
      <header class="view-head">
        <h1>同步回放</h1>
        <p>最多 9 格：录像链（rAF 主时钟 + 漂移吸附）与外部实时流可混排。链来自「推流状态」
          录制面板的 ⊞ / 拖放，或总线 <code>xmedia.sync-add</code>；实时流从下方「外部流」接入。
          <strong>单路回放请用「录像回放」</strong>，这里专用于 ≥2 路。<b>顺序</b>模式各路从自己第 1 段一起播（先后推流的默认选择）；
          <b>墙钟</b>模式按真实录像时刻对齐（各路同时开播才用）。回放窗口无 Range：跨窗即从下一窗口首字节重新流式。</p>
      </header>

      <div class="panel">
        <div class="row" style="margin-bottom: 10px">
          <span class="label" title="流直链如 https://…flv / https://…m3u8；编码器转推到 MediaMTX 后浏览器 WHEP 直连。只填路径名则直接加入已有 MediaMTX 路径">外部流</span>
          <input id="sy-ext-url" class="grow" placeholder="流直链（如 B 站直播源 .flv/.m3u8）或已有 MediaMTX 路径名" style="font-family: var(--xm-mono)">
          <input id="sy-ext-path" size="12" placeholder="路径名(可选)">
          <button id="sy-ext-add" class="btn primary">接入到墙</button>
          <span id="sy-ext-msg" class="label"></span>
        </div>
        <p class="hint">外部流是<strong>实时画面，不可拖动</strong>；直播间页面地址不是流地址，请填真实的 .flv/.m3u8 直链。
          本面板接入的转推任务在格子移除/清空时停止；已存在的 MediaMTX 路径不会被停掉。</p>
        <div class="row" style="margin-bottom: 10px">
          <span class="label" title="顺序：各路从自己第 1 段一起播（默认，适合先后推流）；墙钟：按真实录像时刻对齐（适合同时开播）">对齐</span>
          <select id="sy-align" style="font: inherit; padding: 6px 8px; border: 1px solid var(--xm-border); border-radius: 8px; background: #fff">
            <option value="chain" selected>顺序（各路从头一起播）</option>
            <option value="wall">墙钟（按录像时刻）</option>
          </select>
          <button id="sy-toggle" class="btn primary" disabled>播放</button>
          <input id="sy-scrub" type="range" step="250" min="0" max="1" disabled style="flex: 1 1 320px" aria-label="墙钟位置">
          <span id="sy-clock" class="label" style="font-family: var(--xm-mono)">—</span>
          <span id="sy-count" class="badge pause" title="同一墙钟时间线上对齐的录像路数">已接入 0 路</span>
          <span class="label">布局</span>
          <select id="sy-layout" style="font: inherit; padding: 6px 8px; border: 1px solid var(--xm-border); border-radius: 8px; background: #fff">
            <option value="1">1 窗</option>
            <option value="4" selected>4 窗</option>
            <option value="9">9 窗</option>
          </select>
          <button id="sy-clear" class="btn" disabled>清空</button>
        </div>
        <div id="sy-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px" data-layout="4"></div>
        <p class="hint" id="sy-empty">墙是空的——从「推流状态」的录制面板把链「加入同步」，或拖拽过来。</p>
        <p class="hint">拖动 scrubber：缓冲区内即时，向前需顺序取流追上，已被淘汰的尾部回不去。</p>
      </div>`

    const $id = (id) => el.querySelector('#' + id)
    const grid = $id('sy-grid')

    // ---- 声明态（格子内容/布局）与快速态（时钟）分离 ---------------------------
    let layout = 4
    // 'chain' = every cell starts at its own first window together (default,
    // for streams published one after another); 'wall' = real recording time.
    let align = 'chain'
    const slots = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    let playing = false

    const videos = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const players = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const guards = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const attached = Array.from({ length: SYNC_MAX_SLOTS }, () => -1)
    const posEls = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const badgeEls = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const playerState = Array.from({ length: SYNC_MAX_SLOTS }, () => ({ state: '', detail: '' }))
    const notes = Array.from({ length: SYNC_MAX_SLOTS }, () => '')
    // Live cells keep a WHEP/HLS handle instead of an MsePlayer. `liveSeq`
    // invalidates in-flight connects after a teardown; `liveRetry` owns the
    // bounded reconnect while the encoder is still starting the stream.
    const liveHandles = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const liveSeq = Array.from({ length: SYNC_MAX_SLOTS }, () => 0)
    const liveRetry = Array.from({ length: SYNC_MAX_SLOTS }, () => 0)
    let timeMs = 0
    const scrub = $id('sy-scrub')
    const clock = $id('sy-clock')

    /**
     * Shared master timeline. wall: epoch milliseconds (syncRange).
     * chain: relative milliseconds 0..longest chain — every cell starts at
     * its own first window, so N chained cells actually play TOGETHER.
     */
    const visibleSlots = () => slots.slice(0, layout).filter((s) => s !== null)
    const range = () => {
      if (align === 'wall') {
        // syncRange() reads `entries`; live cells have none, so filter first.
        const w = syncRange(visibleSlots().filter((s) => s.live !== true), layout)
        if (w !== null) return { ...w, wall: true }
      } else {
        let longest = 0
        for (let i = 0; i < layout; i++) {
          const slot = slots[i]
          if (slot === null || slot.live === true || slot.entries.length === 0) continue
          longest = Math.max(longest, chainSeconds(slot))
        }
        if (longest > 0) return { startMs: 0, endMs: longest * 1000, wall: false }
      }
      // A wall of only live cells is playable too: realtime, no scrub/end.
      if (visibleSlots().some((s) => s.live === true)) {
        return { startMs: 0, endMs: 0, wall: false, liveOnly: true }
      }
      return null
    }

    /** Map the master clock into one cell under the active alignment mode. */
    const locate = (globalMs, slot) => align === 'wall'
      ? locateInSlot(globalMs, slot)
      : locateInChain(slot, globalMs / 1000)

    // Badge priority: a cell-level note (waiting/no footage/ended) wins over
    // the player's transient state; 'playing' and idle keep the badge hidden.
    const paintBadge = (i) => {
      const badge = badgeEls[i]
      if (badge === null) return
      const ps = playerState[i]
      const note = notes[i]
      let text = ''
      if (note !== '') text = note
      else if (ps.state === 'error') text = ps.detail || '错误'
      else if (ps.state === 'opening') text = '连接中'
      else if (ps.state === 'ended') text = '已结束'
      badge.textContent = text
      badge.style.display = text === '' ? 'none' : ''
    }

    const paintTransport = (globalMs) => {
      scrub.value = String(globalMs)
      const r = range()
      if (r === null) {
        clock.textContent = '—'
        return
      }
      clock.textContent = r.liveOnly ? '● 实时'
        : r.wall
          ? `${fmtClock(new Date(globalMs).toISOString())} / ${fmtClock(new Date(r.endMs).toISOString())}`
          : `${fmtDur(globalMs / 1000)} / ${fmtDur(r.endMs / 1000)}（顺序）`
    }

    const detachCell = (i) => {
      liveSeq[i] += 1
      if (liveRetry[i] !== 0) { clearTimeout(liveRetry[i]); liveRetry[i] = 0 }
      if (liveHandles[i] !== null) { liveHandles[i].close(); liveHandles[i] = null }
      players[i]?.dispose()
      players[i] = null
      guards[i]?.()
      guards[i] = null
      attached[i] = -1
      playerState[i] = { state: '', detail: '' }
      notes[i] = ''
      if (badgeEls[i] !== null) badgeEls[i].style.display = 'none'
    }

    /** Stream one chain window into a cell (new MsePlayer each window). */
    const attachCell = (i, slot, entryIndex) => {
      const entry = slot.entries[entryIndex]
      const video = videos[i]
      if (entry === undefined || entry.url === '' || video === null) return
      detachCell(i)
      notes[i] = ''
      const player = new MsePlayer(video, (state, detail) => {
        playerState[i] = { state, detail: detail ?? '' }
        paintBadge(i)
      })
      players[i] = player
      attached[i] = entryIndex
      // MsePlayer calls video.play() when the source opens, but the master
      // clock may be parked — re-assert the pause when media starts.
      const guard = () => { if (!playing) video.pause() }
      video.addEventListener('playing', guard)
      guards[i] = () => video.removeEventListener('playing', guard)
      void player.play(entry.url)
    }

    /**
     * Attach a live cell. The stream is already publishing into MediaMTX (or
     * is an existing path), so there is nothing to seek: WHEP carries the
     * picture, native HLS is the fallback where the browser supports it.
     * A fresh endpoint can answer 400 "no stream is available" while the
     * encoder is still starting — retry briefly instead of a black tile.
     */
    const attachLive = (i, slot) => {
      detachCell(i)
      const video = videos[i]
      if (video === null) return
      const seq = liveSeq[i]
      attached[i] = -2 // reserved for "live attached"; windows use >= 0
      const state = (s, detail = '') => {
        if (seq !== liveSeq[i]) return
        playerState[i] = { state: s, detail }
        paintBadge(i)
      }
      state('opening')
      const getViewers = async () => {
        try {
          const v = await call('xmedia.publish.viewers', { path: slot.path })
          if (v && v.error === undefined) return v
        } catch { /* fall back to the URL returned by publish.start */ }
        return slot.viewers ?? null
      }
      const later = (fn, ms) => {
        if (seq !== liveSeq[i]) return
        liveRetry[i] = setTimeout(() => {
          liveRetry[i] = 0
          if (seq === liveSeq[i] && slots[i] === slot) fn()
        }, ms)
      }
      const connect = async (attempt) => {
        if (seq !== liveSeq[i] || slots[i] !== slot) return
        let viewers
        try {
          viewers = await getViewers()
        } catch (e) {
          viewers = null
          state('opening', String(e?.message ?? e).slice(0, 80))
        }
        const url = viewers?.whep
        if (typeof url !== 'string' || url === '') {
          state('opening', '观看地址尚未就绪')
          if (attempt < LIVE_CONNECT_RETRIES) later(() => void connect(attempt + 1), LIVE_RETRY_MS)
          else state('error', '观看地址不可用')
          return
        }
        try {
          const handle = await startWhep(url, video, { audio: false })
          if (seq !== liveSeq[i] || slots[i] !== slot) { handle.close(); return }
          liveHandles[i] = handle
          state('playing')
          if (playing) video.play().catch(() => { /* the operator can press play */ })
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          const transient = /no stream|not found|HTTP 4\d\d|HTTP 503|failed to fetch/i.test(detail)
          if (transient && attempt < LIVE_CONNECT_RETRIES) {
            state('opening', detail)
            later(() => void connect(attempt + 1), LIVE_RETRY_MS)
            return
          }
          if (typeof viewers?.hls === 'string' && nativeHlsSupported()) {
            video.src = viewers.hls
            liveHandles[i] = {
              close() { video.removeAttribute('src'); video.load() },
            }
            video.play().catch(() => state('error', 'HLS 自动播放被拦截'))
            state('playing', 'HLS')
            return
          }
          state('error', detail)
        }
      }
      void connect(0)
    }

    /** Apply the global clock to every visible cell. */
    const drive = (globalMs, run) => {
      for (let i = 0; i < SYNC_MAX_SLOTS; i++) {
        const video = videos[i]
        const slot = i < layout ? slots[i] : null
        if (video === null || slot === null) continue
        if (slot.live === true) {
          // Realtime has no windows: attach once, then just follow the wall's
          // play/pause. Never feed it through locate()/MSE drift correction.
          if (attached[i] !== -2) attachLive(i, slot)
          if (run) { if (video.paused) video.play().catch(() => { /* next tick retries */ }) }
          else if (!video.paused) video.pause()
          continue
        }
        const pos = locate(globalMs, slot)
        const posEl = posEls[i]
        if (pos === null) {
          // Cell is outside its window (wall mode: clock before first / after
          // last recording). Never leave a silent black tile: say why.
          notes[i] = '该时段无录像'
          playerState[i] = { state: '', detail: '' }
          paintBadge(i)
          if (!video.paused) video.pause()
          if (posEl !== null) posEl.textContent = ''
          continue
        }
        if (posEl !== null && slot.entries.length > 1) {
          posEl.textContent = `${pos.entryIndex + 1}/${slot.entries.length}`
        }
        if (attached[i] !== pos.entryIndex) attachCell(i, slot, pos.entryIndex)
        if (pos.rel === null) {
          // A recording gap (wall mode) or the chain's tail (chain mode):
          // hold, paused, and show the reason instead of a silent black tile.
          notes[i] = align === 'chain' ? '本路已播完' : '录像间隙'
          paintBadge(i)
          if (!video.paused) video.pause()
          continue
        }
        notes[i] = ''
        if (video.buffered.length > 0 && Math.abs(video.currentTime - pos.rel) > DRIFT_S) {
          const bufStart = video.buffered.start(0)
          video.currentTime = pos.rel < bufStart ? bufStart : pos.rel
        }
        if (run) {
          if (video.paused) video.play().catch(() => { /* next tick retries */ })
          paintBadge(i)
        } else if (!video.paused) {
          video.pause()
        }
      }
    }

    // ---- 声明态渲染（格子内容变化才重建；MSE 生命周期在 identity 变化时拆） ------
    const cellId = (slot, i) => {
      if (i >= layout || slot === null) return ''
      if (slot.live === true) return `live|${slot.path}`
      if (slot.entries.length === 0) return ''
      const first = slot.entries[0]
      const last = slot.entries[slot.entries.length - 1]
      return `${slot.path}|${slot.entries.length}|${first.startIso}|${last.startIso}|${first.url}`
    }
    const identities = Array.from({ length: SYNC_MAX_SLOTS }, () => '')

    const renderGrid = () => {
      // grid.innerHTML = '' below recreates EVERY <video> element, not just the
      // changed cell. Detaching only identity-changed cells left an earlier
      // cell's MsePlayer bound to the removed element: its new <video> stayed
      // forever empty (black) while the old player kept streaming into the DOM
      // void. Detach all cells so drive() re-attaches each one via attached=-1.
      for (let i = 0; i < SYNC_MAX_SLOTS; i++) {
        identities[i] = i < layout ? cellId(slots[i], i) : ''
        detachCell(i)
      }
      grid.dataset.layout = String(layout)
      grid.style.gridTemplateColumns = `repeat(${layout === 1 ? 1 : layout === 4 ? 2 : 3}, 1fr)`
      grid.innerHTML = ''
      for (let i = 0; i < layout; i++) {
        const slot = slots[i]
        const cell = document.createElement('div')
        cell.style.cssText = 'position:relative; aspect-ratio:16/9; background:#000; border-radius:10px; display:grid; place-items:center'
        cell.addEventListener('dragover', (e) => e.preventDefault())
        cell.addEventListener('drop', (e) => {
          e.preventDefault()
          const payload = parseSyncPayload(e.dataTransfer.getData('text/plain'))
          if (payload !== null) assign(i, payload)
        })
        if (slot === null) {
          cell.innerHTML = '<span style="color: var(--xm-faint); font-size: 12px">拖放录像链到这里</span>'
        } else {
          const video = document.createElement('video')
          video.muted = true
          video.playsInline = true
          video.style.cssText = 'width:100%; height:100%; object-fit:contain'
          cell.appendChild(video)
          videos[i] = video
          const label = document.createElement('div')
          label.style.cssText = 'position:absolute; inset:auto 0 0 0; padding:4px 8px; font:11px var(--xm-mono); color:#fff; background:rgba(0,0,0,.55); display:flex; justify-content:space-between'
          label.innerHTML = slot.live === true
            ? `<span>● LIVE · ${slot.label ?? slot.path}<span></span></span><span style="color:var(--xm-faint)">✕</span>`
            : `<span>${slot.path} · ${fmtClock(slot.entries[0]?.startIso ?? '')} · ${fmtDur(chainSeconds(slot))}<span></span></span><span style="color:var(--xm-faint)">✕</span>`
          const posEl = label.querySelector('span > span')
          posEls[i] = posEl
          const badge = document.createElement('span')
          badge.className = 'badge pause'
          badge.style.cssText = 'position:absolute; top:6px; left:6px; display:none'
          badgeEls[i] = badge
          cell.appendChild(badge)
          const remove = label.querySelector('span:last-child')
          remove.style.cursor = 'pointer'
          remove.addEventListener('click', () => assign(i, null))
          cell.appendChild(label)
        }
        grid.appendChild(cell)
      }
      const active = slots.slice(0, layout).filter((s) => s !== null)
      const occupied = active.length > 0
      const countEl = $id('sy-count')
      countEl.textContent = `已接入 ${active.length} 路`
      countEl.className = 'badge ' + (active.length >= 2 ? 'done' : 'pause')
      countEl.title = active.length >= 2
        ? `${active.length} 路同墙播放（录像按时间线对齐，实时流跟随播放/暂停）`
        : '单路录像建议用「录像回放」做深度 seek；这里用于 ≥2 路对齐'
      $id('sy-empty').style.display = occupied ? 'none' : ''
      $id('sy-clear').disabled = !occupied
    }

    const reflow = () => {
      const r = range()
      if (r === null) {
        timeMs = 0
        playing = false
        $id('sy-toggle').textContent = '播放'
        $id('sy-toggle').classList.add('primary')
        // The button ships disabled in markup; it must be re-enabled whenever
        // a valid timeline exists, otherwise the wall is unplayable even with
        // two occupied cells (sy-clock shows a range but the button stays gray).
        $id('sy-toggle').disabled = true
        scrub.disabled = true
      } else {
        timeMs = Math.min(Math.max(timeMs, r.startMs), r.endMs)
        $id('sy-toggle').disabled = false
        scrub.disabled = r.liveOnly === true
        scrub.min = String(r.startMs)
        scrub.max = String(r.endMs)
      }
      paintTransport(timeMs)
      drive(timeMs, playing)
    }

    /** Stop a re-publish job this panel created; never touch foreign paths. */
    const releaseLive = (i) => {
      const old = slots[i]
      if (old?.live === true && old.owned === true && typeof old.jobId === 'string') {
        void call('xmedia.publish.stop', { jobId: old.jobId }).catch(() => { /* best effort */ })
      }
    }

    const assign = (i, slot) => {
      if (slots[i] !== slot) releaseLive(i)
      slots[i] = slot
      renderGrid()
      reflow()
    }

    // ---- 主时钟（rAF 在声明态之外；每 tick 只做 DOM 直写） ------------------------
    let raf = 0
    let last = performance.now()
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      const dt = now - last
      last = now
      const r = range()
      if (r === null) { stopClock(); return }
      let next = timeMs + dt
      if (r.liveOnly !== true && next >= r.endMs) {
        next = r.endMs
        playing = false
        $id('sy-toggle').textContent = '播放'
        $id('sy-toggle').classList.add('primary')
        cancelAnimationFrame(raf)
        raf = 0
      }
      timeMs = next
      drive(next, true)
      paintTransport(next)
    }
    const startClock = () => {
      if (raf === 0) {
        last = performance.now()
        raf = requestAnimationFrame(loop)
      }
    }
    const stopClock = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    const togglePlay = () => {
      const r = range()
      if (r === null) return
      if (playing) {
        playing = false
        stopClock()
        $id('sy-toggle').textContent = '播放'
        $id('sy-toggle').classList.add('primary')
        drive(timeMs, false)
        return
      }
      // Pressing play at the end means "again from the top".
      if (timeMs >= r.endMs) {
        timeMs = r.startMs
        paintTransport(timeMs)
      }
      playing = true
      $id('sy-toggle').textContent = '暂停'
      $id('sy-toggle').classList.remove('primary')
      drive(timeMs, true)
      startClock()
    }
    $id('sy-toggle').addEventListener('click', togglePlay)
    scrub.addEventListener('input', () => {
      const v = Number(scrub.value)
      if (!Number.isFinite(v)) return
      timeMs = v
      drive(v, playing)
      paintTransport(v)
    })
    $id('sy-layout').addEventListener('change', (e) => {
      layout = Number(e.target.value)
      renderGrid()
      reflow()
    })
    $id('sy-align').addEventListener('change', (e) => {
      align = e.target.value === 'wall' ? 'wall' : 'chain'
      // The two modes have different coordinate systems (relative vs epoch
      // ms): stop, tear down every player, and seek to the new timeline head.
      playing = false
      stopClock()
      $id('sy-toggle').textContent = '播放'
      $id('sy-toggle').classList.add('primary')
      for (let i = 0; i < SYNC_MAX_SLOTS; i++) detachCell(i)
      const r = range()
      timeMs = r === null ? 0 : r.startMs
      reflow()
    })
    $id('sy-clear').addEventListener('click', () => {
      playing = false
      stopClock()
      for (let i = 0; i < SYNC_MAX_SLOTS; i++) { releaseLive(i); slots[i] = null }
      renderGrid()
      reflow()
    })

    // ---- 外部实时流 -----------------------------------------------------------
    const extMsg = (text, isError = false) => {
      const node = $id('sy-ext-msg')
      node.textContent = text
      node.style.color = isError ? 'var(--xm-danger)' : ''
    }
    const extPath = () => `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    $id('sy-ext-add').addEventListener('click', async () => {
      const raw = $id('sy-ext-url').value.trim()
      if (raw === '') { extMsg('请填流直链或已有路径名', true); return }
      const free = firstFreeSlot(slots, layout)
      if (free < 0) { extMsg('墙已满：先点某格右上角的 ✕ 腾出位置', true); return }
      const btn = $id('sy-ext-add')
      btn.disabled = true
      let slot
      try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
          // A direct stream URL: re-encode into MediaMTX so the browser can
          // watch it over WHEP (no CORS, no hls.js/flv.js, Bilibili FLV works).
          const path = ($id('sy-ext-path').value.trim() || extPath())
            .replace(/[^A-Za-z0-9_\-./]/g, '-').slice(0, 120)
          const jobId = `extjob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const res = await call('xmedia.publish.start', { input: raw, path, jobId })
          if (res && res.error) throw new Error(res.error.message ?? JSON.stringify(res.error))
          slot = { live: true, path, label: path, owned: true, jobId, viewers: res.viewers }
          extMsg(`已接入 ${path} · 转推中`, false)
        } else {
          // No scheme: an already published MediaMTX path (e.g. pulled source
          // created in 「推流状态」). Just watch it; never stop a foreign job.
          const path = raw.replace(/^\/+/, '').slice(0, 120)
          if (path === '') throw new Error('路径名无效')
          slot = { live: true, path, label: path, owned: false }
          extMsg(`已加入已有路径 ${path}`, false)
        }
      } catch (e) {
        extMsg(`接入失败：${String(e?.message ?? e).slice(0, 160)}`, true)
        btn.disabled = false
        return
      }
      btn.disabled = false
      $id('sy-ext-url').value = ''
      $id('sy-ext-path').value = ''
      assign(free, slot)
      // Adding a live cell means "show me the picture" even if the wall was idle.
      if (!playing) {
        playing = true
        $id('sy-toggle').textContent = '暂停'
        $id('sy-toggle').classList.remove('primary')
      }
      reflow()
      startClock()
    })

    // 录制面板「加入同步」/ 总线注入：放到第一个空格；满了回到 0（墙替换不增长）。
    ctx.on('xmedia:sync-add', ({ slot }) => {
      const free = firstFreeSlot(slots, layout)
      assign(free >= 0 ? free : 0, slot)
    })

    // 「清空全部录像」后录像链都指向已删除的段——清掉它们，但实时格与录像无关，
    // 不应被连带移除（用户只是清了录像，不是停了外部直播）。
    ctx.on('xmedia:recordings-cleared', () => {
      playing = false
      stopClock()
      for (let i = 0; i < SYNC_MAX_SLOTS; i++) {
        if (slots[i] !== null && slots[i].live !== true) slots[i] = null
        detachCell(i)
      }
      renderGrid()
      reflow()
    })

    renderGrid()
    reflow()
  },
}
