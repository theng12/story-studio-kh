/**
 * Chapter Background Pool Service — serial rotation and pool management per channel.
 *
 * Owner / Production presentation work (2026-11-07):
 *   "Reusable chapter-background pools with serial rotation per channel."
 *
 * Connects the pure rotation algorithm in `contracts/chapter-background-pool.ts`
 * to the channel configuration (`project-manager.ts`) and the built-in background
 * catalog (`background-catalog.ts`), plus auto-discovery of local assets in
 * `{projectDir}/backgrounds/`.
 *
 * Key guarantees:
 *   - Reuses existing channel config machinery (`pm.getConfig`, `pm.updateConfig`).
 *   - Serial cycling wraps cleanly over enabled items; disabled items are skipped.
 *   - Idempotent: re-checking or re-rendering the same episode code keeps its
 *     recorded pick without advancing the cursor (same contract as music-pool).
 *   - Editing the pool (adding/removing items) mid-run neither repeats nor skips.
 *   - Resolves portable references `${BACKGROUND}/<id>` and `${CHANNEL}/backgrounds/<file>`.
 */

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as pm from './project-manager.js'
import {
  listBackgrounds,
  resolveBackground,
  type BackgroundEntry,
} from './background-catalog.js'
import {
  decideChapterBackground,
  normaliseChapterBackgroundPool,
  normaliseCursor,
  type ChapterBackgroundCursor,
  type ChapterBackgroundDecision,
  type ChapterBackgroundItem,
  type ChapterBackgroundPool,
  type ChapterBackgroundUsageEntry,
} from '../contracts/chapter-background-pool.js'

const LOG_CAP = 100
const VALID_BG_EXT = /\.(mp4|mov|webm|mkv|jpg|jpeg|png|webp)$/i

export interface ChapterBackgroundPoolState {
  pool: ChapterBackgroundPool
  cursor: ChapterBackgroundCursor
  recent_usage: ChapterBackgroundUsageEntry[]
  available_catalog: BackgroundEntry[]
  channel_files: string[]
  folder: string | null
}

/**
 * Retrieve the channel's chapter background pool.
 */
export async function getChapterBackgroundPool(slug: string): Promise<ChapterBackgroundPool> {
  const config = await pm.getConfig(slug)
  const rawPool = (config as any)?.chapter_background_pool
  return normaliseChapterBackgroundPool(rawPool)
}

/**
 * Retrieve the channel's standing cursor.
 */
export async function getChapterBackgroundCursor(slug: string): Promise<ChapterBackgroundCursor> {
  const config = await pm.getConfig(slug)
  const rawCursor = (config as any)?.chapter_background_cursor
  return normaliseCursor(rawCursor)
}

/**
 * Retrieve the channel's background usage log (newest first).
 */
export async function getChapterBackgroundUsageLog(slug: string): Promise<ChapterBackgroundUsageEntry[]> {
  const config = await pm.getConfig(slug)
  const rawLog = (config as any)?.chapter_background_usage_log
  return Array.isArray(rawLog) ? rawLog : []
}

/**
 * Update the channel's chapter background pool.
 */
export async function updateChapterBackgroundPool(
  slug: string,
  poolPatch: Partial<ChapterBackgroundPool>,
): Promise<ChapterBackgroundPool> {
  const current = await getChapterBackgroundPool(slug)
  const merged = normaliseChapterBackgroundPool({
    ...current,
    ...poolPatch,
  })

  await pm.updateConfig(slug, {
    chapter_background_pool: merged,
  } as any)

  return merged
}

/**
 * Reset the cursor for the channel's serial rotation back to start.
 */
export async function resetChapterBackgroundCursor(slug: string): Promise<ChapterBackgroundCursor> {
  const resetCursor: ChapterBackgroundCursor = { last_background_id: null, last_index: null }
  await pm.updateConfig(slug, {
    chapter_background_cursor: resetCursor,
  } as any)
  return resetCursor
}

/**
 * Scan the channel directory `{projectDir}/backgrounds/` for available files.
 */
export async function listChannelBackgroundFiles(slug: string): Promise<string[]> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return []
  const bgDir = path.join(projectDir, 'backgrounds')
  if (!existsSync(bgDir)) return []

  try {
    const entries = await fs.readdir(bgDir, { withFileTypes: true })
    return entries
      .filter(e => e.isFile() && VALID_BG_EXT.test(e.name))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * Look ahead to see what background would be picked next for an episode without advancing the cursor.
 *
 * Idempotent: If `episodeCode` was already recorded in `usage_log`, returns that episode's recorded pick.
 */
export async function peekNextChapterBackground(
  slug: string,
  episodeCode?: string,
): Promise<{ item: ChapterBackgroundItem; index: number } | null> {
  const pool = await getChapterBackgroundPool(slug)
  const log = await getChapterBackgroundUsageLog(slug)

  if (episodeCode) {
    const prior = log.find(entry => entry.episode_code === episodeCode)
    if (prior) {
      const existing = pool.items.find(it => it.id === prior.background_id)
      if (existing) {
        const index = pool.items.indexOf(existing)
        return { item: existing, index }
      }
    }
  }

  const cursor = await getChapterBackgroundCursor(slug)
  const decision = decideChapterBackground(pool, cursor)
  if (!decision) return null

  return { item: decision.item, index: decision.index }
}

/**
 * Record an actual pick when an episode render completes or fixes its background selection.
 *
 * Advances the cursor and logs the selection.
 * If the episode already recorded a pick, returns that pick without advancing the cursor again.
 */
export async function recordChapterBackgroundPick(
  slug: string,
  episodeCode: string,
  backgroundId?: string,
): Promise<ChapterBackgroundDecision | null> {
  const pool = await getChapterBackgroundPool(slug)
  const log = await getChapterBackgroundUsageLog(slug)

  // Check for existing pick for this episode
  const existingEntry = log.find(e => e.episode_code === episodeCode)
  if (existingEntry) {
    const item = pool.items.find(it => it.id === existingEntry.background_id)
    if (item) {
      const index = pool.items.indexOf(item)
      const cursor = await getChapterBackgroundCursor(slug)
      return { item, index, cursor }
    }
  }

  const cursor = await getChapterBackgroundCursor(slug)
  let decision = decideChapterBackground(pool, cursor)

  if (backgroundId && pool.items.some(it => it.id === backgroundId)) {
    const item = pool.items.find(it => it.id === backgroundId)!
    const index = pool.items.indexOf(item)
    decision = {
      item,
      index,
      cursor: { last_background_id: item.id, last_index: index },
    }
  }

  if (!decision) return null

  // Append new usage entry, cap at LOG_CAP
  const newEntry: ChapterBackgroundUsageEntry = {
    episode_code: episodeCode,
    background_id: decision.item.id,
    reference: decision.item.reference,
    picked_at: new Date().toISOString(),
  }

  const updatedLog = [newEntry, ...log.filter(e => e.episode_code !== episodeCode)].slice(0, LOG_CAP)

  await pm.updateConfig(slug, {
    chapter_background_cursor: decision.cursor,
    chapter_background_usage_log: updatedLog,
  } as any)

  return decision
}

/**
 * Resolve a chapter background reference to an absolute filesystem path.
 */
export async function resolveChapterBackground(
  slug: string,
  referenceOrId: string,
): Promise<string> {
  const ref = (referenceOrId || '').trim()
  if (!ref) {
    throw new Error('Chapter background reference is empty')
  }

  // 1. Catalog reference `${BACKGROUND}/<id>` or plain catalog id
  if (ref.startsWith('${BACKGROUND}/')) {
    const catId = ref.slice('${BACKGROUND}/'.length)
    return resolveBackground(catId)
  }

  // 2. Direct catalog id check
  const catalogList = listBackgrounds()
  const matchedCatalog = catalogList.find(b => b.id === ref)
  if (matchedCatalog) {
    return resolveBackground(matchedCatalog.id)
  }

  // 3. Project-relative reference `${CHANNEL}/backgrounds/<file>`
  const projectDir = pm.getProjectDir(slug)
  if (projectDir) {
    if (ref.startsWith('${CHANNEL}/')) {
      const rel = ref.slice('${CHANNEL}/'.length)
      const absPath = path.resolve(projectDir, rel)
      if (existsSync(absPath)) return absPath
    }

    const candidateBgDir = path.join(projectDir, 'backgrounds', ref)
    if (existsSync(candidateBgDir)) return candidateBgDir

    const candidateDirect = path.resolve(projectDir, ref)
    if (existsSync(candidateDirect)) return candidateDirect
  }

  // 4. Absolute path
  if (path.isAbsolute(ref) && existsSync(ref)) {
    return ref
  }

  throw new Error(`Chapter background "${ref}" could not be resolved on channel "${slug}".`)
}

/**
 * Return complete pool state for UI and inspection.
 */
export async function getChapterBackgroundPoolState(slug: string): Promise<ChapterBackgroundPoolState> {
  const [pool, cursor, recent_usage, channel_files] = await Promise.all([
    getChapterBackgroundPool(slug),
    getChapterBackgroundCursor(slug),
    getChapterBackgroundUsageLog(slug),
    listChannelBackgroundFiles(slug),
  ])

  let available_catalog: BackgroundEntry[] = []
  try {
    available_catalog = listBackgrounds()
  } catch {
    available_catalog = []
  }

  const projectDir = pm.getProjectDir(slug)
  const folder = projectDir ? path.join(projectDir, 'backgrounds') : null

  return {
    pool,
    cursor,
    recent_usage,
    available_catalog,
    channel_files,
    folder,
  }
}
