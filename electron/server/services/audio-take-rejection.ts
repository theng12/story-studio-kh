/**
 * Rejected narration takes (owner, 2026-10-26, after the DM0018 audition: a
 * Khmer narration take was gibberish).
 *
 * A take is what `audio-versions.ts` calls a take: one section's audio version —
 * a single file, or its ordered `_partN` set, at version 1 (the base names) or
 * `_vN`. Rejecting one means: it can never be selected, merged by Audio
 * Assembly, or reached by Video Assembly again, and it is restorable for three
 * days. After that a housekeeping sweep moves its FILES into Story's one Trash
 * (`lib/trash-move.ts`) — never `rm`, never a second trash path.
 *
 * WHERE THE DECISION LIVES. Not in a filename and not in the active selection:
 * `audio_chapters.json` says which take plays, which is a different question
 * from whether the take is usable at all. The durable record is this episode's
 * own sidecar (`audio_take_rejections.json`), keyed by the take's exact file
 * list, carrying `rejected_at` and the reason. Every reader that can act on a
 * take (status, versions list, Audio Assembly, the generator's activation and
 * "Use This Version") asks the same two functions, so a rejection cannot be
 * honoured in one path and forgotten in another (AGENTS.md §8).
 *
 * THE SHAPE IS A MEASUREMENT, NOT A ZERO. An unreadable sidecar is not "no
 * rejections": it throws, because the convenient answer would silently re-enable
 * a take the owner threw away (AGENTS.md §6).
 */

import fs from 'fs/promises'
import path from 'path'
import type { Dirent } from 'fs'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { moveToTrashSync } from '../lib/trash-move.js'
import { trashTargetFor } from './chapter-parts.js'
import { listChapterTakes, useChapterTake } from './audio-versions.js'

/** The episode-root sidecar. Sits beside `audio_chapters.json` and `audio_tts_model.json`. */
export const AUDIO_TAKE_REJECTIONS_SIDECAR = 'audio_take_rejections.json'

/** Owner's window (2026-10-26): a rejected take can be restored for this long. */
export const TAKE_REJECTION_RESTORE_DAYS = 3

/** How many swept records the sidecar keeps for the page to announce. */
const MAX_SWEPT_RECORDS = 20

export interface RejectedTake {
  /** Section slug as the narration document names it (`Chapter_01`, `Introduction`). */
  section: string
  /** This take's files, in playback order (basenames in the audio folder). */
  files: string[]
  /** 1 = the base names, 2+ = a `_vN` take. Informational for the UI label only. */
  version: number
  /** ISO timestamp — the durable fact the restore window and the sweep are measured from. */
  rejected_at: string
  /** What the owner typed, kept verbatim. Never a placeholder. */
  reason: string
}

/** One take the sweep moved to Story's Trash, kept so the page can say what happened. */
export interface SweptTake {
  section: string
  files: string[]
  rejected_at: string
  reason: string
  trashed_at: string
}

export interface TakeRejectionsFile {
  schema_version: 1
  takes: Record<string, RejectedTake>
  /** Newest last. Bounded; only what the Audio page announces. */
  swept?: SweptTake[]
}

/**
 * A FRESH empty store on every call. A shared literal here would hand every
 * episode the same `takes` object, so one channel's rejection would exclude
 * another channel's identically named take — the cross-episode leak AGENTS.md
 * §4 records six times. The tests caught exactly that.
 */
function emptyStore(): TakeRejectionsFile {
  return { schema_version: 1, takes: {} }
}

const DAY_MS = 24 * 60 * 60 * 1000

function sidecarPath(episodeDir: string): string {
  return path.join(episodeDir, AUDIO_TAKE_REJECTIONS_SIDECAR)
}

/** The durable key of one take: its section plus its exact files. */
export function takeRejectionKey(section: string, files: string[]): string {
  return `${section.trim().toLowerCase()}|${files.join('|')}`
}

const isFileList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0
  && value.every(file => typeof file === 'string' && !!file.trim() && path.basename(file) === file)

function normalizeTake(value: unknown): RejectedTake | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const section = typeof row.section === 'string' ? row.section.trim() : ''
  const reason = typeof row.reason === 'string' ? row.reason.trim() : ''
  const rejected_at = typeof row.rejected_at === 'string' ? row.rejected_at.trim() : ''
  const version = Number(row.version)
  if (!section || !reason || !rejected_at || !Number.isFinite(Date.parse(rejected_at))) return null
  if (!isFileList(row.files)) return null
  return {
    section,
    files: [...row.files],
    version: Number.isInteger(version) && version > 0 ? version : 1,
    rejected_at,
    reason,
  }
}

function normalizeSwept(value: unknown): SweptTake | null {
  const take = normalizeTake(value)
  if (!take) return null
  const row = value as Record<string, unknown>
  const trashed_at = typeof row.trashed_at === 'string' ? row.trashed_at.trim() : ''
  if (!trashed_at || !Number.isFinite(Date.parse(trashed_at))) return null
  return { ...take, trashed_at }
}

function normalizeFile(value: unknown): TakeRejectionsFile {
  if (!value || typeof value !== 'object') return emptyStore()
  const row = value as Record<string, unknown>
  const takes: Record<string, RejectedTake> = {}
  if (row.takes && typeof row.takes === 'object' && !Array.isArray(row.takes)) {
    for (const [key, entry] of Object.entries(row.takes as Record<string, unknown>)) {
      const take = normalizeTake(entry)
      // A row we cannot read is kept OUT of the map, and that is why a parse
      // failure throws below instead of returning a partial list: a take whose
      // record cannot be understood must not read as "not rejected".
      if (take) takes[key] = take
    }
  }
  const swept = Array.isArray(row.swept)
    ? row.swept.map(normalizeSwept).filter((item): item is SweptTake => !!item).slice(-MAX_SWEPT_RECORDS)
    : []
  return { schema_version: 1, takes, ...(swept.length ? { swept } : {}) }
}

/**
 * Read this episode's rejections. Missing file = none. A file that exists but
 * cannot be understood THROWS: silently reporting "nothing rejected" would put
 * a take the owner threw away back in play (§6).
 */
export async function readTakeRejections(episodeDir: string): Promise<TakeRejectionsFile> {
  let raw: string
  try {
    raw = await fs.readFile(sidecarPath(episodeDir), 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return emptyStore()
    throw new Error(`the rejected narration takes cannot be read (${error?.message || String(error)})`)
  }
  try {
    const parsed = JSON.parse(raw)
    const shape = parsed && typeof parsed === 'object' && parsed.schema_version === 1 && parsed.takes && typeof parsed.takes === 'object'
    if (!shape) throw new Error('schema_version/takes are missing')
    return normalizeFile(parsed)
  } catch (error: any) {
    throw new Error(`the rejected narration takes cannot be read (${error?.message || String(error)}); a rejected take stays out of use until this file is fixed`)
  }
}

/** Every file name that belongs to a rejected take in this episode. */
export async function rejectedTakeFileSet(episodeDir: string): Promise<Set<string>> {
  const store = await readTakeRejections(episodeDir)
  const files = new Set<string>()
  for (const take of Object.values(store.takes)) for (const file of take.files) files.add(file)
  return files
}

/** Is this exact take rejected? */
export async function isTakeRejected(episodeDir: string, section: string, files: string[]): Promise<RejectedTake | null> {
  const store = await readTakeRejections(episodeDir)
  return store.takes[takeRejectionKey(section, files)] ?? null
}

/** Rejections for one section, newest first (the versions list shows them). */
export function rejectionsForSection(store: TakeRejectionsFile, section: string): RejectedTake[] {
  const wanted = section.trim().toLowerCase()
  return Object.values(store.takes)
    .filter(take => take.section.toLowerCase() === wanted)
    .sort((a, b) => b.rejected_at.localeCompare(a.rejected_at))
}

export function restoreWindowEnds(rejectedAt: string): string {
  return new Date(Date.parse(rejectedAt) + TAKE_REJECTION_RESTORE_DAYS * DAY_MS).toISOString()
}

export function canRestore(rejected: RejectedTake, now = Date.now()): boolean {
  return now < Date.parse(rejected.rejected_at) + TAKE_REJECTION_RESTORE_DAYS * DAY_MS
}

/**
 * Drop every rejection record that names one of these files.
 *
 * Called when those names are written with NEW bytes (a regeneration activates
 * the chapter again) or moved out of the audio folder (an explicit "Use This
 * Version"). A rejection describes the take that was on disk; once the file
 * holding that name is gone or re-made, the record would be about bytes nobody
 * can hear any more — and keeping it would refuse a take the owner never
 * rejected (§6: the record must mean one thing).
 */
export async function forgetTakeRejections(episodeDir: string, files: string[]): Promise<string[]> {
  if (!files.length) return []
  const names = new Set(files.map(file => path.basename(file)))
  const store = await readTakeRejections(episodeDir)
  const dropped: string[] = []
  for (const [key, take] of Object.entries(store.takes)) {
    if (take.files.some(file => names.has(file))) dropped.push(key)
  }
  if (!dropped.length) return []
  await mutateRejections(episodeDir, current => {
    for (const key of dropped) delete current.takes[key]
  })
  return dropped
}

export interface RejectTakeInput {
  projectDir: string
  episodeDir: string
  audioDir: string
  code: string
  section: string
  files: string[]
  reason: string
  now?: number
}

export interface RejectTakeOutcome {
  rejected: RejectedTake
  /** True when this was already rejected and nothing changed. */
  already: boolean
  /** The rejected take was the one in use. */
  was_active: boolean
  /** The take the selection moved to, or null when it did not move. */
  moved_to: string[] | null
  /** The section has no usable take left: narration has to be made again. */
  needs_narration: boolean
  restore_until: string
  message: string
}

const sameFiles = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((file, index) => file === right[index])

/**
 * Reject one take. If it was the take in use, the selection moves to another
 * usable take when the sidecar that records the selection exists (so the choice
 * is a recorded one, never a rename of the owner's rejected bytes). Otherwise
 * the section honestly reads "needs narration".
 */
export async function rejectTake(input: RejectTakeInput): Promise<RejectTakeOutcome> {
  const section = input.section.trim()
  const files = [...input.files]
  const reason = input.reason.trim()
  if (!section) throw Object.assign(new Error('Which chapter does this take belong to?'), { statusCode: 400 })
  if (!isFileList(files)) throw Object.assign(new Error('Pick one version of this chapter.'), { statusCode: 400 })
  if (!reason) throw Object.assign(new Error('Say why this take is being rejected — it is kept with the take so nobody has to guess later.'), { statusCode: 400 })

  const takes = await listChapterTakes(input.episodeDir, input.audioDir, input.code.toUpperCase(), section)
  const chosen = takes.find(take => sameFiles(take.files, files))
  if (!chosen) {
    throw Object.assign(new Error('That version is no longer in the audio folder. Refresh and pick again.'), { statusCode: 404 })
  }

  const store = await readTakeRejections(input.episodeDir)
  const key = takeRejectionKey(section, files)
  const existing = store.takes[key]
  if (existing) {
    return {
      rejected: existing,
      already: true,
      was_active: chosen.active,
      moved_to: null,
      needs_narration: chosen.active,
      restore_until: restoreWindowEnds(existing.rejected_at),
      message: `${prettyTake(section, files)} is already rejected. It can be restored until ${restoreWindowEnds(existing.rejected_at)}.`,
    }
  }

  const rejected: RejectedTake = {
    section,
    files,
    version: chosen.version,
    rejected_at: new Date(input.now ?? Date.now()).toISOString(),
    reason,
  }
  await mutateRejections(input.episodeDir, current => {
    current.takes[key] = rejected
  })

  let movedTo: string[] | null = null
  if (chosen.active) {
    const replacement = takes.find(take => !take.active && !sameFiles(take.files, files))
    const replacementRejected = replacement
      ? store.takes[takeRejectionKey(section, replacement.files)]
      : undefined
    if (replacement && !replacementRejected) {
      const selector = await hasRecordedSelection(input.episodeDir, section)
      if (selector) {
        // The recorded selection moves; the rejected files stay exactly where
        // they are for the whole restore window (no trash, no rename).
        const result = await useChapterTake({
          projectDir: input.projectDir,
          episodeDir: input.episodeDir,
          audioDir: input.audioDir,
          code: input.code.toUpperCase(),
          slug: section,
          files: replacement.files,
          trashPrevious: false,
        })
        movedTo = result.active
      }
    }
  }

  const needsNarration = chosen.active && !movedTo
  const restoreUntil = restoreWindowEnds(rejected.rejected_at)
  const message = [
    `${prettyTake(section, files)} was rejected${reason ? ` (${reason})` : ''}.`,
    movedTo
      ? `The chapter now uses ${prettyTake(section, movedTo)}. Run Audio Assembly and re-make this chapter's subtitles.`
      : needsNarration
        ? `${prettyLabel(section)} now needs narration: Audio Assembly blocks until it is generated or another version is used.`
        : 'It stays in the folder, unused, and can be restored.',
    `Restore is possible until ${restoreUntil}; after that its files move to Story's Trash.`,
  ].join(' ')

  return { rejected, already: false, was_active: chosen.active, moved_to: movedTo, needs_narration: needsNarration, restore_until: restoreUntil, message }
}

async function hasRecordedSelection(episodeDir: string, section: string): Promise<boolean> {
  try {
    const selector = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8'))
    return Array.isArray(selector?.sections)
      && selector.sections.some((row: any) => typeof row?.slug === 'string' && row.slug.toLowerCase() === section.toLowerCase())
  } catch { return false }
}

function prettyLabel(section: string): string {
  return section.replaceAll('_', ' ')
}

function prettyTake(section: string, files: string[]): string {
  const version = files.map(file => /_v(\d+)\.mp3$/i.exec(file)?.[1]).find(Boolean)
  return `${prettyLabel(section)}, ${version ? `version ${version}` : 'the original take'}`
}

async function mutateRejections(
  episodeDir: string,
  update: (current: TakeRejectionsFile) => void | Promise<void>,
): Promise<void> {
  const target = sidecarPath(episodeDir)
  await withLock(target, async () => {
    const current = await readTakeRejections(episodeDir)
    await update(current)
    await writeJsonAtomic(target, normalizeFile(current))
  })
}

export interface RestoreTakeOutcome {
  restored: RejectedTake
  restored_take_selectable: boolean
  message: string
}

/** Undo a rejection inside its window. After the window the files are gone and this refuses. */
export async function restoreTake(input: {
  episodeDir: string
  section: string
  files: string[]
  now?: number
}): Promise<RestoreTakeOutcome> {
  const section = input.section.trim()
  const files = [...input.files]
  if (!section || !isFileList(files)) throw Object.assign(new Error('Pick the version to restore.'), { statusCode: 400 })
  const store = await readTakeRejections(input.episodeDir)
  const key = takeRejectionKey(section, files)
  const rejected = store.takes[key]
  if (!rejected) throw Object.assign(new Error('That version is not rejected; there is nothing to restore.'), { statusCode: 404 })
  const now = input.now ?? Date.now()
  if (!canRestore(rejected, now)) {
    throw Object.assign(new Error(`${prettyTake(section, files)} can no longer be restored: its restore window ended ${restoreWindowEnds(rejected.rejected_at)}.`), { statusCode: 409 })
  }
  await mutateRejections(input.episodeDir, current => { delete current.takes[key] })
  return {
    restored: rejected,
    restored_take_selectable: true,
    message: `${prettyTake(section, files)} is usable again. It can be picked with “Use This Version”.`,
  }
}

export interface SweepOutcome {
  /** Takes whose files were moved to Story's Trash in this sweep. */
  swept: SweptTake[]
  /** Records left because at least one file could not be moved. */
  deferred: Array<{ section: string; files: string[]; reason: string }>
}

/**
 * Move every take rejected longer than the restore window into Story's one
 * Trash, then drop its record. Injected `now` so the age rule is testable.
 * Idempotent: a record whose files are already gone is dropped without work.
 */
export async function sweepRejectedTakeFiles(input: {
  projectDir: string
  episodeDir: string
  audioDir: string
  now?: number
  log?: (line: string) => void
}): Promise<SweepOutcome> {
  const now = input.now ?? Date.now()
  const store = await readTakeRejections(input.episodeDir)
  const swept: SweptTake[] = []
  const deferred: SweepOutcome['deferred'] = []
  const settled: string[] = []
  for (const [key, take] of Object.entries(store.takes)) {
    if (canRestore(take, now)) continue
    const remaining: string[] = []
    for (const file of take.files) {
      const full = path.join(input.audioDir, file)
      try {
        const stat = await fs.stat(full)
        if (!stat.isFile()) continue
        moveToTrashSync(full, trashTargetFor(input.projectDir, full), 'audio')
        input.log?.(`Rejected narration take moved to Story's Trash: ${path.basename(full)}`)
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue
        remaining.push(file)
        input.log?.(`Rejected narration take could not be moved to Story's Trash (${path.basename(full)}: ${error?.message || error}); it will be tried again.`)
      }
    }
    if (remaining.length) {
      deferred.push({ section: take.section, files: remaining, reason: `could not move ${remaining.join(', ')}` })
      continue
    }
    settled.push(key)
    swept.push({
      section: take.section, files: [...take.files], rejected_at: take.rejected_at, reason: take.reason,
      trashed_at: new Date(now).toISOString(),
    })
    input.log?.(`Rejected narration take from ${prettyLabel(take.section)} (${take.reason}) is past its 3-day restore window; its files are in Story's Trash.`)
  }
  if (settled.length) {
    await mutateRejections(input.episodeDir, current => {
      for (const key of settled) delete current.takes[key]
      if (swept.length) {
        current.swept = [...(current.swept ?? []), ...swept].slice(-MAX_SWEPT_RECORDS)
      }
    })
  }
  return { swept, deferred }
}

/**
 * The daily housekeeping pass over one channel. Returns what it did so the
 * scheduler can report a real figure instead of a guess.
 */
export async function sweepChannelRejectedTakes(input: {
  projectDir: string
  now?: number
  log?: (line: string) => void
}): Promise<{ episodes: number; swept: SweptTake[]; deferred: number }> {
  const episodesRoot = await findEpisodesRoot(input.projectDir)
  if (!episodesRoot) return { episodes: 0, swept: [], deferred: 0 }
  const episodeDirs = await findEpisodeDirsWithRejections(episodesRoot)
  const swept: SweptTake[] = []
  let deferred = 0
  for (const episodeDir of episodeDirs) {
    try {
      const store = await readTakeRejections(episodeDir)
      const files = Object.values(store.takes).flatMap(take => take.files)
      if (!files.length) continue
      const audioDir = await audioDirForRejections(episodeDir, files)
      if (!audioDir) continue
      const result = await sweepRejectedTakeFiles({ projectDir: input.projectDir, episodeDir, audioDir, now: input.now, log: input.log })
      swept.push(...result.swept)
      deferred += result.deferred.length
    } catch (error: any) {
      input.log?.(`Rejected narration takes in ${path.basename(episodeDir)} could not be swept: ${error?.message || error}`)
      deferred += 1
    }
  }
  return { episodes: episodeDirs.length, swept, deferred }
}

async function findEpisodesRoot(projectDir: string): Promise<string | null> {
  const local = path.join(projectDir, 'episodes')
  try { return (await fs.stat(local)).isDirectory() ? local : null } catch { return null }
}

/** Episode folders that carry a rejection sidecar, at most three levels deep (season/episode). */
async function findEpisodeDirsWithRejections(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2) return
    let entries: Dirent[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    const hasSidecar = entries.some(entry => entry.isFile() && entry.name === AUDIO_TAKE_REJECTIONS_SIDECAR)
    if (hasSidecar) { found.push(dir); return }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(path.join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return found
}

/**
 * The episode's audio folder: the subfolder that actually holds this take's
 * files (the channel's own subfolder naming decides its name), else one named
 * like the audio assets folder.
 */
async function audioDirForRejections(episodeDir: string, files: string[]): Promise<string | null> {
  let entries: Dirent[]
  try { entries = await fs.readdir(episodeDir, { withFileTypes: true }) } catch { return null }
  const dirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => path.join(episodeDir, entry.name))
  for (const dir of dirs) {
    for (const file of files) {
      try { if ((await fs.stat(path.join(dir, file))).isFile()) return dir } catch { /* next */ }
    }
  }
  const named = dirs.find(dir => /Audio Assets$/i.test(path.basename(dir)))
  return named ?? null
}
