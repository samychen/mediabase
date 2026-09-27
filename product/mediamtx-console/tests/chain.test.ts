// The recording CHAIN (M3 cross-window playback): clicking a window plays it
// plus every window after it, and the player advances on 'ended' instead of
// demanding another click. These tests pin the store half of that contract —
// the playlist shape, the advance rule (and its stop at the end), and the
// snapshot immutability the panels' useSyncExternalStore relies on.

import { describe, expect, it } from 'vitest'
import type { PlaybackEntry } from '../packages/protocol/src/index.ts'
import { createConsoleStore } from '../packages/client/console/src/store.ts'

const win = (startIso: string, seconds: number): PlaybackEntry => ({
  startIso,
  durationSeconds: seconds,
  url: `http://127.0.0.1:9996/get?start=${encodeURIComponent(startIso)}`,
})

const W1 = win('2026-09-26T10:00:00Z', 60)
const W2 = win('2026-09-26T10:01:00Z', 60)
const W3 = win('2026-09-26T10:02:00Z', 60)

/** The store needs an rpc object; the chain half never calls it. */
function offlineStore() {
  return createConsoleStore({
    call: async (): Promise<never> => { throw new Error('offline') },
  } as never)
}

describe('the recording chain on the player stage', () => {
  it('puts the playlist on the stage and clears any live selection', () => {
    const store = offlineStore()
    store.select('cam1')
    store.playRecording([W1, W2, W3], 0, 'cam1 · chain')
    const rec = store.get().recording
    expect(rec).not.toBeNull()
    expect(rec?.playlist).toHaveLength(3)
    expect(rec?.index).toBe(0)
    expect(rec?.label).toBe('cam1 · chain')
    expect(store.get().selected).toBeNull()
  })

  it('clamps a start index into the playlist and refuses an empty one', () => {
    const store = offlineStore()
    store.playRecording([W1, W2], 7, 'x')
    expect(store.get().recording?.index).toBe(1)
    store.playRecording([W1, W2], -3, 'x')
    expect(store.get().recording?.index).toBe(0)
    store.stopRecording()
    store.playRecording([], 0, 'x')
    expect(store.get().recording).toBeNull()
  })

  it('advances window by window and CLEARS the stage past the last one', () => {
    const store = offlineStore()
    store.playRecording([W1, W2, W3], 0, 'x')
    store.advanceRecording()
    expect(store.get().recording?.index).toBe(1)
    store.advanceRecording()
    expect(store.get().recording?.index).toBe(2)
    store.advanceRecording()
    // No silent looping: an ended chain frees the stage (and the fetch loop).
    expect(store.get().recording).toBeNull()
    // ...and advancing with nothing playing is a no-op, not a crash.
    store.advanceRecording()
    expect(store.get().recording).toBeNull()
  })

  it('replaces the snapshot immutably — the panel sees a NEW recording object', () => {
    const store = offlineStore()
    store.playRecording([W1, W2], 0, 'x')
    const before = store.get().recording
    store.advanceRecording()
    const after = store.get().recording
    expect(after).not.toBe(before)
    expect(before?.index).toBe(0) // the old snapshot still says what it said
    expect(after?.index).toBe(1)
    expect(after?.playlist).toBe(before?.playlist) // the windows themselves are shared, not copied
  })

  it('stops the whole chain on stopRecording', () => {
    const store = offlineStore()
    store.playRecording([W1, W2, W3], 1, 'x')
    store.stopRecording()
    expect(store.get().recording).toBeNull()
  })

  it('seekRecording jumps windows with a NEW object, clamped, and no-ops in place', () => {
    const store = offlineStore()
    store.playRecording([W1, W2, W3], 0, 'x')
    const before = store.get().recording
    store.seekRecording(2)
    const after = store.get().recording
    expect(after?.index).toBe(2)
    expect(after).not.toBe(before)
    expect(after?.playlist).toBe(before?.playlist)

    // Clamped both ways; fractional indexes truncate.
    store.seekRecording(99)
    expect(store.get().recording?.index).toBe(2)
    store.seekRecording(-4)
    expect(store.get().recording?.index).toBe(0)
    store.seekRecording(1.7)
    expect(store.get().recording?.index).toBe(1)

    // Same window: the panel seeks inside it — the snapshot must NOT churn.
    const same = store.get().recording
    store.seekRecording(1)
    expect(store.get().recording).toBe(same)

    // No chain, no crash.
    store.stopRecording()
    store.seekRecording(3)
    expect(store.get().recording).toBeNull()
  })
})
