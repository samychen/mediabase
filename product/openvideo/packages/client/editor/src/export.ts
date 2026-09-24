// The browser-side export: the local replacement for the upstream app's
// managed edit service. The cut plays through ONE more time — the same master
// clock the preview runs — while a canvas compositor draws every frame and a
// MediaRecorder captures canvas + mixed audio.
//
// Honest limits, by design (the base ships no encoder and the product adds no
// native engine): the render is REAL TIME and preview-fidelity — draft-grade
// output (webm, or mp4 where the browser muxes it), not a frame-exact offline
// render. What it guarantees is the document: what you see on the stage is
// what the recorder watches.

import {
  activeAudio,
  activeOverlays,
  activeSegment,
  blockHeight,
  captionText,
  captionTimeline,
  fitTop,
  lineStep,
  mainSegments,
  totalDuration,
  wrapLines,
  type Cue,
  type Edl,
  type MainSegment,
  type OverlayElement,
} from '@openvideo/edl'

export interface ExportOptions {
  edl: Edl
  /** Resolve an EDL src ("asset:<id>", https, data) to a URL the browser can load. */
  resolveSrc: (src: string) => string | null
  /** Source lengths in seconds, keyed by src (the same lookup the preview uses). */
  durations: Record<string, number>
  /** Transcript cues per src, for the project's captions. */
  cuesBySrc: Map<string, Cue[]>
  onProgress: (fraction: number) => void
}

export interface ExportResult {
  blob: Blob
  /** File extension matching the chosen container ("mp4" or "webm"). */
  ext: string
  seconds: number
}

/** Containers tried in order; the first the browser can record wins. */
const MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E032,mp4a.40.2"',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

export function exportSupported(): boolean {
  return typeof MediaRecorder !== 'undefined'
    && typeof document !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
}

export class ExportError extends Error {}

/** Draw one video/image frame into the destination rect, contain or cover. */
function drawMedia(
  g: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  fit: 'contain' | 'cover',
): void {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return
  const scale = fit === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh)
  const cw = sw * scale
  const ch = sh * scale
  // Center inside the destination rect; cover crops the overflow.
  g.drawImage(source, dx + (dw - cw) / 2, dy + (dh - ch) / 2, cw, ch)
}

/** Draw one text element (overlay or caption) exactly the way the stage does. */
function drawText(
  g: CanvasRenderingContext2D,
  el: { text: string; fontSize: number; fontFamily?: string; color?: string; background?: string; align?: string; opacity?: number; x: number; y: number },
  frame: { width: number; height: number },
): void {
  const fam: 'sans' | 'serif' | 'mono' = el.fontFamily === 'serif' ? 'serif' : el.fontFamily === 'mono' ? 'mono' : 'sans'
  const cssFamily = fam === 'serif' ? 'serif' : fam === 'mono' ? 'monospace' : 'sans-serif'
  const boxed = el.background !== undefined
  const lines = wrapLines(el.text, el.fontSize, frame.width, fam)
  const step = lineStep(el.fontSize, boxed)
  const top = fitTop(el.y, blockHeight(el.text, el.fontSize, frame.width, fam, boxed), frame.height)
  const anchorX = el.x * frame.width
  g.save()
  g.globalAlpha = el.opacity ?? 1
  g.font = `${el.fontSize}px ${cssFamily}`
  g.textAlign = el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left'
  g.textBaseline = 'top'
  lines.forEach((line, n) => {
    if (line.trim() === '') return
    const ly = top * frame.height + n * step
    if (boxed && el.background !== undefined) {
      const w = g.measureText(line).width
      const padX = 0.45 * el.fontSize
      const padY = 0.3 * el.fontSize
      const bx = el.align === 'center' ? anchorX - w / 2 - padX : el.align === 'right' ? anchorX - w - padX : anchorX - padX
      g.fillStyle = el.background
      g.fillRect(bx, ly - padY, w + padX * 2, el.fontSize + padY * 2)
    }
    g.fillStyle = el.color ?? '#ffffff'
    g.fillText(line, anchorX, ly)
  })
  g.restore()
}

export async function exportProject(opts: ExportOptions): Promise<ExportResult> {
  const { edl, resolveSrc, durations, cuesBySrc, onProgress } = opts
  if (!exportSupported()) throw new ExportError('export.unsupported')

  const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
  if (mime === undefined) throw new ExportError('export.noMime')

  const srcDur = (src: string): number | undefined => durations[src]
  const segments = mainSegments(edl, srcDur)
  const total = totalDuration(segments)
  if (total <= 0) throw new ExportError('export.empty')

  const frame = { width: edl.output.width, height: edl.output.height }
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const g = canvas.getContext('2d')
  if (g === null) throw new ExportError('export.noCanvas')

  // ---- media elements + the audio graph ------------------------------------
  const videos = new Map<string, HTMLVideoElement>()
  const images = new Map<string, HTMLImageElement>()
  const audios = new Map<string, HTMLAudioElement>()
  const AudioCtor: typeof AudioContext | undefined = typeof AudioContext !== 'undefined'
    ? AudioContext
    : undefined
  const audio = AudioCtor !== undefined ? new AudioCtor() : null
  const dest = audio?.createMediaStreamDestination() ?? null
  const gains = new Map<string, GainNode>()

  const gainFor = (key: string): GainNode | null => {
    if (audio === null || dest === null) return null
    let gain = gains.get(key)
    if (gain === undefined) {
      gain = audio.createGain()
      gain.connect(dest)
      gains.set(key, gain)
    }
    return gain
  }

  const collectSrcs = (): void => {
    const seen = new Set<string>()
    const want = (src: string, kind: 'video' | 'image' | 'audio'): void => {
      if (seen.has(`${kind}:${src}`)) return
      seen.add(`${kind}:${src}`)
      const url = resolveSrc(src)
      if (url === null) return
      if (kind === 'video') {
        const el = document.createElement('video')
        el.src = url
        el.preload = 'auto'
        el.playsInline = true
        el.crossOrigin = 'anonymous'
        videos.set(src, el)
        // Audio: tap the element into the graph (this silences the speakers —
        // the recorder is the only listener).
        if (audio !== null) {
          const source = audio.createMediaElementSource(el)
          const gain = gainFor(`v:${src}`)
          if (gain !== null) source.connect(gain)
        }
      } else if (kind === 'image') {
        const el = new Image()
        el.crossOrigin = 'anonymous'
        el.src = url
        images.set(src, el)
      } else {
        const el = document.createElement('audio')
        el.src = url
        el.preload = 'auto'
        el.crossOrigin = 'anonymous'
        audios.set(src, el)
        if (audio !== null) {
          const source = audio.createMediaElementSource(el)
          const gain = gainFor(`a:${src}`)
          if (gain !== null) source.connect(gain)
        }
      }
    }
    for (const seg of segments) want(seg.el.src, seg.el.type === 'image' ? 'image' : 'video')
    for (const track of edl.overlays ?? []) {
      for (const el of track.elements) {
        if (el.type === 'text') continue
        want(el.src, el.type === 'image' ? 'image' : 'video')
      }
    }
    for (const track of edl.audio ?? []) {
      for (const el of track.elements) want(el.src, 'audio')
    }
  }
  collectSrcs()

  const waitReady = async (): Promise<void> => {
    const first = segments[0]
    const waits: Promise<void>[] = []
    for (const img of images.values()) {
      waits.push(new Promise((resolve) => {
        if (img.complete) return resolve()
        img.onload = () => resolve()
        img.onerror = () => resolve()
      }))
    }
    if (first !== undefined && first.el.type === 'video') {
      const v = videos.get(first.el.src)
      if (v !== undefined) {
        waits.push(new Promise((resolve) => {
          if (v.readyState >= 2) return resolve()
          v.oncanplay = () => resolve()
          v.onerror = () => resolve()
        }))
      }
    }
    await Promise.all(waits)
  }
  await waitReady()

  /**
   * Fail LOUDLY before recording: a source this browser cannot decode used to
   * produce a silently black export (drawMedia skips frames while the element
   * is starved, and a black video compresses to almost nothing). Every main /
   * overlay / audio source must reach decodable state first.
   */
  const preflight = async (): Promise<string[]> => {
    const bad: string[] = []
    const settle = (el: HTMLVideoElement | HTMLAudioElement | HTMLImageElement): Promise<void> =>
      new Promise((resolve) => {
        const ok = el instanceof HTMLImageElement
          ? el.complete && el.naturalWidth > 0
          : el.readyState >= 2
        if (ok) return resolve()
        const timer = setTimeout(resolve, 6000)
        const done = (): void => { clearTimeout(timer); resolve() }
        el.addEventListener('loadeddata', done, { once: true })
        el.addEventListener('load', done, { once: true })
        el.addEventListener('error', done, { once: true })
      })
    await Promise.all([
      ...[...videos.entries()].map(async ([srcKey, v]) => {
        await settle(v)
        if (v.readyState < 2 || v.videoWidth === 0) bad.push(srcKey)
      }),
      ...[...images.entries()].map(async ([srcKey, img]) => {
        await settle(img)
        if (!(img.complete && img.naturalWidth > 0)) bad.push(srcKey)
      }),
      ...[...audios.entries()].map(async ([srcKey, a]) => {
        await settle(a)
        if (a.readyState < 2) bad.push(srcKey)
      }),
    ])
    return bad
  }
  const undecodable = await preflight()
  if (undecodable.length > 0) {
    for (const v of videos.values()) { v.pause(); v.removeAttribute('src') }
    for (const a of audios.values()) { a.pause(); a.removeAttribute('src') }
    if (audio !== null) void audio.close()
    throw new ExportError(`export.undecodable:${undecodable.join(',')}`)
  }
  if (audio !== null && audio.state === 'suspended') await audio.resume()

  // ---- captions, computed once (the same layout the preview shows) ----------
  const captionStyle = edl.captions?.style
  const captionLinesAll = edl.captions?.enabled === true && captionStyle !== undefined
    ? captionTimeline(
      segments.filter((s) => s.el.type === 'video').map((s) => ({
        src: s.el.src,
        start: s.start,
        dur: s.dur,
        trimStart: s.el.trimStart ?? 0,
      })),
      cuesBySrc,
      captionStyle.maxChars,
    ).map((line, i) => captionText(line, captionStyle, frame, `cap-${i}`))
    : []

  // ---- record ---------------------------------------------------------------
  const stream = canvas.captureStream(edl.output.fps)
  if (dest !== null) {
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track)
  }
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  const chunks: BlobPart[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  const cleanup = (): void => {
    for (const v of videos.values()) {
      v.pause()
      v.removeAttribute('src')
    }
    for (const a of audios.values()) {
      a.pause()
      a.removeAttribute('src')
    }
    if (audio !== null) void audio.close()
  }

  recorder.start(1000)
  const wallStart = performance.now()
  let clockOffset = 0

  const syncElement = (
    el: HTMLVideoElement | HTMLAudioElement,
    wanted: number,
    active: boolean,
    playing: boolean,
  ): void => {
    if (active) {
      if (Math.abs(el.currentTime - wanted) > 0.35 && !el.seeking) el.currentTime = wanted
      if (playing && el.paused) el.play().catch(() => {})
      if (!playing && !el.paused) el.pause()
    } else if (!el.paused) {
      el.pause()
    }
  }

  await new Promise<void>((resolve, reject) => {
    const tick = (): void => {
      try {
        const wall = (performance.now() - wallStart) / 1000
        const seg = activeSegment(segments, wall)
        // The playing main video is the clock when it can be (drift-corrected),
        // the wall clock carries it otherwise (images, stalls, the tail).
        let t = wall + clockOffset
        if (seg !== undefined && seg.el.type === 'video') {
          const v = videos.get(seg.el.src)
          if (v !== undefined && !v.paused && v.readyState >= 2) {
            const mediaT = seg.start + (v.currentTime - (seg.el.trimStart ?? 0))
            if (Math.abs(mediaT - t) > 0.25) {
              clockOffset += mediaT - t
              t = mediaT
            }
          }
        }
        if (t >= total) t = total

        // ---- draw the frame
        g.fillStyle = edl.output.background ?? '#000000'
        g.fillRect(0, 0, frame.width, frame.height)

        if (seg !== undefined && seg.dur > 0 && t >= seg.start && t < seg.start + seg.dur) {
          const wanted = (seg.el.type === 'video' ? seg.el.trimStart ?? 0 : 0) + (t - seg.start)
          if (seg.el.type === 'video') {
            const v = videos.get(seg.el.src)
            if (v !== undefined) {
              syncElement(v, wanted, true, true)
              const gain = gainFor(`v:${seg.el.src}`)
              if (gain !== null) {
                gain.gain.value = seg.el.sourceAudio === false ? 0 : Math.min(2, seg.el.volume ?? 1)
              }
              if (v.readyState >= 2) drawMedia(g, v, v.videoWidth, v.videoHeight, 0, 0, frame.width, frame.height, seg.el.fit ?? 'contain')
            }
          } else {
            const img = images.get(seg.el.src)
            if (img !== undefined && img.complete) drawMedia(g, img, img.naturalWidth, img.naturalHeight, 0, 0, frame.width, frame.height, seg.el.fit ?? 'contain')
          }
        }

        // Main-track audio only sounds from its own segment; mute everything else.
        for (const [src, v] of videos) {
          const isActive = seg !== undefined && seg.el.type === 'video' && seg.el.src === src && t >= seg.start && t < seg.start + seg.dur
          if (!isActive) {
            if (!v.paused) v.pause()
            const gain = gainFor(`v:${src}`)
            if (gain !== null) gain.gain.value = 0
          }
        }

        // ---- overlays (tracks composite in order; later = on top)
        for (const el of activeOverlays(edl, t)) {
          drawOverlay(el, t)
        }

        // ---- audio bed
        for (const el of activeAudio(edl, t)) {
          const a = audios.get(el.src)
          if (a === undefined) continue
          const wanted = (el.trimStart ?? 0) + (t - el.startTime)
          syncElement(a, wanted, true, true)
          const gain = gainFor(`a:${el.src}`)
          if (gain !== null) gain.gain.value = Math.min(2, el.volume ?? 1)
        }
        for (const [src, a] of audios) {
          const sounding = activeAudio(edl, t).some((el) => el.src === src)
          if (!sounding && !a.paused) a.pause()
        }

        // ---- captions
        for (const line of captionLinesAll) {
          if (t >= line.startTime && t < line.startTime + line.duration) drawText(g, line, frame)
        }

        onProgress(Math.min(1, t / total))
        if (t >= total) {
          // Let the last frames flush before stopping the recorder.
          setTimeout(() => {
            for (const v of videos.values()) v.pause()
            for (const a of audios.values()) a.pause()
            recorder.stop()
            resolve()
          }, 250)
          return
        }
        requestAnimationFrame(tick)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }

    const drawOverlay = (el: OverlayElement, t: number): void => {
      if (el.type === 'text') {
        drawText(g, el, frame)
        return
      }
      const dw = el.width * frame.width
      const dx = el.x * frame.width
      const dy = el.y * frame.height
      g.save()
      g.globalAlpha = el.opacity ?? 1
      if (el.type === 'video') {
        const v = videos.get(el.src)
        if (v !== undefined) {
          const wanted = (el.trimStart ?? 0) + (t - el.startTime)
          syncElement(v, wanted, true, true)
          // Overlay video plays muted in the local export: its words would
          // fight the cut's own audio bed, and the document has no per-overlay
          // audio fields to say otherwise.
          const gain = gainFor(`v:${el.src}`)
          if (gain !== null) gain.gain.value = 0
          if (v.readyState >= 2 && v.videoWidth > 0) {
            const dh = (dw * v.videoHeight) / v.videoWidth
            g.drawImage(v, dx, dy, dw, dh)
          }
        }
      } else {
        const img = images.get(el.src)
        if (img !== undefined && img.complete && img.naturalWidth > 0) {
          const dh = (dw * img.naturalHeight) / img.naturalWidth
          g.drawImage(img, dx, dy, dw, dh)
        }
      }
      g.restore()
    }

    requestAnimationFrame(tick)
  }).finally(cleanup)

  await stopped
  const blob = new Blob(chunks, { type: mime })
  return { blob, ext: mime.includes('mp4') ? 'mp4' : 'webm', seconds: total }
}

/** The main-track segments an export would walk (the UI shows the length up front). */
export function exportSegments(edl: Edl, durations: Record<string, number>): MainSegment[] {
  return mainSegments(edl, (src) => durations[src])
}
