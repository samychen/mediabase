// Tiny formatters shared by panels. No dependencies, no locale tricks — a
// console shows engineers numbers.

export function fmtBytes(n: number): string {
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

export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

export function tracksSummary(tracks: Array<{ type: string; codec: string }>): string {
  if (tracks.length === 0) return '—'
  return tracks.map((tr) => `${tr.type}:${tr.codec}`).join(' ')
}
