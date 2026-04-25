/**
 * Idea persistence and episode folder creation.
 * Stores all generated ideas in projects/{slug}/ideas.json.
 * Handles accepting ideas → creating episode folders with auto-incrementing codes.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { PROJECTS_ROOT } from './project-manager.js'
import { resolveEpisodePaths, formatEpisodeCode } from './utils.js'
import * as pm from './project-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'

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
}

interface IdeasStore {
  ideas: StoredIdea[]
  next_episode_number: number
  recycled_numbers?: number[]
}

// ── Persistence ─────────────────────────────────────────────────────────────

function ideasPath(slug: string): string {
  return path.join(PROJECTS_ROOT, slug, 'ideas.json')
}

/**
 * Raw disk read — returns the parsed store or a fresh empty one. Does NOT
 * perform auto-heal or persist anything. Callers that need a consistent view
 * for a read-modify-write must go through `mutateStore`.
 */
async function readStoreFromDisk(slug: string): Promise<IdeasStore> {
  const p = ideasPath(slug)
  if (existsSync(p)) {
    try {
      const data = JSON.parse(await fs.readFile(p, 'utf-8'))
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
async function applyAutoHeal(slug: string, store: IdeasStore): Promise<boolean> {
  const meta = await pm.getProject(slug)
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
  const recycledSet = new Set(store.recycled_numbers)
  let healed = false
  for (let n = 1; n <= maxNum; n++) {
    if (!usedSet.has(n) && !recycledSet.has(n) && n < store.next_episode_number) {
      store.recycled_numbers.push(n)
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
async function loadStore(slug: string): Promise<IdeasStore> {
  const store = await readStoreFromDisk(slug)
  await applyAutoHeal(slug, store)
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

export async function getIdeas(slug: string, filter?: IdeaStatus): Promise<StoredIdea[]> {
  const store = await loadStore(slug)
  if (filter) return store.ideas.filter(i => i.status === filter)
  return store.ideas
}

export async function addIdeas(
  slug: string, ideas: Array<{
    title: string; logline: string; themes: string[];
    suggested_chapters: number; suggested_length: string; mood: string;
  }>,
  model: string,
): Promise<StoredIdea[]> {
  return mutateStore(slug, (store) => {
    const batchId = `batch-${Date.now()}`
    const now = new Date().toISOString()

    const newIdeas: StoredIdea[] = ideas.map((idea, i) => ({
      id: `idea-${Date.now()}-${i}`,
      ...idea,
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
 * Patch mutable fields on an existing idea. Does NOT rename a folder even if
 * the idea is already accepted — the folder name is baked at accept time, and
 * renaming it would invalidate all downstream generator references.
 */
export async function updateIdea(
  slug: string,
  ideaId: string,
  patch: Partial<Pick<StoredIdea, 'title' | 'logline' | 'themes' | 'suggested_chapters' | 'suggested_length' | 'mood'>>,
): Promise<StoredIdea | null> {
  return mutateStore(slug, (store) => {
    const idea = store.ideas.find(i => i.id === ideaId)
    if (!idea) return null
    if (patch.title !== undefined) idea.title = patch.title
    if (patch.logline !== undefined) idea.logline = patch.logline
    if (patch.themes !== undefined) idea.themes = patch.themes
    if (patch.suggested_chapters !== undefined) idea.suggested_chapters = patch.suggested_chapters
    if (patch.suggested_length !== undefined) idea.suggested_length = patch.suggested_length
    if (patch.mood !== undefined) idea.mood = patch.mood
    return idea
  })
}

export async function getNextEpisodeNumber(slug: string): Promise<number> {
  const store = await loadStore(slug)
  return store.next_episode_number
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
): Promise<AcceptResult> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

  // Phase 1 (locked): reserve the episode number & flip idea status atomically.
  // Folder creation is deliberately kept OUTSIDE the lock — each episode gets a
  // unique code from this phase, so per-episode filesystem work can proceed in
  // parallel without contending on ideas.json.
  const { idea, episodeCode } = await mutateStore(slug, (store) => {
    const idea = store.ideas.find(i => i.id === ideaId)
    if (!idea) throw new Error('Idea not found')
    if (idea.status === 'accepted') throw new Error('Idea already accepted')

    // Assign episode code — use recycled number if available, otherwise increment
    let epNum: number
    if (store.recycled_numbers && store.recycled_numbers.length > 0) {
      epNum = store.recycled_numbers.shift()!
    } else {
      epNum = store.next_episode_number
      store.next_episode_number++
    }
    const episodeCode = formatEpisodeCode(epNum, meta.episode_prefix, meta.episode_digits)

    idea.status = 'accepted'
    idea.episode_code = episodeCode
    idea.accepted_at = new Date().toISOString()

    return { idea, episodeCode }
  })

  // Phase 2 (unlocked): create folder structure (all 8 subfolders).
  const paths = await resolveEpisodePaths(slug, episodeCode, idea.title)
  const foldersCreated: string[] = []

  for (const dir of [
    paths.script_dir, paths.scene_prompts_dir, paths.thumb_prompts_dir,
    paths.metadata_dir, paths.bg_dir, paths.thumb_dir,
    paths.audio_dir, paths.video_dir,
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

export async function acceptMultipleIdeas(
  slug: string,
  ideaIds: string[],
): Promise<AcceptResult[]> {
  const results: AcceptResult[] = []
  for (const id of ideaIds) {
    results.push(await acceptIdea(slug, id))
  }
  return results
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
  if (!existsSync(paths.episode_dir)) return { ...empty, episode_dir: paths.episode_dir }

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
 * Reset an accepted idea back to 'new', delete its episode folder,
 * and recycle the episode number if it was the highest.
 */
export async function resetIdea(slug: string, ideaId: string): Promise<{ deleted_folder: string | null }> {
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

  // Delete the episode folder outside the lock (slow rm).
  let deletedFolder: string | null = null
  if (episodeCode) {
    const paths = await resolveEpisodePaths(slug, episodeCode, snapshotIdea.title)
    if (existsSync(paths.episode_dir)) {
      await fs.rm(paths.episode_dir, { recursive: true })
      deletedFolder = paths.episode_dir
    }
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

  return { deleted_folder: deletedFolder }
}

/**
 * Delete an episode folder by code (from Jobs page, not tied to an idea).
 */
export async function deleteEpisodeFolder(slug: string, episodeCode: string): Promise<{ deleted_folder: string | null }> {
  const meta = await pm.getProject(slug)
  if (!meta) throw new Error('Project not found')

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

  // Delete the folder outside the lock (slow rm).
  const episodeDir = await findEpisodeDir(outputRoot)
  let deletedFolder: string | null = null
  if (episodeDir) {
    await fs.rm(episodeDir, { recursive: true })
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
