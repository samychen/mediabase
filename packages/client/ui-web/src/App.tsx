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
// reload — shows up without a page refresh. The panel mechanics themselves
// (boundary, renderer, area reads) live in ./shell-parts.tsx, shared with
// product shells that keep the mechanics but restyle the chrome.

import { Fragment, createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createShellParts, usePanels } from './shell-parts.tsx'
import { useI18n } from '@mediabase/i18n'

// This shell's look: the error line carries the danger color inline, panel
// sections stretch, headings are the `sub` class pushed off the section above.
const { PanelBoundary, renderPanel } = createShellParts({
  errorKey: 'shell.panelError',
  errorClass: 'status',
  errorStyle: { color: 'var(--danger, #f85149)' },
  logTag: '[ui-web]',
  sectionStyle: { width: '100%' },
  headingClass: 'sub',
  headingStyle: { marginTop: 12 },
})

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
        {sidebar.map((panel) => renderPanel(panel, ctx, t))}
      </div>

      <div className="panel monitor">
        {monitor.map((panel) => renderPanel(panel, ctx, t))}
      </div>

      {right.length > 0 && (
        <div className="panel pane-right">
          {right.map((panel) => renderPanel(panel, ctx, t))}
        </div>
      )}

      {bottom.length > 0 && (
        <div className="panel pane-bottom" style={{ gridColumn: '1 / -1' }}>
          {bottom.map((panel) => renderPanel(panel, ctx, t))}
        </div>
      )}
    </div>
  )
}
