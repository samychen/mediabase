// The stage layers: everything drawn inside the 16:9-ish frame — the active
// main clip (one persistent <video>, or an <img>), overlay media and text,
// the caption lines, the hidden audio elements, and the two honest hints
// (empty cut / undecodable media). Pure render: the clock, the sync effects
// and the element ref maps all live in the player panel; layers just consume
// them. Derived from clawnify/OpenVideo edit.tsx's stage (MIT).

import type { MutableRefObject, RefObject } from 'react'
import type { ReactElement } from 'react'
import type { AudioElement, Edl, MainSegment, OverlayElement, OverlayTextElement } from '@openvideo/edl'
import type { CaptionText } from '@openvideo/edl'
import type { Sel } from '../store.ts'
import { TextOnStage } from './text-stage.tsx'

export interface StageLayersProps {
  draft: Edl
  scale: number
  active: MainSegment | undefined
  overlays: OverlayElement[]
  sounds: AudioElement[]
  captions: CaptionText[]
  resolveSrc: (src: string) => string | null
  videoRef: RefObject<HTMLVideoElement>
  overlayVideos: MutableRefObject<Map<string, HTMLVideoElement>>
  audioEls: MutableRefObject<Map<string, HTMLAudioElement>>
  sel: Sel
  onSelectOverlay: (el: OverlayElement) => void
  /** MEDIA_ERR_ABORTED (1) is filtered by the caller: teardown, not a verdict. */
  onMediaError: (code: number, src: string) => void
  onMediaMetadata: (v: HTMLVideoElement, trimStart: number) => void
  emptyText: string
  issueText: string | null
}

/** Which overlay track holds element `id` (selection needs track+index). */
export function trackOf(draft: Edl, id: string): number {
  return (draft.overlays ?? []).findIndex((track) => track.elements.some((el) => el.id === id))
}

export function StageLayers(props: StageLayersProps): ReactElement {
  const {
    draft, scale, active, overlays, sounds, captions, resolveSrc,
    videoRef, overlayVideos, audioEls, sel, onSelectOverlay,
    onMediaError, onMediaMetadata, emptyText, issueText,
  } = props
  return (
    <>
      {active !== undefined && active.el.type === 'video' && active.dur > 0 && (
        <video
          key={active.el.src}
          ref={videoRef}
          className="ov-stage-fill"
          style={{ objectFit: active.el.fit === 'cover' ? 'cover' : 'contain' }}
          playsInline
          preload="auto"
          src={resolveSrc(active.el.src) ?? undefined}
          onError={(e) => {
            const v = e.currentTarget
            onMediaError(v.error?.code ?? 0, active.el.src)
          }}
          onLoadedMetadata={(e) => {
            onMediaMetadata(e.currentTarget, active.el.trimStart ?? 0)
          }}
        />
      )}
      {active !== undefined && active.el.type === 'image' && active.dur > 0 && (
        <img
          key={active.el.src}
          className="ov-stage-fill"
          style={{ objectFit: active.el.fit === 'cover' ? 'cover' : 'contain' }}
          src={resolveSrc(active.el.src) ?? undefined}
          alt=""
        />
      )}
      {overlays.map((el) => {
        if (el.type === 'text') {
          return (
            <TextOnStage
              key={el.id}
              element={el as OverlayTextElement}
              frame={draft.output}
              scale={scale}
              selected={sel?.kind === 'overlay' && (draft.overlays ?? [])[sel.track]?.elements[sel.index]?.id === el.id}
              onPointerDown={() => onSelectOverlay(el)}
            />
          )
        }
        const url = resolveSrc(el.src)
        const style = {
          position: 'absolute' as const,
          left: `${el.x * 100}%`,
          top: `${el.y * 100}%`,
          width: `${el.width * 100}%`,
          opacity: el.opacity ?? 1,
        }
        return el.type === 'video' ? (
          <video
            key={el.id}
            ref={(v) => {
              if (v === null) overlayVideos.current.delete(el.id)
              else overlayVideos.current.set(el.id, v)
            }}
            style={style}
            playsInline
            preload="auto"
            muted
            src={url ?? undefined}
          />
        ) : (
          <img key={el.id} style={style} src={url ?? undefined} alt="" />
        )
      })}
      {captions.map((cap) => (
        <TextOnStage key={cap.id} element={{ ...cap, fontFamily: 'sans' }} frame={draft.output} scale={scale} />
      ))}
      {sounds.map((el) => (
        <audio
          key={el.id}
          ref={(a) => {
            if (a === null) audioEls.current.delete(el.id)
            else audioEls.current.set(el.id, a)
          }}
          preload="auto"
          src={resolveSrc(el.src) ?? undefined}
        />
      ))}
      {draft.main.elements.length === 0 && (
        <div className="ov-stage-hint">{emptyText}</div>
      )}
      {issueText !== null && (
        <div className="ov-stage-hint ov-error">{issueText}</div>
      )}
    </>
  )
}
