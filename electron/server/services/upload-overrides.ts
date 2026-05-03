/**
 * Per-episode upload override sidecar (`upload_metadata_overrides.json`).
 *
 * Stores user choices that customise an upload without modifying the
 * generator output (which is regenerated routinely from the script
 * pipeline). Today's writers:
 *
 *   - **selected_thumbnail** (v1.0.41) — pinned thumbnail filename
 *     chosen by the user on the Images-page picker. The resolver in
 *     `lib/upload-metadata.ts` honours this over the auto-pick rule.
 *
 * The sidecar is platform-keyed at the top level so future writers
 * (TikTok caption override, Facebook description override) can land
 * without colliding with YouTube's block:
 *
 *   {
 *     "youtube": {
 *       "selected_thumbnail": "TN0008_Thumb02_v1.png",
 *       "title": "...",          // existing, optional
 *       "description": "...",    // existing, optional
 *       "tags": [...]            // existing, optional
 *     }
 *   }
 *
 * Path: `{episode_dir}/upload_metadata_overrides.json`. The file
 * follows episode_dir on renumber/compact; only its CONTENT may need
 * rewriting when filenames it references contain the old episode_code
 * (see `rewriteSelectedThumbnailOnRename`).
 */

import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { resolveEpisodePaths } from './utils.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import type { UploadPlatform } from './upload-store.js'

const FILENAME = 'upload_metadata_overrides.json'

interface PlatformOverrides {
  title?: string
  description?: string
  tags?: string[]
  /** Filename within the episode's thumbnails dir (no path prefix). */
  selected_thumbnail?: string
}

type OverridesFile = Record<string, PlatformOverrides>

async function overridesPath(slug: string, episode_code: string, fallback_title: string): Promise<string> {
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title)
  return path.join(paths.episode_dir, FILENAME)
}

async function readOverridesFile(p: string): Promise<OverridesFile> {
  if (!existsSync(p)) return {}
  try {
    const raw = await fsp.readFile(p, 'utf-8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return {}
    return data as OverridesFile
  } catch {
    return {}
  }
}

/**
 * Read the pinned thumbnail filename for a platform, or null when
 * unset. Doesn't validate that the file exists on disk — callers do
 * that to decide whether to honour the pin or fall back.
 */
export async function readSelectedThumbnail(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform,
): Promise<string | null> {
  const p = await overridesPath(slug, episode_code, fallback_title)
  const data = await readOverridesFile(p)
  const block = data[platform]
  if (!block || typeof block.selected_thumbnail !== 'string') return null
  return block.selected_thumbnail.trim() || null
}

/**
 * Set or clear the pinned thumbnail filename for a platform. Pass
 * `filename = null` to clear. When the platform block becomes empty
 * after the write, it's pruned; when the whole file becomes empty,
 * the file is deleted — keeps the episode dir tidy when the user
 * unpicks every override.
 */
export async function writeSelectedThumbnail(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform,
  filename: string | null,
): Promise<void> {
  const p = await overridesPath(slug, episode_code, fallback_title)
  const data = await readOverridesFile(p)
  const existing = data[platform] || {}
  if (filename === null || filename === '') {
    delete existing.selected_thumbnail
  } else {
    existing.selected_thumbnail = filename
  }
  // Prune empty platform block.
  if (Object.keys(existing).length === 0) {
    delete data[platform]
  } else {
    data[platform] = existing
  }
  // Prune empty file.
  if (Object.keys(data).length === 0) {
    if (existsSync(p)) {
      try { await fsp.rm(p, { force: true }) } catch { /* non-fatal */ }
    }
    return
  }
  // Ensure the episode dir exists before atomic-writing the temp file.
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await writeJsonAtomic(p, data)
}

/**
 * Rewrite any `selected_thumbnail` filenames inside the override file
 * when an episode is renamed (Renumber / Compact). Pinned filenames
 * follow the `{code}_Thumb...` convention, so a string-replace of the
 * code prefix keeps the pin pointing at the same on-disk file after
 * the rename cascade has updated its actual name. No-op when the
 * file doesn't exist or no `selected_thumbnail` is set.
 */
export async function rewriteSelectedThumbnailOnRename(
  slug: string,
  /** New episode_code (the file is at the new path post-rename). */
  newCode: string,
  /** New fallback title (typically unchanged across rename). */
  fallback_title: string,
  oldCode: string,
): Promise<void> {
  const p = await overridesPath(slug, newCode, fallback_title)
  if (!existsSync(p)) return
  const data = await readOverridesFile(p)
  let dirty = false
  for (const platform of Object.keys(data)) {
    const block = data[platform]
    if (!block) continue
    const sel = block.selected_thumbnail
    if (!sel || !sel.includes(oldCode)) continue
    block.selected_thumbnail = sel.replaceAll(oldCode, newCode)
    dirty = true
  }
  if (dirty) {
    await writeJsonAtomic(p, data)
  }
}
