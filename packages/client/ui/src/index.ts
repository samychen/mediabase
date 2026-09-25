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

/**
 * Where a shell renders a panel: title row · left column · main area ·
 * right column · bottom row. The right/bottom areas are OPTIONAL: a shell
 * renders them only while they hold panels, and a composition that registers
 * nothing there looks exactly like the classic three-area layout.
 */
export type PanelArea = 'header' | 'sidebar' | 'monitor' | 'right' | 'bottom'

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
  /** Panels of one area for the shell: respects layout prefs (hidden + order). */
  list(area: PanelArea): UiPanel[]
  /**
   * All registered panels in an area (including hidden), ordered by effective
   * layout — for a layout editor that must still show unchecked panels.
   */
  listAll(area: PanelArea): UiPanel[]
  /** Current layout prefs (fresh copy). */
  getLayout(): UiLayoutPrefs
  /** Merge layout prefs; bumps revision and notifies subscribers. */
  setLayout(prefs: Partial<UiLayoutPrefs>): void
  /** Bumps on every register/unregister/layout change — cache key for reactive consumers. */
  revision(): number
  /**
   * Observe registry changes. Lets the shell re-render panels registered AFTER
   * it mounted (a UI plugin loaded at runtime, ctx.plugins reload, …) instead of
   * only those present at composition time.
   */
  subscribe(listener: () => void): () => void
}

/** Client layout prefs: which panels are hidden and optional order overrides. */
export interface UiLayoutPrefs {
  hiddenIds: string[]
  /** Lower sorts first; missing ids fall back to the panel's registered `order`. */
  orderById: Record<string, number>
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
  let layout: UiLayoutPrefs = { hiddenIds: [], orderById: {} }

  function changed(): void {
    revision++
    // Copy first: a listener may unregister itself (React cleanup) mid-notify.
    for (const listener of [...listeners]) listener()
  }

  function effectiveOrder(p: UiPanel & { seq: number }): number {
    const override = layout.orderById[p.id]
    return override !== undefined ? override : (p.order ?? 100)
  }

  function ordered(area: PanelArea): Array<UiPanel & { seq: number }> {
    return [...panels.values()]
      .filter((p) => p.area === area)
      .sort((a, b) => effectiveOrder(a) - effectiveOrder(b) || a.seq - b.seq)
  }

  function publicPanel(p: UiPanel & { seq: number }): UiPanel {
    const { seq: _seq, ...rest } = p
    return rest
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
      const hidden = new Set(layout.hiddenIds)
      return ordered(area).filter((p) => !hidden.has(p.id)).map(publicPanel)
    },
    listAll(area: PanelArea): UiPanel[] {
      return ordered(area).map(publicPanel)
    },
    getLayout(): UiLayoutPrefs {
      return {
        hiddenIds: [...layout.hiddenIds],
        orderById: { ...layout.orderById },
      }
    },
    setLayout(prefs: Partial<UiLayoutPrefs>): void {
      if (prefs.hiddenIds !== undefined) {
        layout = { ...layout, hiddenIds: [...new Set(prefs.hiddenIds)] }
      }
      if (prefs.orderById !== undefined) {
        layout = { ...layout, orderById: { ...prefs.orderById } }
      }
      changed()
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
    layout = { hiddenIds: [], orderById: {} }
    changed()
    listeners.clear()
  }, `${name}: panels`)
}
