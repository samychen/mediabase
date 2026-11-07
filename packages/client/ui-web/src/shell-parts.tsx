// @mediabase/ui-web / shell-parts.tsx — the shell MECHANICS, separated from
// any one shell's LOOK.
//
// A product may ship its own shell (openvideo's home screen + editor grid
// does) while keeping the same panel mechanics: the reactive area reads, the
// boundary around a broken panel, and the panel renderer. Those live here,
// parameterized by the shell's own classes and keys, so the shells cannot
// drift apart again — a fix to the snapshot discipline or the catch
// discipline lands in every shell at once. The options carry no defaults on
// purpose: a shell states its own error key, classes and log tag.

import { Component, createElement, useCallback, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ComponentType, ErrorInfo, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PanelArea, UiPanel, UiService } from '@mediabase/ui'

export type Translate = (key: string, params?: Record<string, string | number>) => string

const EMPTY: readonly UiPanel[] = []

/**
 * Reactive view of one panel area. useSyncExternalStore requires a snapshot that
 * is referentially stable between changes, so the list is cached by
 * `area:revision` rather than rebuilt on every render.
 */
export function usePanels(ui: UiService | undefined, area: PanelArea): readonly UiPanel[] {
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

export interface ShellPartsOptions {
  /** Key the boundary renders a broken panel with (the shell's own dictionary). */
  errorKey: string
  /** className for that error line. */
  errorClass: string
  /** Inline style for that error line (danger color or the CSS class's job). */
  errorStyle?: CSSProperties
  /** console.error tag when a panel throws. */
  logTag: string
  /** className of the wrapper <section> around one panel. */
  sectionClass?: string
  sectionStyle?: CSSProperties
  /** The panel heading line (rendered only when the heading is non-empty). */
  headingClass?: string
  headingStyle?: CSSProperties
}

type BoundaryProps = {
  label: string
  children: ReactNode
  t: Translate
  errorKey: string
  errorClass: string
  /** `| undefined` on purpose: the kit spreads its (possibly absent) option through. */
  errorStyle?: CSSProperties | undefined
  logTag: string
}

/**
 * Contains a broken panel. A UI capability is third-party code: if one throws
 * or hands back an unexpected payload, the rest of the shell (and every other
 * capability's UI) must keep working instead of white-screening the app.
 */
class PanelBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.logTag} 面板 "${this.props.label}" 渲染失败:`, error.message, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      const text = this.props.t(this.props.errorKey, { panel: this.props.label, message: this.state.error.message })
      return <div className={this.props.errorClass} style={this.props.errorStyle}>{text}</div>
    }
    return this.props.children
  }
}

export interface ShellParts {
  PanelBoundary: ComponentType<{ label: string; children: ReactNode; t: Translate }>
  renderPanel(panel: UiPanel, ctx: Context, t: Translate): ReactNode
}

/** Build one shell's panel parts from that shell's own classes and keys. */
export function createShellParts(options: ShellPartsOptions): ShellParts {
  const boundary: ComponentType<{ label: string; children: ReactNode; t: Translate }> = (props) => (
    <PanelBoundary
      {...props}
      errorKey={options.errorKey}
      errorClass={options.errorClass}
      errorStyle={options.errorStyle}
      logTag={options.logTag}
    />
  )
  const renderPanel = (panel: UiPanel, ctx: Context, t: Translate): ReactNode => {
    const heading = panel.titleKey !== undefined ? t(panel.titleKey) : panel.title
    return (
      <section key={panel.id} className={options.sectionClass} style={options.sectionStyle}>
        {heading !== '' && <div className={options.headingClass} style={options.headingStyle}>{heading}</div>}
        <PanelBoundary
          label={panel.id}
          t={t}
          errorKey={options.errorKey}
          errorClass={options.errorClass}
          errorStyle={options.errorStyle}
          logTag={options.logTag}
        >
          {createElement(panel.component, { ctx })}
        </PanelBoundary>
      </section>
    )
  }
  return { PanelBoundary: boundary, renderPanel }
}
