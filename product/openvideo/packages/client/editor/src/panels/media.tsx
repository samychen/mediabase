// Media panel (sidebar): the library — upload from the browser (chunked over
// the control plane), import a host-local path, attach transcript sidecars,
// and put assets on the timeline. Bytes never travel here: the list is
// metadata, playback and export pull them from the asset's data-plane route.

import { useRef, useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useEditor } from '../use-editor.ts'
import type { AssetRow } from '../store.ts'

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`
  return `${n} B`
}

function kindIcon(asset: AssetRow): string {
  if (asset.contentType.startsWith('video/')) return '🎬'
  if (asset.contentType.startsWith('image/')) return '🖼'
  if (asset.contentType.startsWith('audio/')) return '🎵'
  return '📄'
}

export function MediaPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useEditor(ctx)
  const { t } = useI18n(ctx)
  const fileRef = useRef<HTMLInputElement>(null)
  const vttRef = useRef<HTMLInputElement>(null)
  const [vttTarget, setVttTarget] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)

  if (editor === null) return null
  const { store, state } = editor
  const decodeState = state.decodeState

  const onFiles = async (files: FileList | null): Promise<void> => {
    if (files === null) return
    for (const file of Array.from(files)) {
      setUploading({ name: file.name, fraction: 0 })
      try {
        await store.uploadFile(file, (fraction) => setUploading({ name: file.name, fraction }))
      } finally {
        setUploading(null)
      }
    }
    if (fileRef.current !== null) fileRef.current.value = ''
  }

  const onVtt = async (files: FileList | null): Promise<void> => {
    const file = files?.[0]
    const target = vttTarget
    if (file === undefined || target === null) return
    await store.attachTranscript(target, await file.text())
    setVttTarget(null)
    if (vttRef.current !== null) vttRef.current.value = ''
  }

  return (
    <div className="ov-media">
      <div className="ov-row">
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => void onFiles(e.target.files)} />
        <button onClick={() => fileRef.current?.click()}>{t('ov.media.upload')}</button>
      </div>
      {uploading !== null && (
        <div className="status">{t('ov.media.uploading', { name: uploading.name, pct: Math.round(uploading.fraction * 100) })}</div>
      )}
      <div className="ov-row">
        <input
          type="text"
          value={path}
          placeholder={t('ov.media.importPlaceholder')}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && path.trim() !== '') {
              void store.importPath(path.trim())
              setPath('')
            }
          }}
        />
        <button
          className="secondary"
          disabled={path.trim() === ''}
          onClick={() => {
            void store.importPath(path.trim())
            setPath('')
          }}
        >
          {t('ov.media.import')}
        </button>
      </div>
      <div className="sub">{t('ov.media.importPath')}</div>

      {state.assets.length === 0 && <div className="status">{t('ov.media.empty')}</div>}
      <input ref={vttRef} type="file" accept=".vtt,text/vtt" style={{ display: 'none' }} onChange={(e) => void onVtt(e.target.files)} />
      <ul className="ov-list">
        {state.assets.map((asset) => (
          <li key={asset.id} className="ov-item">
            <span className="ov-item-icon">{kindIcon(asset)}</span>
            <span className="ov-item-main">
              <span className="ov-item-name" title={asset.name}>{asset.name}</span>
              <span className="ov-item-sub">
                {asset.duration !== null ? t('ov.media.duration', { dur: asset.duration.toFixed(1) }) : t('ov.media.unknownDuration')}
                {' · '}
                {fmtBytes(asset.size)}
                {asset.hasTranscript ? ` · ${t('ov.media.hasTranscript')}` : ''}
                {decodeState[asset.id] === 'fail' && (
                  <span className="ov-badge-warn" title={t('ov.media.undecodableHint')}>⚠ {t('ov.media.undecodable')}</span>
                )}
              </span>
            </span>
            <span className="ov-item-actions">
              <button className="ov-mini" title={t('ov.media.addMain')} onClick={() => store.addAssetToMain(asset)}>＋</button>
              {asset.contentType.startsWith('audio/') && (
                <button className="ov-mini" title={t('ov.media.addAudio')} onClick={() => store.addAssetToAudio(asset)}>♪</button>
              )}
              {asset.contentType.startsWith('video/') && (
                <button
                  className="ov-mini"
                  title={t('ov.media.transcript')}
                  onClick={() => {
                    setVttTarget(asset.id)
                    vttRef.current?.click()
                  }}
                >
                  文
                </button>
              )}
              <button className="ov-mini ov-mini-danger" title={t('ov.media.remove')} onClick={() => void store.removeAsset(asset.id)}>✕</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
