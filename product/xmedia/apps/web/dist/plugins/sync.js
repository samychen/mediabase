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

import { MsePlayer } from './lib/mse.js'
import {
  chainSeconds,
  firstFreeSlot,
  locateInSlot,
  parseSyncPayload,
  syncRange,
  encodeSyncPayload,
  SYNC_MAX_SLOTS,
} from './lib/sync-math.js'
import { fmtClock, fmtDur } from './lib/_lib.js'

/** How far a video may drift from the master clock before it gets snapped. */
const DRIFT_S = 0.4

export default {
  id: 'sync',
  title: '同步回放',
  area: 'sidebar',
  group: '媒体面',
  order: 35,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',

  mount(el, ctx) {
    el.innerHTML = `
      <header class="view-head">
        <h1>同步回放</h1>
        <p>最多 9 条录像链放在同一条墙钟时间线上对齐播放（每格一条链，rAF 主时钟 +
          漂移吸附）。链来自「推流状态」录制面板的 ⊞ / 拖放，或总线
          <code>xmedia.sync-add</code>。<strong>单路回放请用「录像回放」</strong>，这里专用于 ≥2 路对齐。
          回放窗口无 Range：跨窗即从下一窗口首字节重新流式。</p>
      </header>

      <div class="panel">
        <div class="row" style="margin-bottom: 10px">
          <button id="sy-toggle" class="btn primary" disabled>播放</button>
          <input id="sy-scrub" type="range" step="250" min="0" max="1" disabled style="flex: 1 1 320px" aria-label="墙钟位置">
          <span id="sy-clock" class="label" style="font-family: var(--xm-mono)">—</span>
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
    const slots = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    let playing = false

    const videos = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const players = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const guards = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const attached = Array.from({ length: SYNC_MAX_SLOTS }, () => -1)
    const posEls = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    const badgeEls = Array.from({ length: SYNC_MAX_SLOTS }, () => null)
    let timeMs = 0
    const scrub = $id('sy-scrub')
    const clock = $id('sy-clock')

    const range = () => syncRange(slots, layout)

    const paintTransport = (globalMs) => {
      scrub.value = String(globalMs)
      const r = range()
      clock.textContent = r === null
        ? '—'
        : `${fmtClock(new Date(globalMs).toISOString())} / ${fmtClock(new Date(r.endMs).toISOString())}`
    }

    const detachCell = (i) => {
      players[i]?.dispose()
      players[i] = null
      guards[i]?.()
      guards[i] = null
      attached[i] = -1
      if (badgeEls[i] !== null) badgeEls[i].style.display = 'none'
    }

    /** Stream one chain window into a cell (new MsePlayer each window). */
    const attachCell = (i, slot, entryIndex) => {
      const entry = slot.entries[entryIndex]
      const video = videos[i]
      if (entry === undefined || entry.url === '' || video === null) return
      detachCell(i)
      const player = new MsePlayer(video, (state, detail) => {
        const badge = badgeEls[i]
        if (badge === null) return
        if (state === 'playing') badge.style.display = 'none'
        else {
          badge.style.display = ''
          badge.textContent = state === 'opening' ? '连接中'
            : state === 'ended' ? '停止'
            : detail === 'mse-unsupported' ? '此浏览器不支持 MSE' : (detail ?? '错误')
        }
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

    /** Apply the global clock to every visible cell. */
    const drive = (globalMs, run) => {
      for (let i = 0; i < SYNC_MAX_SLOTS; i++) {
        const video = videos[i]
        const slot = i < layout ? slots[i] : null
        if (video === null || slot === null) continue
        const pos = locateInSlot(globalMs, slot)
        const posEl = posEls[i]
        if (pos === null) {
          if (!video.paused) video.pause()
          if (posEl !== null) posEl.textContent = ''
          continue
        }
        if (posEl !== null && slot.entries.length > 1) {
          posEl.textContent = `${pos.entryIndex + 1}/${slot.entries.length}`
        }
        if (attached[i] !== pos.entryIndex) attachCell(i, slot, pos.entryIndex)
        if (pos.rel === null) {
          // A recording gap: hold, paused, until the next window starts.
          if (!video.paused) video.pause()
          continue
        }
        if (video.buffered.length > 0 && Math.abs(video.currentTime - pos.rel) > DRIFT_S) {
          const bufStart = video.buffered.start(0)
          video.currentTime = pos.rel < bufStart ? bufStart : pos.rel
        }
        if (run) {
          if (video.paused) video.play().catch(() => { /* next tick retries */ })
        } else if (!video.paused) {
          video.pause()
        }
      }
    }

    // ---- 声明态渲染（格子内容变化才重建；MSE 生命周期在 identity 变化时拆） ------
    const cellId = (slot, i) => {
      if (i >= layout || slot === null || slot.entries.length === 0) return ''
      const first = slot.entries[0]
      const last = slot.entries[slot.entries.length - 1]
      return `${slot.path}|${slot.entries.length}|${first.startIso}|${last.startIso}|${first.url}`
    }
    const identities = Array.from({ length: SYNC_MAX_SLOTS }, () => '')

    const renderGrid = () => {
      // 内容身份变化 → 拆掉该格的流（下一轮 drive 按钟重挂）。
      for (let i = 0; i < SYNC_MAX_SLOTS; i++) {
        const id = i < layout ? cellId(slots[i], i) : ''
        if (identities[i] !== id) {
          identities[i] = id
          detachCell(i)
        }
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
          label.innerHTML = `<span>${slot.path} · ${fmtClock(slot.entries[0]?.startIso ?? '')} · ${fmtDur(chainSeconds(slot))}<span></span></span><span style="color:var(--xm-faint)">✕</span>`
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
      const occupied = slots.slice(0, layout).some((s) => s !== null)
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
        scrub.disabled = true
      } else {
        timeMs = Math.min(Math.max(timeMs, r.startMs), r.endMs)
        scrub.disabled = false
        scrub.min = String(r.startMs)
        scrub.max = String(r.endMs)
      }
      paintTransport(timeMs)
      drive(timeMs, playing)
    }

    const assign = (i, slot) => {
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
      if (r === null) return
      let next = timeMs + dt
      if (next >= r.endMs) {
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
    $id('sy-clear').addEventListener('click', () => {
      playing = false
      stopClock()
      for (let i = 0; i < SYNC_MAX_SLOTS; i++) slots[i] = null
      renderGrid()
      reflow()
    })

    // 录制面板「加入同步」/ 总线注入：放到第一个空格；满了回到 0（墙替换不增长）。
    ctx.on('xmedia:sync-add', ({ slot }) => {
      const free = firstFreeSlot(slots, layout)
      assign(free >= 0 ? free : 0, slot)
    })

    renderGrid()
    reflow()
  },
}
