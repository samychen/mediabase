// The control panel (sidebar): point at a file, choose how many clips, submit.
//
// It renders the engine's stage/progress verbatim — the host reports what the
// engine is actually doing, so the panel never invents a phase. All copy comes
// from messages.ts; the only literals here are numeric limits.

import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { degradedKey, stageKey, stateKey } from '../messages.ts'
import type { HighlightOption } from '../store.ts'
import { useHighlight } from '../use-highlight.ts'

const GROUPS = ['analysis', 'scoring', 'selection', 'text', 'output'] as const

/**
 * One engine knob, rendered from the catalogue rather than a hardcoded input.
 *
 * `available: false` is a first-class state: the host knows this deployment lacks
 * the model (no OpenCLIP, say), so the control is disabled with a reason instead
 * of being accept-then-ignore.
 */
function OptionRow({ ctx, option, value, onChange }: {
  ctx: Context
  option: HighlightOption
  value: unknown
  onChange: (value: unknown) => void
}): ReactElement {
  const { t } = useI18n(ctx)
  const label = t(`vhl.opt.${option.key}`)
  const disabled = !option.available
  const hint = disabled ? `${t('vhl.control.requiresMissing')}: ${option.requires}` : undefined

  if (option.type === 'bool') {
    return (
      <label className="vhl-opt-row" title={hint}>
        <span>
          {label}
          {/* The dependency sits INLINE with the label: as its own grid cell it
              wrapped to a new line and read like a stray word. */}
          {disabled && <em className="vhl-muted"> ({option.requires})</em>}
        </span>
        <input
          type="checkbox"
          disabled={disabled}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    )
  }

  if (option.type === 'int' || option.type === 'float') {
    return (
      <label className="vhl-opt-row" title={hint}>
        <span>{label}</span>
        <input
          type="number"
          disabled={disabled}
          min={option.min ?? undefined}
          max={option.max ?? undefined}
          step={option.type === 'int' ? 1 : 0.1}
          value={typeof value === 'number' ? value : Number(option.default ?? 0)}
          onChange={(event) => {
            const next = Number(event.target.value)
            // An empty field is NaN; keep the previous value instead of sending NaN.
            if (Number.isFinite(next)) onChange(next)
          }}
        />
      </label>
    )
  }

  // A composite knob: seven signal weights that the engine normalises against
  // each other. Rendered as one labelled block so the relative nature is visible
  // instead of seven independent sliders implying absolute effect.
  if (option.type === 'weights') {
    const fields = option.fields ?? {}
    const current = (typeof value === 'object' && value !== null && !Array.isArray(value))
      ? value as Record<string, unknown>
      : {}
    return (
      <div className="vhl-opt-weights">
        {/* Caption spans the block instead of sitting in the two-column grid:
            the relative-weight hint is a sentence, and 96px of grid column
            turned it into a ragged column of single characters. */}
        <div className="vhl-opt-caption">
          <span>{label}</span>
          <span className="vhl-muted">{t('vhl.opt.weightsHint')}</span>
        </div>
        {Object.entries(fields).map(([sub, field]) => (
          <label key={sub} className="vhl-opt-row vhl-opt-sub">
            <span>{t(`vhl.weight.${sub}`)}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={typeof current[sub] === 'number' ? current[sub] as number : field.default}
              onChange={(event) => {
                const next = Number(event.target.value)
                // An empty field is NaN. Keep 0..1 here as well: the host refuses
                // out-of-range values, and a form that can produce a refusal from
                // normal typing is a bad form.
                if (!Number.isFinite(next)) return
                onChange({ ...current, [sub]: Math.min(1, Math.max(0, next)) })
              }}
            />
          </label>
        ))}
      </div>
    )
  }

  if (option.enum !== null) {    return (
      <label className="vhl-opt-row" title={hint}>
        <span>{label}</span>
        <select
          disabled={disabled}
          value={String(value ?? option.default ?? '')}
          onChange={(event) => onChange(event.target.value)}
        >
          {option.enum.map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}
        </select>
      </label>
    )
  }

  const text = option.type === 'strs'
    ? (Array.isArray(value) ? value.join(',') : String(value ?? ''))
    : String(value ?? option.default ?? '')
  return (
    <label className="vhl-opt-row" title={hint}>
      <span>{label}</span>
      <input
        type="text"
        disabled={disabled}
        value={text}
        onChange={(event) => onChange(option.type === 'strs'
          ? event.target.value.split(',').map((part) => part.trim()).filter((part) => part !== '')
          : event.target.value)}
      />
    </label>
  )
}

export function ControlPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useHighlight(ctx)
  const { t } = useI18n(ctx)
  if (editor === null) return null
  const { store, state } = editor
  const job = state.job
  const running = job !== null && (job.state === 'running' || job.state === 'queued')
  const progress = job === null ? 0 : Math.round(Math.max(0, Math.min(1, job.progress)) * 100)

  return (
    <div className="vhl-control">
      {/* The shell already renders the panel title (registered titleKey); a second
          <strong> here printed "高光分析" twice. This row is only the engine badge. */}
      <div className="vhl-head">
        {state.engine === null
          ? <span className="badge off">{t('vhl.control.engineDown')}</span>
          : <span className={state.engine.running ? 'badge on' : 'badge off'}>
              {state.engine.engine ?? t('vhl.control.engineDown')}
            </span>}
      </div>

      <label htmlFor="vhl-input">{t('vhl.control.input')}</label>
      <input
        id="vhl-input"
        type="text"
        value={state.input}
        placeholder={t('vhl.control.inputPlaceholder')}
        onChange={(event) => store.patch({ input: event.target.value, error: null })}
      />

      <div className="row">
        <div>
          <label htmlFor="vhl-topk">{t('vhl.control.topK')}</label>
          <input
            id="vhl-topk"
            type="number"
            min={1}
            max={20}
            value={state.topK}
            onChange={(event) => store.patch({ topK: Number(event.target.value) })}
          />
        </div>
        <div>
          <label htmlFor="vhl-duration">{t('vhl.control.duration')}</label>
          <input
            id="vhl-duration"
            type="number"
            min={1}
            max={60}
            step={0.5}
            value={state.clipDurationSec}
            onChange={(event) => store.patch({ clipDurationSec: Number(event.target.value) })}
          />
        </div>
      </div>

      <div>
        <button type="button" className="secondary" disabled={state.busy} onClick={() => void store.probe()}>
          {t('vhl.control.probe')}
        </button>
        <button type="button" disabled={state.busy || running} onClick={() => void store.start()}>
          {t('vhl.control.start')}
        </button>
        {running && (
          <button type="button" className="secondary" onClick={() => void store.cancel()}>
            {t('vhl.control.cancel')}
          </button>
        )}
      </div>

      {state.options.length > 0 && (
        <details className="vhl-advanced">
          <summary>{t('vhl.control.advanced')}</summary>
          {GROUPS.map((group) => {
            const rows = state.options.filter((option) => option.group === group
              // The two quick controls above already own these, and an external
              // SRT path is an automation input, not something to type here.
              && option.key !== 'maxHighlights' && option.key !== 'clipDurationSec' && option.key !== 'srtPath')
            if (rows.length === 0) return null
            return (
              <div key={group} className="vhl-opt-group">
                <div className="vhl-k">{t(`vhl.group.${group}`)}</div>
                {rows.map((option) => (
                  <OptionRow
                    key={option.key}
                    ctx={ctx}
                    option={option}
                    value={state.values[option.key] !== undefined ? state.values[option.key] : option.default}
                    onChange={(value) => store.setOption(option.key, value)}
                  />
                ))}
              </div>
            )
          })}
        </details>
      )}

      {state.media !== null && (
        <div className="vhl-line">
          <span className="vhl-k">{t('vhl.control.media')}</span>
          <span>
            {state.media.width}×{state.media.height} · {state.media.durationSec.toFixed(1)}s ·{' '}
            {state.media.fps.toFixed(2)}fps · {state.media.videoCodec}
            {state.media.hasAudio ? ` · ${state.media.audioCodec}` : ''}
          </span>
        </div>
      )}

      {job !== null && (
        <div className="vhl-job">
          <div className="vhl-line">
            <span className="vhl-k">{t('vhl.control.stage')}</span>
            <span>
              {t(stageKey(job.stage))} · <span className="badge">{t(stateKey(job.state))}</span>
            </span>
          </div>
          <div className="vhl-line">
            <span className="vhl-k">{t('vhl.control.progress')}</span>
            <span className="vhl-bar"><span style={{ width: `${progress}%` }} /></span>
            <span className="vhl-pct">{progress}%</span>
          </div>
        </div>
      )}

      {state.models?.degraded === true && (
        <div className="status">{t(degradedKey(state.models.degradedReason))}</div>
      )}
      {state.error !== null && <div className="status vhl-error">{state.error}</div>}

      <div className="vhl-jobs">
        <div className="vhl-k">{t('vhl.control.jobs')}</div>
        {state.jobs.length === 0
          ? <div className="status">{t('vhl.control.noJobs')}</div>
          : (
            <ul>
              {state.jobs.slice(0, 6).map((row) => (
                <li key={row.jobId}>
                  <button
                    type="button"
                    className="vhl-pick"
                    title={row.output}
                    onClick={() => void store.select(row.jobId)}
                  >
                    <code>{row.jobId.slice(0, 8)}</code>
                    {/* `off` for both failed and interrupted: in either case the
                        clip does not exist and the row is not a result. */}
                    <span className={
                      row.state === 'succeeded'
                        ? 'badge on'
                        : row.state === 'failed' || row.state === 'interrupted'
                          ? 'badge off'
                          : 'badge'
                    }>
                      {t(stateKey(row.state))}
                    </span>
                    <span className="vhl-muted">{row.segmentCount} × {row.durationSec.toFixed(0)}s</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}
