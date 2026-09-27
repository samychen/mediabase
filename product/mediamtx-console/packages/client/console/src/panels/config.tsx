// Config (bottom drawer): the server's flat global config (~122 keys) as a
// reviewable, editable form — the M3 candidate "read-only review + subset
// patch, no form UI" made real. Everything upstream reports is shown, bucketed
// by key-prefix (conf.ts): scalars become inputs, composite values stay
// read-only JSON (their honest editor is mediamtx.yml). Save sends ONLY the
// diff through mediamtx.config.global.patch and re-reads the config, because
// the server normalizes values and listener changes apply immediately — the
// panel must show the server's truth, not the operator's draft.

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useConsole } from '../use-console.ts'
import { configDiff, groupConfig, seedDraft, type ConfigDraft } from '../conf.ts'

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

  const onSave = (): void => {
    if (dirtyCount === 0 || snap.cfgSaving) return
    setFeedback(null)
    void store.patchGlobalConfig(dirty)
      .then(() => setFeedback({ kind: 'ok', text: t('config.saved', { n: String(dirtyCount) }) }))
      .catch((e: unknown) => setFeedback({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
  }

  return (
    <section className="mx-config">
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
