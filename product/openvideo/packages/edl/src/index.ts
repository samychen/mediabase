// @openvideo/edl — the project document: format, validation, checked
// operations, and the pure timeline logic the preview, the panels and the
// export all share. No DOM, no Node APIs: one package, both typecheck planes.

export {
  MAX_ELEMENTS,
  MAX_OUTPUT_SECONDS,
  MAX_SOURCES,
  MAX_TEXT_CHARS,
  MAX_TRACKS,
  collectAssetIds,
  starterEdl,
  substituteAssetSrcs,
  validateEdl,
} from './edl.ts'
export type {
  AudioElement,
  AudioTrack,
  CaptionStyle as EdlCaptionStyle,
  Edl,
  EdlInvalid,
  Fit,
  MainElement,
  MainImageClip,
  MainVideoClip,
  OutputSettings,
  OverlayElement,
  OverlayMediaElement,
  OverlayTextElement,
  OverlayTrack,
  ProjectCaptions as EdlCaptions,
} from './edl.ts'

export { splitClip } from './split.ts'
export type { SplittableClip } from './split.ts'

export {
  DEFAULT_CAPTIONS,
  DEFAULT_CAPTION_STYLE,
  captionText,
  captionTimeline,
} from './captions.ts'
export type {
  CaptionLine,
  CaptionStyle,
  CaptionText,
  PlacedClip,
  ProjectCaptions,
} from './captions.ts'

export { captionChunks, parseVtt } from './transcript.ts'
export type { CaptionChunk, Cue, CueWindow } from './transcript.ts'

export { blockHeight, fitTop, lineStep, wrapLines } from './textLayout.ts'
export type { FontFamily } from './textLayout.ts'

export {
  activeAudio,
  activeOverlays,
  activeSegment,
  fmtTime,
  mainDur,
  mainSegments,
  totalDuration,
} from './timeline.ts'
export type { MainSegment, SourceDuration } from './timeline.ts'

export { OPS, OP_NAMES, SHAPES, applyOp, describeEdl, opArgs, rid } from './ops.ts'
export type { OpDef, OpName } from './ops.ts'
