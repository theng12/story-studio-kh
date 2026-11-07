/**
 * Final-video review marks (owner, 2026-10-29: *"when I'm outside, I can just
 * review the video then approve it … it's an optional review step"*).
 *
 * A mark is an opinion about ONE exact file. It is stored beside the final as
 * `<final name>.review.json` — the same sidecar convention as
 * `<final name>.finalcheck.json` — with the final's identity under an identity
 * `version`: path, size, modified time, inode and sha256. A re-render, a moved
 * file or an edited file makes the old mark read STALE rather than pretending
 * the new bytes were reviewed (AGENTS.md §6: "not reviewed" and "the file
 * changed" must not look the same).
 *
 * A mark is a review note only. It authorises nothing — not upload, not
 * scheduling, not publishing — and no generator, pipeline step or gate reads
 * it. Review is off unless a channel turns it on (`config.json`
 * `final_review.enabled`), and a channel that never turns it on writes no
 * sidecar and shows no state: existing production is untouched.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import type {
  FinalReviewChannel,
  FinalReviewDecision,
  FinalReviewFileIdentity,
  FinalReviewFileNow,
  FinalReviewItem,
  FinalReviewListResponse,
  FinalReviewState,
} from '../contracts/final-review.js'
import type { ProjectConfig } from '../models/types.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import * as im from './idea-manager.js'
import * as pm from './project-manager.js'
import { resolveEpisodePaths, resolveEpisodeTitleByCode } from './utils.js'
import { findYouTubeSourceVideoPath, resolveYouTubeSourceRevisionCached } from './youtube-source-video.js'

/**
 * The channel's `final_review` block. `models/types.ts` (reserved to the lead)
 * still declares only `{ enabled: boolean }`; the auto-pass fields are written
 * through `updateConfig`'s pass-through, so they are read through this view.
 */
interface FinalReviewBlock {
  enabled?: boolean
  auto_pass?: boolean
  auto_pass_enabled_at?: string
}

function reviewBlock(config: ProjectConfig | null | undefined): FinalReviewBlock {
  return (config as { final_review?: FinalReviewBlock } | null | undefined)?.final_review ?? {}
}

/** Absent or false = off. Only an explicit `true` turns a channel's review on. */
export function finalReviewEnabled(config: ProjectConfig | null | undefined): boolean {
  return reviewBlock(config).enabled === true
}

/** Absent or false = off. Only true when both review and auto_pass are turned on. */
export function finalAutoPassEnabled(config: ProjectConfig | null | undefined): boolean {
  const block = reviewBlock(config)
  return block.enabled === true && block.auto_pass === true
}

/** The mark lives beside the final it is about, so it travels with the file. */
export function finalReviewSidecarPath(finalPath: string): string {
  return `${finalPath}.review.json`
}

/**
 * Where a deliberate clear is remembered, beside the final like the mark.
 * Without it the next list GET would see not_reviewed + an eligible mtime and
 * auto-pass the same bytes the owner just cleared.
 */
export function finalReviewClearedPath(finalPath: string): string {
  return `${finalPath}.review.cleared.json`
}

/** The signature staleness is decided on: size, modified time and inode. */
export function sameFileSignature(recorded: FinalReviewFileNow | FinalReviewFileIdentity, now: FinalReviewFileNow): boolean {
  return recorded.path === now.path
    && recorded.size === now.size
    && recorded.mtime_ms === now.mtime_ms
    && recorded.ino === now.ino
}

async function statFinal(finalPath: string): Promise<FinalReviewFileNow | null> {
  const stat = await fsp.stat(finalPath).catch(() => null)
  if (!stat?.isFile() || stat.size <= 0) return null
  return { path: finalPath, size: stat.size, mtime_ms: stat.mtimeMs, ino: stat.ino }
}

function isDecision(value: unknown): value is FinalReviewDecision {
  return value === 'approved' || value === 'needs_changes' || value === 'auto_passed'
}

function isIdentity(value: any): value is FinalReviewFileIdentity {
  return !!value && value.version === 1
    && typeof value.path === 'string'
    && typeof value.size === 'number'
    && typeof value.mtime_ms === 'number'
    && typeof value.ino === 'number'
    && typeof value.sha256 === 'string'
}

/** A clear record names the exact bytes it clears: path, size, modified time, inode. */
function isClearedIdentity(value: any): value is FinalReviewFileNow & { version: 1 } {
  return !!value && value.version === 1
    && typeof value.path === 'string'
    && typeof value.size === 'number'
    && typeof value.mtime_ms === 'number'
    && typeof value.ino === 'number'
}

/**
 * True when a deliberate clear covers these exact bytes, so auto-pass must not
 * re-apply a mark to them. A tombstone that cannot be read counts as cleared:
 * could-not-work-it-out must never become an auto-pass (§6). A tombstone for
 * OTHER bytes (a re-render) does not block — the new final is eligible again.
 */
async function deliberatelyCleared(finalPath: string, now: FinalReviewFileNow): Promise<boolean> {
  let text: string
  try {
    text = await fsp.readFile(finalReviewClearedPath(finalPath), 'utf8')
  } catch (error: any) {
    return error?.code !== 'ENOENT'
  }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return true
  }
  if (parsed?.schema_version !== 1 || !isClearedIdentity(parsed?.identity)) return true
  return sameFileSignature(parsed.identity, now)
}

/**
 * Read a final's mark against the file as it is now.
 *
 * The recorded sha256 is NOT recomputed here: a read happens on every page
 * load and on every poll, and hashing a 840 MB final each time would make the
 * Review page unusable. Size + modified time + inode detect a replacement
 * (an atomic rename changes the inode; an in-place rewrite changes size or
 * mtime) — the hash is the durable content record the mark was made against.
 * shortcut: a same-size, same-mtime, same-inode edit is not noticed until the
 * file is marked again; tightening that means hashing every read.
 */
export async function readFinalReview(finalPath: string, known?: FinalReviewFileNow | null): Promise<FinalReviewState> {
  const sidecar = finalReviewSidecarPath(finalPath)
  let text: string
  try {
    text = await fsp.readFile(sidecar, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { state: 'not_reviewed' }
    return { state: 'unreadable', error: `Could not read the review mark: ${error?.message || error}` }
  }

  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (error: any) {
    return { state: 'unreadable', error: `The review mark is not valid JSON: ${error?.message || error}` }
  }
  if (parsed?.schema_version !== 1 || !isDecision(parsed?.decision) || typeof parsed?.decided_at !== 'string' || !isIdentity(parsed?.identity)) {
    return { state: 'unreadable', error: 'The review mark is not a version-1 review record.' }
  }

  const now = known === undefined ? await statFinal(finalPath) : known
  if (!now || !sameFileSignature(parsed.identity, now)) {
    return { state: 'stale', decision: parsed.decision, decided_at: parsed.decided_at, recorded: parsed.identity, current: now }
  }
  return { state: 'current', decision: parsed.decision, decided_at: parsed.decided_at, identity: parsed.identity }
}

/**
 * Record a decision about the final exactly as it is now.
 *
 * The whole file is hashed once, here, so the mark names the bytes that were
 * reviewed. `expected` is what the reviewer was actually looking at; when the
 * file on disk no longer matches it (a re-render landed while they watched),
 * the write is refused with `statusCode: 409` — approving bytes nobody saw is
 * exactly the quiet false statement §6 forbids. Throws `409` when the final is
 * gone, too; never writes a mark for a file that is not there.
 */
export async function writeFinalReview(
  finalPath: string,
  decision: FinalReviewDecision,
  expected?: { size: number; mtime_ms: number; ino: number },
): Promise<FinalReviewState> {
  const now = await statFinal(finalPath)
  if (!now) throw Object.assign(new Error('The finished video is not there any more. Refresh and try again.'), { statusCode: 409 })
  // The identity the reviewer was looking at, all of it. Size and modified time
  // catch an in-place rewrite; the INODE catches an atomic replacement that
  // happens to keep the same size and modified time (a `cp -p`/import over the
  // path). Without the inode the mark could be stamped on bytes nobody watched.
  if (expected && (now.size !== expected.size
    || Math.trunc(now.mtime_ms) !== Math.trunc(expected.mtime_ms)
    || now.ino !== expected.ino)) {
    throw Object.assign(new Error('The finished video changed while you were reviewing it. Watch the new one, then mark it.'), { statusCode: 409 })
  }
  const sha256 = await resolveYouTubeSourceRevisionCached(finalPath)
  // The hash reads the whole file over a window that can be seconds long. If the
  // file moved or was rewritten underneath it, the digest would not describe the
  // metadata recorded below — refuse rather than store an identity that never
  // existed together (§6).
  const after = await statFinal(finalPath)
  if (!after || !sameFileSignature(now, after)) {
    throw Object.assign(new Error('The finished video changed while its mark was being saved. Watch it again, then mark it.'), { statusCode: 409 })
  }
  const record = {
    schema_version: 1 as const,
    decision,
    decided_at: new Date().toISOString(),
    identity: { version: 1 as const, ...now, sha256 },
  }
  const sidecar = finalReviewSidecarPath(finalPath)
  await withLock(sidecar, async () => {
    // An auto-pass from a list that started before a clear may land after it;
    // under the same lock the clear holds, so it must refuse rather than
    // re-apply a mark the owner just cleared. approved / needs_changes pass.
    if (decision === 'auto_passed' && await deliberatelyCleared(finalPath, now)) {
      throw Object.assign(new Error('This video was deliberately cleared for these exact bytes; auto-pass will not mark it again.'), { statusCode: 409 })
    }
    await writeJsonAtomic(sidecar, record)
  })
  return { state: 'current', decision: record.decision, decided_at: record.decided_at, identity: record.identity }
}

/**
 * Remove a final review mark. Reverts the final to not_reviewed AND records a
 * clear keyed to these exact bytes, so auto-pass does not instantly re-apply
 * itself on the next list GET — while a re-render (new size/mtime/inode) stays
 * eligible again. The old mark is moved to Story's Trash (recoverable), never
 * hard-deleted; the final's media is never touched.
 *
 * `expected` is the file the caller was looking at, same as `writeFinalReview`:
 * a clear that arrives after the final changed is refused with 409 rather than
 * removing a mark about different bytes. `slug` names the channel the mark
 * belongs to, for the Trash folder.
 */
export async function deleteFinalReview(
  finalPath: string,
  options: { slug: string; expected?: { size: number; mtime_ms: number; ino: number } },
): Promise<FinalReviewState> {
  const now = await statFinal(finalPath)
  if (!now) throw Object.assign(new Error('The finished video is not there any more. Refresh and try again.'), { statusCode: 409 })
  if (options.expected && (now.size !== options.expected.size
    || Math.trunc(now.mtime_ms) !== Math.trunc(options.expected.mtime_ms)
    || now.ino !== options.expected.ino)) {
    throw Object.assign(new Error('The finished video changed while you were reviewing it. Watch the new one, then clear it again.'), { statusCode: 409 })
  }
  const sidecar = finalReviewSidecarPath(finalPath)
  await withLock(sidecar, async () => {
    const after = await statFinal(finalPath)
    if (!after || !sameFileSignature(now, after)) {
      throw Object.assign(new Error('The finished video changed while its mark was being cleared. Refresh and try again.'), { statusCode: 409 })
    }
    const projectDir = pm.getProjectDir(options.slug)
    if (!projectDir) throw Object.assign(new Error('This channel is no longer on this Mac, so its review mark could not be moved to Trash.'), { statusCode: 409 })
    // Move the mark itself to Story's Trash — recoverable, never `unlink`/`rm`.
    // ENOENT (no mark yet) is the idempotent case; anything else fails the
    // clear loudly rather than leaving the old mark standing.
    try {
      // Anchor is the folder the mark lives under: a final on its own drive
      // gets a Trash on that drive, so the rename never crosses volumes.
      moveToTrashSync(
        sidecar,
        path.join(trashRootFor(path.dirname(sidecar), projectDir, options.slug), 'review-marks', path.basename(sidecar)),
        'review-mark',
      )
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    await writeJsonAtomic(finalReviewClearedPath(finalPath), {
      schema_version: 1 as const,
      cleared_at: new Date().toISOString(),
      identity: { version: 1 as const, ...after },
    })
  })
  return { state: 'not_reviewed' }
}

/** The authenticated range-streaming route the page plays (revision query busts a re-render's cache). */
function finalStreamUrl(slug: string, episodeCode: string, now: FinalReviewFileNow): string {
  return `/api/projects/${encodeURIComponent(slug)}/video-editor/final-video/${encodeURIComponent(episodeCode)}`
    + `?v=${Math.trunc(now.mtime_ms)}-${now.size}`
}

/**
 * Every finished video of every channel, newest first.
 *
 * Walks every channel regardless of review setting (owner, 2026-11-01: the
 * Review page must show finals even when review is off — an empty page that
 * says "turn review on" is a dead end when five finals actually exist).
 * A hand-run or imported final is included on the same rule as a pipeline
 * one — the file is the fact, not the run that produced it.
 */
export async function listFinalReviews(options: { slug?: string } = {}): Promise<FinalReviewListResponse> {
  const projects = await pm.listProjects()
  const selected = options.slug ? projects.filter(project => project.slug === options.slug) : projects
  const channels: FinalReviewListResponse['channels'] = []
  const finals: FinalReviewItem[] = []

  await Promise.all(selected.map(async (project) => {
    // A read that THREW is not "review is off": a corrupt or unreadable
    // config must say so rather than read as the owner's own choice (§6).
    let config: ProjectConfig | null = null
    let configError = ''
    try {
      config = await pm.getConfig(project.slug)
    } catch (error: any) {
      configError = `Could not read this channel's review setting: ${error?.message || error}`
    }
    const enabled = finalReviewEnabled(config)
    const autoPassEnabled = finalAutoPassEnabled(config)
    const autoPassAt = reviewBlock(config).auto_pass_enabled_at
    // An unparseable stamp reads NaN and fails the `>=` comparison, so a torn
    // config never auto-passes anything (§6: could-not-read must not pass).
    const autoPassSince = autoPassAt ? new Date(autoPassAt).getTime() : null
    const channel: FinalReviewChannel = {
      slug: project.slug,
      name: project.name,
      review_enabled: enabled,
      auto_pass_enabled: autoPassEnabled,
      final_count: 0,
      auto_pass_count: 0,
    }
    if (configError) channel.error = configError
    channels.push(channel)

    let failed = 0
    let ideas: Awaited<ReturnType<typeof im.getIdeas>>
    try {
      ideas = await im.getIdeas(project.slug, 'accepted')
    } catch (error: any) {
      channel.error = `Could not read this channel's episodes: ${error?.message || error}`
      return
    }

    const rows = await Promise.all(ideas.map(async (idea): Promise<FinalReviewItem | null> => {
      const code = String(idea.episode_code || '').trim()
      if (!code) return null
      try {
        const title = String(idea.title || '').trim() || await resolveEpisodeTitleByCode(project.slug, code)
        const paths = await resolveEpisodePaths(project.slug, code, title)
        const finalPath = await findYouTubeSourceVideoPath(paths, project.slug, code, title)
        if (!finalPath) return null
        const now = await statFinal(finalPath)
        if (!now) return null
        let review = await readFinalReview(finalPath, now)
        let autoPassError = ''
        // Brief H: When auto-pass is enabled for this channel, a final that appears
        // after the switch was turned on is marked auto_passed with its time. Existing
        // finals before that switch was turned on are not back-filled. A deliberate
        // clear covers its exact bytes, so those stay not_reviewed until a re-render.
        if (enabled && autoPassEnabled && autoPassSince !== null && review.state === 'not_reviewed'
          && now.mtime_ms >= autoPassSince
          && !await deliberatelyCleared(finalPath, now)) {
          try {
            review = await writeFinalReview(finalPath, 'auto_passed', {
              size: now.size,
              mtime_ms: now.mtime_ms,
              ino: now.ino,
            })
          } catch (error: any) {
            // A clear landing mid-list is not a failure. Anything else must say
            // so on the item: not_reviewed with no word would read as "auto-pass
            // chose not to", not "the mark could not be saved" (§6).
            if (!await deliberatelyCleared(finalPath, now)) {
              autoPassError = `Could not save the auto-pass mark: ${error?.message || error}`
            }
          }
        }
        return {
          channel_slug: project.slug,
          channel_name: project.name,
          episode_code: code,
          title,
          stream_url: finalStreamUrl(project.slug, code, now),
          size: now.size,
          mtime_ms: now.mtime_ms,
          ino: now.ino,
          review_enabled: enabled,
          review,
          ...(autoPassError ? { auto_pass_error: autoPassError } : {}),
        }
      } catch {
        failed += 1
        return null
      }
    }))

    const validRows = rows.filter((r): r is FinalReviewItem => r !== null)
    for (const row of validRows) finals.push(row)
    channel.final_count = validRows.length
    channel.auto_pass_count = validRows.filter(r => r.review.state === 'current' && r.review.decision === 'auto_passed').length
    if (failed) channel.error = `${failed} episode${failed === 1 ? '' : 's'} could not be read.`
  }))

  finals.sort((a, b) => b.mtime_ms - a.mtime_ms
    || a.channel_slug.localeCompare(b.channel_slug)
    || a.episode_code.localeCompare(b.episode_code))
  channels.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug))
  return { channels, finals, generated_at: new Date().toISOString() }
}
