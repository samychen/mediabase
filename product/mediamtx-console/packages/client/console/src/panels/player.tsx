// Preview player: WHEP first (low latency, zero dependencies — MediaMTX
// serves it natively), HLS as the compatibility fallback but ONLY where the
// browser can play a playlist natively (Safari/iOS); elsewhere that toggle is
// disabled with an explanation instead of pulling in hls.js. Recording
// windows get the same stage through MSE (mse.ts) — one <video>, three
// pipelines, mutually exclusive.
//
// The WHEP session lifecycle is one effect keyed on (selected, mode,
// endpoints): switching streams tears the old PeerConnection down before the
// new one is negotiated, and unmount closes it — no leaked sessions upstream
// (they would linger until ICE timeout).

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'
import { isWhepError, nativeHlsSupported, startWhep, type WhepHandle } from '../whep.ts'
import { MsePlayer } from '../mse.ts'
import { chainLocate, chainOffsetMs, chainTotalMs } from '../playlist.ts'
import { fmtDur } from '../format.ts'
import { IconStop, IconTv } from '../icons.tsx'

type PlayerState = 'idle' | 'connecting' | 'live' | 'error'

export function PlayerPanel({ ctx }: { ctx: Context }): ReactElement | null {
  // Hook order is sacred: everything runs unconditionally, the store-absent
  // case degrades to nulls instead of an early return before useEffect.
  const cons = useConsole(ctx)
  const { t } = useI18n(ctx)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [state, setState] = useState<PlayerState>('idle')
  const [detail, setDetail] = useState<string | null>(null)

  const store = cons?.store ?? null
  const snap = cons?.snap ?? null
  const recording = snap?.recording ?? null
  const recUrl = recording === null ? null : recording.playlist[recording.index]?.url ?? null
  const recPos = recording === null || recording.playlist.length < 2
    ? null
    : `${recording.index + 1}/${recording.playlist.length}`

  // ---- the chain transport (M4): whole-playlist scrubber under the stage ----
  //
  // Position painting rides the video's own timeupdate (no rAF, no renders);
  // a cross-window jump stores the in-window target in pendingSeekRef and
  // lets the re-attached stream apply it as soon as buffer exists — honest
  // against a Range-less /get: the window re-streams from its first byte and
  // the element holds the seek until the fetch covers it.
  const recordingRef = useRef(recording)
  useEffect(() => {
    recordingRef.current = recording
  })
  const chainScrubRef = useRef<HTMLInputElement | null>(null)
  const chainTimeRef = useRef<HTMLSpanElement | null>(null)
  const pendingSeekRef = useRef<number | null>(null)

  const paintChain = (): void => {
    const rec = recordingRef.current
    if (rec === null || rec.playlist.length < 2) return
    const video = videoRef.current
    const cur = video !== null && Number.isFinite(video.currentTime) ? video.currentTime : 0
    const total = chainTotalMs(rec.playlist)
    const posMs = Math.min(chainOffsetMs(rec.playlist, rec.index) + cur * 1000, total)
    const scrub = chainScrubRef.current
    if (scrub !== null) scrub.value = String(posMs)
    const label = chainTimeRef.current
    if (label !== null) label.textContent = `${fmtDur(posMs / 1000)} / ${fmtDur(total / 1000)}`
  }
  // A recording owns the stage: the live pipeline stands down while one plays.
  const selected = recording === null ? snap?.selected ?? null : null
  const mode = snap?.playMode ?? 'whep'
  const webrtcBase = snap?.endpoints?.webrtc ?? null
  const hlsBase = snap?.endpoints?.hls ?? null
  const hlsOk = nativeHlsSupported()

  // Recording playback (MSE ⇄ the playback server; see mse.ts). Declared
  // after the live effect would double-run cleanups in the wrong order, so
  // it lives FIRST: React runs effects top-down, live stands down before the
  // recording pipeline takes the element over. The effect is keyed on the
  // CHAIN'S CURRENT url, so `ended` advancing the index re-runs it: dispose
  // tears the finished window down and the next one starts on the same
  // element — cross-window playback without another click.
  useEffect(() => {
    const video = videoRef.current
    if (video === null || recUrl === null || store === null) return
    const player = new MsePlayer(video, (mseState, mseDetail) => {
      if (mseState === 'opening') {
        setState('connecting')
        setDetail(null)
      } else if (mseState === 'playing') {
        setState('live')
      } else if (mseState === 'ended') {
        setState('idle')
        // Last window → the store clears the stage; otherwise the snapshot
        // change re-keys this effect onto the next window.
        store.advanceRecording()
      } else {
        setState('error')
        setDetail(mseDetail === 'mse-unsupported' ? t('player.mseUnsupported') : mseDetail ?? 'playback error')
      }
    })
    const onProgress = (): void => {
      const pending = pendingSeekRef.current
      if (pending === null || video.buffered.length === 0) return
      pendingSeekRef.current = null
      video.currentTime = pending
    }
    const onTime = (): void => paintChain()
    video.addEventListener('progress', onProgress)
    video.addEventListener('timeupdate', onTime)
    void player.play(recUrl)
    return () => {
      video.removeEventListener('progress', onProgress)
      video.removeEventListener('timeupdate', onTime)
      player.dispose()
    }
    // t is stable per locale; re-running on locale change is harmless.
    // store identity is stable for the plugin's lifetime; paintChain reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recUrl, store])

  useEffect(() => {
    const video = videoRef.current
    if (video === null || selected === null) {
      // While a recording owns the stage, the recording effect drives the
      // state — standing down must not stomp it back to idle.
      if (recUrl === null) {
        setState('idle')
        setDetail(null)
      }
      return
    }
    let handle: WhepHandle | null = null
    let cancelled = false

    if (mode === 'hls') {
      if (hlsBase === null || !hlsOk) {
        setState('error')
        setDetail(hlsBase === null ? 'hls disabled' : t('player.hlsUnsupported'))
        return
      }
      setState('connecting')
      // A leftover srcObject SHADOWS the src attribute — switching from WHEP
      // (srcObject) to HLS (src) must clear it first or the element keeps the
      // dead stream.
      video.srcObject = null
      video.src = `${hlsBase}/${encodeURIComponent(selected)}/index.m3u8`
      video.load()
      const onPlaying = (): void => setState('live')
      const onError = (): void => {
        setState('error')
        // Surface the real cause: MediaError codes (2 = network, 3 = decode,
        // 4 = src not supported) — guessing cost the user a debug round.
        const err = video.error
        setDetail(err !== null ? `media error ${err.code}${err.message ? ` (${err.message})` : ''}` : 'playback error')
      }
      video.addEventListener('playing', onPlaying)
      video.addEventListener('error', onError)
      // Setting src alone never starts native HLS: without play() even a
      // perfectly healthy stream sits at "connecting" forever. The video is
      // muted, so autoplay is allowed.
      video.play().catch((e: unknown) => {
        setState('error')
        setDetail(e instanceof Error ? e.message : String(e))
      })
      return () => {
        video.removeEventListener('playing', onPlaying)
        video.removeEventListener('error', onError)
        video.removeAttribute('src')
        video.load()
      }
    }

    // WHEP mode
    if (webrtcBase === null) {
      setState('error')
      setDetail('webrtc disabled')
      return
    }
    setState('connecting')
    setDetail(null)
    void startWhep(`${webrtcBase}/${encodeURIComponent(selected)}/whep`, video)
      .then((h) => {
        if (cancelled) {
          h.close()
          return
        }
        handle = h
        setState('live')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState('error')
        setDetail(isWhepError(e) ? e.detail : e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      handle?.close()
    }
    // t is stable per locale; re-running on locale change is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, mode, webrtcBase, hlsBase, hlsOk, recUrl])

  if (cons === null || snap === null || store === null) return null

  const stateText = state === 'connecting'
    ? t('player.connecting')
    : state === 'live'
      ? t('player.live')
      : state === 'error'
        ? detail ?? t('common.error', { detail: '?' })
        : t('player.stopped')

  const chain = recording !== null && recording.playlist.length > 1 ? recording : null
  const chainTotal = chain === null ? 0 : chainTotalMs(chain.playlist)

  const onChainScrub = (e: { target: { value: string } }): void => {
    if (chain === null || store === null) return
    const v = Number(e.target.value)
    if (!Number.isFinite(v)) return
    const pos = chainLocate(chain.playlist, v)
    if (pos.index !== chain.index) {
      pendingSeekRef.current = pos.relMs / 1000
      store.seekRecording(pos.index)
    } else {
      const video = videoRef.current
      const rel = pos.relMs / 1000
      if (video !== null) {
        if (video.buffered.length > 0) {
          const bufStart = video.buffered.start(0)
          video.currentTime = rel < bufStart ? bufStart : rel
        } else {
          pendingSeekRef.current = rel
        }
      }
    }
    // Instant feedback from the requested offset; timeupdate corrects it to
    // where the media actually is once the seek lands.
    const scrub = chainScrubRef.current
    if (scrub !== null) scrub.value = String(v)
    const label = chainTimeRef.current
    if (label !== null) label.textContent = `${fmtDur(Math.min(v, chainTotal) / 1000)} / ${fmtDur(chainTotal / 1000)}`
  }

  return (
    <section className="mx-player">
      <header className="mx-player__bar">
        <span className="mx-player__title">
          <IconTv /> {recording !== null ? recording.label : selected ?? t('panel.player.title')}
          {recPos !== null && <span className="mx-badge mx-player__chain" data-state="ready">{recPos}</span>}
        </span>
        {recording === null && (
          <span className="mx-player__modes">
            <label className="mx-check mx-check--inline">
              <input
                type="radio"
                name="mx-play-mode"
                checked={mode === 'whep'}
                onChange={() => store.setPlayMode('whep')}
              />
              <span>{t('player.mode.whep')}</span>
            </label>
            <label className="mx-check mx-check--inline" title={hlsOk ? undefined : t('player.hlsUnsupported')}>
              <input
                type="radio"
                name="mx-play-mode"
                checked={mode === 'hls'}
                disabled={!hlsOk}
                onChange={() => store.setPlayMode('hls')}
              />
              <span>{t('player.mode.hls')}</span>
            </label>
          </span>
        )}
      </header>
      <div className="mx-player__stage" data-state={state}>
        {selected === null && recording === null
          ? <p className="mx-dim mx-player__placeholder">{t('player.none')}</p>
          : <video ref={videoRef} controls playsInline muted />}
      </div>
      {chain !== null && (
        <div className="mx-player__chainbar">
          <input
            ref={chainScrubRef}
            type="range"
            className="mx-player__chainscrub"
            min={0}
            max={chainTotal > 0 ? chainTotal : 1}
            step={250}
            defaultValue={0}
            aria-label={t('player.chainScrub')}
            title={t('player.chainScrub')}
            onChange={onChainScrub}
          />
          <span ref={chainTimeRef} className="mx-mono mx-dim mx-player__chaintime">—</span>
        </div>
      )}
      <footer className="mx-player__foot">
        <span className="mx-badge" data-state={state === 'live' ? 'ready' : state === 'error' ? 'err' : 'idle'}>
          {stateText}
        </span>
        {(selected !== null || recording !== null) && state !== 'idle' && (
          <button
            type="button"
            className="mx-btn"
            onClick={() => {
              if (recording !== null) store.stopRecording()
              else store.select(null)
            }}
          >
            <IconStop /> {t('player.stop')}
          </button>
        )}
      </footer>
    </section>
  )
}
