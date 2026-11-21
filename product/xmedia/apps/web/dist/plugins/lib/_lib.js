// 插件公共小工具 —— 各视图插件可 `import { … } from './lib/_lib.js'`。
// 刻意保持极小：样式与组件类来自壳（index.html），这里只放纯函数。
// fmtBytes/shortId/fmtDay/fmtClock/fmtDur/tracksSummary/entryDurationMs

/** Sleep helper for polling/retry loops. */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Shorten a long path for a table cell (keep the tail, which names the file). */
export const shortPath = (p) => (p.length > 34 ? '…' + p.slice(-33) : p)

/** Human bytes. */
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** A session id shortened for a table cell. */
export function shortId(id) {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

/** 'video:H264 audio:AAC' style track summary. */
export function tracksSummary(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return '—'
  return tracks.map((tr) => `${tr.type}:${tr.codec}`).join(' ')
}

const pad = (n) => String(n).padStart(2, '0')

/** The local calendar day of an RFC3339 timestamp ('2026-09-26'), or the raw string. */
export function fmtDay(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The local clock time of an RFC3339 timestamp ('14:03:07'), or the raw string. */
export function fmtClock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Human duration: '42s', '5:03', '1:02:03'. */
export function fmtDur(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** One playback window's wall duration in ms (junk/negative counts as zero). */
export function entryDurationMs(entry) {
  return Number.isFinite(entry?.durationSeconds) && entry.durationSeconds > 0
    ? entry.durationSeconds * 1000
    : 0
}
