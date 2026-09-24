// @openvideo/edl — the EDL (edit decision list), the document behind a project.
//
// Derived from clawnify/OpenVideo src/server/edl.ts (MIT); ported from zod to
// the repo's one schema dialect (@mediabase/schema / schemastery) and extended
// with the strictness the dialect does not enforce itself:
//
//   - unknown keys are REFUSED with a JSON pointer (schemastery objects are
//     open; the original rejected them with `.strict()`, and refusing typos is
//     what makes an agent's edit loop self-correcting),
//   - main/overlay elements are validated per discriminated branch, so an
//     error path points at the exact element and field.
//
// Shape: one main track (clips laid end-to-end in array order — the sequence
// IS the order), overlay tracks that composite on top (startTime-positioned),
// and audio tracks that mix under the cut. Times are plain seconds; positions
// and sizes are fractions of the canvas.

import { z } from '@mediabase/schema'

export const MAX_ELEMENTS = 100
export const MAX_SOURCES = 20
export const MAX_OUTPUT_SECONDS = 300 // 5 minutes
export const MAX_TEXT_CHARS = 500
export const MAX_TRACKS = 10

// ---- document types (the wire/result shape; validation lives below) --------

export interface OutputSettings {
  width: number
  height: number
  fps: 24 | 30 | 60
  background?: string
}

export type Fit = 'contain' | 'cover'

export interface MainVideoClip {
  id: string
  type: 'video'
  /** "asset:<id>", "file:stage/…", "https://…" or a data: URI. */
  src: string
  trimStart?: number
  trimEnd?: number
  /** Play window: N seconds from trimStart; wins over trimEnd. */
  duration?: number
  sourceAudio?: boolean
  volume?: number
  fit?: Fit
}

export interface MainImageClip {
  id: string
  type: 'image'
  src: string
  /** Images have no intrinsic length on a timeline. */
  duration: number
  trimStart?: number
  trimEnd?: number
  fit?: Fit
}

export type MainElement = MainVideoClip | MainImageClip

export interface OverlayMediaElement {
  id: string
  type: 'video' | 'image'
  src: string
  startTime: number
  duration: number
  x: number
  y: number
  /** Fraction of canvas width; height keeps the source aspect. */
  width: number
  opacity?: number
  trimStart?: number
  trimEnd?: number
}

export interface OverlayTextElement {
  id: string
  type: 'text'
  text: string
  startTime: number
  duration: number
  x: number
  y: number
  fontSize: number
  fontFamily?: 'sans' | 'serif' | 'mono'
  color?: string
  background?: string
  align?: 'left' | 'center' | 'right'
  opacity?: number
}

export type OverlayElement = OverlayMediaElement | OverlayTextElement

export interface OverlayTrack {
  id: string
  hidden?: boolean
  elements: OverlayElement[]
}

export interface AudioElement {
  id: string
  type: 'audio'
  src: string
  startTime: number
  duration?: number
  volume?: number
  trimStart?: number
  trimEnd?: number
}

export interface AudioTrack {
  id: string
  muted?: boolean
  elements: AudioElement[]
}

export interface CaptionStyle {
  /** Font size as a share of the frame's height. */
  size: number
  position: 'bottom' | 'top'
  /** Distance from that edge, as a share of the frame's height. */
  margin: number
  background: boolean
  color: string
  maxChars: number
}

export interface ProjectCaptions {
  enabled: boolean
  lang: string
  style: CaptionStyle
}

export interface Edl {
  version: 1
  output: OutputSettings
  main: { elements: MainElement[] }
  overlays?: OverlayTrack[]
  audio?: AudioTrack[]
  captions?: ProjectCaptions
}

export interface EdlInvalid {
  error: 'edl_invalid'
  detail: string
  /** JSON pointer into the document, e.g. "/main/elements/3/trimStart". */
  path?: string
}

// ---- leaf schemas ----------------------------------------------------------

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
/** Library asset, staged file, public URL, or inline data URI. */
const SRC = /^(asset:.+|file:stage\/.+|https:\/\/.+|data:.+)/

const idS = z.string().min(1).max(120).required()
const secondsS = z.number().min(0)
const playSecondsS = z.number().min(0.05).max(MAX_OUTPUT_SECONDS)
const fracS = z.number().min(0).max(1)
const volumeS = z.number().min(0).max(2)
const hexS = z.string().pattern(HEX_COLOR)
const srcS = z.string().pattern(SRC).required()
const fitS = z.union([z.const('contain'), z.const('cover')])

const outputS = z.object({
  width: z.natural().min(16).max(3840).required(),
  height: z.natural().min(16).max(2160).required(),
  fps: z.union([z.const(24), z.const(30), z.const(60)]).required(),
  background: hexS,
})

const mainVideoS = z.object({
  id: idS,
  type: z.const('video').required(),
  src: srcS,
  trimStart: secondsS,
  trimEnd: secondsS,
  duration: playSecondsS,
  sourceAudio: z.boolean(),
  volume: volumeS,
  fit: fitS,
})

const mainImageS = z.object({
  id: idS,
  type: z.const('image').required(),
  src: srcS,
  duration: playSecondsS.required(),
  trimStart: secondsS,
  trimEnd: secondsS,
  fit: fitS,
})

const overlayMediaS = z.object({
  id: idS,
  type: z.union([z.const('video'), z.const('image')]).required(),
  src: srcS,
  startTime: secondsS.required(),
  duration: playSecondsS.required(),
  x: fracS.required(),
  y: fracS.required(),
  width: z.number().min(0.01).max(1).required(),
  opacity: fracS,
  trimStart: secondsS,
  trimEnd: secondsS,
})

const overlayTextS = z.object({
  id: idS,
  type: z.const('text').required(),
  text: z.string().min(1).max(MAX_TEXT_CHARS).required(),
  startTime: secondsS.required(),
  duration: playSecondsS.required(),
  x: fracS.required(),
  y: fracS.required(),
  fontSize: z.natural().min(8).max(400).required(),
  fontFamily: z.union([z.const('sans'), z.const('serif'), z.const('mono')]),
  color: hexS,
  background: hexS,
  align: z.union([z.const('left'), z.const('center'), z.const('right')]),
  opacity: fracS,
})

const audioElementS = z.object({
  id: idS,
  type: z.const('audio').required(),
  src: srcS,
  startTime: secondsS.required(),
  duration: playSecondsS,
  volume: volumeS,
  trimStart: secondsS,
  trimEnd: secondsS,
})

const captionsS = z.object({
  enabled: z.boolean().required(),
  lang: z.string().pattern(/^[a-z]{2}(-[A-Z]{2})?$/).required(),
  style: z.object({
    size: z.number().min(0.02).max(0.2).required(),
    position: z.union([z.const('bottom'), z.const('top')]).required(),
    margin: z.number().min(0).max(0.5).required(),
    background: z.boolean().required(),
    color: hexS.required(),
    maxChars: z.natural().min(8).max(80).required(),
  }).required(),
})

// ---- strictness the dialect does not enforce: the unknown-key walker -------
//
// The original document format is closed (zod `.strict()`), and closing it is
// what makes `path`-carrying validation useful to an agent: a misspelled field
// must be REFUSED at its exact pointer, not silently ignored. Each node type
// states its allowed keys here; the walker reports the first offender.

const KEY_SETS = {
  root: ['version', 'output', 'main', 'overlays', 'audio', 'captions'],
  output: ['width', 'height', 'fps', 'background'],
  main: ['elements'],
  mainVideo: ['id', 'type', 'src', 'trimStart', 'trimEnd', 'duration', 'sourceAudio', 'volume', 'fit'],
  mainImage: ['id', 'type', 'src', 'duration', 'trimStart', 'trimEnd', 'fit'],
  overlayTrack: ['id', 'hidden', 'elements'],
  overlayMedia: ['id', 'type', 'src', 'startTime', 'duration', 'x', 'y', 'width', 'opacity', 'trimStart', 'trimEnd'],
  overlayText: ['id', 'type', 'text', 'startTime', 'duration', 'x', 'y', 'fontSize', 'fontFamily', 'color', 'background', 'align', 'opacity'],
  audioTrack: ['id', 'muted', 'elements'],
  audioElement: ['id', 'type', 'src', 'startTime', 'duration', 'volume', 'trimStart', 'trimEnd'],
  captions: ['enabled', 'lang', 'style'],
  captionStyle: ['size', 'position', 'margin', 'background', 'color', 'maxChars'],
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const pointer = (path: readonly (string | number)[]): string => `/${path.map(String).join('/')}`

/** First unknown key under `node` for one key set, as a JSON pointer, or null. */
function unknownKey(node: unknown, allowed: readonly string[], path: (string | number)[]): string | null {
  if (!isRecord(node)) return null
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) return pointer([...path, key])
  }
  return null
}

/** Walk the whole document, refusing unknown keys at every closed node. */
function walkStrict(doc: unknown): string | null {
  if (!isRecord(doc)) return null
  const root = unknownKey(doc, KEY_SETS.root, [])
  if (root !== null) return root
  if (doc.output !== undefined) {
    const at = unknownKey(doc.output, KEY_SETS.output, ['output'])
    if (at !== null) return at
  }
  if (doc.captions !== undefined && isRecord(doc.captions)) {
    const at = unknownKey(doc.captions, KEY_SETS.captions, ['captions'])
    if (at !== null) return at
    if (doc.captions.style !== undefined) {
      const inner = unknownKey(doc.captions.style, KEY_SETS.captionStyle, ['captions', 'style'])
      if (inner !== null) return inner
    }
  }
  if (doc.main !== undefined && isRecord(doc.main)) {
    const at = unknownKey(doc.main, KEY_SETS.main, ['main'])
    if (at !== null) return at
    const elements = doc.main.elements
    if (Array.isArray(elements)) {
      for (let i = 0; i < elements.length; i += 1) {
        const el = elements[i]
        const kind = isRecord(el) ? (el.type === 'image' ? KEY_SETS.mainImage : KEY_SETS.mainVideo) : null
        if (kind === null) continue // a non-record / unknown-type element fails in the schema pass with its own pointer
        const inner = unknownKey(el, kind, ['main', 'elements', i])
        if (inner !== null) return inner
      }
    }
  }
  for (const face of ['overlays', 'audio'] as const) {
    const tracks = doc[face]
    if (!Array.isArray(tracks)) continue
    for (let ti = 0; ti < tracks.length; ti += 1) {
      const track = tracks[ti]
      const trackKeys = face === 'overlays' ? KEY_SETS.overlayTrack : KEY_SETS.audioTrack
      const at = unknownKey(track, trackKeys, [face, ti])
      if (at !== null) return at
      if (!isRecord(track) || !Array.isArray(track.elements)) continue
      for (let ei = 0; ei < track.elements.length; ei += 1) {
        const el = track.elements[ei]
        if (!isRecord(el)) continue
        let keys: readonly string[] | null = null
        if (face === 'audio') keys = KEY_SETS.audioElement
        else if (el.type === 'text') keys = KEY_SETS.overlayText
        else keys = KEY_SETS.overlayMedia
        const inner = unknownKey(el, keys, [face, ti, 'elements', ei])
        if (inner !== null) return inner
      }
    }
  }
  return null
}

// ---- validation ------------------------------------------------------------

/** Run one schema at one pointer prefix; a failure becomes an EdlInvalid. */
function checkSection(schema: ReturnType<typeof z.object>, data: unknown, path: (string | number)[]): string | null {
  try {
    schema(data as Record<string, unknown>)
    return null
  } catch (e) {
    const err = e as { message?: string; options?: { path?: (string | number)[] } }
    const sub = Array.isArray(err.options?.path) ? err.options!.path! : []
    const detail = typeof err.message === 'string' ? err.message : String(err)
    // The dialect's message already carries its own `$.path` prefix; strip it
    // so the detail reads as one sentence beside the JSON pointer.
    return `${pointer([...path, ...sub])}\u0000${detail.replace(/^\$\.[^ ]+ /, '')}`
  }
}

function invalid(detail: string, path?: string): { invalid: EdlInvalid } {
  return {
    invalid: {
      error: 'edl_invalid',
      detail,
      ...(path !== undefined && path !== '' ? { path } : {}),
    },
  }
}

/** Decode the `at()` sentinel ("<pointer>\0<detail>") into an EdlInvalid. */
function fromAt(found: string | null): { invalid: EdlInvalid } | null {
  if (found === null) return null
  const [path, detail] = found.split('\u0000')
  return invalid(detail ?? found, path === '/' ? undefined : path)
}

/**
 * Validate a whole EDL document. Every refusal carries the JSON pointer of the
 * offending node (the contract an agent's read → transform → save loop relies
 * on), so the walker runs BEFORE the schema pass: an unknown key is a more
 * precise diagnosis than the branch-union mismatch it would also cause.
 */
export function validateEdl(input: unknown): { edl: Edl } | { invalid: EdlInvalid } {
  const strictAt = walkStrict(input)
  if (strictAt !== null) return invalid(`unknown field ${strictAt}`, strictAt)
  if (!isRecord(input)) return invalid('the document must be a JSON object')

  if (input.version !== 1) return invalid('expected version 1', '/version')

  if (input.output === undefined) return invalid('output is required', '/output')
  const outputFail = fromAt(checkSection(outputS, input.output, ['output']))
  if (outputFail !== null) return outputFail
  const output = input.output as OutputSettings
  if (output.width % 2 !== 0) return invalid('width must be even', '/output/width')
  if (output.height % 2 !== 0) return invalid('height must be even', '/output/height')

  if (!isRecord(input.main) || !Array.isArray(input.main.elements)) {
    return invalid('main.elements must be an array', '/main/elements')
  }
  const elements = input.main.elements as unknown[]
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i]
    const kind = isRecord(el) ? el.type : undefined
    const schema = kind === 'video' ? mainVideoS : kind === 'image' ? mainImageS : null
    if (schema === null) return invalid(`type must be "video" or "image"`, `/main/elements/${i}/type`)
    const fail = fromAt(checkSection(schema, el, ['main', 'elements', i]))
    if (fail !== null) return fail
  }

  if (input.overlays !== undefined) {
    if (!Array.isArray(input.overlays)) return invalid('overlays must be an array', '/overlays')
    if (input.overlays.length > MAX_TRACKS) return invalid(`too many overlay tracks (max ${MAX_TRACKS})`, '/overlays')
    for (let ti = 0; ti < input.overlays.length; ti += 1) {
      const track = input.overlays[ti]
      if (!isRecord(track) || !Array.isArray(track.elements)) {
        return invalid('elements must be an array', `/overlays/${ti}/elements`)
      }
      for (let ei = 0; ei < track.elements.length; ei += 1) {
        const el = track.elements[ei]
        const kind = isRecord(el) ? el.type : undefined
        const schema = kind === 'text' ? overlayTextS : kind === 'video' || kind === 'image' ? overlayMediaS : null
        if (schema === null) return invalid('type must be "text", "video" or "image"', `/overlays/${ti}/elements/${ei}/type`)
        const fail = fromAt(checkSection(schema, el, ['overlays', ti, 'elements', ei]))
        if (fail !== null) return fail
      }
    }
  }

  if (input.audio !== undefined) {
    if (!Array.isArray(input.audio)) return invalid('audio must be an array', '/audio')
    if (input.audio.length > MAX_TRACKS) return invalid(`too many audio tracks (max ${MAX_TRACKS})`, '/audio')
    for (let ti = 0; ti < input.audio.length; ti += 1) {
      const track = input.audio[ti]
      if (!isRecord(track) || !Array.isArray(track.elements)) {
        return invalid('elements must be an array', `/audio/${ti}/elements`)
      }
      for (let ei = 0; ei < track.elements.length; ei += 1) {
        const fail = fromAt(checkSection(audioElementS, track.elements[ei], ['audio', ti, 'elements', ei]))
        if (fail !== null) return fail
      }
    }
  }

  if (input.captions !== undefined) {
    const fail = fromAt(checkSection(captionsS, input.captions, ['captions']))
    if (fail !== null) return fail
  }

  const edl = input as unknown as Edl
  const all = allElements(edl)
  if (all.length > MAX_ELEMENTS) {
    return invalid(`too many elements: ${all.length} (max ${MAX_ELEMENTS})`)
  }
  const sources = new Set(all.map((e) => ('src' in e ? e.src : null)).filter((s): s is string => s !== null))
  if (sources.size > MAX_SOURCES) {
    return invalid(`too many distinct sources: ${sources.size} (max ${MAX_SOURCES})`)
  }
  const ids = new Set<string>()
  for (const el of all) {
    if (ids.has(el.id)) return invalid(`duplicate element id: ${el.id}`)
    ids.add(el.id)
  }
  return { edl }
}

type AnyElement = MainElement | OverlayElement | AudioElement

function allElements(edl: Edl): AnyElement[] {
  return [
    ...edl.main.elements,
    ...(edl.overlays ?? []).flatMap((t) => t.elements),
    ...(edl.audio ?? []).flatMap((t) => t.elements),
  ]
}

/** Distinct "asset:<id>" refs → the bare asset ids. */
export function collectAssetIds(edl: Edl): string[] {
  const ids = new Set<string>()
  for (const el of allElements(edl)) {
    if ('src' in el && el.src.startsWith('asset:')) ids.add(el.src.slice(6))
  }
  return [...ids]
}

/** Deep-copy the EDL with each "asset:<id>" src replaced via `resolve`. */
export function substituteAssetSrcs(edl: Edl, resolve: (assetId: string) => string): Edl {
  const out = structuredClone(edl)
  const swap = (el: MainElement | OverlayElement | AudioElement): void => {
    // Text overlays carry no src; `in` narrows to the media-bearing members.
    if ('src' in el && el.src.startsWith('asset:')) el.src = resolve(el.src.slice(6))
  }
  out.main.elements.forEach((el) => swap(el))
  ;(out.overlays ?? []).forEach((t) => t.elements.forEach((el) => swap(el)))
  ;(out.audio ?? []).forEach((t) => t.elements.forEach((el) => swap(el)))
  return out
}

/** A fresh project's document: empty 720p timeline. */
export function starterEdl(): Edl {
  return {
    version: 1,
    output: { width: 1280, height: 720, fps: 30, background: '#000000' },
    main: { elements: [] },
    overlays: [],
    audio: [],
  }
}
