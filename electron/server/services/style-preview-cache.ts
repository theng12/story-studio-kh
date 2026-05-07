/**
 * App-wide style-preview cache.
 *
 * The image-prompts page can render a single sample image of a style
 * description so the user sees what their `style_tag` text will look
 * like before committing to a full scene-prompt batch. To keep that
 * affordable, generated previews are cached on disk by sha256 of the
 * (normalised) style description — the same description across episodes
 * or projects re-uses the cached PNG instead of re-billing kie.ai.
 *
 * Storage location: app userData dir (per-machine, never iCloud-synced —
 * cached pixel art shouldn't propagate between Macs and would just be
 * regenerated lazily on the new machine on first hover anyway).
 *
 *   <userData>/style-previews/index.json    ← hash → { style_tag, model, created_at, filename }
 *   <userData>/style-previews/<hash>.png    ← actual cached PNG
 *
 * `index.json` lets the route surface the cache hit/miss + last-generated
 * timestamp without listing the directory on every request.
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { writeJsonAtomic } from '../lib/atomic-store.js'

// ESM doesn't expose __dirname natively. Resolve it from import.meta.url
// once at module load — the packaged-vs-dev detection below uses the
// resolved path to decide where the cache lives.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

interface IndexEntry {
  style_tag: string
  model_id: string
  created_at: string
  filename: string
  /** Bytes — set on save so the route can return Content-Length without restat. */
  size_bytes: number
}

interface IndexShape {
  /** Map of sha256(style_tag, normalised) → IndexEntry. */
  entries: Record<string, IndexEntry>
}

const PRODUCT_NAME = 'Story Studio KH'

/**
 * Resolve the on-disk directory holding cached previews. Mirrors the
 * convention `app-settings.ts` uses for app-wide state — userData on
 * macOS / Windows / Linux, with a STORY_STUDIO_DATA_DIR override for
 * tests and dev launchers that want an isolated location.
 */
export function resolveStylePreviewDir(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'style-previews')
  }
  // The app-settings module decides packaged vs. dev the same way; only
  // the packaged branch needs the platform-specific userData lookup
  // (dev runs out of the repo and writes alongside the source).
  const isPackaged = MODULE_DIR.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (!isPackaged) {
    // Dev: keep the cache local to the repo so a dev session leaving
    // generated previews behind doesn't pollute the production-flavoured
    // userData dir on the same machine.
    return path.join(process.cwd(), '.style-previews')
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', PRODUCT_NAME, 'style-previews')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), PRODUCT_NAME, 'style-previews')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), PRODUCT_NAME, 'style-previews')
}

const INDEX_FILENAME = 'index.json'

function indexPath(): string {
  return path.join(resolveStylePreviewDir(), INDEX_FILENAME)
}

/**
 * Hash of the cache key. Normalises whitespace and case so trivial
 * formatting changes ("Soft Watercolor" vs " soft watercolor ") don't
 * generate three separate cache entries for what's effectively the
 * same style description.
 */
export function hashStyleTag(styleTag: string): string {
  const normalised = styleTag.replace(/\s+/g, ' ').trim().toLowerCase()
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16)
}

async function readIndex(): Promise<IndexShape> {
  const p = indexPath()
  if (!existsSync(p)) return { entries: {} }
  try {
    const raw = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.entries) return parsed as IndexShape
    return { entries: {} }
  } catch {
    // Corrupt index — start fresh. The PNGs themselves stay on disk;
    // they just lose their style_tag provenance until regenerated.
    return { entries: {} }
  }
}

async function writeIndex(idx: IndexShape): Promise<void> {
  await fs.mkdir(resolveStylePreviewDir(), { recursive: true })
  await writeJsonAtomic(indexPath(), idx)
}

export interface CachedPreview {
  hash: string
  style_tag: string
  model_id: string
  created_at: string
  filename: string
  /** Absolute path on disk — for the route's res.sendFile. */
  abs_path: string
  size_bytes: number
}

/** Returns the cached preview for this style, or null if not cached. */
export async function getCached(styleTag: string): Promise<CachedPreview | null> {
  const hash = hashStyleTag(styleTag)
  const idx = await readIndex()
  const entry = idx.entries[hash]
  if (!entry) return null
  const abs = path.join(resolveStylePreviewDir(), entry.filename)
  if (!existsSync(abs)) {
    // Index claims a file that's gone — drop the orphan entry so a
    // subsequent generate call doesn't think the disk is cached.
    delete idx.entries[hash]
    await writeIndex(idx).catch(() => { /* fail-soft */ })
    return null
  }
  return {
    hash,
    style_tag: entry.style_tag,
    model_id: entry.model_id,
    created_at: entry.created_at,
    filename: entry.filename,
    abs_path: abs,
    size_bytes: entry.size_bytes,
  }
}

/**
 * Save a freshly generated preview. The image bytes go to a hash-named
 * PNG; the index gets a new entry pointing at it. Caller is responsible
 * for dedupe (call `getCached` first).
 */
export async function savePreview(opts: {
  styleTag: string
  imageBytes: Buffer
  modelId: string
}): Promise<CachedPreview> {
  const hash = hashStyleTag(opts.styleTag)
  const filename = `${hash}.png`
  const dir = resolveStylePreviewDir()
  await fs.mkdir(dir, { recursive: true })
  const abs = path.join(dir, filename)
  await fs.writeFile(abs, opts.imageBytes)

  const now = new Date().toISOString()
  const idx = await readIndex()
  idx.entries[hash] = {
    style_tag: opts.styleTag,
    model_id: opts.modelId,
    created_at: now,
    filename,
    size_bytes: opts.imageBytes.length,
  }
  await writeIndex(idx)
  return {
    hash,
    style_tag: opts.styleTag,
    model_id: opts.modelId,
    created_at: now,
    filename,
    abs_path: abs,
    size_bytes: opts.imageBytes.length,
  }
}

/** Resolve the on-disk path for a previously-cached hash, for the GET route. */
export async function pathForHash(hash: string): Promise<string | null> {
  const idx = await readIndex()
  const entry = idx.entries[hash]
  if (!entry) return null
  const abs = path.join(resolveStylePreviewDir(), entry.filename)
  if (!existsSync(abs)) return null
  return abs
}
