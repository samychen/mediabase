// The store seam every panel reads through: one hook, one snapshot contract.

import { useCallback, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { EditorState, EditorStore } from './store.ts'

/** Panels render this when the editor plugin is not composed (store absent). */
const NOTHING: EditorState = {
  assets: [],
  projects: [],
  openId: null,
  projectName: '',
  projectBrief: '',
  draft: null,
  savedEdl: null,
  dirty: false,
  saving: false,
  saveError: null,
  sel: null,
  playhead: 0,
  playing: false,
  durations: {},
  ask: { busy: false, answer: null, error: null },
  decodeState: {},
  assetsBase: null,
  status: null,
  undoDepth: 0,
  redoDepth: 0,
}

/** The store service the editor plugin provides (absent → panels render null). */
export function useEditor(ctx: Context): { store: EditorStore; state: EditorState } | null {
  const store = ctx.get('openvideoEditor') as EditorStore | undefined
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => store?.subscribe(onChange) ?? ((): void => {}),
    [store],
  )
  const getSnapshot = useCallback((): EditorState => store?.get() ?? NOTHING, [store])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (store === undefined) return null
  return { store, state }
}
