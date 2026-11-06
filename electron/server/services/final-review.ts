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
import * as im from './idea-manager.js'
import * as pm from './project-manager.js'
import { resolveEpisodePaths, resolveEpisodeTitleByCode } from './utils.js'
import { findYouTubeSourceVideoPath, resolveYouTubeSourceRevisionCached } from './youtube-source-video.js'

/** Absent or false = off. Only an explicit `true` turns a channel's review on. */
export function finalReviewEnabled(config: ProjectConfig | null | undefined): boolean {
  return config?.final_review?.enabled === true
}

/** The mark lives beside the final it is about, so it travels with the file. */
export function finalReviewSidecarPath(finalPath: string): string {
  return `${finalPath}.review.json`
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
  return value === 'approved' || value === 'needs_changes'
}

function isIdentity(value: any): value is FinalReviewFileIdentity {
  return !!value && value.version === 1
    && typeof value.path === 'string'
    && typeof value.size === 'number'
    && typeof value.mtime_ms === 'number'
    && typeof value.ino === 'number'
    && typeof value.sha256 === 'string'
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
  await withLock(sidecar, () => writeJsonAtomic(sidecar, record))
  return { state: 'current', decision: record.decision, decided_at: record.decided_at, identity: record.identity }
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
    const channel: FinalReviewChannel = {
      slug: project.slug,
      name: project.name,
      review_enabled: enabled,
      final_count: 0,
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
          review: await readFinalReview(finalPath, now),
        }
      } catch {
        failed += 1
        return null
      }
    }))

    for (const row of rows) if (row) finals.push(row)
    channel.final_count = rows.filter(Boolean).length
    if (failed) channel.error = `${failed} episode${failed === 1 ? '' : 's'} could not be read.`
  }))

  finals.sort((a, b) => b.mtime_ms - a.mtime_ms
    || a.channel_slug.localeCompare(b.channel_slug)
    || a.episode_code.localeCompare(b.episode_code))
  channels.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug))
  return { channels, finals, generated_at: new Date().toISOString() }
}
