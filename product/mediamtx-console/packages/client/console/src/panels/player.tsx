// Preview player: WHEP first (low latency, zero dependencies — MediaMTX
// serves it natively), HLS as the compatibility fallback but ONLY where the
// browser can play a playlist natively (Safari/iOS); elsewhere that toggle is
// disabled with an explanation instead of pulling in hls.js.
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
  const selected = snap?.selected ?? null
  const mode = snap?.playMode ?? 'whep'
  const webrtcBase = snap?.endpoints?.webrtc ?? null
  const hlsBase = snap?.endpoints?.hls ?? null
  const hlsOk = nativeHlsSupported()

  useEffect(() => {
    const video = videoRef.current
    if (video === null || selected === null) {
      setState('idle')
      setDetail(null)
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
  }, [selected, mode, webrtcBase, hlsBase, hlsOk])

  if (cons === null || snap === null || store === null) return null

  const stateText = state === 'connecting'
    ? t('player.connecting')
    : state === 'live'
      ? t('player.live')
      : state === 'error'
        ? detail ?? t('common.error', { detail: '?' })
        : t('player.stopped')

  return (
    <section className="mx-player">
      <header className="mx-player__bar">
        <span className="mx-player__title"><IconTv /> {selected ?? t('panel.player.title')}</span>
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
      </header>
      <div className="mx-player__stage" data-state={state}>
        {selected === null
          ? <p className="mx-dim mx-player__placeholder">{t('player.none')}</p>
          : <video ref={videoRef} controls playsInline muted />}
      </div>
      <footer className="mx-player__foot">
        <span className="mx-badge" data-state={state === 'live' ? 'ready' : state === 'error' ? 'err' : 'idle'}>
          {stateText}
        </span>
        {selected !== null && state !== 'idle' && (
          <button type="button" className="mx-btn" onClick={() => store.select(null)}>
            <IconStop /> {t('player.stop')}
          </button>
        )}
      </footer>
    </section>
  )
}
