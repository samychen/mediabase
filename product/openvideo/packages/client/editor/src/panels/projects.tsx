// Projects panel (sidebar): the home screen of the editor — create, open,
// delete. A project is a plain-JSON EDL document on the host; opening one
// loads it into the shared draft every other panel edits.

import { useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useEditor } from '../use-editor.ts'
import { IconPlus, IconTrash } from '../icons.tsx'

export function ProjectsPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useEditor(ctx)
  const { t } = useI18n(ctx)
  const [name, setName] = useState('')
  // Two-step delete: the first click arms, the second confirms (no modal).
  const [armed, setArmed] = useState<string | null>(null)
  if (editor === null) return null
  const { store, state } = editor

  const create = (): void => {
    const trimmed = name.trim()
    if (trimmed === '') return
    void store.createProject(trimmed)
    setName('')
  }

  return (
    <div className="ov-projects">
      <div className="ov-row">
        <input
          type="text"
          value={name}
          placeholder={t('ov.projects.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
          }}
        />
        <button onClick={create} disabled={name.trim() === ''}><IconPlus size={13} />{t('ov.projects.create')}</button>
      </div>
      {state.projects.length === 0 && <div className="status">{t('ov.projects.empty')}</div>}
      <ul className="ov-list">
        {state.projects.map((p) => (
          <li key={p.id} className={p.id === state.openId ? 'ov-item ov-item-open' : 'ov-item'}>
            <button className="ov-item-main" onClick={() => void store.openProject(p.id)}>
              <span className="ov-item-name">{p.name}</span>
              <span className="ov-item-sub">{t('ov.projects.updated', { date: p.updatedAt.slice(0, 10) })}</span>
            </button>
            {p.id === state.openId && <span className="ov-badge">{t('ov.projects.current')}</span>}
            <button
              className="ov-item-danger"
              title={armed === p.id ? t('ov.projects.removeConfirm', { name: p.name }) : t('ov.projects.remove')}
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
          </li>
        ))}
      </ul>
    </div>
  )
}
