/**
 * App-wide cache for sample-image previews of scene/thumbnail prompts.
 *
 * Lives on the Image Generator page (`/projects/:slug/images`). The user
 * can click a per-prompt "🖼️ Preview" button to render ONE sample image
 * of that exact prompt with their chosen model + aspect + tier — enough
 * to gut-check the visual style before clicking Generate on the whole
 * batch. Cache key bundles every input that affects the output, so:
 *
 *   sha256(prompt + '|' + model_id + '|' + aspect_ratio + '|' + tier)
 *
 * Re-clicking the same combo is free; switching model / aspect / tier
 * invalidates and triggers a fresh render. Stored in userData so the
 * cache is per-machine (cached pixels shouldn't iCloud-sync between
 * Macs and would just regenerate lazily on the new machine anyway).
 *
 *   <userData>/image-previews/index.json    ← hash → IndexEntry
 *   <userData>/image-previews/<hash>.png    ← cached PNG
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { writeJsonAtomic } from '../lib/atomic-store.js'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

interface IndexEntry {
  prompt: string
  model_id: string
  aspect_ratio: string
  tier: string
  created_at: string
  filename: string
  size_bytes: number
}

interface IndexShape {
  entries: Record<string, IndexEntry>
}

const PRODUCT_NAME = 'Story Studio KH'

export function resolveImagePreviewDir(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'image-previews')
  }
  const isPackaged = MODULE_DIR.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (!isPackaged) {
    return path.join(process.cwd(), '.image-previews')
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', PRODUCT_NAME, 'image-previews')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), PRODUCT_NAME, 'image-previews')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), PRODUCT_NAME, 'image-previews')
}

const INDEX_FILENAME = 'index.json'

function indexPath(): string {
  return path.join(resolveImagePreviewDir(), INDEX_FILENAME)
}

/**
 * Cache key. Normalises whitespace inside the prompt so trivial
 * formatting differences don't generate distinct cache entries for what
 * the LLM treats as the same instruction.
 */
export function hashPreviewKey(opts: {
  prompt: string
  modelId: string
  aspectRatio: string
  tier?: string
  seed?: number
}): string {
  const norm = opts.prompt.replace(/\s+/g, ' ').trim()
  const tier = opts.tier || ''
  // The empty segment is where a retired `steps` input used to sit. No caller
  // ever populated it, so keeping the slot leaves every previously cached
  // preview addressable — dropping it would silently orphan the cache and
  // bill a fresh render for pixels already on disk.
  const blob = `${norm}|${opts.modelId}|${opts.aspectRatio}|${tier}||${opts.seed ?? ''}`
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
  await fs.mkdir(resolveImagePreviewDir(), { recursive: true })
  await writeJsonAtomic(indexPath(), idx)
}

export interface CachedPreview {
  hash: string
  prompt: string
  model_id: string
  aspect_ratio: string
  tier: string
  created_at: string
  filename: string
  abs_path: string
  size_bytes: number
}

export async function getCached(opts: {
  prompt: string
  modelId: string
  aspectRatio: string
  tier?: string
  seed?: number
}): Promise<CachedPreview | null> {
  const hash = hashPreviewKey(opts)
  const idx = await readIndex()
  const entry = idx.entries[hash]
  if (!entry) return null
  const abs = path.join(resolveImagePreviewDir(), entry.filename)
  if (!existsSync(abs)) {
    // Index claims a file that's gone — drop the orphan entry so a
    // subsequent generate call doesn't think the disk is cached.
    delete idx.entries[hash]
    await writeIndex(idx).catch(() => { /* fail-soft */ })
    return null
  }
  return {
    hash,
    prompt: entry.prompt,
    model_id: entry.model_id,
    aspect_ratio: entry.aspect_ratio,
    tier: entry.tier,
    created_at: entry.created_at,
    filename: entry.filename,
    abs_path: abs,
    size_bytes: entry.size_bytes,
  }
}

export async function savePreview(opts: {
  prompt: string
  modelId: string
  aspectRatio: string
  tier?: string
  seed?: number
  imageBytes: Buffer
}): Promise<CachedPreview> {
  const hash = hashPreviewKey(opts)
  const filename = `${hash}.png`
  const dir = resolveImagePreviewDir()
  await fs.mkdir(dir, { recursive: true })
  const abs = path.join(dir, filename)
  await fs.writeFile(abs, opts.imageBytes)

  const now = new Date().toISOString()
  const idx = await readIndex()
  idx.entries[hash] = {
    prompt: opts.prompt,
    model_id: opts.modelId,
    aspect_ratio: opts.aspectRatio,
    tier: opts.tier || '',
    created_at: now,
    filename,
    size_bytes: opts.imageBytes.length,
  }
  await writeIndex(idx)
  return {
    hash,
    prompt: opts.prompt,
    model_id: opts.modelId,
    aspect_ratio: opts.aspectRatio,
    tier: opts.tier || '',
    created_at: now,
    filename,
    abs_path: abs,
    size_bytes: opts.imageBytes.length,
  }
}

export async function pathForHash(hash: string): Promise<string | null> {
  const idx = await readIndex()
  const entry = idx.entries[hash]
  if (!entry) return null
  const abs = path.join(resolveImagePreviewDir(), entry.filename)
  if (!existsSync(abs)) return null
  return abs
}
