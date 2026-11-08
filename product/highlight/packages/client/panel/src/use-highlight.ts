// The store seam every panel reads through: one hook, one snapshot contract.

import { useCallback, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { EMPTY_STATE, type HighlightState, type HighlightStore } from './store.ts'

export function useHighlight(ctx: Context): { store: HighlightStore; state: HighlightState } | null {
  const store = ctx.get('highlightEditor') as HighlightStore | undefined
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => store?.subscribe(onChange) ?? ((): void => {}),
    [store],
  )
  // One fallback constant, imported from the store: a second hand-written copy
  // drifts the moment a field is added (it already did once).
  const getSnapshot = useCallback((): HighlightState => store?.get() ?? EMPTY_STATE, [store])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (store === undefined) return null
  return { store, state }
}
