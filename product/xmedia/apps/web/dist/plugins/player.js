// 录像回放插件 —— 单条录像链的深度回放（MSE）：一个 <video>，整条链一条 scrubber，
// 可在任意窗口内 seek；回放 /get 无 Range，跨窗即从下一窗口首字节重新流式。
// 链来自「推流状态」录制面板经总线 `xmedia:play-chain`；多路对齐用「同步回放」。

import { MsePlayer } from './lib/mse.js'
import { chainLocate, chainOffsetMs, chainTotalMs } from './lib/chain.js'
import { fmtDur } from './lib/_lib.js'

const EMPTY_HINT = '<span style="color: var(--xm-faint)">从「推流状态」录制面板点「从此播放」放一条链上来</span>'

export default {
  id: 'player',
  title: '录像回放',
  area: 'sidebar',
  group: '媒体面',
  order: 30,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/></svg>',

  mount(el, ctx) {
    el.innerHTML = `
      <header class="view-head">
        <h1>录像回放</h1>
        <p>单条录像链的深度回放：整条链一条 scrubber，可在任意窗口内 seek；
          回放 /get 无 Range，跨窗即从下一窗口首字节重新流式。
          链从「推流状态」录制面板的「从此播放」送来；多机位对齐用「同步回放」。</p>
      </header>

      <div class="panel">
        <h2>舞台</h2>
        <div class="row" style="margin-bottom: 10px">
          <button id="pl-stop" class="btn" style="display:none">停止</button>
          <span id="pl-state" class="badge run" style="display:none"></span>
        </div>
        <div id="pl-stage" style="min-height: 160px; display: grid; place-items: center; color: var(--xm-faint); background: #000; border-radius: 10px">
          ${EMPTY_HINT}
        </div>
        <div id="pl-chainbar" style="display:none; margin-top: 10px" class="row">
          <input id="pl-scrub" type="range" min="0" max="1" step="250" style="flex: 1 1 320px" aria-label="链位置">
          <span id="pl-chaintime" class="label" style="font-family: var(--xm-mono)">—</span>
        </div>
      </div>

      <p class="label" style="margin-top: -6px">
        录制窗口由 MediaMTX playback 服务按 fMP4 提供（无 Range）——MSE 管线按窗口顺序流式，
        支持缓冲区内拖动，跨窗跳转会从目标窗口首字节重新缓冲。看实时画面请用「实时预览」。
      </p>`

    const $id = (id) => el.querySelector('#' + id)
    const stage = $id('pl-stage')
    const stateEl = $id('pl-state')

    let chain = null          // { playlist, index, label }
    let mse = null
    let pendingSeekMs = null
    let video = null

    const setState = (state, detail) => {
      stateEl.style.display = 'inline-block'
      stateEl.className = 'badge ' + (state === 'live' ? 'done' : state === 'error' ? 'fail' : 'run')
      stateEl.textContent = state === 'connecting' ? '连接中'
        : state === 'live' ? '播放中'
        : state === 'error' ? (detail ?? '错误')
        : '停止'
    }

    const teardown = () => {
      if (mse !== null) { mse.dispose(); mse = null }
      if (video !== null) {
        video.removeEventListener('progress', onProgress)
        video.removeEventListener('timeupdate', onTime)
        video.removeEventListener('playing', onPlaying)
        video.removeEventListener('error', onError)
        video.removeAttribute('src')
        video.load()
      }
    }

    // ---- MSE 录制链 -----------------------------------------------------------
    const chainEl = $id('pl-chainbar')
    const scrub = $id('pl-scrub')
    const chainTime = $id('pl-chaintime')

    const paintChain = () => {
      if (chain === null || chain.playlist.length < 2 || video === null) return
      const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0
      const total = chainTotalMs(chain.playlist)
      const posMs = Math.min(chainOffsetMs(chain.playlist, chain.index) + cur * 1000, total)
      scrub.value = String(posMs)
      chainTime.textContent = `${fmtDur(posMs / 1000)} / ${fmtDur(total / 1000)}`
    }

    const onProgress = () => {
      if (pendingSeekMs === null || video === null || video.buffered.length === 0) return
      const t = pendingSeekMs
      pendingSeekMs = null
      video.currentTime = t
    }
    const onTime = () => paintChain()
    const onPlaying = () => setState('live')
    const onError = () => {
      const err = video !== null ? video.error : null
      setState('error', err !== null ? `media error ${err.code}${err.message ? ` (${err.message})` : ''}` : 'playback error')
    }

    const startRecordingWindow = () => {
      if (chain === null) return
      const entry = chain.playlist[chain.index]
      if (entry === undefined || entry.url === '') { setState('error', '窗口无地址'); return }
      teardown()
      mse = new MsePlayer(video, (mseState, mseDetail) => {
        if (mseState === 'opening') setState('connecting')
        else if (mseState === 'playing') setState('live')
        else if (mseState === 'ended') {
          // 跨窗自动前进：末窗收尾清台，否则 index 前进并重挂载到下一窗口。
          if (chain.index < chain.playlist.length - 1) {
            chain.index += 1
            startRecordingWindow()
          } else {
            chain = null
            setState('idle')
            renderChrome()
          }
        } else setState('error', mseDetail === 'mse-unsupported' ? '此浏览器不支持 MSE' : (mseDetail ?? '回放错误'))
      })
      video.addEventListener('progress', onProgress)
      video.addEventListener('timeupdate', onTime)
      video.addEventListener('playing', onPlaying)
      video.addEventListener('error', onError)
      void mse.play(entry.url)
    }

    // ---- 舞台装配 -------------------------------------------------------------
    const renderChrome = () => {
      const recording = chain !== null
      $id('pl-stop').style.display = recording ? '' : 'none'
      chainEl.style.display = recording && chain.playlist.length > 1 ? 'flex' : 'none'
      if (recording) {
        stage.innerHTML = ''
        video = document.createElement('video')
        video.controls = true
        video.muted = true
        video.playsInline = true
        video.style.cssText = 'width:100%; aspect-ratio:16/9; background:#000; border-radius:10px'
        stage.appendChild(video)
      } else if (stage.querySelector('video') !== null) {
        stage.innerHTML = EMPTY_HINT
        video = null
      }
      if (recording && chain.playlist.length > 1) {
        scrub.max = String(Math.max(chainTotalMs(chain.playlist), 1))
        paintChain()
      }
    }

    const applyStage = () => {
      renderChrome()
      if (chain !== null) { startRecordingWindow(); return }
      setState('idle')
      stateEl.style.display = 'none'
    }

    $id('pl-stop').addEventListener('click', () => {
      teardown()
      chain = null
      setState('idle')
      renderChrome()
    })
    scrub.addEventListener('input', () => {
      if (chain === null) return
      const v = Number(scrub.value)
      if (!Number.isFinite(v)) return
      const pos = chainLocate(chain.playlist, v)
      if (pos.index !== chain.index) {
        pendingSeekMs = pos.relMs / 1000
        chain.index = pos.index
        startRecordingWindow()
      } else if (video !== null) {
        const rel = pos.relMs / 1000
        if (video.buffered.length > 0) {
          const bufStart = video.buffered.start(0)
          video.currentTime = rel < bufStart ? bufStart : rel
        } else {
          pendingSeekMs = rel
        }
      }
      chainTime.textContent = `${fmtDur(Math.min(v, chainTotalMs(chain.playlist)) / 1000)} / ${fmtDur(chainTotalMs(chain.playlist) / 1000)}`
    })

    // 录制面板的「从此播放」：一条链放到本舞台（label 已在源插件拼好）。
    ctx.on('xmedia:play-chain', ({ path, entries, index, label }) => {
      chain = { playlist: entries.filter((e) => e.url !== ''), index: index ?? 0, label: label ?? path }
      applyStage()
    })

    // 「清空全部录像」后，之前送来的链指向已被删除的段。清台，避免旧片段
    // 残留（用户切回来还能看到、点了必然播放失败）。
    ctx.on('xmedia:recordings-cleared', () => {
      teardown()
      chain = null
      setState('idle')
      renderChrome()
    })

    renderChrome()
  },
}
