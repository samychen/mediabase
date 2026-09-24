// Inspector panel (sidebar): the selected element's fields, or — with nothing
// selected — the project itself: identity, output shape, captions, the plain
// JSON document, and the "Ask for a change" box.
//
// Field edits commit on blur/Enter as ONE undo step (typing must not flood
// the history); structural choices go through the same checked operations an
// agent calls. "Ask" delegates to the BASE agent (`agent.run`): the prompt
// carries the cut as a short list, and the model acts through the openvideo
// tools — no key configured means a coded error, never a blocked editor.

import { useEffect, useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { DEFAULT_CAPTIONS, applyOp, type Edl } from '@openvideo/edl'
import { useEditor } from '../use-editor.ts'

/** A numeric field that commits one undo step on blur/Enter. */
function NumField({ label, value, onCommit, min, max, step = 0.1 }: {
  label: string
  value: number | undefined
  onCommit: (n: number) => void
  min?: number
  max?: number
  step?: number
}): ReactElement {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => {
    setText(value === undefined ? '' : String(value))
  }, [value])
  const commit = (): void => {
    const n = Number(text)
    if (text.trim() !== '' && Number.isFinite(n) && n !== value) onCommit(n)
  }
  return (
    <label>
      {label}
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </label>
  )
}

/** A text field with the same commit-on-blur contract. */
function TextField({ label, value, onCommit, textarea = false }: {
  label: string
  value: string
  onCommit: (s: string) => void
  textarea?: boolean
}): ReactElement {
  const [text, setText] = useState(value)
  useEffect(() => {
    setText(value)
  }, [value])
  const commit = (): void => {
    if (text !== value) onCommit(text)
  }
  const props = {
    value: text,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: commit,
    onKeyDown: (e: { key: string }) => {
      if (e.key === 'Enter' && !textarea) commit()
    },
  }
  return (
    <label>
      {label}
      {textarea ? <textarea rows={3} {...props} /> : <input type="text" {...props} />}
    </label>
  )
}

const CAPTION_LANGUAGES: [string, string][] = [
  ['en', 'English'], ['zh', '中文'], ['ja', '日本語'], ['ko', '한국어'],
  ['it', 'Italiano'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['nl', 'Nederlands'], ['pt', 'Português'], ['pl', 'Polski'], ['cs', 'Čeština'], ['ru', 'Русский'],
]

export function InspectorPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useEditor(ctx)
  const { t } = useI18n(ctx)
  const [instruction, setInstruction] = useState('')
  if (editor === null) return null
  const { store, state } = editor
  const draft = state.draft

  if (draft === null) return <div className="ov-inspector"><div className="status">{t('ov.inspector.noProject')}</div></div>

  /** Mutate the selected element (one undo step per commit). */
  const editSelected = (fn: (d: Edl) => void): void => store.setDraft(fn)

  const sel = state.sel
  // Captured as consts so the edit callbacks below keep the narrowed kind
  // (a closure over the raw union would lose it).
  const selMain = sel?.kind === 'main' ? sel.index : null
  const selOverlay = sel?.kind === 'overlay' ? sel : null
  const selAudio = sel?.kind === 'audio' ? sel : null
  const mainEl = selMain !== null ? draft.main.elements[selMain] : undefined
  const overlayEl = selOverlay !== null ? draft.overlays?.[selOverlay.track]?.elements[selOverlay.index] : undefined
  const audioEl = selAudio !== null ? draft.audio?.[selAudio.track]?.elements[selAudio.index] : undefined

  return (
    <div className="ov-inspector">
      {mainEl !== undefined && (
        <section>
          <div className="sub">{t('ov.inspector.clip')} #{selMain ?? 0} · {mainEl.type}</div>
          <label>
            {t('ov.inspector.mediaSource')}
            <span className="ov-row">
              <span className="ov-item-name">
                {mainEl.src.startsWith('asset:')
                  ? (state.assets.find((a) => a.id === mainEl.src.slice(6))?.name ?? t('ov.inspector.assetMissing'))
                  : mainEl.src}
              </span>
              {mainEl.src.startsWith('asset:')
                && state.decodeState[mainEl.src.slice(6)] === 'fail' && (
                <span className="ov-badge-warn" title={t('ov.media.undecodableHint')}>⚠ {t('ov.media.undecodable')}</span>
              )}
              {mainEl.src.startsWith('asset:')
                && state.assets.find((a) => a.id === mainEl.src.slice(6)) === undefined && (
                <span className="ov-badge-warn">⚠ {t('ov.inspector.assetMissing')}</span>
              )}
            </span>
            <select
              value=""
              onChange={(e) => {
                const id = e.target.value
                if (id === '') return
                store.setDraft((d) => {
                  const el = d.main.elements[selMain!]
                  if (el !== undefined) el.src = `asset:${id}`
                })
              }}
            >
              <option value="">{t('ov.inspector.replaceMedia')}</option>
              {state.assets
                .filter((a) => a.contentType.startsWith('video/') || a.contentType.startsWith('image/'))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {state.decodeState[a.id] === 'fail' ? '⚠ ' : ''}{a.name}
                  </option>
                ))}
            </select>
          </label>
          <NumField
            label={t('ov.inspector.trimStart')}
            value={mainEl.trimStart ?? 0}
            min={0}
            onCommit={(n) => editSelected((d) => {
              const el = d.main.elements[selMain!]
              if (el !== undefined) el.trimStart = Math.max(0, n)
            })}
          />
          <NumField
            label={t('ov.inspector.duration')}
            value={mainEl.duration}
            min={0.05}
            onCommit={(n) => editSelected((d) => {
              const el = d.main.elements[selMain!]
              if (el === undefined) return
              if (el.type === 'image') el.duration = Math.max(0.05, n)
              else el.duration = Math.max(0.05, n)
            })}
          />
          {mainEl.type === 'video' && (
            <>
              <label>
                {t('ov.inspector.fit')}
                <select
                  value={mainEl.fit ?? 'contain'}
                  onChange={(e) => editSelected((d) => {
                    const el = d.main.elements[selMain!]
                    if (el !== undefined) el.fit = e.target.value === 'cover' ? 'cover' : 'contain'
                  })}
                >
                  <option value="contain">{t('ov.inspector.contain')}</option>
                  <option value="cover">{t('ov.inspector.cover')}</option>
                </select>
              </label>
              <NumField
                label={t('ov.inspector.volume')}
                value={mainEl.volume ?? 1}
                min={0}
                max={2}
                onCommit={(n) => editSelected((d) => {
                  const el = d.main.elements[selMain!]
                  if (el !== undefined && el.type === 'video') el.volume = Math.min(2, Math.max(0, n))
                })}
              />
              <label className="ov-check">
                <input
                  type="checkbox"
                  checked={mainEl.sourceAudio !== false}
                  onChange={(e) => editSelected((d) => {
                    const el = d.main.elements[selMain!]
                    if (el !== undefined && el.type === 'video') el.sourceAudio = e.target.checked
                  })}
                />
                {t('ov.inspector.sourceAudio')}
              </label>
            </>
          )}
        </section>
      )}

      {overlayEl !== undefined && (
        <section>
          <div className="sub">{t(overlayEl.type === 'text' ? 'ov.inspector.text' : 'ov.inspector.clip')} · {overlayEl.type}</div>
          {overlayEl.type === 'text' ? (
            <>
              <TextField
                label={t('ov.inspector.textContent')}
                value={overlayEl.text}
                textarea
                onCommit={(s) => editSelected((d) => {
                  const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
                  if (el !== undefined && el.type === 'text' && s.trim() !== '') el.text = s.slice(0, 500)
                })}
              />
              <NumField
                label={t('ov.inspector.fontSize')}
                value={overlayEl.fontSize}
                min={8}
                max={400}
                step={1}
                onCommit={(n) => editSelected((d) => {
                  const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
                  if (el !== undefined && el.type === 'text') el.fontSize = Math.round(Math.min(400, Math.max(8, n)))
                })}
              />
              <label>
                {t('ov.inspector.align')}
                <select
                  value={overlayEl.align ?? 'left'}
                  onChange={(e) => editSelected((d) => {
                    const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
                    if (el !== undefined && el.type === 'text') {
                      el.align = e.target.value === 'center' ? 'center' : e.target.value === 'right' ? 'right' : 'left'
                    }
                  })}
                >
                  <option value="left">left</option>
                  <option value="center">center</option>
                  <option value="right">right</option>
                </select>
              </label>
              <label>
                {t('ov.inspector.color')}
                <input
                  type="text"
                  defaultValue={overlayEl.color ?? '#ffffff'}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return
                    editSelected((d) => {
                      const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
                      if (el !== undefined && el.type === 'text') el.color = v
                    })
                  }}
                />
              </label>
              <label>
                {t('ov.inspector.boxBackground')}
                <input
                  type="text"
                  defaultValue={overlayEl.background ?? ''}
                  placeholder="#00000080"
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v !== '' && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return
                    editSelected((d) => {
                      const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
                      if (el !== undefined && el.type === 'text') {
                        if (v === '') delete el.background
                        else el.background = v
                      }
                    })
                  }}
                />
              </label>
            </>
          ) : (
            <NumField
              label={t('ov.inspector.overlayWidth')}
              value={overlayEl.width}
              min={0.01}
              max={1}
              onCommit={(n) => editSelected((d) => {
                const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
                if (el !== undefined && el.type !== 'text') el.width = Math.min(1, Math.max(0.01, n))
              })}
            />
          )}
          <NumField
            label={t('ov.inspector.startTime')}
            value={overlayEl.startTime}
            min={0}
            onCommit={(n) => editSelected((d) => {
              const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
              if (el !== undefined) el.startTime = Math.max(0, n)
            })}
          />
          <NumField
            label={t('ov.inspector.duration')}
            value={overlayEl.duration}
            min={0.05}
            onCommit={(n) => editSelected((d) => {
              const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
              if (el !== undefined) el.duration = Math.max(0.05, n)
            })}
          />
          <NumField
            label={t('ov.inspector.x')}
            value={overlayEl.x}
            min={0}
            max={1}
            onCommit={(n) => editSelected((d) => {
              const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
              if (el !== undefined) el.x = Math.min(1, Math.max(0, n))
            })}
          />
          <NumField
            label={t('ov.inspector.y')}
            value={overlayEl.y}
            min={0}
            max={1}
            onCommit={(n) => editSelected((d) => {
              const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
              if (el !== undefined) el.y = Math.min(1, Math.max(0, n))
            })}
          />
          <NumField
            label={t('ov.inspector.opacity')}
            value={overlayEl.opacity ?? 1}
            min={0}
            max={1}
            onCommit={(n) => editSelected((d) => {
              const el = d.overlays?.[selOverlay!.track]?.elements[selOverlay!.index]
              if (el !== undefined) el.opacity = Math.min(1, Math.max(0, n))
            })}
          />
        </section>
      )}

      {audioEl !== undefined && (
        <section>
          <div className="sub">{t('ov.inspector.audio')}</div>
          <NumField
            label={t('ov.inspector.startTime')}
            value={audioEl.startTime}
            min={0}
            onCommit={(n) => editSelected((d) => {
              const el = d.audio?.[selAudio!.track]?.elements[selAudio!.index]
              if (el !== undefined) el.startTime = Math.max(0, n)
            })}
          />
          <NumField
            label={t('ov.inspector.duration')}
            value={audioEl.duration}
            min={0.05}
            onCommit={(n) => editSelected((d) => {
              const el = d.audio?.[selAudio!.track]?.elements[selAudio!.index]
              if (el !== undefined) el.duration = Math.max(0.05, n)
            })}
          />
          <NumField
            label={t('ov.inspector.volume')}
            value={audioEl.volume ?? 1}
            min={0}
            max={2}
            onCommit={(n) => editSelected((d) => {
              const el = d.audio?.[selAudio!.track]?.elements[selAudio!.index]
              if (el !== undefined) el.volume = Math.min(2, Math.max(0, n))
            })}
          />
        </section>
      )}

      {sel === null && (
        <section>
          <div className="sub">{t('ov.inspector.project')}</div>
          <TextField
            label={t('ov.inspector.name')}
            value={state.projectName}
            onCommit={(s) => {
              if (s.trim() !== '') void store.renameProject(s.trim())
            }}
          />
          <TextField
            label={t('ov.inspector.brief')}
            value={state.projectBrief}
            textarea
            onCommit={(s) => void store.setBrief(s)}
          />

          <div className="sub">{t('ov.inspector.output')}</div>
          <div className="ov-row">
            <NumField
              label={t('ov.inspector.width')}
              value={draft.output.width}
              min={16}
              max={3840}
              step={2}
              onCommit={(n) => editSelected((d) => {
                d.output.width = Math.min(3840, Math.max(16, Math.round(n / 2) * 2))
              })}
            />
            <NumField
              label={t('ov.inspector.height')}
              value={draft.output.height}
              min={16}
              max={2160}
              step={2}
              onCommit={(n) => editSelected((d) => {
                d.output.height = Math.min(2160, Math.max(16, Math.round(n / 2) * 2))
              })}
            />
          </div>
          <label>
            {t('ov.inspector.fps')}
            <select
              value={draft.output.fps}
              onChange={(e) => editSelected((d) => {
                const fps = Number(e.target.value)
                d.output.fps = fps === 24 || fps === 60 ? fps : 30
              })}
            >
              <option value={24}>24</option>
              <option value={30}>30</option>
              <option value={60}>60</option>
            </select>
          </label>
          <div className="ov-row">
            {(['landscape', 'vertical', 'square'] as const).map((shape) => (
              <button
                key={shape}
                className="secondary"
                onClick={() => editSelected((d) => {
                  applyOp(d, 'set_aspect', { shape })
                })}
              >
                {t(`ov.inspector.${shape}`)}
              </button>
            ))}
          </div>

          <div className="sub">{t('ov.inspector.captions')}</div>
          <label className="ov-check">
            <input
              type="checkbox"
              checked={draft.captions?.enabled === true}
              onChange={(e) => editSelected((d) => {
                d.captions = { ...(d.captions ?? DEFAULT_CAPTIONS), enabled: e.target.checked }
              })}
            />
            {t('ov.inspector.captionsEnabled')}
          </label>
          {draft.captions?.enabled === true && (
            <>
              <label>
                {t('ov.inspector.captionsLang')}
                <select
                  value={draft.captions.lang}
                  onChange={(e) => editSelected((d) => {
                    if (d.captions !== undefined) d.captions.lang = e.target.value
                  })}
                >
                  {CAPTION_LANGUAGES.map(([code, label]) => (
                    <option key={code} value={code}>{label} ({code})</option>
                  ))}
                </select>
              </label>
              <NumField
                label="maxChars"
                value={draft.captions.style.maxChars}
                min={8}
                max={80}
                step={1}
                onCommit={(n) => editSelected((d) => {
                  if (d.captions !== undefined) d.captions.style.maxChars = Math.round(Math.min(80, Math.max(8, n)))
                })}
              />
              <div className="status">{t('ov.inspector.captionsHint')}</div>
            </>
          )}
        </section>
      )}

      <section>
        <div className="sub">{t('ov.inspector.ask')}</div>
        <textarea
          rows={2}
          value={instruction}
          placeholder={t('ov.inspector.askPlaceholder')}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <button
          disabled={state.ask.busy || instruction.trim() === ''}
          onClick={() => {
            const text = instruction.trim()
            if (text === '') return
            setInstruction('')
            void store.ask(text)
          }}
        >
          ✨ {state.ask.busy ? t('ov.inspector.askBusy') : t('ov.inspector.askButton')}
        </button>
        {state.ask.answer !== null && <div className="status">{state.ask.answer}</div>}
        {state.ask.error !== null && <div className="status ov-error">{state.ask.error}</div>}
      </section>

      <section>
        <details>
          <summary className="sub">{t('ov.inspector.document')}</summary>
          <textarea className="ov-json" rows={12} readOnly value={JSON.stringify(draft, null, 2)} />
        </details>
      </section>
    </div>
  )
}
