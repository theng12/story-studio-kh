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
 * working path is empty and the only copy of the scene sits in a Trash folder.
 *
 * That folder is not a safe place to leave it: Story's Trash hands items to the
 * MACOS Trash by itself — 7 days, or 20 GB oldest-first (`services/retention.ts` →
 * `handoffOldTrash`), on a timer that does NOT depend on `auto_cleanup_enabled`.
 * About 175 GB of shrink originals were waiting in it when this was written.
 *
 * This cannot recover the per-file reasons of a run that already finished — none
 * were written down before 1.4.334, and no check can invent them. It finds
 * STRANDED ORIGINALS: scene images whose working path holds neither the original
 * nor the JPEG that should have replaced it, wherever the original is now.
 *
 * A ZERO MUST NEVER MEAN TWO THINGS (AGENTS §6)
 * ---------------------------------------------
 * Three ways a check like this lies, and what is done about each:
 *
 *   A read that failed.             Every directory and every index read is
 *                                   recorded: ENOENT means "nothing there" and is
 *                                   fine, anything else (EACCES, EIO) is counted
 *                                   in `read_failures`, named in `scan_note`, and
 *                                   makes the scan incomplete.
 *   A record out of the page.       `listTrash` lists the newest 2,000 items, which
 *                                   is a page, not the index. The index is READ
 *                                   (`streamTrashIndex`), so a record past that page
 *                                   still maps its file — and can still be restored.
 *   An original that has left.      A scene image whose record says Story's Trash
 *                                   handed it to the macOS Trash (or deleted it for
 *                                   good) is reported, never dropped: it cannot be
 *                                   verified here, so it is never part of a clean
 *                                   answer. Where the handoff recorded a size, that
 *                                   record is checked against the macOS Trash by
 *                                   exact name and size; the location is only ever
 *                                   named on a single match.
 *
 * Records written before the handoff kept anything beyond "it left" say nothing
 * about where the file went, and no new record can cover those past moves: they
 * are reported as moved, location unknown.
 *
 * EVERY ENTRY IS CLASSIFIED
 * -------------------------
 *   orphan      — one empty working path, and Story's Trash can put it back.
 *   resolved    — the working path holds the original or its JPEG, or the
 *                 episode's record says the file was deliberately removed.
 *   ambiguous   — the record and the scene-folder layout name different working
 *                 paths, or several macOS Trash files match one handoff.
 *   unknown     — no single working path can be derived, or the original has left
 *                 Story's Trash and cannot be verified from here.
 *   unreadable  — the file cannot be stat-ed, or a delete stopped partway through
 *                 it, so it is not a whole file.
 *
 * Nothing here moves a file. `POST /library/media-cleanup/orphans/restore` is a
 * separate, explicit owner action, and it puts back only an item this check listed
 * as an orphan, through `restoreTrashItem`, whose own guards (still in the Trash,
 * nothing at the working path, not a partial delete) are unchanged. A file the
 * macOS Trash holds is NOT offered back: Story Studio does not reach into the
 * Mac's Trash, and a move back across drives could only be a copy-then-delete,
 * which this codebase never does with the owner's media. The location is given so
 * the owner can drag it back in Finder.
 */
import { lstatSync, readdirSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

import { trashDirOf } from '../lib/trash-move.js'
import { readEpisodeCleanupRecord, type EpisodeCleanupRecordEntry } from './episode-media-cleanup.js'
import * as pm from './project-manager.js'
import { macTrashMatches, restoreTrashItem, streamTrashIndex, trashRoots } from './trash.js'
import { resolveEpisodePathsByCode } from './utils.js'

/**
 * Bounded output, the same bound as a preview sample and for the same reason: a
 * Trash holding thousands of scene images must not send one entry per file. Each
 * class carries `count` and `more` beside its sample, so the bound never hides a
 * number.
 */
const STRANDED_SAMPLE_ITEMS = 50

/** What a scanned Trash entry turned out to be. See the module comment. */
export type StrandedClass = 'orphan' | 'resolved' | 'ambiguous' | 'unknown' | 'unreadable'

export interface StrandedSceneImage {
  project_slug: string
  episode_code: string
  /** Where the file belongs: the scene-image path it was moved out of. */
  working_path: string
  /** Where it is now — Story's Trash, or where Story's Trash last had it. */
  trash_path: string
  bytes: number
  /** The Trash file's modification time, in ms (0 when it is not there to measure). */
  mtime_ms: number
  /** The id `POST /library/media-cleanup/orphans/restore` takes. Orphans only. */
  trash_item_id?: string
  /** The Mac's own Trash copy, when exactly one file there matches its name and size. */
  macos_trash_path?: string
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
  /** Every Trash entry this check classified. */
  scanned: number
  /** Directory and index reads that failed (every one of them is in `scan_note`). */
  read_failures: number
  orphan: StrandedClassReport
  resolved: StrandedClassReport
  ambiguous: StrandedClassReport
  unknown: StrandedClassReport
  unreadable: StrandedClassReport
}

/** What the Trash's own index says about one file. */
interface TrashRecord {
  id: string
  /** The working path the file was moved out of. */
  from: string
  partial: boolean
  removed_size?: number
  removed_mtime_ms?: number
  macos_trash_path?: string
}

/** One scene-image file this check has something to classify. */
interface Found {
  slug: string
  code: string
  relative: string
  /** The scene-image path in Story's Trash — or where it last was, for a file that left. */
  trashPath: string
  record?: TrashRecord
  /** Set when the record says the original has LEFT Story's Trash. */
  gone?: 'macos-trash' | 'deleted'
}

interface Classified {
  class: StrandedClass
  item: StrandedSceneImage
}

/** Reads this check could not make: each one is named, and each one makes the answer incomplete. */
interface ReadLog {
  notes: string[]
  failures: number
  /** Channels whose Trash could not be read: their files were never looked at. */
  failedSlugs: Set<string>
}

function fail(log: ReadLog, note: string): void {
  log.notes.push(note)
  log.failures += 1
}

const describe = (error: any): string => error?.code || error?.message || String(error)

function exists(p: string): boolean { try { lstatSync(p); return true } catch { return false } }

/**
 * Read a directory. An absent one is nothing to scan (ENOENT); anything else is a
 * read this check could not make, and it says so rather than reporting an empty
 * folder.
 */
function readDirectory(dir: string, what: string, log: ReadLog, slug?: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }) } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      fail(log, `${what} could not be read (${describe(error)}); nothing under it was checked.`)
      if (slug) log.failedSlugs.add(slug)
    }
    return []
  }
}

/** Directories directly under `dir`, skipping names we never write and symlinks. */
function subdirectories(dir: string, what: string, log: ReadLog, slug?: string): string[] {
  return readDirectory(dir, what, log, slug)
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map(entry => path.join(dir, entry.name))
}

/** Every file under `dir`, at any depth. Symlinks are never cleanup candidates. */
function filesUnder(dir: string, what: string, log: ReadLog, slug?: string): string[] {
  const files: string[] = []
  for (const entry of readDirectory(dir, what, log, slug)) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(full, what, log, slug))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

/** `<trash>/<slug>/<code>/images/scene_images/<relative path>`, the layout the mover writes. */
function sceneImageLayout(trashPath: string): { slug: string; code: string; relative: string } | null {
  const trashDir = trashDirOf(trashPath)
  if (!trashDir) return null
  const parts = path.relative(trashDir, trashPath).split(path.sep)
  if (parts.length < 5 || parts[2] !== 'images' || parts[3] !== 'scene_images') return null
  const [slug, code] = parts
  const relative = parts.slice(4).join(path.sep)
  return slug && code && relative ? { slug, code, relative } : null
}

/**
 * Every scene-image entry of every channel, found by the layout the mover writes,
 * with the Trash's own record of each one.
 *
 * The walk finds what is still there — `<root>/<slug>/<code>/images/scene_images/**`
 * is the shape `trashReviewedFile` produces, for the Library's Trash and for a
 * channel whose media lives on its own drive. The index then says where each one
 * came from, and adds the ones that are no longer there but whose working path is
 * still empty: originals Story's Trash has handed to the macOS Trash, or deleted.
 */
async function scanSceneImageTrash(): Promise<{ found: Found[]; projects_scanned: number; projects_total: number; log: ReadLog }> {
  const log: ReadLog = { notes: [], failures: 0, failedSlugs: new Set() }
  let projects: Array<{ slug: string }> = []
  try {
    projects = (await pm.listProjects()) as Array<{ slug: string }>
  } catch (error: any) {
    fail(log, `The channels could not be listed (${describe(error)}), so nothing could be checked.`)
  }

  const found: Found[] = []
  // A root with a slug is an old per-channel Trash; the mover never wrote scene
  // images into one, so only the shared shapes are walked.
  for (const root of (await trashRoots()).filter(root => !root.slug)) {
    for (const slugDir of subdirectories(root.dir, 'A Trash folder', log)) {
      const slug = path.basename(slugDir)
      for (const codeDir of subdirectories(slugDir, `${slug}'s Trash folder`, log, slug)) {
        const sceneDir = path.join(codeDir, 'images', 'scene_images')
        for (const file of filesUnder(sceneDir, `${slug}'s scene-image Trash`, log, slug)) {
          found.push({ slug, code: path.basename(codeDir), relative: path.relative(sceneDir, file), trashPath: file })
        }
      }
    }
  }

  // The records for the files just found, plus the ones that have left. The index is
  // streamed: a Trash with hundreds of thousands of records is never held in memory,
  // and no record is out of reach of a page.
  const here = new Map(found.map(file => [path.resolve(file.trashPath), file]))
  const left = new Map<string, Found>()
  const streamed = await streamTrashIndex(line => {
    const to = path.resolve(line.to)
    const record: TrashRecord = {
      id: line.id, from: line.from, partial: line.partial,
      ...(line.removed_size !== undefined ? { removed_size: line.removed_size } : {}),
      ...(line.removed_mtime_ms !== undefined ? { removed_mtime_ms: line.removed_mtime_ms } : {}),
      ...(line.macos_trash_path ? { macos_trash_path: line.macos_trash_path } : {}),
    }
    const mine = here.get(to)
    if (mine) {
      mine.record = record
      // The file is physically here; a record that says it left is an inconsistency
      // worth naming rather than trusting either half.
      if (line.removed) mine.gone = line.removed
      return
    }
    // A later line for a path that is not here says it came back.
    if (left.delete(to) && !line.removed) return
    if (!line.removed || line.kind !== 'images') return
    const layout = sceneImageLayout(line.to)
    if (!layout) return
    // Only an original that is missing from its working path is worth reporting: a
    // scene that was replaced normally is fine wherever its original ended up.
    if (exists(line.from)) return
    left.set(to, { slug: layout.slug, code: layout.code, relative: layout.relative, trashPath: line.to, record, gone: line.removed })
  })
  for (const note of streamed.notes) fail(log, note)
  for (const file of left.values()) found.push(file)

  return {
    found,
    projects_total: projects.length,
    projects_scanned: projects.filter(project => !log.failedSlugs.has(project.slug)).length,
    log,
  }
}

/**
 * What to say about an original that has left Story's Trash: nothing here can check
 * it or put it back, so the most this can do is say where it went — and only by an
 * exact name-and-size match in the Mac's Trash, which is why a record that never
 * kept the size can only ever say "location unknown".
 */
function sayWhereItWent(found: Found): { class: StrandedClass; note: string; macos_trash_path?: string } {
  if (found.gone === 'deleted') {
    return { class: 'unknown', note: 'Deleted for good from Story\'s Trash by the owner; there is nothing left to put back.' }
  }
  const recorded = found.record?.macos_trash_path
  const at = recorded ? ` (last recorded at ${recorded})` : ''
  if (found.record?.removed_size === undefined) {
    return {
      class: 'unknown',
      note: `Moved to the macOS Trash by Story's Trash retention${at}, before Story recorded where each handoff went, so its location is unknown and this check cannot verify or restore it.`,
    }
  }
  const matches = macTrashMatches(path.basename(found.trashPath), found.record.removed_size)
  if (!matches.readable) {
    return { class: 'unknown', note: 'Moved to the macOS Trash by Story\'s Trash retention, and the macOS Trash could not be read, so its location is unknown.' }
  }
  if (matches.paths.length > 1) {
    return {
      class: 'ambiguous',
      note: `Moved to the macOS Trash by Story's Trash retention, and ${matches.paths.length} files there match its name and size, so which one it is cannot be told.`,
    }
  }
  if (matches.paths.length === 1) {
    return {
      class: 'unknown',
      macos_trash_path: matches.paths[0],
      note: `Moved to the macOS Trash by Story's Trash retention: the original is at ${matches.paths[0]}. Story Studio does not move files out of the macOS Trash; drag it back in Finder.`,
    }
  }
  return { class: 'unknown', note: `Moved to the macOS Trash by Story's Trash retention${at}, and it is not there now, so its location is unknown.` }
}

/** One entry, classified. The mapping sources are read in the order that fails safest. */
async function classify(found: Found): Promise<Classified> {
  const item: StrandedSceneImage = {
    project_slug: found.slug,
    episode_code: found.code,
    working_path: found.record?.from ?? '',
    trash_path: found.trashPath,
    bytes: 0,
    mtime_ms: 0,
  }
  const done = (kind: StrandedClass, note?: string): Classified => ({
    class: kind,
    item: {
      ...item,
      ...(note ? { note } : {}),
      // Only an orphan that is still in Story's Trash offers the id: the restore
      // route accepts nothing else.
      ...(kind === 'orphan' && found.record && !found.gone ? { trash_item_id: found.record.id } : {}),
    },
  })

  if (found.gone) {
    if (found.record?.removed_size !== undefined) item.bytes = found.record.removed_size
    item.mtime_ms = found.record?.removed_mtime_ms ?? 0
  } else {
    try {
      const stat = statSync(found.trashPath)
      item.bytes = stat.size
      item.mtime_ms = stat.mtimeMs
    } catch (error: any) {
      return done('unreadable', `Its Trash file could not be read (${describe(error)}).`)
    }
  }
  let sceneDir: string
  try {
    sceneDir = (await resolveEpisodePathsByCode(found.slug, found.code)).bg_dir
  } catch (error: any) {
    return done('unknown', `The episode ${found.code} could not be read (${describe(error)}), so its scene folder is unknown.`)
  }
  const derived = path.join(sceneDir, found.relative)
  item.working_path = found.record?.from ?? derived
  if (found.record?.from && found.record.from !== derived) {
    return done('ambiguous', `The Trash record says it came from ${found.record.from}, but this episode's scene folder says ${derived}.`)
  }
  if (!found.gone && found.record?.partial && !exists(derived)) {
    // A delete that stopped partway through leaves an incomplete file: it is not
    // offered back, and it is not a whole file either.
    return done('unreadable', 'It was left incomplete by a delete that stopped partway through.')
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
  if (record.some(entry => entry.destination_path === found.trashPath && (entry.outcome === 'removed' || entry.mode === 'remove'))) {
    return done('resolved', 'The episode\'s record says this file was deliberately removed, not stranded.')
  }
  if (found.gone) {
    const said = sayWhereItWent(found)
    if (said.macos_trash_path) item.macos_trash_path = said.macos_trash_path
    return done(said.class, said.note)
  }
  if (found.record?.partial) return done('unknown', 'A delete stopped partway through it; Restore is not offered.')
  if (!found.record) {
    return done('unknown', `Its scene folder says it belongs at ${derived}, but no Trash record of the move survives, so Restore cannot put it back.`)
  }
  return done('orphan')
}

const uncertainty: Record<'ambiguous' | 'unknown' | 'unreadable', string> = {
  ambiguous: 'Some Trash files could not be mapped to exactly one working path, so whether an original is stranded there is unknown.',
  unknown: 'Some Trash files could not be placed at all, so whether an original is stranded there is unknown.',
  unreadable: 'Some Trash files could not be read, so whether an original is stranded there is unknown.',
}

/**
 * The stranded-scene-image check: read-only, bounded, and honest about what it could
 * not see. Nothing here moves or deletes a file.
 */
export async function scanStrandedSceneImages(): Promise<StrandedSceneImagesReport> {
  const { found, projects_scanned, projects_total, log } = await scanSceneImageTrash()
  const classified: Classified[] = []
  for (const file of found) classified.push(await classify(file))
  const of = (kind: StrandedClass): StrandedClassReport => {
    const items = classified.filter(entry => entry.class === kind).map(entry => entry.item)
    return { count: items.length, items: items.slice(0, STRANDED_SAMPLE_ITEMS), more: Math.max(0, items.length - STRANDED_SAMPLE_ITEMS) }
  }
  // An original that left Story's Trash is never part of a clean answer, even when
  // its location could be named: nothing here can verify it.
  const leftPaths = new Set(found.filter(file => file.gone).map(file => file.trashPath))
  const leftUnresolved = classified.filter(entry => leftPaths.has(entry.item.trash_path) && entry.class !== 'resolved').length
  const uncertain = (['ambiguous', 'unknown', 'unreadable'] as const)
    .filter(kind => classified.some(entry => entry.class === kind))
    .map(kind => uncertainty[kind])
  const notes = [
    ...log.notes,
    ...(leftUnresolved ? [`${leftUnresolved} scene image(s) have left Story's Trash (handed to the macOS Trash, or deleted for good) and cannot be verified or put back from here.`] : []),
    ...uncertain,
  ]
  return {
    // A zero-orphan answer must never come from a scan that could not see
    // everything (AGENTS §6).
    scan_complete: notes.length === 0 && projects_scanned === projects_total,
    ...(notes.length ? { scan_note: notes.join(' ') } : {}),
    projects_scanned,
    projects_total,
    scanned: classified.length,
    read_failures: log.failures,
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
  if (typeof id !== 'string' || !id) throw failWith('Choose one of the scene images this check listed.')
  const { found } = await scanSceneImageTrash()
  const match = found.find(file => file.record?.id === id)
  if (!match) throw failWith('That item is not one this check offers to put back. Run the check again and choose an item from it.', 409)
  const classified = await classify(match)
  if (classified.class !== 'orphan') {
    throw failWith(`This scene image is not stranded: ${classified.item.note || 'it is not one this check offers to put back.'}`, 409)
  }
  const { restored_to } = await restoreTrashItem(id)
  return { restored_to, project_slug: classified.item.project_slug, episode_code: classified.item.episode_code }
}

function failWith(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}
