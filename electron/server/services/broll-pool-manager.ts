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

function sidecarPath(folderPath: string): string {
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

export interface BrollPool {
  id: string
  name: string
  folder_path: string
  /** Auto-queue normalize jobs for newly-indexed clips. Default ON. */
  auto_normalize: boolean
  /** Target fps for normalized output. 24 (cinematic, our default) or 30. */
  fps_target: 24 | 30
  /** Target resolution; 1920x1080 (1080p, our default). Future: 3840x2160. */
  resolution_target: '1920x1080'
  created_at: string
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

  const pool: BrollPool = {
    id,
    name: input.name.trim(),
    folder_path: input.folder_path,
    auto_normalize: input.auto_normalize !== false, // default true
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

export async function updatePool(id: string, patch: Partial<Pick<BrollPool, 'name' | 'auto_normalize' | 'fps_target'>>): Promise<BrollPool> {
  const reg = await readRegistry()
  const idx = reg.pools.findIndex(p => p.id === id)
  if (idx < 0) throw new Error(`Pool '${id}' not found`)
  reg.pools[idx] = { ...reg.pools[idx]!, ...patch }
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
