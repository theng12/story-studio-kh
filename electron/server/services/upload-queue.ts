/**
 * Project-level Upload Queue — non-episode items (trailers, bumpers,
 * shorts) that live in a dedicated folder alongside the episodes but
 * flow through the same Upload Center UI.
 *
 * Folder: `{project.output_root}/Upload Queue/`
 * Each entry: a video file + an optional `.meta.json` sidecar carrying
 * title / description / tags. First-time scan registers new entries in
 * `config.upload_sequence` with the next available position.
 *
 * The sequence is a unified flat list (episodes + imports) so drag-to-
 * reorder can interleave both types — Phase 5 wires episode reordering
 * on top of the same map.
 */

import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths } from './utils.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

/**
 * Reject filenames that contain path separators or traversal tokens.
 * Routes pass user-supplied filenames through to fsp operations — the
 * queue folder is a user-writable location, so a crafted `../evil.json`
 * could escape the folder and touch files elsewhere. Enforced at the
 * service layer so every caller is covered.
 */
function assertSafeFilename(name: string): void {
  if (!name || typeof name !== 'string') throw new Error('filename required')
  if (name.includes('/') || name.includes('\\')) throw new Error('filename may not contain path separators')
  if (name === '.' || name === '..' || name.startsWith('..') || name.includes('/..') || name.includes('\\..')) {
    throw new Error('filename may not reference parent directories')
  }
  if (name.includes('\0')) throw new Error('filename may not contain null bytes')
}

// Match the import-scan filter — tight enough to avoid junk files but
// broad enough for the four containers YouTube accepts.
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v'])

export const UPLOAD_QUEUE_FOLDER = 'Upload Queue'
export const EPISODE_IMPORT_FOLDER = 'Imported'

/**
 * id shapes: `ep:{episode_code}` for episode rows, `import:{filename}` for
 * project-level queue items. Callers rely on the prefix; don't change it
 * without a migration.
 */
export type QueueItemType = 'episode' | 'import'
export type QueueItemId = string

export interface QueueItemMeta {
  title?: string
  description?: string
  tags?: string[]
  /** Populated by the future "Metadata generator lite" pass. */
  notes?: string
}

export interface UploadSequenceMap {
  [id: QueueItemId]: number
}

/**
 * Path helpers. Folder is created lazily on first scan — we don't want
 * to litter new projects with an empty `Upload Queue` directory unless
 * the user actually opens the Upload Center.
 */
async function getQueueFolder(slug: string): Promise<string | null> {
  const root = await pm.getProjectOutputRoot(slug)
  if (!root) return null
  return path.join(root, UPLOAD_QUEUE_FOLDER)
}

export async function ensureQueueFolder(slug: string): Promise<string | null> {
  const folder = await getQueueFolder(slug)
  if (!folder) return null
  await fsp.mkdir(folder, { recursive: true })
  return folder
}

// ── Sequence persistence ─────────────────────────────────────────────────

export async function readSequence(slug: string): Promise<UploadSequenceMap> {
  const config = (await pm.getConfig(slug)) as any
  const seq = config?.upload_sequence
  if (!seq || typeof seq !== 'object') return {}
  // Guard against legacy array shapes — convert to map on read.
  if (Array.isArray(seq)) {
    const out: UploadSequenceMap = {}
    seq.forEach((entry: any, i: number) => {
      if (entry && typeof entry.id === 'string') {
        out[entry.id] = typeof entry.position === 'number' ? entry.position : i
      }
    })
    return out
  }
  return seq
}

export async function writeSequence(slug: string, map: UploadSequenceMap): Promise<void> {
  await pm.updateConfig(slug, { upload_sequence: map } as any)
}

/** Next position = highest existing + 1. Zero when the map is empty. */
function nextPosition(map: UploadSequenceMap): number {
  const values = Object.values(map)
  if (!values.length) return 0
  return Math.max(...values) + 1
}

// ── Import metadata sidecar ──────────────────────────────────────────────

function metaPathFor(filePath: string): string {
  return `${filePath}.meta.json`
}

export async function readImportMeta(filePath: string): Promise<QueueItemMeta | null> {
  const p = metaPathFor(filePath)
  if (!existsSync(p)) return null
  try {
    const raw = await fsp.readFile(p, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function writeImportMeta(filePath: string, meta: QueueItemMeta): Promise<void> {
  // filePath comes from the route layer which joins a user-supplied filename
  // with the queue folder; re-check the final path is inside that folder as
  // a defense-in-depth layer against a traversal that slipped past the
  // filename validator (e.g. a future caller that bypassed it).
  await writeJsonAtomic(metaPathFor(filePath), meta)
}

// ── Scan ────────────────────────────────────────────────────────────────

export interface ScanResult {
  folder: string
  discovered: Array<{
    id: QueueItemId
    filename: string
    file_path: string
    position: number
    is_new: boolean
    // Best-effort metadata preview (sidecar if present, else filename-derived title)
    title: string
    tags: string[]
    // Best-effort size from fs.stat. 0 if unreadable; the route surfaces this
    // to the UI so destructive confirms can warn about big files (e.g. 4 GB MP4).
    size_bytes: number
  }>
  missing: Array<{ id: QueueItemId; filename: string; position: number }>
}

/**
 * Walk the Upload Queue folder, register any new video files in the
 * sequence, and return the full catalogue. Also detects items that are
 * in the sequence but whose underlying file is gone ("missing") so the
 * UI can warn + offer removal.
 *
 * Filesystem → config is one-way — we don't delete sequence entries on
 * scan (user may have temporarily moved a file). Explicit removal goes
 * through `removeImport` below.
 */
export async function scanImports(slug: string): Promise<ScanResult> {
  const folder = await ensureQueueFolder(slug)
  if (!folder) throw new Error('Project output root not configured.')

  const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => [])
  const seq = await readSequence(slug)
  let dirty = false

  const discovered: ScanResult['discovered'] = []
  const present = new Set<string>()

  // Sort filenames ASCII-asc so a fresh scan assigns predictable positions
  // (not whatever order the OS returned). Users can reorder afterwards.
  const files = entries
    .filter(e => e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  for (const filename of files) {
    const id = `import:${filename}`
    present.add(id)
    let position: number
    let is_new = false
    if (id in seq) {
      position = seq[id]!
    } else {
      position = nextPosition(seq)
      seq[id] = position
      dirty = true
      is_new = true
    }
    const file_path = path.join(folder, filename)
    const meta = await readImportMeta(file_path)
    let size_bytes = 0
    try { size_bytes = (await fsp.stat(file_path)).size } catch { /* unreadable — leave 0 */ }
    discovered.push({
      id,
      filename,
      file_path,
      position,
      is_new,
      title: meta?.title || titleFromFilename(filename),
      tags: Array.isArray(meta?.tags) ? meta!.tags! : [],
      size_bytes,
    })
  }

  // Missing = in sequence but not on disk AND id starts with `import:`.
  const missing: ScanResult['missing'] = []
  for (const id of Object.keys(seq)) {
    if (!id.startsWith('import:')) continue
    if (!present.has(id)) {
      missing.push({ id, filename: id.slice('import:'.length), position: seq[id]! })
    }
  }

  if (dirty) await writeSequence(slug, seq)

  // Sort discovered by stored position so callers can render directly.
  discovered.sort((a, b) => a.position - b.position)
  return { folder, discovered, missing }
}

export async function removeImport(slug: string, filename: string, deleteFile: boolean): Promise<boolean> {
  assertSafeFilename(filename)
  const id = `import:${filename}`
  const seq = await readSequence(slug)
  if (!(id in seq)) return false
  delete seq[id]
  await writeSequence(slug, seq)
  if (deleteFile) {
    const folder = await getQueueFolder(slug)
    if (folder) {
      const fp = path.join(folder, filename)
      // Defense-in-depth: even though assertSafeFilename rejected '/' and '..',
      // verify the resolved path is still inside the queue folder before
      // unlinking. If someone passed a symlink as a filename — or the
      // filesystem has quirks — this catches it.
      const resolved = path.resolve(fp)
      const resolvedFolder = path.resolve(folder)
      if (!resolved.startsWith(resolvedFolder + path.sep) && resolved !== resolvedFolder) {
        throw new Error('Resolved path escapes the upload queue folder')
      }
      await fsp.rm(resolved, { force: true }).catch(() => {})
      await fsp.rm(metaPathFor(resolved), { force: true }).catch(() => {})
    }
  }
  return true
}

export async function reorder(slug: string, ordered_ids: QueueItemId[]): Promise<void> {
  const seq = await readSequence(slug)
  // Assign positions starting at 0. Ids not in `ordered_ids` keep their
  // current position + an offset = max(ordered) + 1 so they land at the end.
  const newSeq: UploadSequenceMap = {}
  ordered_ids.forEach((id, i) => { newSeq[id] = i })
  const maxInOrdered = ordered_ids.length
  let tail = maxInOrdered
  for (const id of Object.keys(seq)) {
    if (!(id in newSeq)) newSeq[id] = tail++
  }
  await writeSequence(slug, newSeq)
}

// ── Per-episode Imported/ scan (Phase 5) ──────────────────────────────
// Separate flow from the project-level queue folder. Drop an externally-
// rendered episode video into `{episode}/Imported/`, run scan, and it
// moves into `{episode}/video/` as the canonical `{code}_final_video.ext`
// that the broadened detection in asset-status.ts picks up.

export interface EpisodeScanResult {
  episode_code: string
  imported_folder: string
  target_folder: string
  /** Files moved into the episode's video/ dir as canonical finals. */
  moved: Array<{ from: string; to: string }>
  /** Files in Imported/ that weren't video files (skipped). */
  skipped: string[]
}

/**
 * Resolve the `{episode}/Imported/` path, creating it if missing. Callers
 * use this both to open-in-Finder (UI) and to enumerate before scanning.
 */
export async function ensureEpisodeImportFolder(slug: string, code: string): Promise<string> {
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '') === code)
  if (!idea) throw new Error(`Accepted episode ${code} not found`)
  const paths = await resolveEpisodePaths(slug, code, idea.title || '')
  const folder = path.join(paths.episode_dir, EPISODE_IMPORT_FOLDER)
  await fsp.mkdir(folder, { recursive: true })
  return folder
}

/**
 * Scan an episode's Imported/ folder, move any video files into the
 * episode's `video/` dir as `{code}_final_video.{ext}`. If a final video
 * with the same ext already exists, suffixes with `_v2`, `_v3`, etc. so
 * the new drop never silently overwrites prior output.
 */
export async function scanEpisodeImports(slug: string, code: string): Promise<EpisodeScanResult> {
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '') === code)
  if (!idea) throw new Error(`Accepted episode ${code} not found`)
  const paths = await resolveEpisodePaths(slug, code, idea.title || '')
  const importedFolder = path.join(paths.episode_dir, EPISODE_IMPORT_FOLDER)
  await fsp.mkdir(importedFolder, { recursive: true })
  await fsp.mkdir(paths.video_dir, { recursive: true })

  const entries = await fsp.readdir(importedFolder, { withFileTypes: true })
  const moved: Array<{ from: string; to: string }> = []
  const skipped: string[] = []

  // Pre-scan the video_dir to figure out the starting version number so
  // multiple drops in one scan don't all land on the same filename.
  const existingVersions = await readExistingFinalVersions(paths.video_dir, code)

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!VIDEO_EXTS.has(ext)) {
      skipped.push(entry.name)
      continue
    }
    const fromPath = path.join(importedFolder, entry.name)
    const toPath = pickNextFinalPath(paths.video_dir, code, ext, existingVersions)
    await fsp.rename(fromPath, toPath).catch(async (e: any) => {
      // Cross-device rename fallback (iCloud / NAS / Dropbox sometimes
      // fail with EXDEV). Copy + unlink preserves intent, just slower.
      if (e?.code === 'EXDEV') {
        await fsp.copyFile(fromPath, toPath)
        await fsp.rm(fromPath, { force: true })
        return
      }
      throw e
    })
    moved.push({ from: fromPath, to: toPath })
  }

  return {
    episode_code: code,
    imported_folder: importedFolder,
    target_folder: paths.video_dir,
    moved,
    skipped,
  }
}

async function readExistingFinalVersions(videoDir: string, code: string): Promise<Set<string>> {
  try {
    const files = await fsp.readdir(videoDir)
    return new Set(files.filter(f => f.toLowerCase().startsWith(`${code.toLowerCase()}_final_video`)))
  } catch {
    return new Set()
  }
}

function pickNextFinalPath(videoDir: string, code: string, ext: string, existing: Set<string>): string {
  // Canonical name first (matches the detection without any version suffix).
  const canonical = `${code}_final_video${ext}`
  if (!existing.has(canonical)) {
    existing.add(canonical)
    return path.join(videoDir, canonical)
  }
  // Otherwise _v2, _v3, ...
  let v = 2
  while (existing.has(`${code}_final_video_v${v}${ext}`)) v++
  const versioned = `${code}_final_video_v${v}${ext}`
  existing.add(versioned)
  return path.join(videoDir, versioned)
}

/**
 * Derive a default title from a filename. Strips the extension, replaces
 * underscores/hyphens with spaces, and trims leading sequence numbers if
 * present (`001_Intro.mp4` → `Intro`).
 */
export function titleFromFilename(name: string): string {
  const noExt = name.replace(/\.[^.]+$/, '')
  const noSeq = noExt.replace(/^\d{1,4}[_\-\s]+/, '')
  return noSeq.replace(/[_\-]+/g, ' ').trim() || noExt
}
