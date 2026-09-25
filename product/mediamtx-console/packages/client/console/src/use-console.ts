// The store seam every panel reads through: one hook, one snapshot contract
// (same shape as openvideo's use-editor).

import { useCallback, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { EMPTY_FALLBACK, type ConsoleSnapshot, type ConsoleStore } from './store.ts'

/** The store service the console plugin provides (absent → panels render null). */
export function useConsole(ctx: Context): { store: ConsoleStore; snap: ConsoleSnapshot } | null {
  const store = ctx.get('mtxConsole') as ConsoleStore | undefined
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => store?.subscribe(onChange) ?? ((): void => {}),
    [store],
  )
  const getSnapshot = useCallback((): ConsoleSnapshot => store?.get() ?? EMPTY_FALLBACK, [store])
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (store === undefined) return null
  return { store, snap }
}
