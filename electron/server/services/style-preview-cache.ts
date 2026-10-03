/**
 * App-wide cache for one-shot "what does this style look like?" sample
 * renders driven from the Image Generator page (/projects/:slug/images).
 *
 * The user types a free-form style description in a small card at the top
 * of /images, picks a model + aspect + tier, and clicks Preview. We render
 * ONE sample image of that style against a fixed neutral baseline scene
 * and persist the PNG keyed by every input that affects the output:
 *
 *   sha256(style + model + aspect + tier + variant + seed)
 *
 * Re-clicking the same combo is free; switching any input invalidates and
 * triggers a fresh render. Stored in userData (per-machine, not iCloud-
 * synced) — cached pixels shouldn't propagate between Macs and would just
 * regenerate lazily on the new machine on first hover anyway.
 *
 *   <userData>/style-previews/index.json    ← hash → entry
 *   <userData>/style-previews/<hash>.png    ← cached PNG
 *
 * (Was deleted in commit fe6be3e when the feature was hosted on the wrong
 * page — Image Prompts — and 422'd because of model-mismatch. Now lives on
 * /images where the user explicitly picks the model so no mismatch is
 * possible. The same shape carried over.)
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { writeJsonAtomic } from '../lib/atomic-store.js'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

interface IndexEntry {
  style_tag: string
  model_id: string
  aspect_ratio: string
  tier: string
  variant_id: string
  seed?: number
  created_at: string
  filename: string
  size_bytes: number
}

interface IndexShape {
  entries: Record<string, IndexEntry>
}

const PRODUCT_NAME = 'Story Studio KH'

export function resolveStylePreviewDir(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'style-previews')
  }
  const isPackaged = MODULE_DIR.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (!isPackaged) {
    // Dev: keep the cache local so a dev session leaving generated
    // previews behind doesn't pollute the production-flavoured userData
    // dir on the same machine.
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
 * Frozen value of the retired inference-steps key segment.
 *
 * Steps were never a customer control: every style preview this app has
 * rendered went out with the image catalogue's `default_steps` fallback of 4,
 * because GenStudio publishes no step contract. Freezing the segment keeps
 * every previously cached preview addressable — dropping it from the blob
 * would orphan the whole cache and bill a fresh render for pixels already on
 * disk. Nothing reads or sends this value.
 */
const LEGACY_STEPS_KEY_SEGMENT = 4

/**
 * Cache key. Normalises whitespace + lowercases so trivial formatting
 * differences ("Soft Watercolor" vs " soft watercolor ") don't generate
 * three separate cache entries.
 */
export function hashStylePreviewKey(opts: {
  styleTag: string
  modelId: string
  aspectRatio: string
  tier?: string
  variantId?: string
  seed?: number
}): string {
  const norm = opts.styleTag.replace(/\s+/g, ' ').trim().toLowerCase()
  const tier = opts.tier || ''
  const variantId = opts.variantId || 'default'
  const seed = opts.seed ?? ''
  const blob = `${norm}|${opts.modelId}|${opts.aspectRatio}|${tier}|${variantId}|${LEGACY_STEPS_KEY_SEGMENT}|${seed}`
  return createHash('sha256').update(blob).digest('hex').slice(0, 16)
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
    return { entries: {} }
  }
}

async function writeIndex(idx: IndexShape): Promise<void> {
  await fs.mkdir(resolveStylePreviewDir(), { recursive: true })
  await writeJsonAtomic(indexPath(), idx)
}

export interface CachedStylePreview {
  hash: string
  style_tag: string
  model_id: string
  aspect_ratio: string
  tier: string
  variant_id: string
  seed?: number
  created_at: string
  filename: string
  abs_path: string
  size_bytes: number
}

export async function getCachedStylePreview(opts: {
  styleTag: string
  modelId: string
  aspectRatio: string
  tier?: string
  variantId?: string
  seed?: number
}): Promise<CachedStylePreview | null> {
  const hash = hashStylePreviewKey(opts)
  const idx = await readIndex()
  const entry = idx.entries[hash]
  if (!entry) return null
  const abs = path.join(resolveStylePreviewDir(), entry.filename)
  if (!existsSync(abs)) {
    delete idx.entries[hash]
    await writeIndex(idx).catch(() => { /* fail-soft */ })
    return null
  }
  return {
    hash,
    style_tag: entry.style_tag,
    model_id: entry.model_id,
    aspect_ratio: entry.aspect_ratio,
    tier: entry.tier,
    variant_id: entry.variant_id || 'default',
    seed: entry.seed,
    created_at: entry.created_at,
    filename: entry.filename,
    abs_path: abs,
    size_bytes: entry.size_bytes,
  }
}

export async function saveStylePreview(opts: {
  styleTag: string
  modelId: string
  aspectRatio: string
  tier?: string
  variantId?: string
  seed?: number
  imageBytes: Buffer
}): Promise<CachedStylePreview> {
  const hash = hashStylePreviewKey(opts)
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
    aspect_ratio: opts.aspectRatio,
    tier: opts.tier || '',
    variant_id: opts.variantId || 'default',
    seed: opts.seed,
    created_at: now,
    filename,
    size_bytes: opts.imageBytes.length,
  }
  await writeIndex(idx)
  return {
    hash,
    style_tag: opts.styleTag,
    model_id: opts.modelId,
    aspect_ratio: opts.aspectRatio,
    tier: opts.tier || '',
    variant_id: opts.variantId || 'default',
    seed: opts.seed,
    created_at: now,
    filename,
    abs_path: abs,
    size_bytes: opts.imageBytes.length,
  }
}

export async function pathForStylePreviewHash(hash: string): Promise<string | null> {
  const idx = await readIndex()
  const entry = idx.entries[hash]
  if (!entry) return null
  const abs = path.join(resolveStylePreviewDir(), entry.filename)
  if (!existsSync(abs)) return null
  return abs
}
