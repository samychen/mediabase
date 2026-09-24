// The product's storage: a media library and a project shelf, both plain
// files under the identity home (`~/.openvideo` by default).
//
// The upstream app kept these in D1 rows and R2 objects; a local host keeps
// them where the user can see them — the project document is the same plain
// JSON either way, which is the whole point of the EDL:
//
//   <mediaDir>/<assetId><ext>        the asset's bytes
//   <mediaDir>/assets.json           the library index (AssetRow[])
//   <mediaDir>/transcripts/<id>.vtt  an attached transcript sidecar
//   <projectDir>/<projectId>.json    one project: { id, name, brief, edl, … }
//
// Writes are atomic (tmp + rename) so a killed host cannot leave a half
// document behind; the index is read fresh on every mutation, so two hosts
// over one directory degrade to last-writer-wins instead of corrupting.

import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Edl } from '@openvideo/edl'

/** One library entry — the row the API answers with. */
export interface AssetRow {
  /** 16-hex id; projects reference the file as "asset:<id>". */
  id: string
  /** File name under the media dir (id + the original extension). */
  key: string
  name: string
  contentType: string
  size: number
  createdAt: string
  /** Seconds, probed by the client from media metadata; null until known. */
  duration: number | null
  hasTranscript: boolean
}

export interface ProjectSummary {
  id: string
  name: string
  brief: string
  createdAt: string
  updatedAt: string
  /** The first main-track clip's asset id (the project's cover), or null. */
  coverAsset: string | null
  /** Where in that source the cover frame sits. */
  coverAt: number | null
}

export interface ProjectRow extends ProjectSummary {
  edl: Edl
}

const newAssetId = (): string => randomBytes(8).toString('hex')
const newProjectId = (): string => randomBytes(8).toString('hex')
const nowIso = (): string => new Date().toISOString()

/** Extensions the library keeps, so a key can be served with its own name. */
const safeExt = (name: string): string => {
  const ext = extname(name).toLowerCase()
  return /^[.][a-z0-9]{1,8}$/.test(ext) ? ext : ''
}

export function guessContentType(name: string): string {
  const ext = extname(name).toLowerCase()
  const table: Record<string, string> = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  }
  return table[ext] ?? 'application/octet-stream'
}

export interface StoreOptions {
  mediaDir: string
  projectDir: string
}

export class MediaStore {
  private readonly mediaDir: string
  private readonly projectDir: string
  private readonly indexFile: string
  private readonly transcriptDir: string

  constructor(opts: StoreOptions) {
    this.mediaDir = opts.mediaDir
    this.projectDir = opts.projectDir
    this.indexFile = join(opts.mediaDir, 'assets.json')
    this.transcriptDir = join(opts.mediaDir, 'transcripts')
  }

  ensure(): void {
    mkdirSync(this.mediaDir, { recursive: true })
    mkdirSync(this.projectDir, { recursive: true })
    mkdirSync(this.transcriptDir, { recursive: true })
  }

  // ---- assets --------------------------------------------------------------

  private readIndex(): AssetRow[] {
    if (!existsSync(this.indexFile)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as unknown
      return Array.isArray(parsed) ? (parsed as AssetRow[]) : []
    } catch {
      // A corrupt index must not wedge the host: report empty, keep the file
      // for the user to inspect (never overwrite what we cannot parse).
      return []
    }
  }

  private writeIndex(rows: readonly AssetRow[]): void {
    this.atomicWrite(this.indexFile, JSON.stringify(rows, null, 2))
  }

  listAssets(): AssetRow[] {
    return this.readIndex().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getAsset(id: string): AssetRow | null {
    return this.readIndex().find((a) => a.id === id) ?? null
  }

  assetPath(row: Pick<AssetRow, 'key'>): string {
    return join(this.mediaDir, row.key)
  }

  /** Adopt an already-written file (an upload's tmp, or a copy) as an asset. */
  addAsset(meta: { name: string; contentType: string; size: number; duration: number | null }, fromPath: string): AssetRow {
    const id = newAssetId()
    const key = `${id}${safeExt(meta.name)}`
    const dest = join(this.mediaDir, key)
    renameSync(fromPath, dest)
    const row: AssetRow = {
      id,
      key,
      name: meta.name,
      contentType: meta.contentType,
      size: meta.size,
      createdAt: nowIso(),
      duration: meta.duration,
      hasTranscript: false,
    }
    const rows = this.readIndex()
    rows.push(row)
    this.writeIndex(rows)
    return row
  }

  /** Copy a host-local file into the library (the "import by path" door). */
  importFile(path: string, duration: number | null): AssetRow {
    const name = path.split(/[\\/]/).pop() ?? 'media'
    const id = newAssetId()
    const key = `${id}${safeExt(name)}`
    copyFileSync(path, join(this.mediaDir, key))
    const row: AssetRow = {
      id,
      key,
      name,
      contentType: guessContentType(name),
      size: statSync(join(this.mediaDir, key)).size,
      createdAt: nowIso(),
      duration,
      hasTranscript: false,
    }
    const rows = this.readIndex()
    rows.push(row)
    this.writeIndex(rows)
    return row
  }

  removeAsset(id: string): void {
    const row = this.getAsset(id)
    this.writeIndex(this.readIndex().filter((a) => a.id !== id))
    if (row !== null) {
      rmSync(this.assetPath(row), { force: true })
      rmSync(this.transcriptPath(id), { force: true })
    }
  }

  setDuration(id: string, duration: number): AssetRow | null {
    const rows = this.readIndex()
    const row = rows.find((a) => a.id === id)
    if (row === undefined) return null
    row.duration = duration
    this.writeIndex(rows)
    return row
  }

  // ---- transcripts (caption words; a user-attached .vtt sidecar) -----------

  transcriptPath(id: string): string {
    return join(this.transcriptDir, `${id}.vtt`)
  }

  setTranscript(id: string, vtt: string): void {
    this.atomicWrite(this.transcriptPath(id), vtt)
    const rows = this.readIndex()
    const row = rows.find((a) => a.id === id)
    if (row !== undefined) {
      row.hasTranscript = true
      this.writeIndex(rows)
    }
  }

  getTranscript(id: string): string | null {
    const file = this.transcriptPath(id)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }

  // ---- projects ------------------------------------------------------------

  listProjects(): ProjectSummary[] {
    const out: ProjectSummary[] = []
    for (const file of this.projectFiles()) {
      const project = this.readProjectFile(file)
      if (project !== null) out.push(summaryOf(project))
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getProject(id: string): ProjectRow | null {
    const file = join(this.projectDir, `${id}.json`)
    return existsSync(file) ? this.readProjectFile(file) : null
  }

  createProject(input: { name: string; brief?: string; edl: Edl }): ProjectRow {
    const id = newProjectId()
    const stamp = nowIso()
    const row: ProjectRow = {
      id,
      name: input.name,
      brief: input.brief ?? '',
      createdAt: stamp,
      updatedAt: stamp,
      coverAsset: null,
      coverAt: null,
      edl: input.edl,
    }
    this.saveProject(row)
    return row
  }

  saveProject(row: ProjectRow): void {
    const withCover = { ...row, ...coverOf(row.edl) }
    this.atomicWrite(join(this.projectDir, `${row.id}.json`), JSON.stringify(withCover, null, 2))
  }

  removeProject(id: string): void {
    rmSync(join(this.projectDir, `${id}.json`), { force: true })
  }

  /** Names of the projects whose EDL references "asset:<id>". */
  projectsUsingAsset(id: string): string[] {
    const needle = `asset:${id}`
    const out: string[] = []
    for (const file of this.projectFiles()) {
      const project = this.readProjectFile(file)
      if (project !== null && JSON.stringify(project.edl).includes(needle)) out.push(project.name)
    }
    return out
  }

  private projectFiles(): string[] {
    if (!existsSync(this.projectDir)) return []
    return readdirSync(this.projectDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(this.projectDir, f))
  }

  private readProjectFile(file: string): ProjectRow | null {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProjectRow
      if (typeof parsed?.id !== 'string' || parsed.edl === undefined) return null
      return parsed
    } catch {
      return null
    }
  }

  private atomicWrite(file: string, content: string): void {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, content)
    renameSync(tmp, file)
  }
}

function summaryOf(row: ProjectRow): ProjectSummary {
  const { id, name, brief, createdAt, updatedAt, coverAsset, coverAt } = row
  return { id, name, brief, createdAt, updatedAt, coverAsset, coverAt }
}

/** The first main-track clip is the project's cover. */
function coverOf(edl: Edl): { coverAsset: string | null; coverAt: number | null } {
  const first = edl.main.elements[0]
  if (first === undefined || !first.src.startsWith('asset:')) return { coverAsset: null, coverAt: null }
  return { coverAsset: first.src.slice(6), coverAt: first.trimStart ?? 0 }
}
