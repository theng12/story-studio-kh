/**
 * Upload one episode's finished Shorts to YouTube, each as its own video.
 *
 * WHY A SEPARATE STEP, AND NOT A SECOND DOOR TO YOUTUBE
 *
 * A Short is not the episode. It is a separate video with its own title, its
 * own file and its own publish date. So it cannot be uploaded by the
 * episode's upload path, which resolves the episode's FINAL VIDEO.
 *
 * But it must not become a second admission path either. The guards that keep
 * a channel safe — the assigned channel, the credential, the quota ceiling,
 * the "already on YouTube" check, the metadata gate, the final-check hold —
 * all live in ONE place (`routes/youtube-upload-center.ts`), and a Short that
 * skipped them would be the exact defect AGENTS.md §8 warns about.
 *
 * So the admission path takes ONE extra input: the FILE to upload. Every
 * guard still runs. The only thing that changes is which file is sent.
 *
 * WHAT THIS NEVER DOES
 *
 *   - it never asks for `public`. Every Short is uploaded PRIVATE, and the
 *     only way a Short becomes public is YouTube flipping it on the
 *     `publishAt` date the owner chose. There is no visibility change after
 *     the upload, anywhere in this file.
 *   - a `publishAt` in the past is REFUSED, never sent: YouTube publishes a
 *     past-dated upload immediately, which would make it public the moment it
 *     landed.
 *   - an upload failure never fails the Shorts and never fails the episode.
 *     It is a loud line in the job log, and the Shorts on disk are untouched.
 */

import path from 'node:path'

import * as pm from './project-manager.js'
import * as plans from './upload-plans.js'
import { resolveEpisodePathsByCode } from './utils.js'
import {
  planShortsUpload,
  readShortsMoments,
  readShortsUploadState,
  shortsAutoUploadMode,
  shortsUploadSpacingDays,
  writeShortUploadRecord,
  type ShortsAutoUploadMode,
} from './shorts-upload.js'

export { shortsAutoUploadMode, shortsUploadSpacingDays }

/** The Shorts folder of one episode. */
export async function shortsDirFor(slug: string, code: string): Promise<string> {
  const paths = await resolveEpisodePathsByCode(slug, code.toUpperCase())
  return path.join(paths.episode_dir, 'shorts')
}

export interface ShortsUploadOptions {
  /** Overrides the channel's stored mode. Used by the manual API route. */
  mode?: ShortsAutoUploadMode
  /** Overrides the channel's stored spacing. */
  spacing_days?: number
  /** Now, for the "publishAt must be in the future" test. */
  now?: number
}

export interface ShortsUploadOutcome {
  file: string
  title: string
  uploaded: boolean
  video_id?: string
  publish_at?: string
  error?: string
}

export interface ShortsUploadReport {
  mode: ShortsAutoUploadMode
  spacing_days: number
  /** One line per decision, for the job log and the API answer. */
  lines: string[]
  outcomes: ShortsUploadOutcome[]
  uploaded: number
  /** True when a Short would not go up. The Shorts and the episode are unaffected. */
  upload_failed: boolean
  reason?: string
}

/**
 * Upload an episode's Shorts, if the channel asked for it.
 *
 * Returns a report rather than throwing for an upload failure: the Shorts are
 * on disk and verified, and that is the job's success. The upload is an extra
 * step whose failure must be loud without taking the episode down with it.
 */
export async function uploadShortsForEpisode(
  slug: string,
  code: string,
  options: ShortsUploadOptions = {},
): Promise<ShortsUploadReport> {
  const upperCode = code.toUpperCase()
  const config = await pm.getConfig(slug) as any
  const mode = options.mode ?? shortsAutoUploadMode(config)
  const spacing = options.spacing_days ?? shortsUploadSpacingDays(config)
  const lines: string[] = []
  const empty: ShortsUploadReport = { mode, spacing_days: spacing, lines, outcomes: [], uploaded: 0, upload_failed: false }

  if (mode === 'off') {
    empty.reason = 'Automatic Shorts upload is off for this channel.'
    return empty
  }

  const shortsDir = await shortsDirFor(slug, upperCode)
  const moments = await readShortsMoments(shortsDir)
  if (!moments.length) {
    empty.reason = `${upperCode} has no Shorts to upload.`
    return empty
  }

  // The parent episode's publish date, read live. In 'scheduled' mode there
  // is no date without it, and a date in the past is refused.
  const parentSchedule = await plans.readItemSchedule(slug)
  const plan = await planShortsUpload({
    code: upperCode,
    shortsDir,
    moments,
    mode,
    spacing_days: spacing,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(parentSchedule[upperCode] ? { parent_publish_at: parentSchedule[upperCode] } : {}),
  })
  for (const skipped of plan.skipped) {
    lines.push(`Short ${skipped.file}: ${skipped.reason}; it was not uploaded.`)
  }
  if (!plan.entries.length) {
    empty.reason = plan.reason || 'There was nothing to upload.'
    lines.push(empty.reason)
    return empty
  }

  const { admitYouTubeUpload } = await import('../routes/youtube-upload-center.js')
  const outcomes: ShortsUploadOutcome[] = []
  let uploaded = 0
  for (const entry of plan.entries) {
    const title = entry.title
    // Recorded as queued BEFORE the upload is admitted, so a crash mid-upload
    // leaves a record saying a Short was being sent rather than nothing.
    await writeShortUploadRecord(shortsDir, entry.file, {
      file: entry.file, title, state: 'queued',
      ...(entry.publish_at ? { publish_at: entry.publish_at } : {}),
    }).catch(() => {})
    let admission: { status: number; json: any }
    try {
      admission = await admitYouTubeUpload(slug, {
        episode_code: upperCode,
        // ALWAYS private. Never public, never unlisted — a Short goes up
        // private and YouTube publishes it on its own date if the owner
        // asked for one.
        privacy_status: 'private',
        ...(entry.publish_at ? { publish_at: entry.publish_at } : {}),
        short_source: { id: entry.id, file: entry.file, title },
      }, { automatic: true })
    } catch (error: any) {
      const message = `Short ${entry.index + 1} (${title}) was not uploaded: ${error?.message || error}`
      lines.push(message)
      outcomes.push({ file: entry.file, title, uploaded: false, error: message })
      await writeShortUploadRecord(shortsDir, entry.file, {
        file: entry.file, title, state: 'failed', error: message,
      }).catch(() => {})
      continue
    }
    if (admission.status >= 300) {
      const detail = admission.json?.detail || `Upload admission failed (${admission.status}).`
      const message = `Short ${entry.index + 1} (${title}) was not uploaded: ${detail}`
      lines.push(message)
      outcomes.push({ file: entry.file, title, uploaded: false, error: message })
      await writeShortUploadRecord(shortsDir, entry.file, {
        file: entry.file, title, state: 'failed', error: message,
      }).catch(() => {})
      continue
    }
    uploaded += 1
    const message = `Short ${entry.index + 1} (${title}) admitted to upload as private`
      + `${entry.publish_at ? `, to be made public on ${entry.publish_at}` : ''}.`
    lines.push(message)
    outcomes.push({
      file: entry.file, title, uploaded: true,
      ...(admission.json?.video_id ? { video_id: admission.json.video_id } : {}),
      ...(entry.publish_at ? { publish_at: entry.publish_at } : {}),
    })
    // The state stays QUEUED here. Admission queues the upload; the upload
    // itself runs in the queue's own job, and it is that job that knows
    // whether YouTube took the file. Writing `uploaded` at admission would
    // record a Short as gone up while its upload was still running — or had
    // failed — and a retry would then skip it (the Shorts job does the
    // upload; see `uploadShortsAfterVerification`).
    await writeShortUploadRecord(shortsDir, entry.file, {
      file: entry.file, title, state: 'queued',
      ...(entry.publish_at ? { publish_at: entry.publish_at } : {}),
    }).catch(() => {})
  }

  return {
    mode,
    spacing_days: spacing,
    lines,
    outcomes,
    uploaded,
    // A Short that would not go up is a loud failure, but it is not a failed
    // Shorts job and not a failed episode.
    upload_failed: outcomes.some(outcome => !outcome.uploaded),
  }
}

/**
 * The state of an episode's Short uploads, for the API and the UI.
 */
export async function readShortsUploadStatus(slug: string, code: string): Promise<{
  shorts: Record<string, unknown>
  total: number
  uploaded: number
}> {
  const shortsDir = await shortsDirFor(slug, code.toUpperCase())
  const state = await readShortsUploadState(shortsDir)
  const files = Object.keys(state.shorts)
  return {
    shorts: state.shorts,
    total: files.length,
    uploaded: files.filter(file => state.shorts[file]?.state === 'uploaded').length,
  }
}
