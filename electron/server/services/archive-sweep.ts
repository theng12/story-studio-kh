/**
 * Archive uploaded videos — move finished films out of the way (v1.4.4).
 *
 * The owner's request: *"i also want to add an option to move uploaded videos
 * to a folder anywhere i want. it's like a button i click and it perge all the
 * videos into a new folder or something so that only finished videos live
 * there. this way i can consider backing it up and clearing for storage or just
 * delete it or something."*
 *
 * So: MOVE, across the whole Library, into a folder he picks. What is left is a
 * folder containing only finished videos — something ordinary tools can back
 * up, park on a slow disk, or delete. This app deliberately does none of those
 * things; the value is that it does not have to.
 *
 * ── The one safety rule, reused rather than rewritten ──
 *
 * A video is only touched when its episode's YouTube sidecar carries a
 * `video_id`. That is the same proof `storage-audit.ts` has always required
 * before deleting a final video, read through the same `readSidecar`. There is
 * NO force option here — he is clearing space, not gambling with masters, and
 * an episode whose upload cannot be proven stays exactly where it is and is
 * listed as skipped with the reason.
 *
 * ── Copy, verify, then remove ──
 *
 * The destination is usually another volume, so this is never a rename. Each
 * file is copied, then verified at the destination by size AND sha256, and only
 * then removed from the source. If verification fails the source is left alone
 * and both copies survive — losing a finished video is the worst thing this
 * feature could do, and it is worse than not running.
 *
 * That ordering is also what makes a stop safe: at every instant a file is
 * either wholly at the source or wholly at both ends. There is no moment when
 * it exists only as a partial copy that has already been deleted from home.
 *
 * ── Why it scans a folder rather than an episode list ──
 *
 * His finished videos are not where the app would put them today: 220 GB of
 * them sit in `~/Downloads/YouTube Exports`, written when the retired
 * `external_final_video_root` still existed. A sweep that only looked in
 * `<Library>/Exports` would find nothing on the day he most needs it. So it
 * scans a SOURCE FOLDER he names — defaulting to the Library's Exports — and
 * matches each video back to its episode by the code in its name.
 */

import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { readSidecar } from './upload-sidecar.js'
import { resolveEpisodePaths } from './utils.js'
import { writeAtomic } from '../lib/sync-safe.js'

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v)$/i
/**
 * `EP0047`, `TN0123`, `DK0031` — the prefix is per project, so this is generic.
 *
 * Deliberately NOT `\b…\b`: the real filenames are `TN0001_final_video.mp4`,
 * and `\b` does not match between `1` and `_` because underscore counts as a
 * word character. That version silently matched nothing at all.
 */
const EPISODE_CODE = /(?:^|[^A-Za-z0-9])([A-Za-z]{2,6}\d{3,5})(?![0-9])/

/** Breadcrumb written into the episode folder when its video is archived. */
export const ARCHIVE_SIDECAR = 'archived_video.json'

export interface ArchivedRecord {
  /** Where the file was moved to. */
  archived_to: string
  archived_at: string
  bytes: number
  sha256: string
  /** The upload that authorised the move, recorded so the proof travels too. */
  youtube_video_id: string
  original_path: string
}

export interface ArchiveCandidate {
  source_path: string
  filename: string
  bytes: number
  /** Episode code parsed from the filename or its folder. */
  code: string
  /** Resolved project, when the code matched one. */
  slug?: string
  title?: string
  youtube_video_id?: string
  /** `ready` will be moved; `skipped` will not, and says why. */
  status: 'ready' | 'skipped'
  reason?: string
}

export interface ArchivePreview {
  source_root: string
  source_exists: boolean
  candidates: ArchiveCandidate[]
  ready_count: number
  ready_bytes: number
  skipped_count: number
  skipped_bytes: number
  /** Ready files per channel, so he can see what the sweep is about to touch. */
  by_channel: Array<{ slug: string; count: number; bytes: number }>
}

/** Default source: the Library's own Exports folder. */
async function defaultSourceRoot(): Promise<string> {
  const { exportsDir } = await import('./library.js')
  return exportsDir()
}

/**
 * Every episode in the Library that can PROVE it was uploaded, keyed by code.
 *
 * Built once per sweep rather than per file: a 200-file scan against 450
 * episodes would otherwise re-read every sidecar hundreds of times.
 */
async function buildUploadedIndex(): Promise<Map<string, { slug: string; title: string; videoId: string }>> {
  const index = new Map<string, { slug: string; title: string; videoId: string }>()
  const projects = await pm.listProjects().catch(() => [])
  for (const project of projects) {
    const slug = (project as any).slug
    if (!slug) continue
    const ideas = await im.getIdeas(slug, 'accepted').catch(() => [])
    for (const idea of ideas) {
      const code = (idea.episode_code || '').toUpperCase()
      if (!code) continue
      try {
        const sc = await readSidecar(slug, code, idea.title || '', 'youtube')
        if (sc?.video_id) {
          index.set(code, { slug, title: idea.title || '', videoId: sc.video_id })
        }
      } catch { /* unreadable sidecar → not proven, leave out */ }
    }
  }
  return index
}

function codeFrom(filename: string, dir: string): string {
  return (filename.match(EPISODE_CODE)?.[1] || dir.match(EPISODE_CODE)?.[1] || '').toUpperCase()
}

/**
 * What a sweep would do, without doing any of it.
 *
 * He sees the bill first — how many videos, how much space, which channels, and
 * every skip with its reason — and then presses go.
 */
export async function previewArchiveSweep(
  opts: { sourceRoot?: string } = {},
): Promise<ArchivePreview> {
  const sourceRoot = (opts.sourceRoot || '').trim() || await defaultSourceRoot()
  const empty: ArchivePreview = {
    source_root: sourceRoot,
    source_exists: false,
    candidates: [],
    ready_count: 0, ready_bytes: 0, skipped_count: 0, skipped_bytes: 0,
    by_channel: [],
  }
  if (!sourceRoot || !existsSync(sourceRoot)) return empty
  empty.source_exists = true

  const uploaded = await buildUploadedIndex()
  const candidates: ArchiveCandidate[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!VIDEO_EXT.test(entry.name)) continue
      const stat = await fs.stat(full).catch(() => null)
      if (!stat?.isFile()) continue

      const code = codeFrom(entry.name, dir)
      const base: ArchiveCandidate = {
        source_path: full, filename: entry.name, bytes: stat.size, code,
        status: 'skipped',
      }
      if (!code) {
        candidates.push({ ...base, reason: 'no episode code in the filename, so it cannot be matched to an episode' })
        continue
      }
      const hit = uploaded.get(code)
      if (!hit) {
        candidates.push({ ...base, reason: `${code} is not confirmed uploaded to YouTube` })
        continue
      }
      candidates.push({
        ...base,
        status: 'ready',
        slug: hit.slug,
        title: hit.title,
        youtube_video_id: hit.videoId,
      })
    }
  }
  await walk(sourceRoot)

  const ready = candidates.filter(c => c.status === 'ready')
  const skipped = candidates.filter(c => c.status === 'skipped')
  const byChannel = new Map<string, { count: number; bytes: number }>()
  for (const c of ready) {
    const row = byChannel.get(c.slug!) || { count: 0, bytes: 0 }
    row.count += 1; row.bytes += c.bytes
    byChannel.set(c.slug!, row)
  }

  return {
    source_root: sourceRoot,
    source_exists: true,
    candidates,
    ready_count: ready.length,
    ready_bytes: ready.reduce((n, c) => n + c.bytes, 0),
    skipped_count: skipped.length,
    skipped_bytes: skipped.reduce((n, c) => n + c.bytes, 0),
    by_channel: [...byChannel.entries()]
      .map(([slug, v]) => ({ slug, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve())
  })
  return hash.digest('hex')
}

export interface ArchiveMoved {
  code: string
  slug: string
  from: string
  to: string
  bytes: number
}

export interface ArchiveRunResult {
  destination: string
  moved: ArchiveMoved[]
  bytes_moved: number
  /** Files deliberately not touched, with the reason. */
  skipped: Array<{ source_path: string; code: string; reason: string }>
  /** Files that failed. The SOURCE of each is still intact. */
  failed: Array<{ source_path: string; code: string; error: string }>
  /** True when a stop was requested and honoured between files. */
  cancelled: boolean
}

export interface ArchiveRunOptions {
  destination: string
  sourceRoot?: string
  /** Checked between files. A stop never interrupts a copy midway. */
  shouldStop?: () => boolean
  /** Called after each file so a long sweep can report progress. */
  onProgress?: (done: number, total: number, current: string) => void
}

/**
 * Move every confirmed-uploaded video from the source folder to `destination`.
 *
 * Copies, verifies, then removes. Never renames, because the destination is
 * usually another volume and a rename across volumes is a copy anyway — but one
 * whose failure modes are invisible.
 */
export async function runArchiveSweep(opts: ArchiveRunOptions): Promise<ArchiveRunResult> {
  const destination = path.resolve(String(opts.destination || '').trim())
  if (!destination) throw Object.assign(new Error('Choose a folder to move the videos into.'), { statusCode: 400 })

  const { assertWriteIsolatedInTests } = await import('../lib/test-isolation.js')
  assertWriteIsolatedInTests(destination, 'archive-destination')
  await fs.mkdir(destination, { recursive: true })

  const preview = await previewArchiveSweep({ sourceRoot: opts.sourceRoot })
  const ready = preview.candidates.filter(c => c.status === 'ready')
  const result: ArchiveRunResult = {
    destination,
    moved: [],
    bytes_moved: 0,
    skipped: preview.candidates
      .filter(c => c.status === 'skipped')
      .map(c => ({ source_path: c.source_path, code: c.code, reason: c.reason || 'skipped' })),
    failed: [],
    cancelled: false,
  }

  let done = 0
  for (const candidate of ready) {
    if (opts.shouldStop?.()) { result.cancelled = true; break }

    // One folder per channel at the destination, so the archive stays legible
    // rather than becoming 200 loose files.
    const targetDir = path.join(destination, candidate.slug!)
    const target = path.join(targetDir, candidate.filename)
    try {
      await fs.mkdir(targetDir, { recursive: true })

      // Refuse to overwrite. A same-named file already there is either this
      // very archive run repeated, or a different episode's collision — either
      // way, silently clobbering a finished video is not acceptable.
      if (existsSync(target)) {
        result.skipped.push({
          source_path: candidate.source_path,
          code: candidate.code,
          reason: `a file named ${candidate.filename} is already in the archive folder`,
        })
        continue
      }

      await fs.copyFile(candidate.source_path, target)

      // Verify BEFORE removing. Size catches a truncated copy; the hash catches
      // silent corruption, which is the failure a big cross-volume copy actually
      // has. Both, because size alone would pass a corrupted file of the right
      // length.
      const targetStat = await fs.stat(target)
      if (targetStat.size !== candidate.bytes) {
        throw new Error(`copy is ${targetStat.size} bytes but the original is ${candidate.bytes}`)
      }
      const [sourceHash, targetHash] = await Promise.all([
        sha256Of(candidate.source_path),
        sha256Of(target),
      ])
      if (sourceHash !== targetHash) {
        throw new Error('the copy does not match the original (checksum differs)')
      }

      // Breadcrumb first, removal second. If the process dies between them the
      // worst case is a record pointing at a file that also still exists — an
      // over-report, not a lost video.
      await writeArchiveBreadcrumb(candidate, target, sourceHash)
      await fs.rm(candidate.source_path, { force: true })

      result.moved.push({
        code: candidate.code,
        slug: candidate.slug!,
        from: candidate.source_path,
        to: target,
        bytes: candidate.bytes,
      })
      result.bytes_moved += candidate.bytes
    } catch (e: any) {
      // The source is untouched on every path that reaches here: removal is the
      // last statement in the try, after verification.
      result.failed.push({
        source_path: candidate.source_path,
        code: candidate.code,
        error: e?.message || String(e),
      })
      // Leave the unverified copy behind rather than deleting it — two copies is
      // a tidying problem, one lost master is not recoverable.
    } finally {
      done += 1
      opts.onProgress?.(done, ready.length, candidate.filename)
    }
  }
  return result
}

/**
 * Record where an episode's video went.
 *
 * Without this, an archived episode is indistinguishable from one whose video
 * has gone missing — and 1.4.2 taught the app to report exactly that, so the
 * sweep would manufacture the false alarm we had just built the reporting to
 * catch. "Archived to X" and "missing" are different facts and must never be
 * spelled the same way.
 */
async function writeArchiveBreadcrumb(
  candidate: ArchiveCandidate,
  target: string,
  sha256: string,
): Promise<void> {
  try {
    const paths = await resolveEpisodePaths(candidate.slug!, candidate.code, candidate.title || '')
    const record: ArchivedRecord = {
      archived_to: target,
      archived_at: new Date().toISOString(),
      bytes: candidate.bytes,
      sha256,
      youtube_video_id: candidate.youtube_video_id || '',
      original_path: candidate.source_path,
    }
    await writeAtomic(path.join(paths.episode_dir, ARCHIVE_SIDECAR), JSON.stringify(record, null, 2))
  } catch {
    // A breadcrumb that cannot be written must not stop the move: the file is
    // already safely copied and verified. The cost is a less informative UI,
    // not a lost video.
  }
}

/** Where this episode's video was archived to, or null. */
export async function readArchiveRecord(episodeDir: string): Promise<ArchivedRecord | null> {
  try {
    const raw = await fs.readFile(path.join(episodeDir, ARCHIVE_SIDECAR), 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed?.archived_to ? parsed as ArchivedRecord : null
  } catch {
    return null
  }
}
