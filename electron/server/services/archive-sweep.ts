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
import { constants as fsConstants, createReadStream, existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths } from './utils.js'
import { writeAtomic } from '../lib/sync-safe.js'
import {
  youtubeRetentionEvidenceFor,
  youtubeArchiveProofForFile,
  readYouTubeRetentionStores,
  type YouTubeRetentionEvidence,
} from './youtube-remote-video.js'
import { withFinalVideoPathLock } from './final-video-lock.js'

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

/**
 * Why a file is being left alone, in a form the UI can count.
 *
 * The prose `reason` is for reading; this is for grouping. Before 1.4.10 the
 * confirm dialog described every skip as "not confirmed uploaded", which was
 * wrong for the ~14 files in his `TerenceGaming` folder that have no episode
 * code at all — and it had no way to be right, because only prose existed.
 */
export type ArchiveSkipReason =
  | 'no_code'
  | 'unknown_channel'
  | 'ambiguous_channel'
  | 'not_uploaded'
  | 'not_reviewed'
  | 'collision'

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
  /** The same fact as `reason`, in a form the UI can count by. */
  reason_code?: ArchiveSkipReason
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
 * The key an upload proof is filed under: the CHANNEL and the code together.
 *
 * v1.4.10. This used to be the bare code, and that was a data-loss bug. Seven
 * of the eleven channels on the reporting machine use the `EP` prefix, 302
 * codes exist in more than one channel, and `EP0001`–`EP0006` exist in seven
 * each — so `EP0042` uploaded on one channel authorised moving a SECOND
 * channel's un-uploaded `EP0042` master into the first channel's archive
 * folder and deleting the original. The copy-verify-
 * remove ordering was never the problem: the file was verified into the wrong
 * place, correctly, and then removed.
 *
 * `storage-audit.ts` never had this bug because it is always handed a slug.
 * This is the file that scans a folder and has to work the slug out, so this is
 * the file that has to be careful.
 */
function provenKey(slug: string, code: string): string {
  return `${slug.toLowerCase()}::${code.toUpperCase()}`
}

interface UploadedIndex {
  /** `(slug, code)` → the proof. NEVER keyed by code alone. */
  proven: Map<string, { slug: string; title: string; evidence: YouTubeRetentionEvidence }>
  /**
   * Folder name (lowercased) → the channel it identifies, or `null` when two
   * channels answer to the same name and it therefore identifies nothing.
   */
  aliases: Map<string, string | null>
}

/**
 * Every episode in the Library that can PROVE it was uploaded, keyed by
 * `(channel, code)` — plus the folder names that identify each channel.
 *
 * Built once per sweep rather than per file: a 200-file scan against 450
 * episodes would otherwise re-read every sidecar hundreds of times.
 */
async function buildUploadedIndex(): Promise<UploadedIndex> {
  const proven = new Map<string, { slug: string; title: string; evidence: YouTubeRetentionEvidence }>()
  const aliases = new Map<string, string | null>()
  const projects = await pm.listProjects().catch(() => [])

  const addAlias = (name: string, slug: string) => {
    const key = (name || '').trim().toLowerCase()
    if (!key) return
    const seen = aliases.get(key)
    // Two channels answering to one folder name means that name proves
    // nothing. Poisoning the entry is deliberate: a wrong bind is the bug we
    // are fixing, and a refusal is the safe answer.
    if (seen === undefined) aliases.set(key, slug)
    else if (seen !== slug) aliases.set(key, null)
  }

  for (const project of projects) {
    const slug = (project as any).slug
    if (!slug) continue
    addAlias(slug, slug)
    // His export tree is `{root}/{slug}/…`, but a hand-sorted pile may use the
    // channel's display name instead, so both identify the channel.
    addAlias((project as any).name || '', slug)
    const ideas = await im.getIdeas(slug, 'accepted').catch(() => [])
    const { records: operations, state: publishingState } = await readYouTubeRetentionStores(slug)
    for (const idea of ideas) {
      const code = (idea.episode_code || '').toUpperCase()
      if (!code) continue
      const evidence = await youtubeRetentionEvidenceFor(
        slug, code, idea.title || '', operations, publishingState,
      )
      // Keep even unusable/uncertain evidence in the index. Candidate-level
      // source checks below turn it into a safe skip with an honest reason.
      proven.set(provenKey(slug, code), { slug, title: idea.title || '', evidence })
    }
  }
  return { proven, aliases }
}

/**
 * The episode code for one file: its own name first, then the folders it sits
 * in BELOW the scanned root.
 *
 * v1.4.44 — the folder search used to run over the whole absolute path, which
 * means every folder between the disk root and the scan — a volume name, a
 * user folder, a sync client's cache — could donate a code to a file that has
 * none. It surfaced as an intermittent test failure (a system temp folder
 * named `…-JW5269` made a holiday clip claim to be episode JW5269), but the
 * same thing happens to a real person whose Videos folder sits under any path
 * with two-to-six letters and three-to-five digits in it.
 *
 * Nothing unsafe followed from it — the channel check downstream refuses a
 * file it cannot place, so the invented code produced a confusing skip reason
 * rather than a wrong move. It was still a code attributed to a file from
 * somewhere the user never pointed at.
 */
function codeFrom(filename: string, dir: string, sourceRoot: string): string {
  const withinScan = path.relative(sourceRoot, dir)
  const searchable = withinScan.startsWith('..') || path.isAbsolute(withinScan) ? '' : withinScan
  return (filename.match(EPISODE_CODE)?.[1] || searchable.match(EPISODE_CODE)?.[1] || '').toUpperCase()
}

/**
 * Which channel does this file physically belong to?
 *
 * Answered from where the file SITS, never from what it is called. A file under
 * `…/YouTube Exports/<channel>/Season 003/EP0042 - …/` belongs to that channel,
 * and may only ever be proven against that channel's sidecar.
 *
 * The folder the user pointed the scan at counts as the outermost segment —
 * picking `…/YouTube Exports/<channel>` is the same evidence as scanning its
 * parent, just stated one level up.
 *
 * There is NO fallback to a code-only match. A video whose channel cannot be
 * established is precisely the video that must not move.
 */
function channelFrom(
  fileDir: string,
  sourceRoot: string,
  aliases: Map<string, string | null>,
): { slug: string | null; ambiguous: boolean } {
  const rel = path.relative(sourceRoot, fileDir)
  const segments = [path.basename(sourceRoot)]
  if (rel && rel !== '.') segments.push(...rel.split(path.sep))

  const matched = new Set<string>()
  let sawPoisoned = false
  for (const segment of segments) {
    if (!aliases.has(segment.toLowerCase())) continue
    const slug = aliases.get(segment.toLowerCase())
    if (slug === null) { sawPoisoned = true; continue }
    matched.add(slug!)
  }
  if (matched.size === 1) return { slug: [...matched][0]!, ambiguous: false }
  return { slug: null, ambiguous: matched.size > 1 || sawPoisoned }
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

      const code = codeFrom(entry.name, dir, sourceRoot)
      const base: ArchiveCandidate = {
        source_path: full, filename: entry.name, bytes: stat.size, code,
        status: 'skipped',
      }
      if (!code) {
        candidates.push({
          ...base,
          reason_code: 'no_code',
          reason: 'no episode code in the filename, so it cannot be matched to an episode',
        })
        continue
      }
      // Channel FIRST, proof second. The code alone says nothing about which
      // channel's episode this is — seven of his channels use the `EP` prefix.
      const channel = channelFrom(dir, sourceRoot, uploaded.aliases)
      if (!channel.slug) {
        candidates.push({
          ...base,
          reason_code: channel.ambiguous ? 'ambiguous_channel' : 'unknown_channel',
          reason: channel.ambiguous
            ? `more than one channel could own this folder, so ${code} cannot be tied to one`
            : `nothing in this file's path names a channel, so ${code} cannot be tied to one`,
        })
        continue
      }
      const hit = uploaded.proven.get(provenKey(channel.slug, code))
      if (!hit) {
        candidates.push({
          ...base,
          slug: channel.slug,
          reason_code: 'not_uploaded',
          reason: `${code} is not confirmed uploaded to YouTube on ${channel.slug}`,
        })
        continue
      }
      const proof = await youtubeArchiveProofForFile(hit.evidence, full)
      if (!proof.usable || !proof.video_id) {
        candidates.push({
          ...base,
          slug: channel.slug,
          reason_code: 'not_uploaded',
          reason: `${code} is not the exact render confirmed usable on YouTube on ${channel.slug}`,
        })
        continue
      }
      candidates.push({
        ...base,
        status: 'ready',
        slug: hit.slug,
        title: hit.title,
        youtube_video_id: proof.video_id,
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
  skipped: Array<{ source_path: string; code: string; reason: string; reason_code?: ArchiveSkipReason }>
  /** Files that failed. The SOURCE of each is still intact. */
  failed: Array<{ source_path: string; code: string; error: string }>
  /** True when a stop was requested and honoured between files. */
  cancelled: boolean
  /**
   * Things that should not have happened and were refused rather than papered
   * over. Empty on a healthy run.
   */
  warnings: string[]
}

export interface ArchiveRunOptions {
  destination: string
  sourceRoot?: string
  /**
   * The exact files the user approved, by source path — the reviewed set.
   *
   * v1.4.10. The run recomputes the preview so the upload proof is read fresh
   * and can only ever get STRICTER, then moves the intersection. Anything that
   * has appeared in the folder since he read the bill is left alone: he agreed
   * to move a named list, not to move whatever is there when he presses go.
   *
   * Omit it only for programmatic use with no review step; the UI always sends
   * it and the route requires it.
   */
  approved?: string[]
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
  const result: ArchiveRunResult = {
    destination,
    moved: [],
    bytes_moved: 0,
    skipped: preview.candidates
      .filter(c => c.status === 'skipped')
      .map(c => ({
        source_path: c.source_path, code: c.code,
        reason: c.reason || 'skipped', reason_code: c.reason_code,
      })),
    failed: [],
    cancelled: false,
    warnings: [],
  }

  // Act on the reviewed set. The fresh preview decides what MAY move; his
  // approval decides what WILL. A file that qualifies but he never saw is
  // reported, not moved.
  const approved = opts.approved
    ? new Set(opts.approved.map(p => path.resolve(String(p))))
    : null
  const qualified = preview.candidates.filter(c => c.status === 'ready')
  const ready = approved
    ? qualified.filter(c => approved.has(path.resolve(c.source_path)))
    : qualified
  if (approved) {
    for (const c of qualified) {
      if (approved.has(path.resolve(c.source_path))) continue
      result.skipped.push({
        source_path: c.source_path,
        code: c.code,
        reason: 'this appeared after you reviewed the list, so it was left alone',
        reason_code: 'not_reviewed',
      })
    }
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
          reason_code: 'collision',
        })
        continue
      }

      // Keep a concurrent Video Assembly promotion from replacing the source
      // after this copy is checked but before its pathname is removed. Re-read
      // the receipt inside this same lock: a same-size new render that arrives
      // after preview must not inherit the approved file's YouTube identity.
      const move = await withFinalVideoPathLock(candidate.source_path, async () => {
        const { records, state } = await readYouTubeRetentionStores(candidate.slug!)
        const evidence = await youtubeRetentionEvidenceFor(
          candidate.slug!, candidate.code, candidate.title || '', records, state,
        )
        const freshProof = await youtubeArchiveProofForFile(evidence, candidate.source_path)
        if (!freshProof.usable || freshProof.video_id !== candidate.youtube_video_id) {
          return {
            skipped: `the approved YouTube receipt changed before this copy started; ${candidate.filename} was left in place`,
          }
        }

        try {
          await fs.copyFile(candidate.source_path, target, fsConstants.COPYFILE_EXCL)
        } catch (error: any) {
          if (error?.code === 'EEXIST') {
            return { skipped: `a file named ${candidate.filename} is already in the archive folder` }
          }
          throw error
        }

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
        const breadcrumbWarning = await writeArchiveBreadcrumb(candidate, target, sourceHash)
        await fs.rm(candidate.source_path, { force: true })
        return { sourceHash, breadcrumbWarning }
      })
      if (typeof move.skipped === 'string') {
        result.skipped.push({
          source_path: candidate.source_path,
          code: candidate.code,
          reason: move.skipped,
          reason_code: 'not_uploaded',
        })
        continue
      }
      if (move.breadcrumbWarning) result.warnings.push(move.breadcrumbWarning)

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
 *
 * It writes into an episode folder that ALREADY EXISTS, and never makes one.
 * `writeAtomic` does `mkdir(recursive)`, so before 1.4.10 a breadcrumb aimed at
 * an episode that is not there would conjure the folder — which, with the
 * cross-channel bug above it, meant inventing an episode on the wrong channel
 * as a side effect of archiving. Missing means something is wrong upstream;
 * that is worth saying out loud, not worth papering over with a new directory.
 *
 * Returns a warning to surface, or null when all was well.
 */
async function writeArchiveBreadcrumb(
  candidate: ArchiveCandidate,
  target: string,
  sha256: string,
): Promise<string | null> {
  try {
    const paths = await resolveEpisodePaths(candidate.slug!, candidate.code, candidate.title || '')
    if (!existsSync(paths.episode_dir)) {
      return `${candidate.code}: archived to ${target}, but its episode folder on ${candidate.slug} `
        + 'is not there, so no record was written into it.'
    }
    const record: ArchivedRecord = {
      archived_to: target,
      archived_at: new Date().toISOString(),
      bytes: candidate.bytes,
      sha256,
      youtube_video_id: candidate.youtube_video_id || '',
      original_path: candidate.source_path,
    }
    await writeAtomic(path.join(paths.episode_dir, ARCHIVE_SIDECAR), JSON.stringify(record, null, 2))
    return null
  } catch (e: any) {
    // A breadcrumb that cannot be written must not stop the move: the file is
    // already safely copied and verified. The cost is a less informative UI,
    // not a lost video.
    return `${candidate.code}: archived to ${target}, but its record could not be written `
      + `(${e?.message || String(e)}).`
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
