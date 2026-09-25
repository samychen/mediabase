// Media panel (sidebar): the library — upload from the browser (chunked over
// the control plane), import a host-local path, attach transcript sidecars,
// and put assets on the timeline. Bytes never travel here: the list is
// metadata, playback and export pull them from the asset's data-plane route.

import { useRef, useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useI18n } from '@mediabase/i18n'
import { useEditor } from '../use-editor.ts'
import type { AssetRow } from '../store.ts'
import { IconCaptions, IconFilm, IconImage, IconMusic, IconPlus, IconTrash, IconUpload } from '../icons.tsx'

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`
  return `${n} B`
}

function KindIcon({ asset }: { asset: AssetRow }): ReactElement {
  if (asset.contentType.startsWith('video/')) return <IconFilm size={14} />
  if (asset.contentType.startsWith('image/')) return <IconImage size={14} />
  if (asset.contentType.startsWith('audio/')) return <IconMusic size={14} />
  return <IconCaptions size={14} />
}

export function MediaPanel({ ctx }: { ctx: Context }): ReactElement | null {
  const editor = useEditor(ctx)
  const { t } = useI18n(ctx)
  const fileRef = useRef<HTMLInputElement>(null)
  const vttRef = useRef<HTMLInputElement>(null)
  const [vttTarget, setVttTarget] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
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
        <button onClick={() => fileRef.current?.click()}><IconUpload size={13} />{t('ov.media.upload')}</button>
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
      <div className="ov-row">
        <input
          type="text"
          value={url}
          placeholder={t('ov.media.urlPlaceholder')}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim() !== '' && !fetching) {
              const u = url.trim()
              setUrl('')
              setFetching(true)
              void store.fetchUrl(u).finally(() => setFetching(false))
            }
          }}
        />
        <button
          className="secondary"
          disabled={url.trim() === '' || fetching}
          onClick={() => {
            const u = url.trim()
            setUrl('')
            setFetching(true)
            void store.fetchUrl(u).finally(() => setFetching(false))
          }}
        >
          {fetching ? '…' : t('ov.media.fetch')}
        </button>
      </div>
      <div className="sub">{t('ov.media.addUrl')}</div>

      {state.assets.length === 0 && <div className="status">{t('ov.media.empty')}</div>}
      <input ref={vttRef} type="file" accept=".vtt,text/vtt" style={{ display: 'none' }} onChange={(e) => void onVtt(e.target.files)} />
      <ul className="ov-list">
        {state.assets.map((asset) => (
          <li key={asset.id} className="ov-item">
            <span className="ov-item-icon"><KindIcon asset={asset} /></span>
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
                {asset.proxy?.status === 'ready' && (
                  <span className="ov-badge">{t('ov.media.proxyReady')}</span>
                )}
                {asset.proxy?.status === 'running' && (
                  <span className="ov-item-sub">
                    {t('ov.media.proxyRunning', { pct: Math.round((asset.proxy.progress ?? 0) * 100) })}
                  </span>
                )}
                {asset.proxy?.status === 'queued' && (
                  <span className="ov-item-sub">{t('ov.media.proxyQueued')}</span>
                )}
                {asset.proxy?.status === 'failed' && (
                  <span className="ov-badge-warn" title={asset.proxy.error ?? ''}>⚠ {t('ov.media.proxyFailedBadge')}</span>
                )}
              </span>
            </span>
            <span className="ov-item-actions">
              <button className="ov-mini" title={t('ov.media.addMain')} onClick={() => store.addAssetToMain(asset)}><IconPlus size={12} /></button>
              {asset.contentType.startsWith('audio/') && (
                <button className="ov-mini" title={t('ov.media.addAudio')} onClick={() => store.addAssetToAudio(asset)}><IconMusic size={12} /></button>
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
                  <IconCaptions size={12} />
                </button>
              )}
              {asset.contentType.startsWith('video/') && decodeState[asset.id] === 'fail'
                && (asset.proxy === undefined || asset.proxy.status === 'none' || asset.proxy.status === 'failed') && (
                <button className="ov-mini" title={t('ov.media.proxyHint')} onClick={() => void store.ensureProxy(asset.id)}>
                  {t('ov.media.proxy')}
                </button>
              )}
              {asset.contentType.startsWith('video/')
                && (asset.proxy?.status === 'running' || asset.proxy?.status === 'queued') && (
                <button className="ov-mini" title={t('ov.media.proxyCancel')} onClick={() => void store.cancelProxy(asset.id)}>⏹</button>
              )}
              <button className="ov-mini ov-mini-danger" title={t('ov.media.remove')} onClick={() => void store.removeAsset(asset.id)}><IconTrash size={12} /></button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
