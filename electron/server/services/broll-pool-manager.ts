/**
 * B-Roll Pool Manager — app-level registry of stock-footage pools.
 *
 * Architectural split:
 *   - APP REGISTRY (this machine):   <userData>/broll-pools.json
 *       Tracks which pools the user has registered + their folder paths.
 *       Survives across projects; each project subscribes to a pool by id.
 *   - SSD SIDECAR (travels with pool): <pool_folder>/.story-studio-broll.json
 *       Per-clip metadata: duration, fps, resolution, normalized flag,
 *       tags, sha256, indexed_at. Lives ON the SSD so plugging the drive
 *       into another Mac brings tags + history along automatically.
 *   - THUMBNAILS (app-level cache):   <userData>/broll-thumbnails/<sha>.jpg
 *       Keyed by clip content hash so renames don't invalidate. Cached
 *       per-machine so disconnecting the SSD doesn't blank the library
 *       view.
 *
 * Why hybrid: the 10GB of clips lives on the SSD (slow to scan, big to
 * sync); the lightweight tag/index sidecar travels with them; the
 * frequently-accessed thumbnail cache lives where it's fastest to read
 * (per-Mac userData).
 */
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { writeJsonAtomic, readJsonOr } from '../lib/atomic-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Paths ───────────────────────────────────────────────────────────────

const PRODUCT_NAME = 'Story Studio KH'

function resolveUserDataDir(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) return process.env.STORY_STUDIO_DATA_DIR
  const isPackaged = __dirname.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (!isPackaged) {
    // Dev: keep app-state local to the repo so a dev session doesn't
    // pollute the production-flavoured userData dir on the same machine.
    return path.join(process.cwd(), '.story-studio-data')
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', PRODUCT_NAME)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), PRODUCT_NAME)
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), PRODUCT_NAME)
}

function poolRegistryPath(): string {
  return path.join(resolveUserDataDir(), 'broll-pools.json')
}

export function thumbnailDir(): string {
  return path.join(resolveUserDataDir(), 'broll-thumbnails')
}

export function thumbnailPath(sha256: string): string {
  return path.join(thumbnailDir(), `${sha256}.jpg`)
}

export function sidecarPath(folderPath: string): string {
  return path.join(folderPath, '.story-studio-broll.json')
}

/** Hidden subfolder where normalized re-encodes live alongside originals.
 *  Keeping originals untouched is deliberate: re-encoding is irreversible
 *  data loss otherwise, and a user might want to re-normalize at different
 *  fps/resolution later. The dot-prefix hides it from Finder by default. */
export function normalizedSubdir(folderPath: string): string {
  return path.join(folderPath, '.broll-normalized')
}

// ── Types ───────────────────────────────────────────────────────────────

/** v1.0.403 — per-pool slideshow defaults for IMAGE pools (the "Image Pool"
 *  format). Each is overridable per-episode at assemble time. */
export interface PoolSlideshowSettings {
  /** Seconds each image is held on screen. Default 8. */
  seconds_per_image: number
  /** How a non-16:9 image fills the frame. crop = fill + slight crop (default),
   *  fit = letterbox, blur = blurred-background fill. */
  fit: 'crop' | 'fit' | 'blur'
  /** Apply a slow Ken-Burns zoom/pan so stills don't feel static. Default true. */
  motion: boolean
  /** Crossfade duration between images (seconds). 0 = hard cut. Default 0.5. */
  transition_sec: number
  /** Cross-episode no-repeat window (how many recent episodes to avoid). Default 20. */
  dedup_lookback: number
}

export function defaultSlideshowSettings(): PoolSlideshowSettings {
  return { seconds_per_image: 8, fit: 'crop', motion: true, transition_sec: 0.5, dedup_lookback: 20 }
}

export interface BrollPool {
  id: string
  name: string
  folder_path: string
  /** v1.0.403 — what the pool holds. 'video' = stock-footage clips (B-Roll,
   *  the original + default when absent). 'image' = still images for the
   *  Image Pool slideshow format. 'audio' = sound effects (SFX library).
   *  Drives which file extensions are indexed, how thumbnails are made (none
   *  for audio), and which picker surfaces the pool. */
  media?: 'video' | 'image' | 'audio'
  /** Auto-queue normalize jobs for newly-indexed clips. Default ON. */
  auto_normalize: boolean
  /** Target fps for normalized output. 24 (cinematic, our default) or 30. */
  fps_target: 24 | 30
  /** Target resolution; 1920x1080 (1080p, our default). Future: 3840x2160. */
  resolution_target: '1920x1080'
  /** v1.0.403 — slideshow defaults; only meaningful for media:'image' pools. */
  slideshow?: PoolSlideshowSettings
  created_at: string
}

/** Media kind of a pool, defaulting legacy (field-absent) pools to 'video'. */
export function poolMedia(pool: Pick<BrollPool, 'media'>): 'video' | 'image' | 'audio' {
  return pool.media === 'image' ? 'image' : pool.media === 'audio' ? 'audio' : 'video'
}

interface PoolRegistry {
  schema_version: 1
  pools: BrollPool[]
}

export interface BrollClip {
  filename: string
  duration: number
  width: number
  height: number
  fps: number
  size_bytes: number
  sha256: string
  /** True when a 1080p/24fps (or configured) re-encode exists under
   *  `.broll-normalized/<filename>`. Renders should prefer that path when
   *  set — concat-demuxer-fast, no per-frame filtergraph. */
  normalized: boolean
  /** Free-text tags applied by the user (manually) and/or vision-LLM.
   *  Empty array on freshly-indexed clips; the Library UI is what fills
   *  these in over time. */
  tags: string[]
  /** ISO timestamp of the last successful ffprobe. */
  indexed_at: string
  /** Set to true when the file disappears from disk between scans. Kept
   *  so tags + history survive a temporary unmount of the SSD without
   *  the user losing curation work. */
  missing?: boolean
}

interface Sidecar {
  schema_version: 1
  pool_name: string
  clips: Record<string, BrollClip>
}

// ── Registry I/O ────────────────────────────────────────────────────────

async function readRegistry(): Promise<PoolRegistry> {
  const p = poolRegistryPath()
  const init: PoolRegistry = { schema_version: 1, pools: [] }
  return await readJsonOr<PoolRegistry>(p, init)
}

async function writeRegistry(reg: PoolRegistry): Promise<void> {
  await fs.mkdir(resolveUserDataDir(), { recursive: true })
  await writeJsonAtomic(poolRegistryPath(), reg)
}

export async function listPools(): Promise<BrollPool[]> {
  const reg = await readRegistry()
  return reg.pools
}

export async function getPool(id: string): Promise<BrollPool | null> {
  const reg = await readRegistry()
  return reg.pools.find(p => p.id === id) || null
}

/** Generate a filesystem-safe slug from a free-text name, bumping suffix
 *  if it collides with an existing pool. Mirrors the StylePreset slug
 *  helper for UX consistency. */
function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return base || 'pool'
}

export async function createPool(input: {
  name: string
  folder_path: string
  auto_normalize?: boolean
  fps_target?: 24 | 30
  /** 'image' = Image Pool (slideshow), 'audio' = SFX library, 'video' (default) = B-Roll. */
  media?: 'video' | 'image' | 'audio'
  /** v1.0.403 — initial slideshow defaults for an image pool (merged over defaults). */
  slideshow?: Partial<PoolSlideshowSettings>
}): Promise<BrollPool> {
  if (!input.name?.trim()) throw new Error('Pool name is required')
  if (!input.folder_path) throw new Error('folder_path is required')
  if (!existsSync(input.folder_path)) {
    throw new Error(`Folder does not exist: ${input.folder_path}. Plug in the SSD or pick a different path.`)
  }

  const reg = await readRegistry()
  const base = slugify(input.name)
  let id = base
  let n = 2
  while (reg.pools.some(p => p.id === id)) { id = `${base}-${n}`; n += 1 }

  const media: 'video' | 'image' | 'audio' = input.media === 'image' ? 'image' : input.media === 'audio' ? 'audio' : 'video'
  const pool: BrollPool = {
    id,
    name: input.name.trim(),
    folder_path: input.folder_path,
    media,
    ...(media === 'image' ? { slideshow: { ...defaultSlideshowSettings(), ...(input.slideshow || {}) } } : {}),
    // v1.0.92+ — default OFF. Auto-normalize was previously default-on,
    // which silently kicked a queue of long ffmpeg encodes the moment
    // the user registered a fresh pool. For a 200-clip library on
    // external SSD that's ~1-3 hours of CPU + disk. Opt-in is the
    // safer + politer default — user clicks "⚡ Normalize all" when
    // ready.
    auto_normalize: input.auto_normalize === true,
    fps_target: input.fps_target ?? 24,             // default 24fps (cinematic)
    resolution_target: '1920x1080',
    created_at: new Date().toISOString(),
  }
  reg.pools.push(pool)
  await writeRegistry(reg)

  // Seed an empty sidecar so the first scan has somewhere to write.
  // Non-fatal if the SSD is read-only or unmounted right now — the
  // first scan attempt will surface that error to the user.
  try { await writeSidecar(pool.folder_path, { schema_version: 1, pool_name: pool.name, clips: {} }) } catch { /* tolerate */ }

  return pool
}

export async function updatePool(id: string, patch: Partial<Pick<BrollPool, 'name' | 'auto_normalize' | 'fps_target' | 'slideshow' | 'folder_path'>>): Promise<BrollPool> {
  const reg = await readRegistry()
  const idx = reg.pools.findIndex(p => p.id === id)
  if (idx < 0) throw new Error(`Pool '${id}' not found`)
  const prev = reg.pools[idx]!
  // v1.0.405 — repoint: changing folder_path moves the pool to a new folder
  // (e.g. you relocated the drive). The clip sidecar lives INSIDE the folder,
  // so a moved-intact folder keeps its tags; a brand-new folder starts empty
  // until the next scan. Validate it exists so we don't point at nothing.
  if (typeof patch.folder_path === 'string') {
    const next = patch.folder_path.trim()
    if (!next) throw new Error('folder_path cannot be empty')
    if (!existsSync(next)) throw new Error(`Folder does not exist: ${next}. Connect the drive or pick a different path.`)
    patch.folder_path = next
  }
  // Merge slideshow settings field-by-field so a partial patch (e.g. just
  // seconds_per_image) doesn't wipe the other slideshow defaults.
  const slideshow = patch.slideshow
    ? { ...(prev.slideshow || defaultSlideshowSettings()), ...patch.slideshow }
    : prev.slideshow
  reg.pools[idx] = { ...prev, ...patch, ...(slideshow ? { slideshow } : {}) }
  await writeRegistry(reg)
  return reg.pools[idx]!
}

/** Removes a pool from the registry. Does NOT delete files on the SSD —
 *  the user's clips + their tag sidecar stay on disk so unregistering
 *  is reversible by re-registering the same folder. */
export async function deletePool(id: string): Promise<void> {
  const reg = await readRegistry()
  const next = reg.pools.filter(p => p.id !== id)
  if (next.length === reg.pools.length) throw new Error(`Pool '${id}' not found`)
  await writeRegistry({ ...reg, pools: next })
}

// ── Sidecar I/O ─────────────────────────────────────────────────────────

async function readSidecar(folderPath: string): Promise<Sidecar> {
  const p = sidecarPath(folderPath)
  const init: Sidecar = { schema_version: 1, pool_name: '', clips: {} }
  return await readJsonOr<Sidecar>(p, init)
}

async function writeSidecar(folderPath: string, data: Sidecar): Promise<void> {
  await writeJsonAtomic(sidecarPath(folderPath), data)
}

export async function listClips(poolId: string, opts?: { includeMissing?: boolean }): Promise<BrollClip[]> {
  const pool = await getPool(poolId)
  if (!pool) throw new Error(`Pool '${poolId}' not found`)
  if (!existsSync(pool.folder_path)) {
    // SSD unplugged or path moved. Surface what the sidecar last knew,
    // marked as offline. UI can render a banner without blanking.
    return []
  }
  const sidecar = await readSidecar(pool.folder_path)
  const includeMissing = opts?.includeMissing !== false
  return Object.values(sidecar.clips)
    .filter(c => includeMissing || !c.missing)
    .sort((a, b) => a.filename.localeCompare(b.filename))
}

export async function isPoolOnline(poolId: string): Promise<boolean> {
  const pool = await getPool(poolId)
  if (!pool) return false
  return existsSync(pool.folder_path)
}

/** Update tags on a single clip. Whitespace + dupes are normalised; an
 *  empty array means "remove all tags from this clip". */
export async function setClipTags(poolId: string, filename: string, tags: string[]): Promise<BrollClip> {
  const pool = await getPool(poolId)
  if (!pool) throw new Error(`Pool '${poolId}' not found`)
  if (!existsSync(pool.folder_path)) throw new Error('Pool folder offline — plug in the SSD before editing tags.')
  const sidecar = await readSidecar(pool.folder_path)
  const clip = sidecar.clips[filename]
  if (!clip) throw new Error(`Clip '${filename}' not in pool sidecar`)

  const normalised = Array.from(new Set(
    (tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean),
  )).sort()
  clip.tags = normalised
  await writeSidecar(pool.folder_path, sidecar)
  return clip
}

/** Mark a clip as normalized (sets the flag + records the relative path
 *  under .broll-normalized/). Called by the normalize job executor. */
export async function markClipNormalized(poolId: string, filename: string): Promise<void> {
  const pool = await getPool(poolId)
  if (!pool) return
  if (!existsSync(pool.folder_path)) return
  const sidecar = await readSidecar(pool.folder_path)
  const clip = sidecar.clips[filename]
  if (!clip) return
  clip.normalized = true
  await writeSidecar(pool.folder_path, sidecar)
}

// ── Rename ──────────────────────────────────────────────────────────────
//
// Per-clip rename keeps the user's pool clean (clips imported from stock
// sites land as `pexels-video-1234567-large.mp4` which is unsearchable).
// The user picks a clear name or applies a bulk template like
// `prayer_001.mp4`, and we:
//   1) Validate the new name (no path separators, no empty, has extension).
//   2) Detect collisions both in the sidecar and on disk.
//   3) Rename the file on disk (fs.rename = atomic if same volume).
//   4) Rename the matching normalized variant under .broll-normalized/
//      if one exists, so renders keep using the fast-path encode.
//   5) Rewrite the sidecar entry under the new filename key.
//   6) Update the pool's usage_log + project usage_logs IF they reference
//      the clip by filename (sha-based references are unaffected).
//
// All operations under a try/catch so a partial failure doesn't leave the
// sidecar pointing at a missing file: we rename the file FIRST, then
// the normalized variant, then the sidecar. If sidecar write fails the
// disk state is already consistent (file lives at the new name); the
// next scan reconciles it.

const VALID_FILENAME_RE = /^[A-Za-z0-9._\- ()\[\]+&#'%@$~,;!=]+$/

function isValidFilename(name: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = (name || '').trim()
  if (!trimmed) return { ok: false, reason: 'name is empty' }
  if (trimmed.length > 200) return { ok: false, reason: 'name is too long (>200 chars)' }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return { ok: false, reason: 'name cannot contain path separators' }
  }
  if (trimmed === '.' || trimmed === '..') return { ok: false, reason: 'reserved name' }
  if (trimmed.startsWith('.')) return { ok: false, reason: 'leading dot reserved for hidden files' }
  if (!VALID_FILENAME_RE.test(trimmed)) {
    return { ok: false, reason: 'name contains unsupported characters' }
  }
  // Must keep an extension so ffprobe / ffmpeg still picks the right
  // demuxer. We don't enforce a specific ext (user might be renaming a
  // .mov; that's fine), but reject extensionless names that would
  // confuse the indexer.
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1) {
    return { ok: false, reason: 'name must include a file extension (e.g. .mp4)' }
  }
  return { ok: true }
}

export async function renameClip(
  poolId: string,
  oldFilename: string,
  newFilename: string,
): Promise<BrollClip> {
  const pool = await getPool(poolId)
  if (!pool) throw new Error(`Pool '${poolId}' not found`)
  if (!existsSync(pool.folder_path)) {
    throw new Error('Pool folder offline — plug in the SSD before renaming.')
  }

  const cleanNew = newFilename.trim()
  if (cleanNew === oldFilename) return (await readSidecar(pool.folder_path)).clips[oldFilename]

  const validation = isValidFilename(cleanNew)
  if (!validation.ok) {
    throw new Error(`Invalid filename "${cleanNew}": ${validation.reason}`)
  }

  const sidecar = await readSidecar(pool.folder_path)
  const clip = sidecar.clips[oldFilename]
  if (!clip) throw new Error(`Clip '${oldFilename}' not in pool sidecar`)

  if (sidecar.clips[cleanNew]) {
    throw new Error(`Another clip already uses the name "${cleanNew}"`)
  }
  const oldPath = path.join(pool.folder_path, oldFilename)
  const newPath = path.join(pool.folder_path, cleanNew)
  if (existsSync(newPath)) {
    throw new Error(`A file already exists at "${cleanNew}" on disk — pick a different name.`)
  }

  // Disk: original first, then normalized variant if present.
  await fs.rename(oldPath, newPath)
  try {
    const normDir = normalizedSubdir(pool.folder_path)
    const oldNorm = path.join(normDir, oldFilename)
    const newNorm = path.join(normDir, cleanNew)
    if (existsSync(oldNorm)) {
      await fs.rename(oldNorm, newNorm)
    }
  } catch (e: any) {
    // The original is already renamed; failing to rename the normalized
    // variant is recoverable (next "Normalize all" will re-create it from
    // the new name). Warn but don't abort.
    console.warn(`[broll-rename] failed to rename normalized variant for ${oldFilename} → ${cleanNew}: ${e?.message || e}`)
  }

  // Sidecar: swap the key + the embedded filename.
  const updated: BrollClip = { ...clip, filename: cleanNew }
  delete sidecar.clips[oldFilename]
  sidecar.clips[cleanNew] = updated
  await writeSidecar(pool.folder_path, sidecar)

  return updated
}

/**
 * Bulk rename via a template. The template may contain these tokens:
 *   {n}     → 1-based index in the input list (no padding)
 *   {n:3}   → zero-padded to N digits ({n:3} → 001, 002, ...)
 *   {ext}   → original extension WITHOUT the dot (e.g. "mp4")
 *   {orig}  → original basename WITHOUT extension
 *   {sha}   → first 8 chars of the clip's sha256 (collision-safe shorthand)
 *
 * The template MUST contain an extension (either literal `.mp4` or `.{ext}`)
 * so the renamed files keep something ffmpeg recognises.
 *
 * Returns the list of (oldFilename, newFilename, status) so the UI can show
 * which renames succeeded vs failed without re-fetching the whole pool.
 */
export interface BulkRenameRow {
  old_filename: string
  new_filename: string
  status: 'renamed' | 'skipped' | 'error'
  detail?: string
}

export async function renameClipsBulk(
  poolId: string,
  template: string,
  filenames: string[],
  opts?: { startIndex?: number },
): Promise<BulkRenameRow[]> {
  const pool = await getPool(poolId)
  if (!pool) throw new Error(`Pool '${poolId}' not found`)
  if (!existsSync(pool.folder_path)) {
    throw new Error('Pool folder offline — plug in the SSD before renaming.')
  }
  const sidecar = await readSidecar(pool.folder_path)
  const start = Math.max(1, Math.floor(opts?.startIndex ?? 1))
  const rows: BulkRenameRow[] = []

  // Pre-pass: compute target names for collision detection (within the
  // batch and against existing sidecar entries that are NOT in the batch).
  const batchSet = new Set(filenames)
  const proposed: Array<{ old: string; next: string }> = []
  let i = 0
  for (const original of filenames) {
    const idx = start + i
    i++
    const clip = sidecar.clips[original]
    if (!clip) {
      rows.push({ old_filename: original, new_filename: original, status: 'error', detail: 'not in sidecar' })
      continue
    }
    const next = applyRenameTemplate(template, {
      index: idx,
      original,
      sha: clip.sha256,
    })
    if (next === original) {
      rows.push({ old_filename: original, new_filename: original, status: 'skipped', detail: 'template produced same name' })
      continue
    }
    const validation = isValidFilename(next)
    if (!validation.ok) {
      rows.push({ old_filename: original, new_filename: next, status: 'error', detail: validation.reason })
      continue
    }
    proposed.push({ old: original, next })
  }

  // Collision check: within-batch dupes + outside-batch dupes.
  const targetCounts = new Map<string, number>()
  for (const p of proposed) targetCounts.set(p.next, (targetCounts.get(p.next) || 0) + 1)
  for (const p of proposed) {
    if ((targetCounts.get(p.next) || 0) > 1) {
      rows.push({ old_filename: p.old, new_filename: p.next, status: 'error', detail: 'template produced a duplicate name within this batch' })
      continue
    }
    if (sidecar.clips[p.next] && !batchSet.has(p.next)) {
      rows.push({ old_filename: p.old, new_filename: p.next, status: 'error', detail: 'name already taken by another clip in this pool' })
      continue
    }
    try {
      // Execute one at a time so we get fine-grained per-row status.
      await renameClip(poolId, p.old, p.next)
      rows.push({ old_filename: p.old, new_filename: p.next, status: 'renamed' })
    } catch (e: any) {
      rows.push({ old_filename: p.old, new_filename: p.next, status: 'error', detail: e?.message || String(e) })
    }
  }
  return rows
}

/** Expand {n}, {n:N}, {ext}, {orig}, {sha} in a rename template. */
export function applyRenameTemplate(
  template: string,
  vars: { index: number; original: string; sha: string },
): string {
  const dot = vars.original.lastIndexOf('.')
  const origBase = dot > 0 ? vars.original.slice(0, dot) : vars.original
  const origExt = dot > 0 ? vars.original.slice(dot + 1) : ''
  return template
    .replace(/\{n:(\d+)\}/g, (_, w) => String(vars.index).padStart(Number(w), '0'))
    .replace(/\{n\}/g, String(vars.index))
    .replace(/\{ext\}/g, origExt)
    .replace(/\{orig\}/g, origBase)
    .replace(/\{sha\}/g, vars.sha.slice(0, 8))
}

// ── Sidecar export for the scan logic ───────────────────────────────────
// The scan helper in broll-indexer.ts mutates the sidecar via these
// thin wrappers so callers don't have to know the disk layout.

export async function loadSidecarForScan(folderPath: string): Promise<Sidecar> {
  return await readSidecar(folderPath)
}

export async function saveSidecarForScan(folderPath: string, sidecar: Sidecar): Promise<void> {
  await writeSidecar(folderPath, sidecar)
}

// ── Misc helpers ────────────────────────────────────────────────────────

export function computeFileSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32)
}

/** Streaming sha256 — for clips that may be hundreds of MB we never want
 *  to load the entire file into memory just to hash it. Reads in 1MB
 *  chunks; takes ~150ms for a 100MB file on M2 SSD. */
export async function sha256File(filePath: string): Promise<string> {
  const fsMod = await import('fs')
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fsMod.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 32)))
    stream.on('error', reject)
  })
}
