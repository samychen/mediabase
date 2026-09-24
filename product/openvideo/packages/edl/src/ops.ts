// The checked operation set: the ONLY way an agent (or the editor's buttons)
// changes a cut. The model never writes the document itself — it calls one
// operation at a time, each a pure transform over a draft EDL, and the result
// is validated as a whole before it is saved. One instruction, one undo.
//
// Derived from clawnify/OpenVideo src/server/instruct.ts (MIT): the original
// eight operations are ported as-is; `clean_up_clip` (which needed the managed
// footage-analysis service) is not, and the assembly operations an agent needs
// to BUILD a cut locally are added (`add_clip`, `add_audio`, `remove_audio`,
// `set_captions`).

import { z } from '@mediabase/schema'
import { splitClip } from './split.ts'
import { DEFAULT_CAPTIONS, type CaptionStyle } from './captions.ts'
import { MAX_TEXT_CHARS, type AudioElement, type Edl, type MainElement, type OverlayTextElement } from './edl.ts'

export const SHAPES: Record<string, { width: number; height: number }> = {
  landscape: { width: 1280, height: 720 },
  vertical: { width: 720, height: 1280 },
  square: { width: 1080, height: 1080 },
}

/** Short random id for generated elements (the document requires unique ids). */
export const rid = (): string => Math.random().toString(36).slice(2, 10)

/** Operation names the document accepts, in the order an agent should learn them. */
export const OP_NAMES = [
  'add_clip',
  'trim_clip',
  'split_clip',
  'delete_clip',
  'move_clip',
  'set_clip_audio',
  'add_text',
  'remove_text',
  'add_audio',
  'remove_audio',
  'set_captions',
  'set_aspect',
] as const

export type OpName = (typeof OP_NAMES)[number]

/** Apply one operation to a draft (mutates it). Returns what to tell the user, or an error. */
export function applyOp(draft: Edl, name: OpName | string, args: Record<string, unknown>): { said: string } | { error: string } {
  const main = draft.main.elements
  const clipAt = (n: unknown): MainElement | null => {
    const i = Number(n)
    return Number.isInteger(i) && i >= 0 && i < main.length ? (main[i] ?? null) : null
  }

  switch (name) {
    case 'add_clip': {
      const raw = String(args.src ?? '')
      if (raw === '') return { error: 'src is required (an "asset:<id>" reference)' }
      const src = raw.startsWith('asset:') || raw.startsWith('https://') || raw.startsWith('data:') ? raw : `asset:${raw}`
      const kind = args.kind === 'image' ? 'image' : 'video'
      const at = args.at === undefined ? main.length : Number(args.at)
      if (!Number.isInteger(at) || at < 0 || at > main.length) return { error: `cannot insert at ${String(args.at)}` }
      const el: MainElement = kind === 'image'
        ? {
          id: rid(),
          type: 'image',
          src,
          duration: typeof args.duration === 'number' && args.duration >= 0.05 ? args.duration : 3,
        }
        : {
          id: rid(),
          type: 'video',
          src,
          ...(typeof args.duration === 'number' && args.duration >= 0.05 ? { duration: args.duration } : {}),
        }
      main.splice(at, 0, el)
      return { said: `Added ${kind} clip ${el.id} at position ${at}` }
    }
    case 'trim_clip': {
      const clip = clipAt(args.clip)
      if (clip === null) return { error: `there is no clip ${String(args.clip)}` }
      if (typeof args.start === 'number') clip.trimStart = Math.max(0, args.start)
      if (typeof args.seconds === 'number') {
        if (args.seconds < 0.05) return { error: 'a clip has to play for at least 0.05 seconds' }
        if (clip.type === 'image') return { error: 'an image clip\'s length is its duration; set it directly' }
        clip.duration = args.seconds
      }
      const played = clip.type === 'video' ? clip.duration : clip.duration
      return { said: `Trimmed clip ${String(args.clip)} to ${played?.toFixed(1) ?? '?'}s from ${(clip.trimStart ?? 0).toFixed(1)}s` }
    }
    case 'split_clip': {
      const i = Number(args.clip)
      const clip = clipAt(i)
      const at = Number(args.at)
      if (clip === null) return { error: `there is no clip ${String(args.clip)}` }
      const halves = splitClip(clip, at, clip.type === 'video' ? clip.duration : clip.duration, rid())
      if (halves === null) return { error: 'split at a point inside the clip, after its start and before its end' }
      main.splice(i, 1, ...halves)
      return { said: `Split clip ${i} at ${at.toFixed(1)}s` }
    }
    case 'delete_clip': {
      const i = Number(args.clip)
      if (clipAt(i) === null) return { error: `there is no clip ${String(args.clip)}` }
      main.splice(i, 1)
      return { said: `Removed clip ${i}` }
    }
    case 'move_clip': {
      const from = Number(args.clip)
      const to = Number(args.to)
      if (clipAt(from) === null) return { error: `there is no clip ${String(args.clip)}` }
      if (!Number.isInteger(to) || to < 0 || to >= main.length) return { error: `cannot move to ${String(args.to)}` }
      const moved = main.splice(from, 1)[0]
      if (moved === undefined) return { error: `there is no clip ${String(args.clip)}` }
      main.splice(to, 0, moved)
      return { said: `Moved clip ${from} to position ${to}` }
    }
    case 'set_clip_audio': {
      const clip = clipAt(args.clip)
      if (clip === null) return { error: `there is no clip ${String(args.clip)}` }
      if (clip.type !== 'video') return { error: 'only a video clip carries its own sound' }
      if (typeof args.muted === 'boolean') clip.sourceAudio = !args.muted
      if (typeof args.volume === 'number') clip.volume = Math.max(0, Math.min(2, args.volume))
      return { said: args.muted === true ? `Muted clip ${String(args.clip)}` : `Set clip ${String(args.clip)} volume` }
    }
    case 'add_text': {
      const text = String(args.text ?? '').slice(0, MAX_TEXT_CHARS)
      if (text.trim() === '') return { error: 'the text is empty' }
      draft.overlays = draft.overlays ?? []
      const first = draft.overlays[0]
      if (draft.overlays.length === 0 || first === undefined) draft.overlays.push({ id: rid(), elements: [] })
      const el: OverlayTextElement = {
        id: rid(),
        type: 'text',
        text,
        startTime: Math.max(0, Number(args.start) || 0),
        duration: Math.max(0.05, Number(args.seconds) || 2),
        x: typeof args.x === 'number' ? Math.min(1, Math.max(0, args.x)) : 0.5,
        y: typeof args.y === 'number' ? Math.min(1, Math.max(0, args.y)) : 0.85,
        fontSize: typeof args.size === 'number' ? Math.round(Math.min(400, Math.max(8, args.size))) : 40,
        color: '#ffffff',
        background: '#000000a0',
        align: 'center',
      }
      draft.overlays[0]!.elements.push(el)
      return { said: `Added the text "${text.slice(0, 40)}"` }
    }
    case 'remove_text': {
      const track = draft.overlays?.[Number(args.track)]
      const index = Number(args.index)
      if (track === undefined || track.elements[index] === undefined) return { error: 'there is no text there' }
      track.elements.splice(index, 1)
      return { said: 'Removed a text element' }
    }
    case 'add_audio': {
      const raw = String(args.src ?? '')
      if (raw === '') return { error: 'src is required (an "asset:<id>" reference)' }
      const src = raw.startsWith('asset:') || raw.startsWith('https://') || raw.startsWith('data:') ? raw : `asset:${raw}`
      draft.audio = draft.audio ?? []
      const first = draft.audio[0]
      if (draft.audio.length === 0 || first === undefined) draft.audio.push({ id: rid(), elements: [] })
      // The tool vocabulary is `start`/`seconds` (like add_text); the document
      // vocabulary is `startTime`/`duration` — accept both, write the document's.
      const startRaw = args.start ?? args.startTime
      const durRaw = args.seconds ?? args.duration
      const el: AudioElement = {
        id: rid(),
        type: 'audio',
        src,
        startTime: Math.max(0, Number(startRaw) || 0),
        ...(typeof durRaw === 'number' && durRaw >= 0.05 ? { duration: durRaw } : {}),
        volume: typeof args.volume === 'number' ? Math.max(0, Math.min(2, args.volume)) : 1,
      }
      draft.audio[0]!.elements.push(el)
      return { said: `Added audio ${el.id} at ${el.startTime.toFixed(1)}s` }
    }
    case 'remove_audio': {
      const track = draft.audio?.[Number(args.track)]
      const index = Number(args.index)
      if (track === undefined || track.elements[index] === undefined) return { error: 'there is no audio there' }
      track.elements.splice(index, 1)
      return { said: 'Removed an audio element' }
    }
    case 'set_captions': {
      const enabled = args.enabled === true
      const lang = typeof args.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(args.lang) ? args.lang : (draft.captions?.lang ?? DEFAULT_CAPTIONS.lang)
      const style: CaptionStyle = draft.captions?.style ?? DEFAULT_CAPTIONS.style
      draft.captions = { enabled, lang, style }
      return { said: enabled ? `Turned captions on (${lang})` : 'Turned captions off' }
    }
    case 'set_aspect': {
      const shape = SHAPES[String(args.shape)]
      if (shape === undefined) return { error: 'shape must be landscape, vertical or square' }
      draft.output.width = shape.width
      draft.output.height = shape.height
      return { said: `Set the video to ${String(args.shape)}` }
    }
    default:
      return { error: `no such operation "${name}"` }
  }
}

// ---- the operation surface, declared ONCE ----------------------------------
//
// Each operation's arguments as an @mediabase/schema object: the host
// capability registers these as agent tools (the registry derives the LLM's
// JSON Schema from the same declaration), and `openvideo.projects.op`
// validates against them before `applyOp` runs.

const clipIndex = z.natural().description('0-based position on the main track').required()

export interface OpDef {
  name: OpName
  description: string
  params: ReturnType<typeof z.object>
}

export const OPS: readonly OpDef[] = [
  {
    name: 'add_clip',
    description: 'Put a library asset on the main track. `src` is "asset:<id>" (or the bare id); `at` is the 0-based position (default: the end). An image clip needs `duration` (seconds on screen, default 3).',
    params: z.object({
      project: z.string().description('project id').required(),
      src: z.string().description('"asset:<id>" from openvideo_assets_list').required(),
      kind: z.union([z.const('video'), z.const('image')]).description('default video'),
      at: z.natural().description('0-based insert position; default the end'),
      duration: z.number().min(0.05).description('play window in seconds (images: required)'),
    }),
  },
  {
    name: 'trim_clip',
    description: "Set where a main-track clip starts and how long it plays. `start` is seconds into the source, `seconds` is how long to play from there. Use it to cut dead air off a clip's head or tail.",
    params: z.object({
      project: z.string().description('project id').required(),
      clip: clipIndex,
      start: z.number().min(0).description('seconds into the source'),
      seconds: z.number().min(0.05).description('how long to play, in seconds'),
    }),
  },
  {
    name: 'split_clip',
    description: "Cut a main-track clip in two at a point measured in seconds from the clip's own start.",
    params: z.object({
      project: z.string().description('project id').required(),
      clip: clipIndex,
      at: z.number().min(0).description("seconds from the start of the clip as it plays now").required(),
    }),
  },
  {
    name: 'delete_clip',
    description: 'Remove a clip from the main track.',
    params: z.object({
      project: z.string().description('project id').required(),
      clip: clipIndex,
    }),
  },
  {
    name: 'move_clip',
    description: 'Move a main-track clip to another position; the sequence is the order they play in.',
    params: z.object({
      project: z.string().description('project id').required(),
      clip: clipIndex,
      to: z.natural().description('0-based destination').required(),
    }),
  },
  {
    name: 'set_clip_audio',
    description: "Mute a clip's own sound, or set its volume (1 is the source level).",
    params: z.object({
      project: z.string().description('project id').required(),
      clip: clipIndex,
      muted: z.boolean(),
      volume: z.number().min(0).max(2).description('0 to 2'),
    }),
  },
  {
    name: 'add_text',
    description: 'Put a line of text on screen. Times are seconds on the finished video, not inside a clip. Position is a fraction of the frame: x 0.5 is the middle, y 0.85 sits near the bottom.',
    params: z.object({
      project: z.string().description('project id').required(),
      text: z.string().min(1).max(MAX_TEXT_CHARS).required(),
      start: z.number().min(0).description('seconds on the output timeline').required(),
      seconds: z.number().min(0.05).description('how long the text stays').required(),
      x: z.number().min(0).max(1).description('0 to 1, default 0.5'),
      y: z.number().min(0).max(1).description('0 to 1, default 0.85'),
      size: z.natural().min(8).max(400).description('font size in pixels of the canvas, default 40'),
    }),
  },
  {
    name: 'remove_text',
    description: 'Remove an on-screen text element by its track and index in the document.',
    params: z.object({
      project: z.string().description('project id').required(),
      track: z.natural().required(),
      index: z.natural().required(),
    }),
  },
  {
    name: 'add_audio',
    description: 'Put a library audio asset on the music bed. `start` is seconds on the finished video; volume 0..2 (default 1).',
    params: z.object({
      project: z.string().description('project id').required(),
      src: z.string().description('"asset:<id>" of an audio file').required(),
      start: z.number().min(0).description('seconds on the output timeline, default 0'),
      seconds: z.number().min(0.05).description('how long to play; default the whole file'),
      volume: z.number().min(0).max(2),
    }),
  },
  {
    name: 'remove_audio',
    description: 'Remove an audio element by its track and index in the document.',
    params: z.object({
      project: z.string().description('project id').required(),
      track: z.natural().required(),
      index: z.natural().required(),
    }),
  },
  {
    name: 'set_captions',
    description: 'Turn project captions on or off. Captions need transcripts (.vtt attached to the clips); check openvideo_assets_list.',
    params: z.object({
      project: z.string().description('project id').required(),
      enabled: z.boolean().required(),
      lang: z.string().pattern(/^[a-z]{2}(-[A-Z]{2})?$/).description('transcript language, e.g. en or zh'),
    }),
  },
  {
    name: 'set_aspect',
    description: "Change the shape of the finished video: 'landscape' (16:9), 'vertical' (9:16) or 'square'.",
    params: z.object({
      project: z.string().description('project id').required(),
      shape: z.union([z.const('landscape'), z.const('vertical'), z.const('square')]).required(),
    }),
  },
]

/** The `args` slice of one operation's tool call (the `project` id stripped). */
export function opArgs(_name: OpName | string, args: Record<string, unknown>): Record<string, unknown> {
  const { project: _project, ...rest } = args
  return rest
}

/** The cut as a short list, not raw JSON — what an agent is shown as context. */
export function describeEdl(edl: Edl, names: Map<string, string>): string {
  const clips = edl.main.elements.map((el, i) => {
    const name = names.get(el.src) ?? el.src
    const from = el.trimStart ?? 0
    const playing = el.duration !== undefined ? `${el.duration.toFixed(1)}s` : 'the rest'
    const audio = el.type === 'video' && el.sourceAudio === false ? ', muted' : ''
    return `  clip ${i}: "${name}" from ${from.toFixed(1)}s, plays ${playing}${audio}`
  })
  const texts = (edl.overlays ?? []).flatMap((track, ti) =>
    track.elements.map((el, i) =>
      el.type === 'text'
        ? `  text ${ti}.${i}: "${el.text}" at ${el.startTime.toFixed(1)}s for ${el.duration.toFixed(1)}s`
        : `  overlay ${ti}.${i}: ${el.type}`,
    ),
  )
  const sounds = (edl.audio ?? []).flatMap((track, ti) =>
    track.elements.map((el, i) => `  audio ${ti}.${i}: "${names.get(el.src) ?? el.src}" at ${el.startTime.toFixed(1)}s`),
  )
  return [
    `Canvas ${edl.output.width}x${edl.output.height} at ${edl.output.fps}fps.`,
    clips.length > 0 ? `Main track, in play order:\n${clips.join('\n')}` : 'The main track is empty.',
    texts.length > 0 ? `On-screen text:\n${texts.join('\n')}` : 'No on-screen text.',
    sounds.length > 0 ? `Music/audio:\n${sounds.join('\n')}` : 'No audio bed.',
  ].join('\n')
}
