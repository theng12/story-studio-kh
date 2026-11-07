/**
 * Chapter Background Pool Service — serial rotation per channel with stable
 * (episode, chapter) identity (release 1.4.386, item 14).
 *
 * What this owns:
 *  - Pool / cursor / usage log for a channel, stored on its `config.json`
 *    under `chapter_background_*`.
 *  - Serial picking across BOTH boundaries: chapter→chapter inside one episode
 *    and episode→episode across the channel. The usage log is keyed by
 *    `chapterRotationKey(episode, chapter)` (AGENTS §4: ownership is a fact to
 *    look up, never parsed), so a retry of the same chapter keeps its pick and
 *    does not move the rotation, while a second chapter in the same episode
 *    advances it.
 *  - Reference resolution restricted to what the channel OWNS: approved catalog
 *    backgrounds (`${BACKGROUND}/<id>`), this channel's own `backgrounds/`
 *    inventory (`${CHANNEL}/backgrounds/<file>` or a plain filename), or an
 *    absolute path whose realpath stays inside that inventory folder.
 *    Traversal, foreign-channel paths and symlink escapes are refused by name.
 *
 * Atomicity follows the project's existing pattern: every read-modify-write of
 * the chapter state runs inside `withLock(configPath)` with `writeJsonAtomic`,
 * the same lock key and helpers `project-manager.updateConfig` uses, so two
 * concurrent chapter records serialize and neither history nor cursor is lost.
 * A retry that changes nothing writes nothing (config mtime stays untouched).
 */

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as pm from './project-manager.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import {
  listBackgrounds,
  resolveBackground,
  type BackgroundEntry,
} from './background-catalog.js'
import {
  chapterRotationKey,
  decideChapterBackground,
  normaliseChapterBackgroundPool,
  normaliseCursor,
  type ChapterBackgroundCursor,
  type ChapterBackgroundDecision,
  type ChapterBackgroundItem,
  type ChapterBackgroundPool,
  type ChapterBackgroundUsageEntry,
} from '../contracts/chapter-background-pool.js'

const LOG_CAP = 200
const VALID_BG_EXT = /\.(mp4|mov|webm|mkv|jpg|jpeg|png|webp)$/i

/** Catalog availability, named honestly: a failed catalog never reads as an empty success. */
export interface ChapterBackgroundCatalogState {
  available: boolean
  entries: BackgroundEntry[]
  /** Present when `available` is false: why, with the underlying failure named. */
  reason?: string
}

export interface ChapterBackgroundPoolState {
  pool: ChapterBackgroundPool
  cursor: ChapterBackgroundCursor
  recent_usage: ChapterBackgroundUsageEntry[]
  catalog: ChapterBackgroundCatalogState
  /** Filenames in this channel's own backgrounds inventory (the ownership list). */
  channel_files: string[]
  /** Absolute inventory folder, or null when the project directory is offline. */
  folder: string | null
}

function configPathFor(slug: string): string {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new Error(`Channel "${slug}" has no project directory on this Mac.`)
  const configPath = path.join(projectDir, 'config.json')
  if (!existsSync(configPath)) throw new Error(`Channel "${slug}" has no config.json; nothing was changed.`)
  return configPath
}

/**
 * The ONE write path for chapter state: read config inside the channel's
 * config lock, let `mutate` change only the `chapter_background_*` keys, and
 * write back atomically — exactly how `project-manager.updateConfig` protects
 * its own read-modify-write, sharing the same lock key so this and any
 * concurrent updateConfig call serialize.
 *
 * Returns false without writing when `mutate` changed nothing (a retry must
 * not churn config.json mtime — the Production Board reads it).
 */
async function mutateChapterState(
  slug: string,
  mutate: (data: Record<string, any>) => void,
): Promise<boolean> {
  const configPath = configPathFor(slug)
  let changed = false
  await withLock(configPath, async () => {
    const raw = await fs.readFile(configPath, 'utf8')
    let data: Record<string, any>
    try {
      data = JSON.parse(raw)
    } catch (error: any) {
      throw new Error(`config.json for channel "${slug}" is corrupt (${error?.message}); nothing was changed.`)
    }
    const before = JSON.stringify(data)
    mutate(data)
    changed = JSON.stringify(data) !== before
    if (changed) await writeJsonAtomic(configPath, data)
  })
  return changed
}

export async function getChapterBackgroundPool(slug: string): Promise<ChapterBackgroundPool> {
  const config = await pm.getConfig(slug)
  return normaliseChapterBackgroundPool((config as any)?.chapter_background_pool)
}

export async function getChapterBackgroundCursor(slug: string): Promise<ChapterBackgroundCursor> {
  const config = await pm.getConfig(slug)
  return normaliseCursor((config as any)?.chapter_background_cursor)
}

export async function getChapterBackgroundUsageLog(slug: string): Promise<ChapterBackgroundUsageEntry[]> {
  const config = await pm.getConfig(slug)
  const raw = (config as any)?.chapter_background_usage_log
  return Array.isArray(raw) ? raw : []
}

/** Replace the channel's pool (same lock-protected write as every other mutation here). */
export async function updateChapterBackgroundPool(
  slug: string,
  items: ChapterBackgroundItem[],
): Promise<ChapterBackgroundPool> {
  const merged = normaliseChapterBackgroundPool({ items })
  await mutateChapterState(slug, data => {
    data.chapter_background_pool = merged
  })
  return merged
}

export async function resetChapterBackgroundCursor(slug: string): Promise<ChapterBackgroundCursor> {
  const reset: ChapterBackgroundCursor = { last_background_id: null, last_index: null }
  await mutateChapterState(slug, data => {
    data.chapter_background_cursor = reset
  })
  return reset
}

/**
 * This channel's own background inventory — the ownership list. Membership here
 * decides whether a reference belongs to this channel; nothing is parsed from
 * a path (AGENTS §4).
 */
export async function listChannelBackgroundFiles(slug: string): Promise<string[]> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return []
  const bgDir = path.join(projectDir, 'backgrounds')
  if (!existsSync(bgDir)) return []
  try {
    const entries = await fs.readdir(bgDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && VALID_BG_EXT.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function inventoryDirFor(slug: string): string | null {
  const projectDir = pm.getProjectDir(slug)
  return projectDir ? path.join(projectDir, 'backgrounds') : null
}

/**
 * Containment check on REAL paths: the resolved file must live inside the
 * channel's own backgrounds folder after every symlink is followed, so a link
 * planted inside the folder cannot reach outside the channel.
 */
async function containedInInventory(inventoryDir: string, candidate: string): Promise<boolean> {
  try {
    const realDir = await fs.realpath(inventoryDir)
    const realFile = await fs.realpath(candidate)
    return realFile === realDir || realFile.startsWith(realDir + path.sep)
  } catch {
    return false
  }
}

/**
 * Look ahead: what would the rotation take for this (episode, chapter)?
 *
 * Read-only — a peek never advances anything. If this boundary already
 * recorded a pick, that pick is returned (the same idempotence record uses).
 */
export async function peekChapterBackground(
  slug: string,
  episodeCode: string,
  chapterSlug: string | null | undefined = '',
): Promise<{ item: ChapterBackgroundItem; index: number } | null> {
  const [pool, cursor, log] = await Promise.all([
    getChapterBackgroundPool(slug),
    getChapterBackgroundCursor(slug),
    getChapterBackgroundUsageLog(slug),
  ])
  const key = chapterRotationKey(episodeCode, chapterSlug)
  const prior = log.find(entry => chapterRotationKey(entry.episode_code, entry.chapter_slug) === key)
  if (prior) {
    const index = pool.items.findIndex(item => item.id === prior.background_id)
    if (index >= 0) return { item: pool.items[index]!, index }
  }
  const decision = decideChapterBackground(pool, cursor)
  return decision ? { item: decision.item, index: decision.index } : null
}

/**
 * Record the background this (episode, chapter) boundary actually uses.
 *
 *  - Retry idempotence: if the boundary already recorded a pick, that pick is
 *    returned and NOTHING is written — a re-render never moves the rotation.
 *  - Otherwise the pick is taken from the standing cursor (or `backgroundId`
 *    when the caller names a valid pool item), the log gains one keyed entry,
 *    and the cursor advances. The whole read-modify-write runs inside the
 *    config lock, so concurrent records for different chapters both land.
 */
export async function recordChapterBackgroundPick(
  slug: string,
  episodeCode: string,
  chapterSlug: string | null | undefined = '',
  backgroundId?: string,
): Promise<ChapterBackgroundDecision | null> {
  const key = chapterRotationKey(episodeCode, chapterSlug)
  const trimmedChapter = typeof chapterSlug === 'string' ? chapterSlug.trim() : ''
  let result: ChapterBackgroundDecision | null = null

  await mutateChapterState(slug, data => {
    const pool = normaliseChapterBackgroundPool(data.chapter_background_pool)
    const cursor = normaliseCursor(data.chapter_background_cursor)
    const log: ChapterBackgroundUsageEntry[] = Array.isArray(data.chapter_background_usage_log)
      ? data.chapter_background_usage_log : []

    const prior = log.find(entry => chapterRotationKey(entry.episode_code, entry.chapter_slug) === key)
    if (prior) {
      const index = pool.items.findIndex(item => item.id === prior.background_id)
      if (index >= 0) {
        result = { item: pool.items[index]!, index, cursor }
      }
    }
    if (result) return

    let decision = decideChapterBackground(pool, cursor)
    if (backgroundId) {
      const explicitIndex = pool.items.findIndex(item => item.id === backgroundId)
      const enabledList = pool.items.filter(entry => entry.enabled)
      const enabledIndex = explicitIndex >= 0 ? enabledList.indexOf(pool.items[explicitIndex]!) : -1
      if (enabledIndex >= 0) {
        const item = pool.items[explicitIndex]!
        decision = {
          item,
          index: enabledIndex,
          cursor: { last_background_id: item.id, last_index: enabledIndex },
        }
      }
    }
    if (!decision) return

    const entry: ChapterBackgroundUsageEntry = {
      episode_code: episodeCode,
      chapter_slug: trimmedChapter,
      background_id: decision.item.id,
      reference: decision.item.reference,
      picked_at: new Date().toISOString(),
    }
    data.chapter_background_usage_log = [entry, ...log.filter(e => chapterRotationKey(e.episode_code, e.chapter_slug) !== key)].slice(0, LOG_CAP)
    data.chapter_background_cursor = decision.cursor
    result = decision
  })

  return result
}

/**
 * Resolve a pool reference to an absolute path, restricted to what this
 * channel owns:
 *
 *  1. `${BACKGROUND}/<id>` and bare catalog ids → the approved catalog only
 *     (integrity-checked; unknown/pending ids fail loudly).
 *  2. `${CHANNEL}/backgrounds/<file>` and plain filenames → this channel's own
 *     inventory, with realpath containment.
 *  3. Absolute paths → accepted only when their realpath stays inside the
 *     channel's own inventory folder (an explicit local reference to a file
 *     the channel owns), never for anything outside.
 *
 * Anything else — `..` traversal, another channel's folder, a symlink pointing
 * out, a file the inventory does not list — is refused by name.
 */
export async function resolveChapterBackground(
  slug: string,
  referenceOrId: string,
): Promise<string> {
  const ref = (referenceOrId || '').trim()
  if (!ref) throw new Error('Chapter background reference is empty.')

  const inventoryDir = inventoryDirFor(slug)

  // 1. Catalog forms — approved catalog membership only.
  const catalogRef = ref.startsWith('${BACKGROUND}/') ? ref.slice('${BACKGROUND}/'.length) : ref
  if (!catalogRef.includes('/') && !path.isAbsolute(catalogRef)) {
    const approved = listBackgrounds().find(entry => entry.id === catalogRef)
    if (approved || ref.startsWith('${BACKGROUND}/')) {
      if (ref.startsWith('${BACKGROUND}/') && catalogRef.includes('..')) {
        throw new Error(`Chapter background "${ref}" is not an approved catalog background on channel "${slug}".`)
      }
      // resolveBackground validates id shape + integrity and names unknown/pending ids.
      return resolveBackground(catalogRef)
    }
  }

  // 2. Channel inventory forms.
  if (!inventoryDir) throw new Error(`Channel "${slug}" has no project directory on this Mac.`)

  let candidate: string | null = null
  if (ref.startsWith('${CHANNEL}/')) {
    const rel = ref.slice('${CHANNEL}/'.length)
    const file = rel.startsWith('backgrounds/') ? rel.slice('backgrounds/'.length) : rel
    if (!file || file.includes('/') || file.includes('\\') || file === '..' || file.includes('..')) {
      throw new Error(`Chapter background "${ref}" points outside channel "${slug}" and was refused.`)
    }
    candidate = path.join(inventoryDir, file)
  } else if (!ref.includes('/') && !ref.includes('\\') && ref !== '..' && !ref.includes('..')) {
    // Plain filename → must be in this channel's inventory (ownership by lookup).
    const inventory = await listChannelBackgroundFiles(slug)
    if (!inventory.includes(ref)) {
      throw new Error(`Chapter background "${ref}" is not one of channel "${slug}"'s own background files.`)
    }
    candidate = path.join(inventoryDir, ref)
  } else if (path.isAbsolute(ref)) {
    // 3. Absolute: kept only when it IS this channel's own inventory file.
    candidate = ref
  } else {
    throw new Error(`Chapter background "${ref}" is not an approved catalog background or a file of channel "${slug}".`)
  }

  if (!existsSync(candidate)) {
    throw new Error(`Chapter background "${ref}" does not exist in channel "${slug}"'s backgrounds folder.`)
  }
  if (!(await containedInInventory(inventoryDir, candidate))) {
    throw new Error(`Chapter background "${ref}" resolves outside channel "${slug}"'s own backgrounds folder and was refused.`)
  }
  return path.resolve(candidate)
}

/** Full editor state. A failed catalog is reported as unavailable with its reason — never as an empty success. */
export async function getChapterBackgroundPoolState(slug: string): Promise<ChapterBackgroundPoolState> {
  const [pool, cursor, recent_usage, channel_files] = await Promise.all([
    getChapterBackgroundPool(slug),
    getChapterBackgroundCursor(slug),
    getChapterBackgroundUsageLog(slug),
    listChannelBackgroundFiles(slug),
  ])

  let catalog: ChapterBackgroundCatalogState
  try {
    catalog = { available: true, entries: listBackgrounds() }
  } catch (error: any) {
    catalog = {
      available: false,
      entries: [],
      reason: `Background catalog unavailable: ${error?.message || error}`,
    }
  }

  const inventoryDir = inventoryDirFor(slug)
  return {
    pool,
    cursor,
    recent_usage,
    catalog,
    channel_files,
    folder: inventoryDir && existsSync(inventoryDir) ? inventoryDir : null,
  }
}
