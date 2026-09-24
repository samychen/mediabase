// The checked operation set: every transform an agent (or a timeline button)
// may apply. Ported expectations from clawnify/OpenVideo's instruct flow
// (MIT), extended with the local assembly ops (add_clip / add_audio).
// The invariant under test: an op either says what it did, or refuses with a
// reason — and the result always passes validateEdl.

import { describe, expect, it } from 'vitest'
import { applyOp, starterEdl, validateEdl, type Edl } from '../packages/edl/src/index.ts'

const cut = (): Edl => {
  const doc = starterEdl()
  doc.main.elements.push(
    { id: 'a', type: 'video', src: 'asset:aaaaaaaaaaaaaaaa', duration: 10 },
    { id: 'b', type: 'video', src: 'asset:bbbbbbbbbbbbbbbb' },
  )
  return doc
}

const said = (doc: Edl, op: string, args: Record<string, unknown>): string => {
  const out = applyOp(doc, op, args)
  expect('error' in out, JSON.stringify(out)).toBe(false)
  // Every operation's result must still be a valid document.
  expect('edl' in validateEdl(doc)).toBe(true)
  return 'said' in out ? out.said : ''
}

const refused = (doc: Edl, op: string, args: Record<string, unknown>): string => {
  const out = applyOp(doc, op, args)
  expect('said' in out).toBe(false)
  return 'error' in out ? out.error : ''
}

describe('applyOp: main track', () => {
  it('add_clip appends by default and inserts at a position', () => {
    const doc = cut()
    said(doc, 'add_clip', { src: 'asset:cccccccccccccccc' })
    expect(doc.main.elements).toHaveLength(3)
    said(doc, 'add_clip', { src: 'cccccccccccccccc', at: 0, kind: 'image', duration: 2 })
    expect(doc.main.elements[0]).toMatchObject({ type: 'image', src: 'asset:cccccccccccccccc', duration: 2 })
  })

  it('trim_clip sets the play window and the head', () => {
    const doc = cut()
    said(doc, 'trim_clip', { clip: 0, start: 2, seconds: 5 })
    expect(doc.main.elements[0]).toMatchObject({ trimStart: 2, duration: 5 })
  })

  it('trim_clip refuses a window shorter than the minimum', () => {
    expect(refused(cut(), 'trim_clip', { clip: 0, seconds: 0.01 })).toContain('0.05')
  })

  it('split_clip cuts in two and keeps the whole length', () => {
    const doc = cut()
    said(doc, 'split_clip', { clip: 0, at: 4 })
    expect(doc.main.elements).toHaveLength(3)
    expect(doc.main.elements[0]).toMatchObject({ duration: 4 })
    expect(doc.main.elements[1]).toMatchObject({ trimStart: 4, duration: 6 })
  })

  it('split_clip refuses a point outside the clip', () => {
    expect(refused(cut(), 'split_clip', { clip: 0, at: 0 })).toContain('inside')
    expect(refused(cut(), 'split_clip', { clip: 0, at: 10 })).toContain('inside')
  })

  it('delete_clip and move_clip reorder the sequence', () => {
    const doc = cut()
    said(doc, 'move_clip', { clip: 1, to: 0 })
    expect(doc.main.elements.map((e) => e.id)).toEqual(['b', 'a'])
    said(doc, 'delete_clip', { clip: 0 })
    expect(doc.main.elements.map((e) => e.id)).toEqual(['a'])
    expect(refused(doc, 'delete_clip', { clip: 5 })).toContain('no clip')
  })

  it('set_clip_audio mutes and sets volume, video clips only', () => {
    const doc = cut()
    said(doc, 'set_clip_audio', { clip: 0, muted: true, volume: 0.5 })
    expect(doc.main.elements[0]).toMatchObject({ sourceAudio: false, volume: 0.5 })
    doc.main.elements.push({ id: 'img', type: 'image', src: 'asset:cccccccccccccccc', duration: 2 })
    expect(refused(doc, 'set_clip_audio', { clip: 2, muted: true })).toContain('video')
  })
})

describe('applyOp: overlays, audio, shape', () => {
  it('add_text creates the first overlay track and appends', () => {
    const doc = cut()
    said(doc, 'add_text', { text: 'hello', start: 1, seconds: 2 })
    const el = doc.overlays?.[0]?.elements[0]
    expect(el).toMatchObject({ type: 'text', text: 'hello', startTime: 1, duration: 2, x: 0.5, y: 0.85 })
    expect(refused(doc, 'add_text', { text: '  ', start: 0, seconds: 1 })).toContain('empty')
  })

  it('remove_text takes one element out by track and index', () => {
    const doc = cut()
    said(doc, 'add_text', { text: 'one', start: 0, seconds: 1 })
    said(doc, 'remove_text', { track: 0, index: 0 })
    expect(doc.overlays?.[0]?.elements).toHaveLength(0)
    expect(refused(doc, 'remove_text', { track: 3, index: 0 })).toContain('no text')
  })

  it('add_audio / remove_audio manage the music bed', () => {
    const doc = cut()
    said(doc, 'add_audio', { src: 'asset:dddddddddddddddd', start: 2, volume: 0.3 })
    expect(doc.audio?.[0]?.elements[0]).toMatchObject({ type: 'audio', startTime: 2, volume: 0.3 })
    said(doc, 'remove_audio', { track: 0, index: 0 })
    expect(doc.audio?.[0]?.elements).toHaveLength(0)
  })

  it('set_captions switches the project setting', () => {
    const doc = cut()
    said(doc, 'set_captions', { enabled: true, lang: 'zh' })
    expect(doc.captions).toMatchObject({ enabled: true, lang: 'zh' })
    said(doc, 'set_captions', { enabled: false })
    expect(doc.captions?.enabled).toBe(false)
  })

  it('set_aspect changes the canvas shape', () => {
    const doc = cut()
    said(doc, 'set_aspect', { shape: 'vertical' })
    expect(doc.output).toMatchObject({ width: 720, height: 1280 })
    expect(refused(doc, 'set_aspect', { shape: 'round' })).toContain('landscape')
  })

  it('refuses an unknown operation', () => {
    expect(refused(cut(), 're-render everything', {})).toContain('no such operation')
  })
})
