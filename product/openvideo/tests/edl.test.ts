// The EDL contract an agent's read → transform → save loop relies on:
// a valid document round-trips, and EVERY refusal names the offending node
// with a JSON pointer. Also guards the dialect port: schemastery objects are
// open, so the strictness walker is what refuses unknown fields.

import { describe, expect, it } from 'vitest'
import {
  MAX_ELEMENTS,
  collectAssetIds,
  starterEdl,
  substituteAssetSrcs,
  validateEdl,
  type Edl,
} from '../packages/edl/src/index.ts'

const validDoc = (): Edl => ({
  version: 1,
  output: { width: 1280, height: 720, fps: 30, background: '#000000' },
  main: {
    elements: [
      { id: 'intro', type: 'video', src: 'asset:3f9c2a1b8d4e6f70', trimStart: 2 },
      { id: 'screen', type: 'video', src: 'asset:9a1d4c7e2b5f8036', duration: 12, fit: 'cover', sourceAudio: false },
      { id: 'outro', type: 'image', src: 'asset:5e8b1f4a7c2d9063', duration: 3 },
    ],
  },
  overlays: [
    {
      id: 'titles',
      elements: [
        {
          id: 'hook', type: 'text', text: 'Three features.\nOne minute.', fontSize: 72,
          startTime: 0.5, duration: 3, x: 0.5, y: 0.12, align: 'center',
          color: '#ffffff', background: '#00000080',
        },
      ],
    },
  ],
  audio: [
    { id: 'music', elements: [{ id: 'bed', type: 'audio', src: 'asset:7d2a5f8c1e4b9036', startTime: 0, volume: 0.35 }] },
  ],
})

const pointerOf = (input: unknown): string | undefined => {
  const out = validateEdl(input)
  return 'invalid' in out ? out.invalid.path : undefined
}

describe('validateEdl', () => {
  it('accepts a complete document and returns it normalized', () => {
    const out = validateEdl(validDoc())
    expect('edl' in out).toBe(true)
    if ('edl' in out) expect(out.edl.main.elements).toHaveLength(3)
  })

  it('accepts the starter document (an empty main track is a valid draft)', () => {
    expect('edl' in validateEdl(starterEdl())).toBe(true)
  })

  it('refuses a wrong version at /version', () => {
    expect(pointerOf({ ...validDoc(), version: 2 })).toBe('/version')
  })

  it('refuses a bad fps inside output', () => {
    const doc = validDoc()
    doc.output.fps = 25 as unknown as 30
    expect(pointerOf(doc)).toMatch(/^\/output\/fps/)
  })

  it('refuses an odd width (encoders need even dimensions)', () => {
    const doc = validDoc()
    doc.output.width = 1281
    expect(pointerOf(doc)).toBe('/output/width')
  })

  it('refuses an unknown field with its exact pointer (the agent typo case)', () => {
    const doc = validDoc() as unknown as Record<string, unknown>
    const main = doc.main as unknown as { elements: unknown[] }
    main.elements[2] = { ...(main.elements[2] as object), durationn: 3 }
    expect(pointerOf(doc)).toBe('/main/elements/2/durationn')
  })

  it('refuses an unknown field on the root, on a track and on a text overlay', () => {
    expect(pointerOf({ ...validDoc(), edition: 1 })).toBe('/edition')
    const doc = validDoc()
    const track = doc.overlays![0] as unknown as Record<string, unknown>
    track.hiddenly = true
    expect(pointerOf(doc)).toBe('/overlays/0/hiddenly')
    const doc2 = validDoc()
    const textEl = doc2.overlays![0]!.elements[0] as unknown as Record<string, unknown>
    textEl.src = 'asset:x'
    expect(pointerOf(doc2)).toBe('/overlays/0/elements/0/src')
  })

  it('refuses a negative time at the exact element field', () => {
    const doc = validDoc()
    ;(doc.main.elements[0] as { trimStart?: number }).trimStart = -1
    expect(pointerOf(doc)).toBe('/main/elements/0/trimStart')
  })

  it('refuses an image clip without a duration', () => {
    const doc = validDoc()
    delete (doc.main.elements[2] as { duration?: number }).duration
    expect(pointerOf(doc)).toBe('/main/elements/2/duration')
  })

  it('refuses a bad src scheme', () => {
    const doc = validDoc()
    doc.main.elements[0]!.src = 'ftp://example.com/x.mp4'
    expect(pointerOf(doc)).toMatch(/^\/main\/elements\/0\/src/)
  })

  it('refuses a duplicate element id anywhere in the document', () => {
    const doc = validDoc()
    doc.audio?.[0]?.elements.push({ ...(doc.audio[0]!.elements[0] as object), id: 'intro' } as never)
    const out = validateEdl(doc)
    expect('invalid' in out && out.invalid.detail).toContain('duplicate element id')
  })

  it('refuses more than MAX_ELEMENTS elements', () => {
    const doc = starterEdl()
    for (let i = 0; i < MAX_ELEMENTS + 1; i += 1) {
      doc.main.elements.push({ id: `c${i}`, type: 'video', src: 'asset:aaaaaaaaaaaaaaaa', duration: 1 })
    }
    const out = validateEdl(doc)
    expect('invalid' in out && out.invalid.detail).toContain('too many elements')
  })
})

describe('asset helpers', () => {
  it('collects the distinct asset ids a document references', () => {
    expect(collectAssetIds(validDoc()).sort()).toEqual(
      ['3f9c2a1b8d4e6f70', '5e8b1f4a7c2d9063', '7d2a5f8c1e4b9036', '9a1d4c7e2b5f8036'].sort(),
    )
  })

  it('substitutes asset srcs without touching the original', () => {
    const doc = validDoc()
    const out = substituteAssetSrcs(doc, (id) => `file:stage/${id}.mp4`)
    expect(out.main.elements[0]!.src).toBe('file:stage/3f9c2a1b8d4e6f70.mp4')
    expect(doc.main.elements[0]!.src).toBe('asset:3f9c2a1b8d4e6f70')
    expect(out.audio?.[0]?.elements[0]?.src).toBe('file:stage/7d2a5f8c1e4b9036.mp4')
  })
})
