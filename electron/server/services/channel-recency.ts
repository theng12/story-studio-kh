/**
 * When a channel was last WORKED ON — including work done INSIDE one of its
 * episodes.
 *
 * ── What changed and why ──
 *
 * The first version of this measure (1.4.35x) statted four things at the
 * channel's top level: `jobs.json`, `config.json`, `project.json` and the
 * `episodes/` folder. That answers "did the channel itself change", which is a
 * good proxy for "did a job run" and a poor answer for "did a person work on an
 * episode": a script edited inside an episode folder, a scene plan saved, a
 * chapter re-recorded — none of them touches the channel folder or `episodes/`,
 * so the sort labelled "Recently worked on" left the channel where it was. The
 * owner asked for the real thing (2026-10-26).
 *
 * ── The definition ──
 *
 * The newest modification time of:
 *   - the channel's own work files (`project.json`, `config.json`, `jobs.json`,
 *     `ideas.json`, `continuity.json`, the upload overrides, the production
 *     standards note) and the `episodes/` folder itself;
 *   - each episode folder, the sidecar files sitting directly in it
 *     (`scene_plan.json`, `audio_chapters.json`, `broll-selection.json`, …),
 *     and the FILES inside its text-artifact subfolders — script, metadata,
 *     scene prompts, thumbnail prompts, subtitles.
 *
 * The heavy media folders (scene images, thumbnails, audio, merged audio,
 * video) contribute their OWN mtime — a file added, replaced or removed — but
 * are never read into. A 300-scene episode would otherwise cost 300+ stats per
 * channel per list read, and every media write already rewrites `jobs.json`
 * through the job queue, so the thing a deep media scan would catch is covered
 * by the cheaper measure.
 *
 * ── What is ignored, deliberately ──
 *
 * `_trash/`, `_backups/`, dot-folders (`.cache/`, `.audio-quality-*`), and
 * `*.lock` files. None of them is work: a lock is a moment of coordination, a
 * cache is derived, `_trash` is where removals go. Counting them would let
 * housekeeping move a channel to the top of "Recently worked on".
 *
 * ── Cost ──
 *
 * Bounded depth: `episodes/` → season → episode → text folder → file. No
 * recursive walk of the media trees. The result is cached per channel and
 * dropped when the project's folder watcher sees a change under `episodes/`
 * (see `episode-folder-watcher.ts`), with a short TTL as the safety net for a
 * Library big enough to lose its watcher to the LRU cap. A walk that does not
 * finish inside `WALK_TIMEOUT_MS` — a stalled volume — yields UNKNOWN, never a
 * zero (AGENTS §6), so the list sorts it last rather than calling it the oldest
 * channel in the Library.
 *
 * No cheaper authoritative source exists to prefer: `jobs.json` carries job
 * timestamps but only for generated work (not edits); `ideas.json` is a
 * channel-level index rewritten on idea changes; the episode-status cache is
 * about readiness, not activity, and resolving an episode's paths costs more
 * than this walk.
 */

import fs from 'fs/promises'
import path from 'path'

import { TRASH_DIRNAME } from '../lib/trash-move.js'
import { DEFAULT_SUBFOLDER_NAMES, type SubfolderNames } from '../models/types.js'

/** Channel-level files a person or a generator edits. */
const CHANNEL_WORK_FILES = [
  'project.json',
  'config.json',
  'jobs.json',
  'ideas.json',
  'continuity.json',
  'upload_metadata_overrides.json',
  'production_standards.txt',
  // Where a self-contained channel keeps its final renders. The folder's own
  // mtime moves when a final is added or replaced; the tree under it is not
  // walked (a finished render is also a job, and jobs.json already moved).
  'Exports',
] as const

/**
 * Episode subfolders that hold TEXT artifacts — the ones a person edits by
 * hand, and the only ones read into. Everything else is statted, not listed.
 */
const TEXT_SUBFOLDER_KEYS = ['script', 'metadata', 'scene_prompts', 'thumb_prompts', 'subtitles'] as const

/** Housekeeping, never work. Dot-entries are covered by `skipEntry`. */
const IGNORED_NAMES = new Set([TRASH_DIRNAME, '_backups', 'node_modules'])

/**
 * An episode folder is named `<CODE> - <title>`, with the code at the front.
 * Season containers (`Season 001`, or whatever prefix the channel chose) do not
 * match, which is how one level of season is told apart from an episode.
 */
const EPISODE_FOLDER_NAME = /^[A-Za-z]{1,4}\d{3,5}\b/

/** How long a cached answer survives without an invalidation event. */
const CACHE_TTL_MS = 60_000
/** A walk that takes longer than this is a stalled disk, not a big channel. */
const WALK_TIMEOUT_MS = 10_000
const MAX_CACHED_CHANNELS = 200

interface CacheEntry {
  slug: string
  /** Newest of the cheap channel-level markers when the value was computed. */
  markers: number
  at: number
  value: string | null
}

/** Key: the channel folder. Value: the last answer and the markers it saw. */
const cache = new Map<string, CacheEntry>()

export interface ChannelRecencyInput {
  slug: string
  channelDir: string
  /** The channel's own subfolder names, when project.json carries them. */
  subfolderNames?: Partial<SubfolderNames>
}

/** Drop every cached answer for a channel — called when its tree changes. */
export function forgetChannelRecency(slug: string): void {
  for (const [dir, entry] of cache) {
    if (entry.slug === slug) cache.delete(dir)
  }
}

/** Test hook — a fresh process never needs this, a shared one might. */
export function _clearChannelRecencyCache(): void {
  cache.clear()
}

function skipEntry(name: string): boolean {
  return !name || name.startsWith('.') || IGNORED_NAMES.has(name) || name.endsWith('.lock')
}

async function mtimeOf(target: string): Promise<number> {
  const stat = await fs.stat(target).catch(() => null)
  return stat?.mtimeMs ?? 0
}

/**
 * The cheap half: how the channel looks at its own top level. Doubles as the
 * cache's freshness check — if any of these moved, the previous answer is
 * stale even without a watcher event.
 */
async function channelMarkers(channelDir: string): Promise<number> {
  let newest = 0
  await Promise.all([
    ...CHANNEL_WORK_FILES.map(async (name) => {
      const at = await mtimeOf(path.join(channelDir, name))
      if (at > newest) newest = at
    }),
    (async () => {
      const at = await mtimeOf(path.join(channelDir, 'episodes'))
      if (at > newest) newest = at
    })(),
  ])
  return newest
}

/**
 * The suffixes that identify the channel's text-artifact subfolders.
 *
 * The stored templates look like `'{code} - 01 Script'`; the folder on disk is
 * `EP001 - 01 Script`. Matching on the part after `{code}` is what lets this
 * follow a channel that renamed its own subfolders without resolving every
 * episode's paths (which would need its title, and a read per episode).
 */
function textFolderSuffixes(subfolderNames?: Partial<SubfolderNames>): string[] {
  return TEXT_SUBFOLDER_KEYS.map((key) => {
    const template = String(subfolderNames?.[key] || DEFAULT_SUBFOLDER_NAMES[key])
    const suffix = template.split('{code}').join('')
    // A template that is only `{code}` would `endsWith('')` on every folder.
    return suffix || DEFAULT_SUBFOLDER_NAMES[key].split('{code}').join('')
  })
}

/**
 * Everything worth knowing about one episode folder, in one pass:
 * the folder, its direct children (sidecars and subfolders), and the files
 * inside the text subfolders only.
 */
async function episodeNewest(episodeDir: string, suffixes: readonly string[]): Promise<number> {
  let newest = await mtimeOf(episodeDir)
  const entries = await fs.readdir(episodeDir, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.map(async (entry) => {
    if (skipEntry(entry.name)) return
    const full = path.join(episodeDir, entry.name)
    const at = await mtimeOf(full)
    if (at > newest) newest = at
    if (!entry.isDirectory() || !suffixes.some(suffix => entry.name.endsWith(suffix))) return
    // A text-artifact folder: its FILES are the work. In-place rewrites (a
    // script saved over itself) do not move the folder's mtime, so they have
    // to be statted.
    const files = await fs.readdir(full).catch(() => [])
    await Promise.all(files.map(async (name) => {
      if (skipEntry(name)) return
      const fileAt = await mtimeOf(path.join(full, name))
      if (fileAt > newest) newest = fileAt
    }))
  }))
  return newest
}

/** A season container: its children can be episode folders. One level only. */
async function seasonNewest(seasonDir: string, suffixes: readonly string[]): Promise<number> {
  let newest = await mtimeOf(seasonDir)
  const entries = await fs.readdir(seasonDir, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.map(async (entry) => {
    if (skipEntry(entry.name)) return
    const full = path.join(seasonDir, entry.name)
    const at = await mtimeOf(full)
    if (at > newest) newest = at
    if (!entry.isDirectory()) return
    const episodeAt = await episodeNewest(full, suffixes)
    if (episodeAt > newest) newest = episodeAt
  }))
  return newest
}

async function computeNewest(input: ChannelRecencyInput, markers: number): Promise<string | null> {
  // Nothing at the channel's own level could be read: unknown, not zero. A
  // channel folder with no project.json is not a channel and never gets here.
  if (!markers) return null

  const suffixes = textFolderSuffixes(input.subfolderNames)
  let newest = markers
  const episodesDir = path.join(input.channelDir, 'episodes')
  const entries = await fs.readdir(episodesDir, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.map(async (entry) => {
    if (skipEntry(entry.name)) return
    const full = path.join(episodesDir, entry.name)
    const at = await mtimeOf(full)
    if (at > newest) newest = at
    if (!entry.isDirectory()) return
    const inner = EPISODE_FOLDER_NAME.test(entry.name)
      ? episodeNewest(full, suffixes)
      : seasonNewest(full, suffixes)
    const deepAt = await inner
    if (deepAt > newest) newest = deepAt
  }))
  return newest > 0 ? new Date(newest).toISOString() : null
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    if (typeof timer.unref === 'function') timer.unref()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })
}

/**
 * When this channel was last worked on, as an ISO string — or null for UNKNOWN
 * (the channel could not be read, or the walk did not finish in time).
 */
export async function channelLastWorkedAt(input: ChannelRecencyInput): Promise<string | null> {
  const markers = await channelMarkers(input.channelDir)
  const hit = cache.get(input.channelDir)
  if (hit && hit.slug === input.slug && hit.markers === markers && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value
  }

  const value = markers ? await withTimeout(computeNewest(input, markers), WALK_TIMEOUT_MS) : null

  if (cache.size >= MAX_CACHED_CHANNELS && !cache.has(input.channelDir)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(input.channelDir, { slug: input.slug, markers, at: Date.now(), value })
  return value
}
