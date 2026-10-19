import { randomUUID } from 'node:crypto'
import { appendFileSync, constants, copyFileSync, lstatSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Story Studio's ONE trash (1.4.289, owner 2026-10-11: "not 17 channel trashes").
 *
 * Nothing the app removes is hard-deleted: it moves to `<Library>/_trash/<slug>/…`
 * (`<Library>` = the folder holding every channel), and the owner empties it on
 * Story → Trash. A move is a rename, so it never crosses drives: media on a drive
 * of its own goes to that drive's `<drive folder>/_trash/<slug>/…`, which the
 * Trash page lists beside the Library one. Every move is recorded in the trash
 * folder's `.trash-index.jsonl` (where it came from, what kind it is, when), which
 * is what Restore reads.
 */
export const TRASH_DIRNAME = '_trash'
export const TRASH_INDEX = '.trash-index.jsonl'
/** Trash folders for what belongs to no channel: the app itself, and the Character Library. */
export const APP_TRASH = '_story-studio'
export const CHARACTER_TRASH = '_character-library'

/**
 * How long Story's Trash waits before the Mac's Trash takes it, and the size that
 * overrides the wait (owner, 2026-10-19: "7 days OR 20 GB"). One pair of numbers for
 * every housekeeping sweep that ends in the Trash — the handoff (`services/retention.ts`)
 * and the log folder (`services/logger.ts`) read the same setting.
 */
export const TRASH_HANDOFF_DAYS_KEY = 'trash_handoff_days'
export const TRASH_HANDOFF_GB_KEY = 'trash_handoff_gb'
export const DEFAULT_TRASH_HANDOFF_DAYS = 7
export const DEFAULT_TRASH_HANDOFF_GB = 20

/** One line of `.trash-index.jsonl`. */
export interface TrashIndexEntry { id: string; from: string; to: string; kind: string; at: string }

/** `<Library>/_trash` for a Library folder (the parent of every channel folder). */
export function libraryTrashDir(library: string): string {
  return path.join(library, TRASH_DIRNAME)
}

/**
 * Where a channel's removed files go: `<Library>/_trash/<slug>` when `anchor` (the
 * folder the file lives under: the channel, its media drive, the exports folder) is
 * on the Library's drive, else `<anchor>/_trash/<slug>` on its own drive.
 */
export function trashRootFor(anchor: string, projectDir: string, slug: string): string {
  const library = path.dirname(path.resolve(projectDir))
  return sameDrive(anchor, library)
    ? path.join(libraryTrashDir(library), slug)
    : path.join(anchor, TRASH_DIRNAME, slug)
}

function sameDrive(a: string, b: string): boolean {
  const inside = (p: string, base: string) => p === base || p.startsWith(base + path.sep)
  try { return statSync(a).dev === statSync(b).dev } catch {
    return inside(path.resolve(a), path.resolve(b)) // not there yet: judge by path
  }
}

/**
 * Rename `file` to `target`, creating parents (mkdir -p on every call, so a
 * missing `_trash` never blocks a run). An existing item at `target` is never
 * replaced: the name gets a timestamp suffix instead. A failed rename throws
 * and leaves the file where it was: there is deliberately no copy-then-delete
 * fallback (a cross-device failure must skip the file, not destroy it).
 * `kind` labels it on the Trash page ("final-video", "images", …).
 */
export function moveToTrashSync(file: string, target: string, kind = 'other'): string {
  mkdirSync(path.dirname(target), { recursive: true })
  const { dir, name, ext } = path.parse(target)
  let candidate = target
  for (let n = 0; exists(candidate); n += 1) {
    candidate = path.join(dir, `${name}.${Date.now()}${n ? `-${n}` : ''}${ext}`)
  }
  renameSync(file, candidate)
  recordTrashMove(path.resolve(file), path.resolve(candidate), kind)
  return candidate
}

/**
 * Preserve active bytes in Story's Trash without moving the active file.
 * Used only when a later atomic promotion must keep the complete prior package
 * recoverable while every current member remains in place until preservation
 * has succeeded.
 */
export function copyToTrashSync(file: string, target: string, kind = 'other'): string {
  mkdirSync(path.dirname(target), { recursive: true })
  const { dir, name, ext } = path.parse(target)
  let candidate = target
  for (let n = 0; exists(candidate); n += 1) {
    candidate = path.join(dir, `${name}.${Date.now()}${n ? `-${n}` : ''}${ext}`)
  }
  copyFileSync(file, candidate, constants.COPYFILE_EXCL)
  recordTrashMove(path.resolve(file), path.resolve(candidate), kind, true)
  return candidate
}

/** The `_trash` folder `target` sits in (the last `_trash` segment), or null. */
export function trashDirOf(target: string): string | null {
  const marker = `${path.sep}${TRASH_DIRNAME}${path.sep}`
  const at = target.lastIndexOf(marker)
  return at < 0 ? null : target.slice(0, at + marker.length - 1)
}

function recordTrashMove(from: string, to: string, kind: string, strict = false): void {
  const dir = trashDirOf(to)
  if (!dir) return
  const entry: TrashIndexEntry = { id: randomUUID(), from, to, kind, at: new Date().toISOString() }
  // A lost index line only costs Restore for that item; the move itself already happened.
  try { appendFileSync(path.join(dir, TRASH_INDEX), `${JSON.stringify(entry)}\n`) } catch (error) {
    if (strict) throw error
  }
}

function exists(p: string): boolean {
  try { lstatSync(p); return true } catch { return false }
}

/**
 * Where the SOURCE of a folder move that crossed drives goes once its copy is
 * complete: the trash on the source's own drive, never `fs.rm` (renumber,
 * compact and reseason used to delete it). Inside the project →
 * `trashRootFor(project)/moved/<relative>`; under `anchor` (the Library output
 * root or the exports root) → `trashRootFor(anchor)/moved/<relative>`; otherwise beside it.
 */
export function trashCopiedSourceSync(source: string, projectDir: string, slug: string, anchor?: string): string {
  const under = (root: string) => {
    const rel = path.relative(root, source)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
  }
  const inProject = under(projectDir)
  const inAnchor = anchor ? under(anchor) : null
  const target = inProject
    ? path.join(trashRootFor(projectDir, projectDir, slug), 'moved', inProject)
    : inAnchor
      ? path.join(trashRootFor(anchor!, projectDir, slug), 'moved', inAnchor)
      : path.join(path.dirname(source), TRASH_DIRNAME, slug, path.basename(source))
  return moveToTrashSync(source, target, 'moved-source')
}
