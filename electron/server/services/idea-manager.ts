/**
 * Idea persistence and episode folder creation.
 * Stores all generated ideas in projects/{slug}/ideas.json.
 * Handles accepting ideas → creating episode folders with auto-incrementing codes.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { resolveEpisodePaths, formatEpisodeCode, projectDirFor, projectMetaOnce, type EpisodePaths, type ProjectFactsCache } from './utils.js'
import * as pm from './project-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'

export type IdeaStatus = 'new' | 'accepted' | 'dismissed'

export interface StoredIdea {
  id: string
  title: string
  logline: string
  themes: string[]
  suggested_chapters: number
  suggested_length: string
  mood: string
  status: IdeaStatus
  episode_code: string | null  // Set when accepted
  generated_at: string
  accepted_at: string | null
  batch_id: string  // Groups ideas from the same generation run
  model_used: string
  idea_fingerprint?: string
  series_formula_id?: string
  topic_pack_ids?: string[]
  idea_dimensions?: Record<string, string>
  campaign_id?: string
  /**
   * Per-episode "this is done outside the app" overrides — supports two
   * cases:
   *   - YouTube imports already published: marked_done=true short-circuits
   *     the asset-status compute to all-true so the pipeline view stops
   *     showing them as "needs work".
   *   - Pre-Story-Studio assets: status_overrides lets the user force
   *     individual asset booleans true/false on top of file detection
   *     (e.g. "I have audio + scenes from elsewhere; mark those true,
   *     keep file-detection for everything else").
   *
   * Both fields are absent on every existing record on disk → readers
   * treat absence as "no overrides" → today's behavior unchanged.
   */
  marked_done?: boolean
  marked_done_at?: string | null
  status_overrides?: Partial<EpisodeStatus>
}

// Re-imported (not re-declared) to avoid a circular import — asset-status.ts
// imports from this module too. We use a type-only import so the compiled
// output has no runtime dependency on asset-status here.
import type { EpisodeStatus } from './asset-status.js'

interface IdeasStore {
  ideas: StoredIdea[]
  next_episode_number: number
  recycled_numbers?: number[]
}

// ── Persistence ─────────────────────────────────────────────────────────────

function ideasPath(slug: string, cache?: ProjectFactsCache): string {
  // Use getProjectDir so linked-project locations (e.g. an iCloud-synced
  // folder registered via "Add existing project folder…") resolve to the
  // right ideas.json. Falling back to the default location keeps fresh
  // project creation working before the dir exists on disk.
  return path.join(projectDirFor(slug, cache), 'ideas.json')
}

/**
 * Raw disk read — returns the parsed store or a fresh empty one. Does NOT
 * perform auto-heal or persist anything. Callers that need a consistent view
 * for a read-modify-write must go through `mutateStore`.
 */
async function readStoreFromDisk(slug: string, cache?: ProjectFactsCache): Promise<IdeasStore> {
  const p = ideasPath(slug, cache)
  return parseStore(existsSync(p) ? await fs.readFile(p, 'utf-8').catch(() => null) : null)
}

function parseStore(text: string | null): IdeasStore {
  if (text !== null) {
    try {
      const data = JSON.parse(text)
      return {
        ideas: data.ideas || [],
        next_episode_number: data.next_episode_number || 1,
        recycled_numbers: data.recycled_numbers || [],
      }
    } catch { /* corrupt file — fall through to empty */ }
  }
  return { ideas: [], next_episode_number: 1, recycled_numbers: [] }
}

/**
 * In-memory auto-heal: populate `recycled_numbers` with gaps between 1 and the
 * highest used episode number. Mutates `store` in place and returns whether
 * anything changed. Persistence is the caller's responsibility.
 */
async function applyAutoHeal(slug: string, store: IdeasStore, cache?: ProjectFactsCache): Promise<boolean> {
  // `projectMetaOnce` is the same `project.json` `getProject` reads, reached
  // through the request-scoped cache. Only `episode_prefix` is used here, and
  // it cannot change while one response is being built — so a 302-episode list
  // should not read and parse project.json 1,340 times to learn it.
  const meta = cache
    ? await projectMetaOnce(slug, cache).catch(() => null)
    : await pm.getProject(slug)
  if (!meta) return false
  const acceptedNums = store.ideas
    .filter(i => i.status === 'accepted' && i.episode_code)
    .map(i => parseInt(i.episode_code!.replace(meta.episode_prefix, ''), 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b)
  if (acceptedNums.length === 0) return false
  const maxNum = Math.max(...acceptedNums, store.next_episode_number - 1)
  const usedSet = new Set(acceptedNums)
  if (!store.recycled_numbers) store.recycled_numbers = []
  let healed = false

  // Bidirectional cleanup: REMOVE any code from recycled_numbers that's
  // now in use by an accepted idea. This catches the case where direct
  // writes outside mutateStore (e.g. adoptOne in upload-orphans.ts)
  // filled a slot we'd previously marked as recyclable. Without this,
  // a stale recycled_numbers entry causes acceptIdea to hand out a
  // code that's already taken — duplicate-code corruption that
  // surfaces as "new ideas overwrite old ones at TN0001".
  const filtered = store.recycled_numbers.filter(n => !usedSet.has(n))
  if (filtered.length !== store.recycled_numbers.length) {
    store.recycled_numbers = filtered
    healed = true
  }

  // Forward cleanup: ADD any gap below the high-water mark to
  // recycled_numbers (the original behaviour). Only counts a number as
  // a "gap" if it's neither used NOR already-recycled — set rebuilt
  // post-filter so we don't double-add anything we just removed.
  const recycledSet = new Set(store.recycled_numbers)
  for (let n = 1; n <= maxNum; n++) {
    if (!usedSet.has(n) && !recycledSet.has(n) && n < store.next_episode_number) {
      store.recycled_numbers.push(n)
      recycledSet.add(n)
      healed = true
    }
  }
  if (healed) store.recycled_numbers.sort((a, b) => a - b)
  return healed
}

/**
 * Read-only load. Returns a healed view of the store but does NOT persist the
 * heal back to disk — only `mutateStore` writes. Safe for pure readers like
 * `getIdeas` / `getNextEpisodeNumber`.
 */
// S15: readers re-read ideas.json (hundreds of KB on a big channel) on every call, which on a busy
// disk is the slow part. Its text is kept per path + inode + size + mtime; each reader parses its own
// copy (as fast as a clone). Writers (mutateStore) always read the disk.
const readMemo = new Map<string, { signature: string; text: string }>()

async function readStoreMemo(slug: string, cache?: ProjectFactsCache): Promise<IdeasStore> {
  const p = ideasPath(slug, cache)
  const info = await fs.stat(p).catch(() => null)
  if (!info) return parseStore(null)
  const signature = `${info.size}:${info.mtimeMs}:${info.ino}`
  const hit = readMemo.get(p)
  if (hit?.signature === signature) return parseStore(hit.text)
  const text = await fs.readFile(p, 'utf-8').catch(() => null)
  if (text !== null) readMemo.set(p, { signature, text })
  return parseStore(text)
}

async function loadStore(slug: string, cache?: ProjectFactsCache): Promise<IdeasStore> {
  const store = await readStoreMemo(slug, cache)
  await applyAutoHeal(slug, store, cache)
  return store
}

/**
 * Serialised read-modify-write for ideas.json.
 *
 * Takes an exclusive lock on the slug's ideas.json path, loads the current
 * store, applies auto-heal, invokes `fn(store)` to mutate it, then writes the
 * result atomically (temp file + rename). If `fn` throws, the file is left
 * untouched and the lock is released.
 *
 * Every mutator in this module must go through this helper — a bare write
 * would race with concurrent callers and a SIGKILL mid-write could truncate
 * ideas.json, wiping the operator's entire backlog on next load.
 */
async function mutateStore<T>(
  slug: string,
  fn: (store: IdeasStore) => Promise<T> | T,
): Promise<T> {
  return withLock(ideasPath(slug), async () => {
    const store = await readStoreFromDisk(slug)
    await applyAutoHeal(slug, store)
    const result = await fn(store)
    await writeJsonAtomic(ideasPath(slug), store)
    return result
  })
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * An idea title becomes part of the episode folder name ({code} - {title}),
 * and a folder name cannot hold a path separator — resolveEpisodePaths refuses
 * one outright. "AC/DC" or "Before/After" used to be stored as-is and then
 * fail at Accept, so separators are swapped for a dash where titles enter.
 */
export function sanitizeIdeaTitle(title: string): string {
  return String(title ?? '').replace(/[/\\\u0000]+/g, '-').trim()
}

export async function getIdeas(slug: string, filter?: IdeaStatus, cache?: ProjectFactsCache): Promise<StoredIdea[]> {
  const store = await loadStore(slug, cache)
  if (filter) return store.ideas.filter(i => i.status === filter)
  return store.ideas
}

export async function addIdeas(
  slug: string, ideas: Array<{
    title: string; logline: string; themes: string[];
    suggested_chapters: number; suggested_length: string; mood: string;
    idea_fingerprint?: string; series_formula_id?: string;
    topic_pack_ids?: string[]; idea_dimensions?: Record<string, string>;
    campaign_id?: string;
  }>,
  model: string,
  batchIdOverride?: string,
): Promise<StoredIdea[]> {
  return mutateStore(slug, (store) => {
    const batchId = batchIdOverride || `batch-${Date.now()}`
    const now = new Date().toISOString()

    const newIdeas: StoredIdea[] = ideas.map((idea, i) => ({
      id: `idea-${Date.now()}-${i}`,
      ...idea,
      title: sanitizeIdeaTitle(idea.title),
      status: 'new' as IdeaStatus,
      episode_code: null,
      generated_at: now,
      accepted_at: null,
      batch_id: batchId,
      model_used: model,
    }))

    store.ideas.push(...newIdeas)
    return newIdeas
  })
}

/**
 * Patch mutable fields on an existing idea. JSON-only: writes the new
 * values to ideas.json and returns the updated record. Does NOT touch
 * the on-disk episode folder — callers that need the folder name to
 * follow the title (route handler PATCH /ideas/:id, post-script title
 * sync in episode.ts) call `renameEpisodeFolderForTitleChange` from
 * `episode-folder-title-sync.ts` AFTER this returns. JSON is updated
 * first so a folder-rename failure leaves the source of truth correct.
 */
export async function updateIdea(
  slug: string,
  ideaId: string,
  patch: Partial<Pick<StoredIdea, 'title' | 'logline' | 'themes' | 'suggested_chapters' | 'suggested_length' | 'mood'>>,
): Promise<StoredIdea | null> {
  return mutateStore(slug, (store) => {
    const idea = store.ideas.find(i => i.id === ideaId)
    if (!idea) return null
    if (patch.title !== undefined) idea.title = sanitizeIdeaTitle(patch.title)
    if (patch.logline !== undefined) idea.logline = patch.logline
    if (patch.themes !== undefined) idea.themes = patch.themes
    if (patch.suggested_chapters !== undefined) idea.suggested_chapters = patch.suggested_chapters
    if (patch.suggested_length !== undefined) idea.suggested_length = patch.suggested_length
    if (patch.mood !== undefined) idea.mood = patch.mood
    return idea
  })
}

// ── Mark-done + status overrides (Part 4 of mark-done plan) ──────────────
//
// These flip the new optional fields on a StoredIdea. The corresponding
// route handlers also call episodeStatusCache.invalidate(slug, code) so
// the next pipeline read sees the change without waiting for an mtime
// bump on disk.

/**
 * Flip `marked_done` on a single idea. Pass `done: true` to suppress the
 * episode from "needs work" lists; pass `done: false` to revert and let
 * file detection drive the status again. Returns the updated idea, or
 * null when no idea has the given episode code.
 */
export async function markEpisodeDone(
  slug: string,
  episode_code: string,
  done: boolean,
): Promise<StoredIdea | null> {
  const CODE = episode_code.toUpperCase()
  return mutateStore(slug, (store) => {
    const idea = store.ideas.find(i => (i.episode_code || '').toUpperCase() === CODE)
    if (!idea) return null
    idea.marked_done = done
    idea.marked_done_at = done ? new Date().toISOString() : null
    return idea
  })
}

/**
 * Replace per-asset status overrides for an episode. Pass `null` to clear
 * (revert to pure file detection). Pass an object whose keys are
 * EpisodeStatus fields → boolean to force them. Unknown keys are ignored.
 */
export async function setEpisodeStatusOverrides(
  slug: string,
  episode_code: string,
  overrides: Record<string, boolean> | null,
): Promise<StoredIdea | null> {
  const CODE = episode_code.toUpperCase()
  // Sanitize the input — only known EpisodeStatus keys survive. Keeps the
  // on-disk shape clean even if a future field is removed from the type.
  const VALID_KEYS = new Set([
    'research', 'script', 'introduction', 'scene_prompts', 'thumb_prompts',
    'metadata', 'images', 'thumbnails', 'audio', 'merged_audio', 'subtitles',
    'character_sheet', 'broll_picked', 'scene_plan', 'scene_review',
    'motion_review', 'video', 'video_assembly',
  ])
  return mutateStore(slug, (store) => {
    const idea = store.ideas.find(i => (i.episode_code || '').toUpperCase() === CODE)
    if (!idea) return null
    if (overrides === null) {
      delete idea.status_overrides
    } else {
      const cleaned: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(overrides)) {
        if (VALID_KEYS.has(k) && typeof v === 'boolean') cleaned[k] = v
      }
      idea.status_overrides = cleaned as any
    }
    return idea
  })
}

/**
 * Bulk-set marked_done across many episodes in a single atomic write.
 * Used by the Ideas-page "Mark all selected as done" toolbar action.
 * Episode codes that don't match any idea are silently skipped.
 *
 * Returns the count of ideas actually changed (skips no-ops).
 */
export async function bulkMarkDone(
  slug: string,
  episode_codes: string[],
  done: boolean,
): Promise<{ changed: number; total_requested: number }> {
  if (!episode_codes.length) return { changed: 0, total_requested: 0 }
  const wanted = new Set(episode_codes.map(c => c.toUpperCase()))
  return mutateStore(slug, (store) => {
    const now = new Date().toISOString()
    let changed = 0
    for (const idea of store.ideas) {
      const code = (idea.episode_code || '').toUpperCase()
      if (!code || !wanted.has(code)) continue
      if (idea.marked_done === done) continue  // no-op
      idea.marked_done = done
      idea.marked_done_at = done ? now : null
      changed++
    }
    return { changed, total_requested: episode_codes.length }
  })
}

/**
 * Convenience: bulk-set marked_done across every accepted idea matching a
 * provenance source. Currently the only useful value for `source` is
 * 'imported' — the existing import flow stamps `batch_id: 'imported'` on
 * every idea created from an external folder. This is the one-click
 * "mark all 53 YouTube imports as already done" action.
 *
 * Returns the count actually changed + an array of affected episode codes
 * so the UI can show "marked 53 episodes" and invalidate cache entries.
 */
export async function bulkMarkDoneBySource(
  slug: string,
  source: 'imported',
  done: boolean,
): Promise<{ changed: number; episode_codes: string[] }> {
  return mutateStore(slug, (store) => {
    const now = new Date().toISOString()
    const codes: string[] = []
    let changed = 0
    for (const idea of store.ideas) {
      if (idea.batch_id !== source) continue
      if (!idea.episode_code) continue
      if (idea.marked_done === done) {
        // Still report the code in the affected list so the cache
        // invalidator knows to flush even when the flag was already set —
        // belt-and-suspenders for stale cache entries.
        codes.push(idea.episode_code)
        continue
      }
      idea.marked_done = done
      idea.marked_done_at = done ? now : null
      codes.push(idea.episode_code)
      changed++
    }
    return { changed, episode_codes: codes }
  })
}

export async function getNextEpisodeNumber(slug: string): Promise<number> {
  const store = await loadStore(slug)
  return store.next_episode_number
}

/**
 * The number a default Accept will actually hand out: the lowest recycled gap
 * first, else the counter. Same healed view acceptIdea's lock sees, so the
 * Accept dialog can promise exactly the code the click will produce.
 */
export async function getNextAcceptNumber(slug: string): Promise<number> {
  const store = await loadStore(slug)
  return store.recycled_numbers?.length ? store.recycled_numbers[0]! : store.next_episode_number
}

export interface AcceptResult {
  idea: StoredIdea
  episode_code: string
  episode_dir: string
  folders_created: string[]
}

export async function acceptIdea(
  slug: string,
  ideaId: string,
  autoGenerateScript: boolean = false,
  opts: { override_code?: string } = {},
): Promise<AcceptResult> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  // Phase 1 (locked): reserve the episode number & flip idea status atomically.
  // Folder creation is deliberately kept OUTSIDE the lock — each episode gets a
  // unique code from this phase, so per-episode filesystem work can proceed in
  // parallel without contending on ideas.json.
  const { idea, episodeCode, paths } = await mutateStore(slug, async (store) => {
    const idea = store.ideas.find(i => i.id === ideaId)
    if (!idea) throw new Error('Idea not found')
    if (idea.status === 'accepted') {
      throw new Error(`This idea is already accepted${idea.episode_code ? ` as ${idea.episode_code}` : ''}.`)
    }

    let epNum: number
    let episodeCode: string

    if (opts.override_code) {
      // User-supplied custom code path. Validate prefix + parse the
      // number, then enforce uniqueness against current accepted ideas.
      const override = opts.override_code.toUpperCase()
      const example = formatEpisodeCode(42, meta.episode_prefix, meta.episode_digits)
      if (!override.startsWith(meta.episode_prefix.toUpperCase())) {
        throw new Error(`The episode code must start with "${meta.episode_prefix}", for example ${example}.`)
      }
      const numStr = override.slice(meta.episode_prefix.length)
      const parsed = parseInt(numStr, 10)
      if (!Number.isFinite(parsed) || !/^\d+$/.test(numStr) || parsed < 1) {
        throw new Error(`"${opts.override_code}" is not a valid episode code. Use "${meta.episode_prefix}" followed by a positive integer, for example ${example}.`)
      }
      const formatted = formatEpisodeCode(parsed, meta.episode_prefix, meta.episode_digits)
      const collision = store.ideas.find(
        i => i.status === 'accepted' && i.episode_code === formatted,
      )
      if (collision) {
        throw new Error(`Episode code ${formatted} is already in use`)
      }
      epNum = parsed
      episodeCode = formatted
      // Bookkeeping: keep next_episode_number > epNum so subsequent
      // auto-assignments don't collide. Drop epNum from recycled if it
      // was sitting there. Auto-heal will normalise the rest.
      if (epNum >= store.next_episode_number) {
        store.next_episode_number = epNum + 1
      }
      if (Array.isArray(store.recycled_numbers)) {
        store.recycled_numbers = store.recycled_numbers.filter(n => n !== epNum)
      }
    } else {
      // Default path: use recycled if available, else increment.
      if (store.recycled_numbers && store.recycled_numbers.length > 0) {
        epNum = store.recycled_numbers.shift()!
      } else {
        epNum = store.next_episode_number
        store.next_episode_number++
      }
      episodeCode = formatEpisodeCode(epNum, meta.episode_prefix, meta.episode_digits)
    }

    // Resolve the folder BEFORE flipping status. A title stored before titles
    // were sanitised can still hold "/"; heal it here. Any other refusal
    // throws now, so ideas.json is left untouched and the idea stays 'new'
    // instead of becoming "accepted" with no folder and no way to retry.
    idea.title = sanitizeIdeaTitle(idea.title)
    const paths = await resolveEpisodePaths(slug, episodeCode, idea.title)

    idea.status = 'accepted'
    idea.episode_code = episodeCode
    idea.accepted_at = new Date().toISOString()

    return { idea, episodeCode, paths }
  })

  // Phase 2 (unlocked): create the full folder structure (all 10 canonical
  // subfolders) so every stage's folder is present up-front — including
  // 08 Audio Merge Output and 09 Subtitles Output, which used to be created
  // lazily only when those steps ran.
  const foldersCreated: string[] = []

  for (const dir of [
    paths.script_dir, paths.scene_prompts_dir, paths.thumb_prompts_dir,
    paths.metadata_dir, paths.bg_dir, paths.thumb_dir,
    paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir, paths.video_dir,
  ]) {
    await fs.mkdir(dir, { recursive: true })
    foldersCreated.push(dir)
  }

  // Write episode_info.json
  const episodeInfo = {
    episode_code: episodeCode,
    title: idea.title,
    logline: idea.logline,
    themes: idea.themes,
    suggested_chapters: idea.suggested_chapters,
    suggested_length: idea.suggested_length,
    mood: idea.mood,
    model_used: idea.model_used,
    series_formula_id: idea.series_formula_id,
    topic_pack_ids: idea.topic_pack_ids,
    idea_dimensions: idea.idea_dimensions,
    episode_profile: idea.idea_dimensions?.['episode-profile'],
    accepted_at: idea.accepted_at,
    created_from_idea: idea.id,
    project: meta.name,
  }
  await fs.writeFile(
    path.join(paths.episode_dir, 'episode_info.json'),
    JSON.stringify(episodeInfo, null, 2) + '\n',
  )

  return {
    idea,
    episode_code: episodeCode,
    episode_dir: paths.episode_dir,
    folders_created: foldersCreated,
  }
}

export interface BatchAcceptResult {
  accepted: AcceptResult[]
  /** Already accepted before this click — nothing to do, not a failure. */
  skipped: Array<{ id: string; title: string; episode_code: string | null }>
  failed: Array<{ id: string; title: string; reason: string }>
}

/**
 * Accept each idea independently. One bad idea used to stop the loop, leaving
 * the ones before it accepted but the page still showing them as New — and a
 * second click then failed on "already accepted". Every idea now gets its own
 * attempt, and ones accepted earlier are skipped rather than reported as errors.
 */
export async function acceptMultipleIdeas(
  slug: string,
  ideaIds: string[],
): Promise<BatchAcceptResult> {
  const result: BatchAcceptResult = { accepted: [], skipped: [], failed: [] }
  const byId = new Map((await readStoreFromDisk(slug)).ideas.map(idea => [idea.id, idea]))
  for (const id of ideaIds) {
    const known = byId.get(id)
    if (known?.status === 'accepted') {
      result.skipped.push({ id, title: known.title, episode_code: known.episode_code })
      continue
    }
    try {
      result.accepted.push(await acceptIdea(slug, id))
    } catch (e: any) {
      result.failed.push({ id, title: known?.title || id, reason: e?.message || String(e) })
    }
  }
  return result
}

export async function dismissIdea(slug: string, ideaId: string): Promise<boolean> {
  return mutateStore(slug, (store) => {
    const idea = store.ideas.find(i => i.id === ideaId)
    if (!idea) return false
    idea.status = 'dismissed'
    return true
  })
}

export async function removeIdea(slug: string, ideaId: string): Promise<boolean> {
  const meta = await pm.getProject(slug)
  return mutateStore(slug, (store) => {
    const idx = store.ideas.findIndex(i => i.id === ideaId)
    if (idx === -1) return false

    const idea = store.ideas[idx]

    // If the idea was accepted, recycle its episode number
    if (idea.status === 'accepted' && idea.episode_code && meta) {
      const epNum = parseInt(idea.episode_code.replace(meta.episode_prefix, ''), 10)
      if (!isNaN(epNum)) {
        if (epNum === store.next_episode_number - 1) {
          store.next_episode_number = epNum
        } else {
          if (!store.recycled_numbers) store.recycled_numbers = []
          if (!store.recycled_numbers.includes(epNum)) {
            store.recycled_numbers.push(epNum)
            store.recycled_numbers.sort((a: number, b: number) => a - b)
          }
        }
      }
    }

    store.ideas.splice(idx, 1)
    return true
  })
}

export async function updateNextEpisodeNumber(slug: string, num: number): Promise<void> {
  await mutateStore(slug, (store) => {
    store.next_episode_number = num
  })
}

/**
 * Apply a batch of episode-code renames atomically + bump
 * next_episode_number, all under the same lock that every other
 * ideas.json mutator uses. This is the safe entry point for the
 * "shift everyone forward by N to make room for orphan adoptions"
 * flow in upload-orphans.ts — it guarantees auto-heal runs after the
 * renames so `recycled_numbers` stays consistent with the new code
 * assignments (no stale entries pointing at slots that are about to
 * be filled).
 *
 * The fs.rename / folder shuffle is the caller's responsibility — this
 * function only updates ideas.json. Callers should run the fs work
 * BEFORE calling here so disk + state agree on commit.
 */
export async function applyRenumberPatch(
  slug: string,
  patch: {
    /** Each entry maps an idea ID to its new episode code. */
    renames: Array<{ idea_id: string; new_code: string }>
    /** Set next_episode_number to at least this value. */
    advance_next_to: number
  },
): Promise<{ applied: number; missing: string[] }> {
  return mutateStore(slug, async (store) => {
    const missing: string[] = []
    let applied = 0
    for (const r of patch.renames) {
      const idea = store.ideas.find(i => i.id === r.idea_id)
      if (!idea) { missing.push(r.idea_id); continue }
      idea.episode_code = r.new_code
      applied++
    }
    if (patch.advance_next_to > store.next_episode_number) {
      store.next_episode_number = patch.advance_next_to
    }
    // Re-run auto-heal AFTER the mutation so the freshly-vacated slots
    // (the old codes we just shifted out of) become recyclable in the
    // same atomic write. Without this, the renumber leaves a window
    // where the slots are unowned but not in recycled_numbers — a
    // future mutator's pre-fn auto-heal would catch it eventually,
    // but exposing the invariant on commit is cleaner.
    await applyAutoHeal(slug, store)
    return { applied, missing }
  })
}

/**
 * Promote an existing idea straight to "accepted" with a caller-supplied
 * episode_code, without running the acceptIdea flow (which would assign its
 * own code and create folders). Used by episode-import, which already has the
 * folder and only needs to register the association in ideas.json.
 *
 * Also bumps `next_episode_number` past the supplied code if needed, so
 * subsequent regular accepts don't collide with the imported number.
 */
export async function promoteToAccepted(
  slug: string,
  ideaId: string,
  opts: { episode_code: string; accepted_at?: string },
): Promise<StoredIdea | null> {
  return mutateStore(slug, (store) => {
    const idea = store.ideas.find(i => i.id === ideaId)
    if (!idea) return null
    idea.status = 'accepted'
    idea.episode_code = opts.episode_code
    idea.accepted_at = opts.accepted_at || new Date().toISOString()

    // If we auto-bumped the episode number, consume it from the project counter.
    const numMatch = opts.episode_code.match(/(\d+)$/)
    const epNum = numMatch ? parseInt(numMatch[1]!, 10) : 0
    if (epNum >= store.next_episode_number) {
      store.next_episode_number = epNum + 1
    }
    return idea
  })
}

/**
 * Preview the on-disk impact of `resetIdea` so the operator's confirmation
 * dialog can enumerate exactly what's about to be deleted (counts, total
 * size, breakdown by asset kind, last-modified time). Read-only — never
 * mutates state. Returns `file_count: 0` if the folder is missing or empty.
 */
export interface ResetPreview {
  episode_code: string | null
  episode_dir: string | null
  exists: boolean
  file_count: number
  total_bytes: number
  total_bytes_human: string
  breakdown: { images: number; audio: number; video: number; scripts: number; other: number }
  last_modified_iso: string | null
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.opus'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'])
const SCRIPT_EXTS = new Set(['.docx', '.txt', '.md', '.json', '.srt', '.vtt'])

function categorize(ext: string): keyof ResetPreview['breakdown'] {
  const e = ext.toLowerCase()
  if (IMAGE_EXTS.has(e)) return 'images'
  if (AUDIO_EXTS.has(e)) return 'audio'
  if (VIDEO_EXTS.has(e)) return 'video'
  if (SCRIPT_EXTS.has(e)) return 'scripts'
  return 'other'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  const decimals = i >= 2 ? 2 : 0
  return `${value.toFixed(decimals)} ${units[i]}`
}

export async function previewIdeaReset(slug: string, ideaId: string): Promise<ResetPreview> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  const snapshot = await readStoreFromDisk(slug)
  const idea = snapshot.ideas.find(i => i.id === ideaId)
  if (!idea) throw new Error('Idea not found')

  const empty: ResetPreview = {
    episode_code: idea.episode_code,
    episode_dir: null,
    exists: false,
    file_count: 0,
    total_bytes: 0,
    total_bytes_human: '0 B',
    breakdown: { images: 0, audio: 0, video: 0, scripts: 0, other: 0 },
    last_modified_iso: null,
  }
  if (!idea.episode_code) return empty

  const paths = await resolveEpisodePaths(slug, idea.episode_code, idea.title)
  // Un-accept moves the media_root copy too, so the confirm counts it too.
  const heavy = await heavyEpisodeDir(paths, (meta as any).media_root)
  const heavyExists = !!heavy && existsSync(heavy.dir)
  if (!existsSync(paths.episode_dir) && !heavyExists) return { ...empty, episode_dir: paths.episode_dir }

  const breakdown = { images: 0, audio: 0, video: 0, scripts: 0, other: 0 }
  let fileCount = 0
  let totalBytes = 0
  let latestMtimeMs = 0

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      try {
        const st = await fs.stat(full)
        fileCount++
        totalBytes += st.size
        if (st.mtimeMs > latestMtimeMs) latestMtimeMs = st.mtimeMs
        breakdown[categorize(path.extname(entry.name))]++
      } catch { /* skip unreadable entry */ }
    }
  }
  await walk(paths.episode_dir)
  if (heavyExists) await walk(heavy!.dir)

  return {
    episode_code: idea.episode_code,
    episode_dir: paths.episode_dir,
    exists: true,
    file_count: fileCount,
    total_bytes: totalBytes,
    total_bytes_human: formatBytes(totalBytes),
    breakdown,
    last_modified_iso: latestMtimeMs ? new Date(latestMtimeMs).toISOString() : null,
  }
}

/**
 * Move a directory into the project's `_trash` (or `<media_root>/_trash/<slug>`
 * for heavy media on another drive), keeping its path under `anchor`. Nothing
 * the app removes is hard-deleted; the owner empties `_trash` himself.
 */
function trashDirSync(slug: string, dir: string, anchor: string): string | null {
  if (!existsSync(dir)) return null
  const projectDir = projectDirFor(slug)
  const rel = path.relative(anchor, dir)
  const keep = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(dir)
  return moveToTrashSync(dir, path.join(trashRootFor(anchor, projectDir, slug), keep))
}

/**
 * The episode's heavy-media twin under `media_root`, when the project keeps
 * one on another drive. Null when there is no media_root, it is not defined on
 * this Mac, or it resolves to the episode folder itself.
 */
async function heavyEpisodeDir(paths: EpisodePaths, mediaRoot?: string): Promise<{ dir: string; anchor: string } | null> {
  if (!mediaRoot) return null
  const { resolveAssetPath } = await import('./path-resolver.js')
  let anchor: string
  try { anchor = resolveAssetPath(String(mediaRoot), paths.output_root) } catch { return null }
  if (!anchor) return null
  const dir = path.join(anchor, path.relative(paths.output_root, paths.episode_dir))
  return path.resolve(dir) === path.resolve(paths.episode_dir) ? null : { dir, anchor }
}

/**
 * The episode folder plus, when media_root is set, its heavy-media twin.
 *
 * The PROJECT folder moves first and is allowed to throw: if it cannot move,
 * nothing has moved and the caller leaves the idea accepted. The heavy copy
 * moves second; a failure there is reported as a warning rather than thrown,
 * because the episode is already half-moved and un-accepting it is the
 * truthful state. (Heavy-first used to leave media in _trash with the idea
 * still accepted.)
 */
async function trashEpisodeFolders(
  slug: string, paths: EpisodePaths, mediaRoot?: string,
): Promise<{ moved: string | null; warnings: string[] }> {
  const warnings: string[] = []
  const moved = trashDirSync(slug, paths.episode_dir, projectDirFor(slug)) ? paths.episode_dir : null
  const heavy = await heavyEpisodeDir(paths, mediaRoot)
  if (heavy) {
    try { trashDirSync(slug, heavy.dir, heavy.anchor) }
    catch (e: any) {
      warnings.push(`The episode's media folder on the media drive could not be moved to _trash (${e?.message || String(e)}). It is still at ${heavy.dir}.`)
    }
  }
  return { moved, warnings }
}

/**
 * Reset an accepted idea back to 'new', move its episode folder to the
 * project's `_trash`, and recycle the episode number.
 */
export async function resetIdea(slug: string, ideaId: string): Promise<{ deleted_folder: string | null; warnings: string[] }> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  // Resolve the target folder BEFORE taking the lock — we need the idea's
  // current episode_code + title to know where to delete on disk. Reading
  // outside the lock is fine: the only writer that could change these is
  // another call through mutateStore, and if one wins the race it'll flip
  // status away from 'accepted' and the second call will throw cleanly.
  const snapshot = await readStoreFromDisk(slug)
  const snapshotIdea = snapshot.ideas.find(i => i.id === ideaId)
  if (!snapshotIdea) throw new Error('Idea not found')
  if (snapshotIdea.status !== 'accepted') throw new Error('Only accepted ideas can be reset')
  const episodeCode = snapshotIdea.episode_code

  // Move the episode folder to _trash outside the lock. Never a hard delete:
  // Reset used to fs.rm the folder, destroying every rendered asset.
  let deletedFolder: string | null = null
  let warnings: string[] = []
  if (episodeCode) {
    const paths = await resolveEpisodePaths(slug, episodeCode, snapshotIdea.title)
    ;({ moved: deletedFolder, warnings } = await trashEpisodeFolders(slug, paths, (meta as any).media_root))
  }

  // Now commit the state change under the lock.
  await mutateStore(slug, (store) => {
    const idea = store.ideas.find(i => i.id === ideaId)
    if (!idea) throw new Error('Idea not found')
    // If a concurrent writer already reset this idea, skip further mutation.
    if (idea.status !== 'accepted') return

    if (episodeCode) {
      const epNum = parseInt(episodeCode.replace(meta.episode_prefix, ''), 10)
      if (!isNaN(epNum)) {
        // If this was the highest number, we can simply decrement
        // If it's in the middle, we add it to a recycled numbers pool
        if (epNum === store.next_episode_number - 1) {
          store.next_episode_number = epNum
        } else {
          // Add to recycled pool for reuse
          if (!store.recycled_numbers) store.recycled_numbers = []
          store.recycled_numbers.push(epNum)
          store.recycled_numbers.sort((a: number, b: number) => a - b)
        }
      }
    }

    idea.status = 'new'
    idea.episode_code = null
    idea.accepted_at = null
  })

  return { deleted_folder: deletedFolder, warnings }
}

/**
 * Delete an episode folder by code (from Jobs page, not tied to an idea).
 */
export async function deleteEpisodeFolder(slug: string, episodeCode: string): Promise<{ deleted_folder: string | null }> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  // ── What this is allowed to delete ──────────────────────────────────────
  //
  // `episodeCode` arrives straight from the route param, and the matcher below
  // had an `entry.name === episodeCode` branch — so ANY directory name matched.
  // `DELETE /api/projects/<slug>/episodes/Season%20001` resolved to the season
  // folder and recursively removed every episode in it (5–10 GB each).
  //
  // The code is deliberately NOT required to have an accepted idea: the Jobs
  // page uses this for folders that never had one, which is the documented
  // reason this function is separate from the idea lifecycle.
  //
  // `episodeNumber` is deliberately NOT used here: it is an UNANCHORED
  // `${prefix}(\d+)` search, so `"EP0001 - A Real Episode"` matches it and would
  // sail through — and the matcher below has an `entry.name === episodeCode`
  // branch, so that string names a real episode folder and would be recursively
  // deleted. The code must be EXACTLY the prefix plus digits, nothing else.
  const prefix = String((meta as any).episode_prefix || 'EP').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`^${prefix}\\d+$`, 'i').test(episodeCode.trim())) {
    throw new Error(
      `Refusing to delete: '${episodeCode}' is not an episode code for this project. ` +
      `Only a whole episode ("${String((meta as any).episode_prefix || 'EP')}0001") can be deleted this way.`,
    )
  }

  // Find the episode folder by searching
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // Search for the folder
  async function findEpisodeDir(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = path.join(dir, entry.name)
          if (entry.name.startsWith(`${episodeCode} - `) || entry.name === episodeCode) {
            return fullPath
          }
          // Search one level deeper (inside season folders)
          const nested = await findEpisodeDir(fullPath)
          if (nested) return nested
        }
      }
    } catch { /* skip */ }
    return null
  }

  // Move the folder to the project's _trash outside the lock — never a hard delete.
  const episodeDir = await findEpisodeDir(outputRoot)
  let deletedFolder: string | null = null
  if (episodeDir) {
    trashDirSync(slug, episodeDir, projectDirFor(slug))
    deletedFolder = episodeDir
  }

  // Commit the bookkeeping under the lock.
  await mutateStore(slug, (store) => {
    // Recycle the episode number
    const epNum = parseInt(episodeCode.replace(meta.episode_prefix, ''), 10)
    if (!isNaN(epNum)) {
      if (epNum === store.next_episode_number - 1) {
        store.next_episode_number = epNum
      } else {
        if (!store.recycled_numbers) store.recycled_numbers = []
        if (!store.recycled_numbers.includes(epNum)) {
          store.recycled_numbers.push(epNum)
          store.recycled_numbers.sort((a: number, b: number) => a - b)
        }
      }
    }

    // Also reset any idea that was associated with this code
    for (const idea of store.ideas) {
      if (idea.episode_code === episodeCode && idea.status === 'accepted') {
        idea.status = 'new'
        idea.episode_code = null
        idea.accepted_at = null
      }
    }
  })

  return { deleted_folder: deletedFolder }
}
