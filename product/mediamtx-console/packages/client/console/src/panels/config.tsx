// Config (bottom drawer): the server registry (M3 multi-server) and the
// flat global config (~122 keys) as a reviewable, editable form — the M3
// candidates "single server per host" and "read-only review + subset patch,
// no form UI" made real. Everything upstream reports is shown, bucketed
// by key-prefix (conf.ts): scalars become inputs, composite values stay
// read-only JSON (their honest editor is mediamtx.yml). Save sends ONLY the
// diff through mediamtx.config.global.patch and re-reads the config, because
// the server normalizes values and listener changes apply immediately — the
// panel must show the server's truth, not the operator's draft.

import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'
import { configDiff, groupConfig, seedDraft, type ConfigDraft } from '../conf.ts'
import { fmtClock, fmtDay } from '../format.ts'
import { IconClose, IconEdit, IconPlus, IconTrash } from '../icons.tsx'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface ServerForm {
  name: string
  url: string
  username: string
  password: string
  token: string
}

const EMPTY_SERVER_FORM: ServerForm = { name: '', url: '', username: '', password: '', token: '' }

/** Inside this window an expiring token turns amber instead of staying dim. */
const TOKEN_SOON_MS = 10 * 60 * 1000

/** Number inputs show '' for NaN (an emptied field), never the string "NaN". */
function numText(v: string | number | boolean | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

export function ConfigPanel({ ctx }: { ctx: Context }): ReactElement | null {
  // Hook order is sacred: everything runs unconditionally, store-absent
  // degrades to nulls at the end.
  const cons = useConsole(ctx)
  const { t } = useI18n(ctx)
  const store = cons?.store ?? null
  const snap = cons?.snap ?? null
  const cfg = snap?.cfg ?? null

  const [draft, setDraft] = useState<ConfigDraft>({})
  const [srvForm, setSrvForm] = useState<ServerForm>(EMPTY_SERVER_FORM)
  /** The server name being edited, or null while the form registers a new one. */
  const [editing, setEditing] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Load once per store (the panel opens with the drawer; refresh re-pulls).
  useEffect(() => {
    if (store !== null) void store.loadGlobalConfig()
  }, [store])

  // A (re)loaded config re-seeds the draft — after Save the server's
  // normalized truth replaces what the operator typed.
  useEffect(() => {
    setDraft(cfg === null ? {} : seedDraft(cfg))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg])

  const groups = useMemo(() => (cfg === null ? [] : groupConfig(cfg)), [cfg])

  if (cons === null || store === null || snap === null) return null

  const dirty = cfg === null ? {} : configDiff(cfg, draft)
  const dirtyCount = Object.keys(dirty).length

  const setField = (key: string, value: string | number | boolean): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const onSwitch = (name: string): void => {
    if (name === '' || name === snap.activeServer) return
    setFeedback(null)
    void store.switchServer(name)
      .then(() => setFeedback({ kind: 'ok', text: t('config.serverSwitched', { name }) }))
      .catch((e: unknown) => setFeedback({ kind: 'err', text: msg(e) }))
  }

  // One form, two verbs: registering a new server, or rotating an existing
  // one in place (blank credential fields KEEP — the wire clears only on an
  // explicit empty string, which this form never sends).
  const onSubmitServer = (event: FormEvent): void => {
    event.preventDefault()
    const name = srvForm.name.trim()
    const url = srvForm.url.trim()
    if (name === '' || url === '') return
    setFeedback(null)
    const payload = {
      name,
      url,
      ...(srvForm.username.trim() !== '' ? { username: srvForm.username.trim(), password: srvForm.password } : {}),
      ...(srvForm.token.trim() !== '' ? { token: srvForm.token.trim() } : {}),
    }
    const run = editing === null ? store.addServer(payload) : store.updateServer(payload)
    void run
      .then(() => {
        setFeedback({ kind: 'ok', text: t(editing === null ? 'config.serverAdded' : 'config.serverUpdated', { name }) })
        setSrvForm(EMPTY_SERVER_FORM)
        setEditing(null)
      })
      .catch((e: unknown) => setFeedback({ kind: 'err', text: msg(e) }))
  }

  const onEditServer = (name: string, url: string): void => {
    setFeedback(null)
    setEditing(name)
    setSrvForm({ name, url, username: '', password: '', token: '' })
  }

  const onRemoveServer = (name: string): void => {
    setFeedback(null)
    void store.removeServer(name)
      .then(() => setFeedback({ kind: 'ok', text: t('config.serverRemoved', { name }) }))
      .catch((e: unknown) => setFeedback({ kind: 'err', text: msg(e) }))
  }

  const onSave = (): void => {
    if (dirtyCount === 0 || snap.cfgSaving) return
    setFeedback(null)
    void store.patchGlobalConfig(dirty)
      .then(() => setFeedback({ kind: 'ok', text: t('config.saved', { n: String(dirtyCount) }) }))
      .catch((e: unknown) => setFeedback({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
  }

  const activeEntry = snap.servers.find((s) => s.name === snap.activeServer) ?? null

  // The bridge decodes a bearer token's exp (never verifies — that is the
  // server's job); expired turns red, expiring-soon amber, distant future dim.
  const tokenBadge = (expiresAt: number): { state: 'err' | 'idle' | undefined; text: string } => {
    const ms = expiresAt * 1000
    const iso = new Date(ms).toISOString()
    const time = `${fmtDay(iso)} ${fmtClock(iso)}`
    if (ms < Date.now()) return { state: 'err', text: t('config.tokenExpired', { time }) }
    if (ms - Date.now() < TOKEN_SOON_MS) return { state: 'idle', text: t('config.tokenExpiring', { time }) }
    return { state: undefined, text: t('config.tokenExpiring', { time }) }
  }

  return (
    <section className="mx-config">
      <h3 className="mx-h">{t('config.servers')}</h3>
      <div className="mx-config__bar">
        <select
          className="mx-select mx-config__srvpick"
          value={snap.activeServer ?? ''}
          onChange={(e) => onSwitch(e.target.value)}
        >
          {snap.servers.map((s) => (
            <option key={s.name} value={s.name}>{s.name} · {s.url}</option>
          ))}
        </select>
        {activeEntry !== null && <span className="mx-kind">{activeEntry.auth}</span>}
      </div>
      {snap.servers.length > 0 && (
        <table className="mx-table mx-table--dense">
          <tbody>
            {snap.servers.map((s) => (
              <tr key={s.name} data-active={s.name === snap.activeServer ? 'yes' : undefined}>
                <td className="mx-mono">
                  {s.name}
                  {s.name === snap.activeServer && <span className="mx-config__active"> · {t('config.serverActive')}</span>}
                </td>
                <td className="mx-mono mx-dim">{s.url}</td>
                <td className="mx-table__label">
                  {s.auth}
                  {s.expiresAt !== null && (() => {
                    const b = tokenBadge(s.expiresAt)
                    return <span className="mx-badge mx-config__exp" data-state={b.state}>{b.text}</span>
                  })()}
                </td>
                <td className="mx-config__rowbtns">
                  <button
                    type="button"
                    className="mx-btn mx-btn--icon"
                    title={t('config.srvEdit')}
                    onClick={() => onEditServer(s.name, s.url)}
                  >
                    <IconEdit />
                  </button>
                  <button
                    type="button"
                    className="mx-btn mx-btn--icon mx-btn--danger"
                    title={t('stream.delete')}
                    disabled={s.name === snap.activeServer}
                    onClick={() => onRemoveServer(s.name)}
                  >
                    <IconTrash />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="mx-form mx-config__srvform" onSubmit={onSubmitServer}>
        <label className="mx-field">
          <span>{t('config.srvName')}</span>
          <input
            value={srvForm.name}
            onChange={(e) => setSrvForm({ ...srvForm, name: e.target.value })}
            placeholder="office"
            disabled={editing !== null}
            required
          />
        </label>
        <label className="mx-field">
          <span>{t('config.srvUrl')}</span>
          <input value={srvForm.url} onChange={(e) => setSrvForm({ ...srvForm, url: e.target.value })} placeholder="http://192.168.1.10:9997" required />
        </label>
        <label className="mx-field">
          <span>{t('config.srvUser')}</span>
          <input value={srvForm.username} onChange={(e) => setSrvForm({ ...srvForm, username: e.target.value })} placeholder={editing === null ? undefined : t('config.srvKeep')} autoComplete="off" />
        </label>
        <label className="mx-field">
          <span>{t('config.srvPass')}</span>
          <input type="password" value={srvForm.password} onChange={(e) => setSrvForm({ ...srvForm, password: e.target.value })} placeholder={editing === null ? undefined : t('config.srvKeep')} autoComplete="new-password" />
        </label>
        <label className="mx-field">
          <span>{t('config.srvToken')}</span>
          <input type="password" value={srvForm.token} onChange={(e) => setSrvForm({ ...srvForm, token: e.target.value })} placeholder={editing === null ? undefined : t('config.srvKeep')} autoComplete="off" />
        </label>
        {editing === null
          ? <button type="submit" className="mx-btn"><IconPlus /> {t('config.serverAdd')}</button>
          : (
              <>
                <button type="submit" className="mx-btn mx-btn--primary"><IconEdit /> {t('config.serverUpdate')}</button>
                <button
                  type="button"
                  className="mx-btn mx-btn--icon"
                  title={t('config.srvEditCancel')}
                  onClick={() => { setEditing(null); setSrvForm(EMPTY_SERVER_FORM) }}
                >
                  <IconClose />
                </button>
              </>
            )}
      </form>
      {snap.serversError !== null && <p className="mx-error">{t('common.error', { detail: snap.serversError })}</p>}

      <h3 className="mx-h">{t('panel.config.title')}</h3>
      <div className="mx-config__bar">
        <button type="button" className="mx-btn" disabled={snap.cfgLoading} onClick={() => void store.loadGlobalConfig()}>
          {t('common.refresh')}
        </button>
        <button type="button" className="mx-btn mx-btn--primary" disabled={dirtyCount === 0 || snap.cfgSaving} onClick={onSave}>
          {t('config.save')}
        </button>
        <button
          type="button"
          className="mx-btn"
          disabled={dirtyCount === 0}
          onClick={() => { setDraft(cfg === null ? {} : seedDraft(cfg)); setFeedback(null) }}
        >
          {t('config.reset')}
        </button>
        {dirtyCount > 0 && <span className="mx-badge" data-state="idle">{t('config.dirty', { n: String(dirtyCount) })}</span>}
        {snap.cfgLoading && <span className="mx-dim">{t('common.loading')}</span>}
      </div>
      <p className="mx-dim mx-config__danger">{t('config.danger')}</p>
      {snap.cfgError !== null && <p className="mx-error">{t('common.error', { detail: snap.cfgError })}</p>}
      {feedback !== null && <p className={feedback.kind === 'ok' ? 'mx-ok' : 'mx-error'}>{feedback.text}</p>}
      {cfg !== null && (
        <div className="mx-config__groups">
          {groups.map((g) => (
            <details key={g.group} className="mx-config__group">
              <summary className="mx-config__summary">
                {g.group} <span className="mx-dim">· {g.fields.length}</span>
              </summary>
              <div className="mx-config__fields">
                {g.fields.map((f) => (
                  <label key={f.key} className="mx-config__field" data-kind={f.kind}>
                    <span className="mx-mono mx-config__key" title={f.key}>{f.key}</span>
                    {f.kind === 'complex'
                      ? <pre className="mx-config__json" title={t('config.readonly')}>{JSON.stringify(f.value, null, 1)}</pre>
                      : f.kind === 'bool'
                        ? (
                            <input
                              type="checkbox"
                              checked={draft[f.key] === true}
                              onChange={(e) => setField(f.key, e.target.checked)}
                            />
                          )
                        : f.kind === 'number'
                          ? (
                              <input
                                type="number"
                                step="any"
                                value={numText(draft[f.key])}
                                onChange={(e) => setField(f.key, e.target.value === '' ? Number.NaN : Number(e.target.value))}
                              />
                            )
                          : (
                              <input
                                type="text"
                                value={typeof draft[f.key] === 'string' ? (draft[f.key] as string) : ''}
                                onChange={(e) => setField(f.key, e.target.value)}
                              />
                            )}
                  </label>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}
