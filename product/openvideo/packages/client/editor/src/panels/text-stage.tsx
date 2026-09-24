// TextOnStage — one text element (overlay or caption) drawn on the stage.
//
// Derived from clawnify/OpenVideo src/client/edit.tsx `TextOnStage` (MIT),
// with the Tailwind classes replaced by the product's own: the line breaking
// is the shared `wrapLines`/`lineStep`/`fitTop` logic, so the stage, the
// canvas export and the captions all agree on where every line sits.

import type { ReactElement } from 'react'
import { blockHeight, fitTop, lineStep, wrapLines } from '@openvideo/edl'

const DEFAULT_TEXT_COLOR = '#ffffff'

export interface StageText {
  text: string
  fontSize: number
  fontFamily?: 'sans' | 'serif' | 'mono'
  color?: string
  background?: string
  opacity?: number
  align?: 'left' | 'center' | 'right'
  x: number
  y: number
}

export function TextOnStage({
  element: textEl,
  frame,
  scale,
  selected = false,
  onPointerDown,
}: {
  element: StageText
  frame: { width: number; height: number }
  scale: number
  selected?: boolean
  /** Absent for captions, which are placed by the project's style, not dragged. */
  onPointerDown?: () => void
}): ReactElement {
  const family = textEl.fontFamily ?? 'sans'
  const lines = wrapLines(textEl.text, textEl.fontSize, frame.width, family)
  const step = lineStep(textEl.fontSize, textEl.background !== undefined) / frame.height
  const top = fitTop(
    textEl.y,
    blockHeight(textEl.text, textEl.fontSize, frame.width, family, textEl.background !== undefined),
    frame.height,
  )
  const cssFamily = family === 'serif' ? 'serif' : family === 'mono' ? 'monospace' : 'ui-sans-serif, system-ui, sans-serif'
  return (
    <>
      {lines.map((line, n) =>
        line.trim() === '' ? null : (
          <div
            key={n}
            onPointerDown={onPointerDown}
            className={onPointerDown !== undefined
              ? (selected ? 'ov-text ov-text-selected' : 'ov-text ov-text-grab')
              : 'ov-text'}
            style={{
              left: `${textEl.x * 100}%`,
              top: `${(top + n * step) * 100}%`,
              transform: textEl.align === 'center' ? 'translateX(-50%)' : textEl.align === 'right' ? 'translateX(-100%)' : undefined,
              fontSize: textEl.fontSize * scale,
              fontFamily: cssFamily,
              color: textEl.color ?? DEFAULT_TEXT_COLOR,
              background: textEl.background,
              padding: textEl.background !== undefined ? `${0.3 * textEl.fontSize * scale}px ${0.45 * textEl.fontSize * scale}px` : undefined,
              opacity: textEl.opacity ?? 1,
              textAlign: textEl.align ?? 'left',
            }}
          >
            {line}
          </div>
        ),
      )}
    </>
  )
}
