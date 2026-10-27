/**
 * The final video a re-assembly replaces (owner, 2026-10-27).
 *
 * A re-render used to overwrite the channel's `{CODE}_final_video.mp4` with no
 * copy kept: one bad render and the approved video was gone. Now, when Video
 * Assembly is about to take an existing final's name:
 *
 *   1. the NEW render passes the same completion checks a first render does —
 *      length against the plan, media readable, loudness at the target — while
 *      the accepted final is still in place;
 *   2. only then do the previous final and the sidecars that belong to it move,
 *      as one folder, into `_previous_finals/<stamp>_<code>/` beside it;
 *   3. the new render is published under the final name.
 *
 * So a failed render leaves the accepted final exactly where it was, and a
 * queue (or a Mac) that stops between 2 and 3 leaves the previous final
 * recoverable in its folder rather than lost — the job log names the folder.
 *
 * The kept copy is restorable for `FINAL_VIDEO_RETENTION_DAYS`; the daily
 * retention tick (`services/retention.ts`) then hands the whole folder to
 * Story's one Trash through `lib/trash-move.ts` (never `rm`, never a
 * copy-delete across drives). The channel-level record
 * (`final_video_replacements.json`) is what that sweep reads — no folder
 * walking, and an unreadable record throws instead of reading as "nothing
 * retained" (AGENTS.md §6).
 *
 * The remote-render importer uses the SAME service for the final it displaces
 * (`services/final-render-import.ts`), so a fleet render and a local
 * re-assembly leave the owner with the same three-day restorable copy rather
 * than the fleet path dropping the previous final straight into Story's Trash.
 */

import fs from 'fs/promises'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import type { Job } from '../models/types.js'

/** Owner's window (2026-10-27): a replaced final can be restored for this long. */
export const FINAL_VIDEO_RETENTION_DAYS = 3

/** Holds one folder per replaced final, beside the final it belonged to. */
export const PREVIOUS_FINALS_DIRNAME = '_previous_finals'

/** The channel's record of what it keeps, and where. Beside `config.json`. */
export const FINAL_VIDEO_REPLACEMENTS_SIDECAR = 'final_video_replacements.json'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RECORDS = 400

export interface RetainedFinalVideo {
  code: string
  /** The retained folder: the previous final and its sidecars, together. */
  retained_path: string
  /** When it was replaced — the clock the retention window runs on. */
  retained_at: string
  /** The render that took its name (informational; the filename is canonical). */
  replaced_by: string
  final_name: string
}

interface ReplacementsFile {
  schema_version: 1
  replaced: RetainedFinalVideo[]
}

/** `_previous_finals/` inside the folder the final lives in (same drive as the final). */
export function previousFinalsDir(finalPath: string): string {
  return path.join(path.dirname(finalPath), PREVIOUS_FINALS_DIRNAME)
}

/**
 * The sidecars that belong to THIS final, matched by what their names END with.
 *
 * A prefix test would claim every other episode's sidecars in a shared Exports
 * folder (AGENTS.md §6), so the exact final filename is part of the suffix.
 */
export function sidecarsOfFinal(finalName: string): string[] {
  return [`${finalName}.finalcheck.json`, `${finalName}.finalcheck.expectation.json`]
}

export function sidecarBelongsToFinal(name: string, finalName: string): boolean {
  return sidecarsOfFinal(finalName).some(suffix => name.endsWith(suffix))
}

function hasBytes(file: string): boolean {
  try {
    const stat = statSync(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function replacementsPath(projectDir: string): string {
  return path.join(projectDir, FINAL_VIDEO_REPLACEMENTS_SIDECAR)
}

/**
 * What this channel keeps. An unreadable record THROWS: answering "nothing was
 * retained" for a torn file would abandon preserved videos (AGENTS.md §6).
 */
export function readRetainedFinalVideos(projectDir: string): RetainedFinalVideo[] {
  const file = replacementsPath(projectDir)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`Could not read ${FINAL_VIDEO_REPLACEMENTS_SIDECAR}: ${error?.message || error}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: any) {
    throw new Error(`${FINAL_VIDEO_REPLACEMENTS_SIDECAR} is not valid JSON: ${error?.message || error}`, { cause: error })
  }
  const rows = (parsed as ReplacementsFile | null)?.replaced
  if (!Array.isArray(rows)) throw new Error(`${FINAL_VIDEO_REPLACEMENTS_SIDECAR} has no \`replaced\` list.`)
  return rows.filter((row): row is RetainedFinalVideo => !!row
    && typeof row.retained_path === 'string' && !!row.retained_path
    && typeof row.retained_at === 'string' && Number.isFinite(Date.parse(row.retained_at)))
}

export async function recordRetainedFinalVideo(projectDir: string, entry: RetainedFinalVideo): Promise<void> {
  const file = replacementsPath(projectDir)
  await withLock(`final-video-replacements:${path.resolve(file)}`, async () => {
    const kept = readRetainedFinalVideos(projectDir)
      .filter(row => row.retained_path !== entry.retained_path)
    await writeJsonAtomic(file, { schema_version: 1, replaced: [...kept, entry].slice(-MAX_RECORDS) } satisfies ReplacementsFile)
  })
}

/** Forget one retained copy whose bytes went back to the live name (never deletes). */
export async function dropRetainedFinalVideo(projectDir: string, retainedPath: string): Promise<void> {
  const file = replacementsPath(projectDir)
  await withLock(`final-video-replacements:${path.resolve(file)}`, async () => {
    const kept = readRetainedFinalVideos(projectDir).filter(row => row.retained_path !== retainedPath)
    await writeJsonAtomic(file, { schema_version: 1, replaced: kept } satisfies ReplacementsFile)
  })
}

function stampFor(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/**
 * Move `finalPath` (and the sidecars that belong to it) into a new folder under
 * `_previous_finals/` and record it. Returns null when there is nothing there
 * (a first render) or when the move could not be made — the caller is told, in
 * its own job log, either way.
 */
export async function retainPreviousFinalVideo(opts: {
  job: Job
  projectDir: string
  code: string
  finalPath: string
  now?: number
}): Promise<RetainedFinalVideo | null> {
  const { job, projectDir, code, finalPath } = opts
  if (!hasBytes(finalPath)) return null
  const now = opts.now ?? Date.now()
  const finalName = path.basename(finalPath)
  const target = path.join(previousFinalsDir(finalPath), `${stampFor(now)}_${code.toUpperCase()}`)
  const moved: string[] = []
  try {
    await fs.mkdir(target, { recursive: true })
    // Sidecars first: a video kept without its check record is still a video;
    // a check record with no video would be an orphan.
    const listing = await fs.readdir(path.dirname(finalPath)).catch(() => [] as string[])
    for (const name of listing.filter(entry => sidecarBelongsToFinal(entry, finalName))) {
      await fs.rename(path.join(path.dirname(finalPath), name), path.join(target, name))
      moved.push(name)
    }
    await fs.rename(finalPath, path.join(target, finalName))
  } catch (error: any) {
    // Put the sidecars back so the live final keeps its own records, and say so.
    for (const name of moved) {
      await fs.rename(path.join(target, name), path.join(path.dirname(finalPath), name)).catch(() => undefined)
    }
    job.output_lines.push(
      `⚠ Could not keep the previous final (${error?.message || error}); it was left where it is.`,
    )
    return null
  }

  const entry: RetainedFinalVideo = {
    code: code.toUpperCase(),
    retained_path: target,
    retained_at: new Date(now).toISOString(),
    replaced_by: finalName,
    final_name: finalName,
  }
  try {
    await recordRetainedFinalVideo(projectDir, entry)
  } catch (error: any) {
    // The bytes are already safe; only the record the sweep reads failed. Say it.
    job.output_lines.push(
      `⚠ Kept the previous final at ${target}, but could not record it for automatic cleanup `
      + `(${error?.message || error}). It stays there until you remove it.`,
    )
  }
  job.output_lines.push(
    `Previous final kept for ${FINAL_VIDEO_RETENTION_DAYS} days: ${target} `
    + `(${[finalName, ...moved].join(', ')}). It is reversible until the daily cleanup hands it to Story's Trash; `
    + 'restore by moving it back to the episode folder, or use Story → Trash after that.',
  )
  return entry
}

function digestOf(file: string): string | null {
  let handle: number | null = null
  try {
    handle = openSync(file, 'r')
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null)
      if (!read) break
      digest.update(buffer.subarray(0, read))
    }
    return digest.digest('hex')
  } catch {
    return null
  } finally {
    if (handle !== null) closeSync(handle)
  }
}

/** Is this retained copy the exact bytes the caller is about to replace? */
export function retainedCopyMatches(entry: RetainedFinalVideo, expected: { sha256: string; size_bytes: number }): boolean {
  const kept = path.join(entry.retained_path, entry.final_name)
  try {
    if (statSync(kept).size !== expected.size_bytes) return false
  } catch {
    return false
  }
  return digestOf(kept) === expected.sha256
}

/**
 * The copy of `finalPath` a previous pass already kept, if there is one.
 *
 * A retry re-enters publication with the previous final already moved aside
 * (a crash after the keep, or a second importer pass after one that could not
 * finish), so the live name no longer has its bytes. The channel record is the
 * answer; when a crash landed between the move and the record write, the
 * `_previous_finals/` folder is found and the record is written now — the daily
 * sweep only knows what the record says (§6: the folder alone is not enough).
 */
export async function findRetainedFinalVideo(opts: {
  job: Job
  projectDir: string
  finalPath: string
  expected: { sha256: string; size_bytes: number }
}): Promise<RetainedFinalVideo | null> {
  const { job, projectDir, finalPath, expected } = opts
  const finalName = path.basename(finalPath)
  const dir = previousFinalsDir(finalPath)
  const recorded = readRetainedFinalVideos(projectDir).filter(entry => entry.final_name === finalName)
  // One folder per replacement, newest last only by name order; every candidate
  // is checked against the bytes being replaced, so a stamp order can never
  // hand back another replacement's copy.
  const candidates = [
    ...recorded,
    ...(await fs.readdir(dir).catch((error: any) => {
      if (error?.code === 'ENOENT') return [] as string[]
      throw error
    })).map(name => ({
      code: name.slice(name.lastIndexOf('_') + 1),
      retained_path: path.join(dir, name),
      // The kept file's own timestamp: a stamp of 0 would let the sweep bin it at once.
      retained_at: new Date(statSync(path.join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? Date.now()).toISOString(),
      replaced_by: finalName,
      final_name: finalName,
    } satisfies RetainedFinalVideo)),
  ]
  for (const entry of candidates) {
    if (!retainedCopyMatches(entry, expected)) continue
    if (!recorded.some(row => row.retained_path === entry.retained_path)) {
      await recordRetainedFinalVideo(projectDir, entry).catch((error: any) => {
        job.output_lines.push(
          `⚠ Kept the previous final at ${entry.retained_path}, but could not record it for automatic cleanup `
          + `(${error?.message || error}). It stays there until you remove it.`,
        )
      })
    }
    return entry
  }
  return null
}

/** One line for a job log: which previous final was kept, where, and for how long. */
export function retainedFinalLogLine(entry: RetainedFinalVideo): string {
  return `Previous final kept for ${FINAL_VIDEO_RETENTION_DAYS} days: ${entry.retained_path} `
    + `(${entry.final_name}). It is reversible until the daily cleanup hands it to Story's Trash; `
    + 'restore by moving it back to the episode folder, or use Story → Trash after that.'
}

/** Put a retained final (and its sidecars) back where it came from. */
export async function restoreRetainedFinalVideo(entry: RetainedFinalVideo, job?: Job): Promise<boolean> {
  const finalPath = path.join(path.dirname(path.dirname(entry.retained_path)), entry.final_name)
  try {
    // Move the members back, then the folder is empty and can stay (never rm).
    for (const name of await fs.readdir(entry.retained_path)) {
      const destination = path.join(path.dirname(finalPath), name)
      if (existsSync(destination)) throw new Error(`${name} is already there`)
      await fs.rename(path.join(entry.retained_path, name), destination)
    }
    job?.output_lines.push(`The previous final was put back: ${finalPath}`)
    return true
  } catch (error: any) {
    job?.output_lines.push(
      `⚠ The previous final is still at ${entry.retained_path} (${error?.message || error}); `
      + 'move it back by hand if you need it.',
    )
    return false
  }
}

/** The Trash root this retained folder belongs in — the one on its own drive. */
async function trashTargetForFinal(projectDir: string, slug: string, target: string): Promise<string> {
  const anchors: string[] = [projectDir]
  try {
    const { exportsDir, previousExportsDirs } = await import('./library.js')
    anchors.push(...[await exportsDir().catch(() => ''), ...await previousExportsDirs().catch(() => [])].filter(Boolean))
  } catch { /* no library configured on this Mac */ }
  try {
    const pm = await import('./project-manager.js')
    const mediaRoot = ((await pm.getProject(slug)) as { media_root?: string } | null)?.media_root
    if (mediaRoot) {
      const { resolveAssetPath } = await import('./path-resolver.js')
      const root = resolveAssetPath(String(mediaRoot), await pm.getProjectOutputRoot(slug) || projectDir)
      if (root) anchors.push(root)
    }
  } catch { /* media drive not defined here */ }
  const container = path.dirname(target)
  const under = (root: string) => {
    const rel = path.relative(root, container)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
  }
  for (const anchor of anchors) {
    const rel = under(anchor)
    if (rel !== null) return path.join(trashRootFor(anchor, projectDir, slug), rel, path.basename(target))
  }
  // Not under any configured anchor (a moved library): the project's own Trash,
  // which is what every other helper falls back to.
  return path.join(trashRootFor(projectDir, projectDir, slug), 'previous-finals', path.basename(target))
}

export interface RetainedFinalSweep {
  channels: number
  swept: number
  deferred: number
  lines: string[]
}

/** One channel: retained finals past their window go to Story's Trash. */
export async function sweepChannelRetainedFinalVideos(opts: {
  projectDir: string
  slug: string
  now?: number
  log?: (line: string) => void
}): Promise<RetainedFinalSweep> {
  const now = opts.now ?? Date.now()
  const log = opts.log ?? (() => undefined)
  const result: RetainedFinalSweep = { channels: 1, swept: 0, deferred: 0, lines: [] }
  const kept: RetainedFinalVideo[] = []
  const entries = readRetainedFinalVideos(opts.projectDir)
  for (const entry of entries) {
    const age = now - Date.parse(entry.retained_at)
    if (!existsSync(entry.retained_path)) {
      log(`${entry.code}: the kept copy at ${entry.retained_path} is gone; dropping the record.`)
      continue
    }
    if (!(age >= FINAL_VIDEO_RETENTION_DAYS * DAY_MS)) { kept.push(entry); continue }
    try {
      const target = await trashTargetForFinal(opts.projectDir, opts.slug, entry.retained_path)
      const moved = moveToTrashSync(entry.retained_path, target, 'final-video')
      result.swept += 1
      log(`${entry.code}: kept final moved to Story's Trash → ${moved}`)
    } catch (error: any) {
      result.deferred += 1
      kept.push(entry)
      log(`${entry.code}: could not move the kept final to the Trash (${error?.message || error}); it was left where it is.`)
    }
  }
  if (kept.length !== entries.length) {
    await withLock(`final-video-replacements:${path.resolve(replacementsPath(opts.projectDir))}`, async () => {
      await writeJsonAtomic(replacementsPath(opts.projectDir), { schema_version: 1, replaced: kept } satisfies ReplacementsFile)
    })
  }
  return result
}

/** Every channel's retained finals, for the daily retention tick. */
export async function sweepRetainedFinalVideos(now = Date.now()): Promise<RetainedFinalSweep> {
  const pm = await import('./project-manager.js')
  const total: RetainedFinalSweep = { channels: 0, swept: 0, deferred: 0, lines: [] }
  for (const project of await pm.listProjects()) {
    const projectDir = pm.getProjectDir(project.slug)
    if (!projectDir) continue
    total.channels += 1
    try {
      const result = await sweepChannelRetainedFinalVideos({
        projectDir, slug: project.slug, now, log: line => total.lines.push(`${project.slug}: ${line}`),
      })
      total.swept += result.swept
      total.deferred += result.deferred
    } catch (error: any) {
      total.lines.push(`${project.slug}: could not read ${FINAL_VIDEO_REPLACEMENTS_SIDECAR} (${error?.message || error}); nothing was moved.`)
      total.deferred += 1
    }
  }
  return total
}

/**
 * Publish a finished render over the final it replaces, in the order that
 * protects the accepted one.
 *
 * `verify` is the render's own completion check (the same one a first render
 * runs). It is called on the new file BEFORE anything is moved; when it throws,
 * the caller's `publish` is never reached and the accepted final is untouched.
 */
export async function publishOverPreviousFinal(opts: {
  job: Job
  project_slug: string
  projectDir: string
  code: string
  finalPath: string
  /** The encoded render, not yet under its final name. */
  newRenderPath: string
  finalName: string
  verify: (pathname: string) => Promise<void>
  /** The caller's existing publication (rename/copy + fallbacks); returns where it landed. */
  publish: () => Promise<string>
}): Promise<{ resolved: string; previousExisted: boolean; retained: RetainedFinalVideo | null; restored: boolean }> {
  const { job, code, finalPath, finalName } = opts
  // One replacement at a time per final name; `publish` takes its own lock on
  // the same path afterwards, always in this order, so the two never invert.
  return withLock(`final-video-replacement:${path.resolve(finalPath)}`, async () => {
    const previousExisted = hasBytes(finalPath)
    // The one path whose whole job is to REFUSE displacing an accepted final (a
    // remote-refused local fallback): its exclusive publication must hit the same
    // conflict it always did, so it keeps the old order and moves nothing.
    const refusedFallback = job.final_render_remote_wait?.phase === 'refused'
    if (!previousExisted || refusedFallback) {
      // Nothing to keep (or nothing allowed to move): publish as before, and the
      // caller keeps its historical order — checks after publication.
      return { resolved: await opts.publish(), previousExisted, retained: null, restored: false }
    }
    // 1. The new render's checks, while the accepted final is still in place.
    try {
      await opts.verify(opts.newRenderPath)
    } catch (error: any) {
      job.output_lines.push(
        `The previous final is unchanged at ${finalPath}. This render was not published `
        + `(${error?.message || error}); its file is still ${opts.newRenderPath}.`,
      )
      throw error
    }
    // 2. Keep the final this one replaces.
    const retained = await retainPreviousFinalVideo({ job, projectDir: opts.projectDir, code, finalPath })
    // 3. Publish.
    let resolved: string
    try {
      resolved = await opts.publish()
    } catch (error) {
      // Nothing took the name: the accepted final goes straight back.
      if (retained) {
        await restoreRetainedFinalVideo(retained, job)
        await dropRetainedFinalVideo(opts.projectDir, retained.retained_path).catch(() => undefined)
      }
      throw error
    }
    if (retained && path.basename(resolved) !== finalName) {
      await restoreRetainedFinalVideo(retained, job)
      await dropRetainedFinalVideo(opts.projectDir, retained.retained_path).catch(() => undefined)
      return { resolved, previousExisted, retained: null, restored: true }
    }
    return { resolved, previousExisted, retained, restored: false }
  })
}
