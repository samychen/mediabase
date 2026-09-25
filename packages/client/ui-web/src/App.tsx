// @mediabase/ui-web / App.tsx — the SHELL (capability-agnostic).
//
// Renders chrome (title) plus every panel registered into ctx.ui, grouped by
// area: `header` inline in the title row, `sidebar` in the left column,
// `monitor` in the right area. Nothing here knows about media, python, workflow,
// or even the connection: adding a UI capability = registering a panel from its
// own package, no shell edits. Composing no capability packages yields an empty
// but working shell.
//
// Panels are read reactively (usePanels), so a plugin that registers into
// ctx.ui AFTER this shell mounted — runtime-loaded UI packages, ctx.plugins
// reload — shows up without a page refresh.

import { Component, Fragment, createElement, useCallback, useRef, useSyncExternalStore } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PanelArea, UiPanel, UiService } from '@mediabase/ui'
import { useI18n } from '@mediabase/i18n'



const EMPTY: readonly UiPanel[] = []

/**
 * Reactive view of one panel area. useSyncExternalStore requires a snapshot that
 * is referentially stable between changes, so the list is cached by
 * `area:revision` rather than rebuilt on every render.
 */
function usePanels(ui: UiService | undefined, area: PanelArea): readonly UiPanel[] {
  const cache = useRef<{ key: string; panels: readonly UiPanel[] }>({ key: '', panels: EMPTY })
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => ui?.subscribe(onChange) ?? (() => {}),
    [ui],
  )
  const getSnapshot = useCallback((): readonly UiPanel[] => {
    if (!ui) return EMPTY
    const key = `${area}:${ui.revision()}`
    if (cache.current.key !== key) cache.current = { key, panels: ui.list(area) }
    return cache.current.panels
  }, [ui, area])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Contains a broken panel. A UI capability is third-party code: if one throws
 * or hands back an unexpected payload, the rest of the shell (and every other
 * capability's UI) must keep working instead of white-screening the app.
 */
class PanelBoundary extends Component<{ label: string; children: ReactNode; t?: (key: string, params?: Record<string, string | number>) => string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui-web] 面板 "${this.props.label}" 渲染失败:`, error.message, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error) {
      const text = this.props.t !== undefined
        ? this.props.t('shell.panelError', { panel: this.props.label, message: this.state.error.message })
        : `panel "${this.props.label}" failed: ${this.state.error.message}`
      return <div className="status" style={{ color: 'var(--danger, #f85149)' }}>{text}</div>
    }
    return this.props.children
  }
}

function renderPanel(panel: UiPanel, ctx: Context, title: boolean, t: (key: string, params?: Record<string, string | number>) => string): ReactNode {
  const heading = panel.titleKey !== undefined ? t(panel.titleKey) : panel.title
  return (
    <section key={panel.id} style={{ width: '100%' }}>
      {title && heading !== '' && <div className="sub" style={{ marginTop: 12 }}>{heading}</div>}
      <PanelBoundary label={panel.id} t={t}>{createElement(panel.component, { ctx })}</PanelBoundary>
    </section>
  )
}

export function App({ ctx, title = 'Mediabase' }: { ctx: Context; title?: string }): JSX.Element {
  const ui = ctx.get('ui')
  // Translating the shell is a subscription: switching locale re-renders every
  // registered panel (they read the same store through useI18n).
  const { t } = useI18n(ctx)
  const header = usePanels(ui, 'header')
  const sidebar = usePanels(ui, 'sidebar')
  const monitor = usePanels(ui, 'monitor')
  const right = usePanels(ui, 'right')
  const bottom = usePanels(ui, 'bottom')

  // The grid grows only when a product fills the optional areas: right adds a
  // column, bottom a full-width row. With neither registered the layout is
  // byte-for-byte the classic two-pane shell.
  const columns = `360px 1fr${right.length > 0 ? ' 340px' : ''}`
  const rows = bottom.length > 0 ? '1fr auto' : '1fr'

  return (
    <div className="app" style={{ gridTemplateColumns: columns, gridTemplateRows: rows }}>
      <div className="panel">
        <h1>
          {title}
          {header.map((panel) => (
            <Fragment key={panel.id}>
              <PanelBoundary label={panel.id} t={t}>{createElement(panel.component, { ctx })}</PanelBoundary>
            </Fragment>
          ))}
        </h1>
        <div className="sub">{t('shell.subtitle')}</div>

        {sidebar.length === 0 && (
          <div className="status">{t('shell.empty')}</div>
        )}
        {sidebar.map((panel) => renderPanel(panel, ctx, true, t))}
      </div>

      <div className="panel monitor">
        {monitor.map((panel) => renderPanel(panel, ctx, true, t))}
      </div>

      {right.length > 0 && (
        <div className="panel pane-right">
          {right.map((panel) => renderPanel(panel, ctx, true, t))}
        </div>
      )}

      {bottom.length > 0 && (
        <div className="panel pane-bottom" style={{ gridColumn: '1 / -1' }}>
          {bottom.map((panel) => renderPanel(panel, ctx, true, t))}
        </div>
      )}
    </div>
  )
}
