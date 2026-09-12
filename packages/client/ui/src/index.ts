// @mediabase/ui — client plugin: UI panel registry (route-C foundation) + the
// contracts sibling panels coordinate through.
//
// UI capability packages register {area, title, order, component} into ctx.ui;
// the shell (ui-web) renders whatever is registered — the UI analogue of the
// host tool registry. Adding a UI capability = registering a panel, no shell
// edit. This package is deliberately React-free and capability-free: it owns the
// registry (and the shared panel-state contract), never a capability itself.

import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** UI panel registry (client side). */
    ui: UiService
    /**
     * Shared panel state (current media file/size/duration). The contract lives
     * here so panels from different packages can coordinate without importing
     * each other's package; the value is PROVIDED by the capability package that
     * produces it (ui-media) — read it with ctx.get('view') and tolerate
     * undefined when that capability is not composed.
     */
    view: ViewState
  }
}

/** Where the shell renders a panel: title row · left column · right area. */
export type PanelArea = 'header' | 'sidebar' | 'monitor'

export interface UiPanel {
  id: string
  /** Fallback text; use `titleKey` to make the title translatable at render time. */
  title: string
  /** Translation key resolved through ctx.i18n (falls back to `title`). */
  titleKey?: string
  area: PanelArea
  /** Lower renders first; registration order breaks ties. */
  order?: number
  component: (props: { ctx: Context }) => ReactElement
}

/** Shared panel state; see the `view` augmentation above. */
export interface ViewState {
  file: string
  w: number
  h: number
  duration: number
}

export interface UiService {
  /** Register a panel; the returned disposer unregisters it. Ids must be unique. */
  register(panel: UiPanel): () => void
  /** Panels of one area, ordered. The array is a fresh copy — cache it outside React. */
  list(area: PanelArea): UiPanel[]
  /** Bumps on every register/unregister — the cache key for reactive consumers. */
  revision(): number
  /**
   * Observe registry changes. Lets the shell re-render panels registered AFTER
   * it mounted (a UI plugin loaded at runtime, ctx.plugins reload, …) instead of
   * only those present at composition time.
   */
  subscribe(listener: () => void): () => void
}

// Form generation from a method's JSON Schema (see form.tsx): a capability gets a
// usable UI for its API without writing one.
export {
  SchemaForm,
  fieldsFromSchema,
  initialValues,
  valuesFromFields,
} from './form.tsx'
export type { FieldError, FieldKind, FormField, JsonSchemaLike, SchemaFormProps } from './form.tsx'

/** Plugin name (stable identity). */
export const name = 'ui'

export function apply(ctx: Context): void {
  const panels = new Map<string, UiPanel & { seq: number }>()
  const listeners = new Set<() => void>()
  let seq = 0
  let revision = 0

  function changed(): void {
    revision++
    // Copy first: a listener may unregister itself (React cleanup) mid-notify.
    for (const listener of [...listeners]) listener()
  }

  const ui: UiService = {
    register(panel: UiPanel): () => void {
      if (panels.has(panel.id)) throw new Error(`ui: 面板 id 重复 "${panel.id}"`)
      panels.set(panel.id, { ...panel, seq: seq++ })
      changed()
      return () => {
        if (!panels.delete(panel.id)) return
        changed()
      }
    },
    list(area: PanelArea): UiPanel[] {
      return [...panels.values()]
        .filter((p) => p.area === area)
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.seq - b.seq)
        .map(({ seq: _seq, ...p }) => p) // strip internal seq
    },
    revision(): number {
      return revision
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  ctx.reflect.provide('ui', ui)
  ctx.effect(() => () => {
    // Announce the teardown before dropping subscribers: a consumer still
    // mounted (runtime reload of this plugin) must re-render to the empty state
    // instead of keeping the panels of a dead registry.
    panels.clear()
    changed()
    listeners.clear()
  }, `${name}: panels`)
}
