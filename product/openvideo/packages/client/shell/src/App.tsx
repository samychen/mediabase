// @openvideo/ui-shell / App.tsx — the product's own shell.
//
// Layout derived from clawnify/OpenVideo src/client/edit.tsx (MIT): projects
// as the HOME SCREEN (cards, cover = the first clip's frame), and the classic
// four-region editor grid — left rail (media), center player, right context
// inspector, full-width timeline below. Panels are still read reactively from
// ctx.ui by AREA (the registry contract from @mediabase/ui), so the shell
// names no capability: compose a panel into `sidebar`/`monitor`/`right`/
// `bottom` and it appears in the matching pane.

import { Component, createElement, useCallback, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PanelArea, UiPanel, UiService } from '@mediabase/ui'
import { useI18n } from '@mediabase/i18n'
import { IconChevronLeft, IconFilm, IconPlus, IconTrash } from '@openvideo/ui-editor'
import type { EditorState, EditorStore } from '@openvideo/ui-editor'
import './styles.css'

const EMPTY: readonly UiPanel[] = []

/** Reactive view of one panel area (same snapshot discipline as the base shell). */
function usePanels(ui: UiService | undefined, area: PanelArea): readonly UiPanel[] {
  const cache = useRef<{ key: string; panels: readonly UiPanel[] }>({ key: '', panels: EMPTY })
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => ui?.subscribe(onChange) ?? ((): void => {}),
    [ui],
  )
  const getSnapshot = useCallback((): readonly UiPanel[] => {
    if (!ui) return EMPTY
    const key = `${area}:${ui.revision()}`
    if (cache.current.key !== key) cache.current = { key, panels: ui.list(area) }
    return cache.current.panels
  }, [ui, area, cache])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Contains a broken panel: one throwing capability must not white-screen the app. */
class PanelBoundary extends Component<
  { label: string; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui-shell] 面板 "${this.props.label}" 渲染失败:`, error.message, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="status ov-error">
          {this.props.t('ov.shell.panelError', { panel: this.props.label, message: this.state.error.message })}
        </div>
      )
    }
    return this.props.children
  }
}

type TFunc = (key: string, params?: Record<string, string | number>) => string

function renderPanel(panel: UiPanel, ctx: Context, t: TFunc): ReactNode {
  const heading = panel.titleKey !== undefined ? t(panel.titleKey) : panel.title
  return (
    <section key={panel.id} className="ovs-section">
      {heading !== '' && <div className="ovs-pane-title">{heading}</div>}
      <PanelBoundary label={panel.id} t={t}>{createElement(panel.component, { ctx })}</PanelBoundary>
    </section>
  )
}

// ---- home screen: projects as cards ----------------------------------------

function Home({ ctx, store, state, title }: { ctx: Context; store: EditorStore; state: EditorState; title: string }): ReactElement {
  const { t } = useI18n(ctx)
  const [name, setName] = useState('')
  const [armed, setArmed] = useState<string | null>(null)
  const header = usePanels(ctx.get('ui'), 'header')

  const create = (): void => {
    const trimmed = name.trim()
    if (trimmed === '') return
    void store.createProject(trimmed)
    setName('')
  }

  return (
    <div className="ovs-home">
      <div className="ovs-topbar">
        <span className="ovs-brand">{title}</span>
        <span className="ovs-topbar-panels">
          {header.map((panel) => (
            <PanelBoundary key={panel.id} label={panel.id} t={t}>
              {createElement(panel.component, { ctx })}
            </PanelBoundary>
          ))}
        </span>
      </div>
      <div className="ovs-home-body">
        <p className="ovs-tagline">{t('ov.shell.tagline')}</p>
        <div className="ovs-newrow">
          <input
            type="text"
            value={name}
            aria-label={t('ov.shell.newProject')}
            placeholder={t('ov.shell.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
          />
          <button onClick={create} disabled={name.trim() === ''}>
            <IconPlus size={13} />{t('ov.shell.create')}
          </button>
        </div>

        {state.projects.length === 0 && (
          <div className="ovs-empty">
            <div className="ovs-empty-icon"><IconFilm size={28} /></div>
            <div className="ovs-empty-title">{t('ov.shell.emptyTitle')}</div>
            <p className="ovs-empty-body">{t('ov.shell.emptyBody')}</p>
          </div>
        )}

        <div className="ovs-cards">
          {state.projects.map((p) => (
            <div key={p.id} className="ovs-card">
              <button className="ovs-cover" onClick={() => void store.openProject(p.id)} title={t('ov.shell.open')}>
                {p.coverAsset !== null ? (
                  <video
                    className="ovs-cover-media"
                    src={`${store.assetUrl(p.coverAsset)}#t=${Math.max(0, p.coverAt ?? 0)}`}
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <span className="ovs-cover-empty"><IconFilm size={22} /></span>
                )}
              </button>
              <div className="ovs-card-meta">
                <button className="ovs-card-name" onClick={() => void store.openProject(p.id)}>{p.name}</button>
                <span className="ovs-card-sub">{t('ov.shell.updated', { date: p.updatedAt.slice(0, 10) })}</span>
                <button
                  className="ovs-card-delete"
                  title={armed === p.id ? t('ov.shell.deleteConfirm', { name: p.name }) : t('ov.shell.delete')}
                  onClick={() => {
                    if (armed === p.id) {
                      setArmed(null)
                      void store.removeProject(p.id)
                    } else {
                      setArmed(p.id)
                      setTimeout(() => setArmed((cur) => (cur === p.id ? null : cur)), 3000)
                    }
                  }}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---- editor: the four-region grid -------------------------------------------

function Editor({ ctx, store, state, title }: { ctx: Context; store: EditorStore; state: EditorState; title: string }): ReactElement {
  const { t } = useI18n(ctx)
  const ui = ctx.get('ui')
  const header = usePanels(ui, 'header')
  const sidebar = usePanels(ui, 'sidebar')
  const monitor = usePanels(ui, 'monitor')
  const right = usePanels(ui, 'right')
  const bottom = usePanels(ui, 'bottom')

  return (
    <div className="ovs-editor">
      <div className="ovs-topbar">
        <button className="ovs-back" onClick={() => store.closeProject()} title={title}>
          <IconChevronLeft size={13} />{t('ov.shell.back')}
        </button>
        <span className="ovs-project-name">{state.projectName}</span>
        <span className="ovs-topbar-panels">
          {header.map((panel) => (
            <PanelBoundary key={panel.id} label={panel.id} t={t}>
              {createElement(panel.component, { ctx })}
            </PanelBoundary>
          ))}
        </span>
      </div>
      <div className="ovs-grid">
        <div className="ovs-pane ovs-left">
          {sidebar.map((panel) => renderPanel(panel, ctx, t))}
        </div>
        <div className="ovs-pane ovs-center">
          {monitor.map((panel) => renderPanel(panel, ctx, t))}
        </div>
        <div className="ovs-pane ovs-right">
          {right.map((panel) => renderPanel(panel, ctx, t))}
        </div>
        <div className="ovs-pane ovs-bottom">
          {bottom.map((panel) => renderPanel(panel, ctx, t))}
        </div>
      </div>
    </div>
  )
}

export function Shell({ ctx, title }: { ctx: Context; title: string }): ReactElement {
  const { t } = useI18n(ctx)
  const store = ctx.get('openvideoEditor') as EditorStore | undefined
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => store?.subscribe(onChange) ?? ((): void => {}),
    [store],
  )
  const getSnapshot = useCallback((): EditorState | null => store?.get() ?? null, [store])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (store === undefined || state === null) {
    return <div className="ovs-missing">{t('ov.shell.missingEditor')}</div>
  }
  return state.openId === null
    ? <Home ctx={ctx} store={store} state={state} title={title} />
    : <Editor ctx={ctx} store={store} state={state} title={title} />
}
