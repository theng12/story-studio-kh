/**
 * Stranded scene images: the recovery check for a shrink that moved an original
 * into Story's Trash and never put its JPEG in its place.
 *
 * WHY THIS EXISTS (production, 2026-10-20)
 * ----------------------------------------
 * A running all-channel `shrink_images` run reported `failed_count: 2` and nobody
 * could say which files those were. The run's own reasons are gone with the
 * process; the files themselves are the part that still matters. The swap moves
 * the original to `_trash` FIRST, so when the swap and its rollback both fail, the
 * working path is empty and the only copy of the scene sits in a Trash folder the
 * owner empties after seven days.
 *
 * This cannot recover the per-file reasons of a run that already finished — those
 * were never written down before 1.4.334, and no check can invent them. It finds
 * STRANDED ORIGINALS: scene images sitting in a channel's Trash whose working path
 * holds neither the original nor the JPEG that should have replaced it.
 *
 * WHAT IS SCANNED, AND HOW A TRASH FILE IS MAPPED BACK
 * ---------------------------------------------------
 * The scene-image folders of every Trash root Story uses — `<root>/<slug>/<code>/
 * images/scene_images/**`, the layout `discoverRoot` + `trashReviewedFile` write —
 * so a file is found by its own path even when no record of the move survived.
 *
 * Three sources say where it belongs, and the mapping is trusted only when they
 * agree:
 *   1. the Trash's own record (`.trash-index.jsonl`, paired to items by
 *      `services/trash.ts`) — `from`, and the id `POST /trash/restore` takes;
 *   2. the scene-image layout: `<root>/<slug>/<code>/images/scene_images/<rel>`
 *      belongs at `<episode scene folder>/<rel>`;
 *   3. the episode's own cleanup record (`readEpisodeCleanupRecord`): mode
 *      `compress` means the file was moved aside to be REPLACED, mode `remove`
 *      means it was deliberately REMOVED.
 *
 * Where those disagree the item is AMBIGUOUS and no restore is offered: putting a
 * file back at a guessed path is worse than leaving it in the Trash, where the
 * owner can still see it.
 *
 * EVERY SCANNED ENTRY IS CLASSIFIED, AND A ZERO NEVER MEANS TWO THINGS (AGENTS §6)
 * -----------------------------------------------------------------------------
 *   orphan      — one empty working path, and the Trash can put it back.
 *   resolved    — the working path holds the original or its JPEG, or the
 *                 episode's record says the file was deliberately removed.
 *   ambiguous   — the record and the layout name different working paths.
 *   unknown     — no single working path can be derived (no Trash record, an
 *                 unreadable episode folder, a layout this mover never writes).
 *   unreadable  — the file cannot be stat-ed, or a delete stopped partway through
 *                 it, so it is not a whole file.
 *
 * `scan_complete` is false whenever anything was ambiguous, unknown or unreadable,
 * or a channel's Trash could not be read — so a zero-orphan answer from a complete
 * scan can never look like a zero from a scan that could not see everything.
 *
 * Nothing here moves a file. `POST /library/media-cleanup/orphans/restore` is a
 * separate, explicit owner action, and it puts back only an item this check listed
 * as an orphan, through `restoreTrashItem`, whose own guards (still in the Trash,
 * nothing at the working path, not a partial delete) are unchanged.
 */
import { lstatSync, readdirSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

import { libraryTrashDir } from '../lib/trash-move.js'
import { readEpisodeCleanupRecord, type EpisodeCleanupRecordEntry } from './episode-media-cleanup.js'
import * as pm from './project-manager.js'
import { listTrash, restoreTrashItem, trashRoots, type TrashItem } from './trash.js'
import { resolveEpisodePathsByCode } from './utils.js'

/**
 * Bounded output, the same bound as a preview sample and for the same reason: a
 * Trash holding thousands of scene images must not send one entry per file. Each
 * class carries `count` and `more` beside its sample, so the bound never hides a
 * number.
 */
const STRANDED_SAMPLE_ITEMS = 50

/** What a scanned Trash file turned out to be. See the module comment. */
export type StrandedClass = 'orphan' | 'resolved' | 'ambiguous' | 'unknown' | 'unreadable'

export interface StrandedSceneImage {
  project_slug: string
  episode_code: string
  /** Where the file belongs: the scene-image path it was moved out of. */
  working_path: string
  /** Where it is now. */
  trash_path: string
  bytes: number
  /** The Trash file's modification time, in ms. */
  mtime_ms: number
  /** The id `POST /library/media-cleanup/orphans/restore` takes. Orphans only. */
  trash_item_id?: string
  /** Why it is not an orphan, in words, for every other class. */
  note?: string
}

export interface StrandedClassReport {
  count: number
  /** The first `STRANDED_SAMPLE_ITEMS` of this class. */
  items: StrandedSceneImage[]
  /** Entries of this class beyond the sample: `count - items.length`. */
  more: number
}

export interface StrandedSceneImagesReport {
  /** False when anything could not be read or mapped: a zero here is not "clean". */
  scan_complete: boolean
  /** Why the scan is not complete, in words, when it is not. */
  scan_note?: string
  projects_scanned: number
  projects_total: number
  /** Every Trash file this check classified. */
  scanned: number
  orphan: StrandedClassReport
  resolved: StrandedClassReport
  ambiguous: StrandedClassReport
  unknown: StrandedClassReport
  unreadable: StrandedClassReport
}

interface Classified {
  class: StrandedClass
  item: StrandedSceneImage
}

/** One scene-image file found by the walk, before anything is decided about it. */
interface Found {
  slug: string
  code: string
  relative: string
  trashPath: string
  /** The Trash's own record of the move, when it has one. */
  indexed?: TrashItem
}

function fail(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

function exists(p: string): boolean { try { lstatSync(p); return true } catch { return false } }

/** Directories directly under `dir`, skipping names we never write and symlinks. */
function subdirectories(dir: string): string[] {
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map(entry => path.join(dir, entry.name))
}

/** Every file under `dir`, at any depth. Symlinks are never cleanup candidates. */
function filesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of subdirectories(dir)) files.push(...filesUnder(entry))
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return files }
  for (const entry of entries) {
    if (entry.isFile() && !entry.isSymbolicLink()) files.push(path.join(dir, entry.name))
  }
  return files
}

/**
 * Every scene-image Trash file of every channel, found by the layout the mover
 * writes. `<root>/<slug>/<code>/images/scene_images/<relative path under the
 * episode's scene folder>` is the one shape `trashReviewedFile` produces, for the
 * Library's Trash and for a channel whose media lives on its own drive.
 */
async function findSceneImageTrash(): Promise<{
  found: Found[]
  projects_scanned: number
  projects_total: number
  notes: string[]
}> {
  const notes: string[] = []
  let projects: Array<{ slug: string }> = []
  try {
    projects = (await pm.listProjects()) as Array<{ slug: string }>
  } catch (error: any) {
    notes.push(`The channels could not be listed (${error?.message || error}), so nothing could be checked.`)
  }
  const listing = await listTrash()
  if (listing.items_total > listing.items.length) {
    notes.push(`Story's Trash holds ${listing.items_total} items and this check read the newest ${listing.items.length}, so older ones were not matched to their Trash records.`)
  }
  // The Trash's own records, by the file they moved. `listTrash` has already
  // dropped what left the Trash (the Mac's Trash, a permanent delete), so an id
  // from here is one Restore would still accept.
  const indexedByPath = new Map<string, TrashItem>()
  for (const item of listing.items) if (item.path) indexedByPath.set(path.resolve(item.path), item)

  // A channel whose Trash folder cannot be read could be hiding a stranded
  // original: that is an incomplete scan, not a clean one.
  let scannedProjects = 0
  const library = libraryTrashDir(pm.projectsRoot())
  for (const project of projects) {
    const dir = path.join(library, project.slug)
    if (!exists(dir)) { scannedProjects += 1; continue }
    try { readdirSync(dir); scannedProjects += 1 } catch (error: any) {
      notes.push(`The Trash folder of ${project.slug} could not be read (${error?.message || error}).`)
    }
  }

  const found: Found[] = []
  // A root with a slug is an old per-channel Trash; the mover never wrote scene
  // images into one, so only the shared shapes are walked.
  const roots = (await trashRoots()).filter(root => !root.slug)
  for (const root of roots) {
    for (const slugDir of subdirectories(root.dir)) {
      for (const codeDir of subdirectories(slugDir)) {
        const sceneDir = path.join(codeDir, 'images', 'scene_images')
        for (const file of filesUnder(sceneDir)) {
          const indexed = indexedByPath.get(path.resolve(file))
          found.push({
            slug: path.basename(slugDir),
            code: path.basename(codeDir),
            relative: path.relative(sceneDir, file),
            trashPath: file,
            ...(indexed ? { indexed } : {}),
          })
        }
      }
    }
  }
  return { found, projects_scanned: scannedProjects, projects_total: projects.length, notes }
}

/**
 * One found file, classified. The mapping sources are read in the order that
 * fails safest: the Trash's record, the layout, then the episode's own record.
 */
async function classify(found: Found): Promise<Classified> {
  const item: StrandedSceneImage = {
    project_slug: found.slug,
    episode_code: found.code,
    working_path: found.indexed?.from ?? '',
    trash_path: found.trashPath,
    bytes: 0,
    mtime_ms: 0,
  }
  const done = (kind: StrandedClass, note?: string): Classified => ({
    class: kind,
    item: {
      ...item,
      ...(note ? { note } : {}),
      // Only an orphan offers the id: the restore route accepts nothing else.
      ...(kind === 'orphan' && found.indexed?.restorable ? { trash_item_id: found.indexed.id } : {}),
    },
  })

  try {
    const stat = statSync(found.trashPath)
    item.bytes = stat.size
    item.mtime_ms = stat.mtimeMs
  } catch (error: any) {
    return done('unreadable', `Its Trash file could not be read (${error?.message || error}).`)
  }
  let sceneDir: string
  try {
    sceneDir = (await resolveEpisodePathsByCode(found.slug, found.code)).bg_dir
  } catch (error: any) {
    return done('unknown', `The episode ${found.code} could not be read (${error?.message || error}), so its scene folder is unknown.`)
  }
  const derived = path.join(sceneDir, found.relative)
  item.working_path = found.indexed?.from ?? derived
  if (found.indexed?.from && found.indexed.from !== derived) {
    return done('ambiguous', `The Trash record says it came from ${found.indexed.from}, but this episode's scene folder says ${derived}.`)
  }
  if (found.indexed && !found.indexed.restorable && !exists(derived)) {
    // A delete that stopped partway through leaves an incomplete file: it is not
    // offered back, and it is not a whole file either.
    return done('unreadable', found.indexed.restore_note || 'It was left incomplete by a delete that stopped partway through.')
  }
  let record: EpisodeCleanupRecordEntry[] = []
  try { record = await readEpisodeCleanupRecord(found.slug, found.code) } catch { /* no record, no reason */ }
  const conflict = record.find(entry => entry.destination_path === found.trashPath && entry.source_path !== derived)
  if (conflict) {
    return done('ambiguous', `The episode's own record says it came from ${conflict.source_path}, not ${derived}.`)
  }
  if (exists(derived)) {
    return done('resolved', 'The working path already holds a file — the original, or the JPEG that replaced it — so nothing is stranded here.')
  }
  const mine = record.filter(entry => entry.destination_path === found.trashPath || entry.source_path === derived)
  if (mine.some(entry => entry.outcome === 'removed' || entry.mode === 'remove')) {
    return done('resolved', 'The episode\'s record says this file was deliberately removed, not stranded.')
  }
  if (!found.indexed) {
    return done('unknown', `Its scene folder says it belongs at ${derived}, but no Trash record of the move survives, so Restore cannot put it back.`)
  }
  if (!found.indexed.restorable) {
    return done('unknown', found.indexed.restore_note || 'Restore is not offered for this Trash item.')
  }
  return done('orphan')
}

const uncertainty: Record<'ambiguous' | 'unknown' | 'unreadable', string> = {
  ambiguous: 'Some Trash files could not be mapped to exactly one working path, so whether an original is stranded there is unknown.',
  unknown: 'Some Trash files could not be placed at all, so whether an original is stranded there is unknown.',
  unreadable: 'Some Trash files could not be read, so whether an original is stranded there is unknown.',
}

/**
 * The stranded-scene-image check: read-only, bounded, and honest about what it
 * could not see. Nothing here moves or deletes a file.
 */
export async function scanStrandedSceneImages(): Promise<StrandedSceneImagesReport> {
  const { found, projects_scanned, projects_total, notes } = await findSceneImageTrash()
  const classified: Classified[] = []
  for (const file of found) classified.push(await classify(file))
  const of = (kind: StrandedClass): StrandedClassReport => {
    const items = classified.filter(entry => entry.class === kind).map(entry => entry.item)
    return { count: items.length, items: items.slice(0, STRANDED_SAMPLE_ITEMS), more: Math.max(0, items.length - STRANDED_SAMPLE_ITEMS) }
  }
  const uncertain = (['ambiguous', 'unknown', 'unreadable'] as const)
    .filter(kind => classified.some(entry => entry.class === kind))
    .map(kind => uncertainty[kind])
  const allNotes = [...notes, ...uncertain]
  return {
    // A zero-orphan answer must never come from a scan that could not see
    // everything (AGENTS §6).
    scan_complete: allNotes.length === 0 && projects_scanned === projects_total,
    ...(allNotes.length ? { scan_note: allNotes.join(' ') } : {}),
    projects_scanned,
    projects_total,
    scanned: classified.length,
    orphan: of('orphan'), resolved: of('resolved'), ambiguous: of('ambiguous'),
    unknown: of('unknown'), unreadable: of('unreadable'),
  }
}

/**
 * Put one listed orphan back at its working path.
 *
 * Only an item THIS check lists as an orphan is accepted, and the move itself is
 * `restoreTrashItem` — the Trash's own Restore, which refuses when the item is
 * gone, when a delete stopped partway through it, or when something already sits
 * at the working path. So a stale page can never overwrite a file that arrived
 * since it was drawn.
 */
export async function restoreStrandedSceneImage(id: unknown): Promise<{ restored_to: string; project_slug: string; episode_code: string }> {
  if (typeof id !== 'string' || !id) throw fail('Choose one of the scene images this check listed.')
  const { found } = await findSceneImageTrash()
  const match = found.find(file => file.indexed?.id === id)
  if (!match) throw fail('That item is not one this check offers to put back. Run the check again and choose an item from it.', 409)
  const classified = await classify(match)
  if (classified.class !== 'orphan') {
    throw fail(`This scene image is not stranded: ${classified.item.note || 'it is not one this check offers to put back.'}`, 409)
  }
  const { restored_to } = await restoreTrashItem(id)
  return { restored_to, project_slug: classified.item.project_slug, episode_code: classified.item.episode_code }
}
