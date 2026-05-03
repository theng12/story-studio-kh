/**
 * Per-episode upload sidecars.
 *
 * Written after a successful upload so subsequent actions (metadata
 * update, schedule change, Reconcile link) can look up the remote
 * `video_id` without round-tripping the YouTube API. Also serves as
 * the "already uploaded" signal for the Queue view.
 *
 * One file per episode per platform:
 *   {episode_dir}/{platform}_upload.json
 *
 * For Phase 2 only YouTube is live; the shape is identical for TikTok /
 * Facebook so the same code path will work when those land.
 */

import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { resolveEpisodePaths } from './utils.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import type { UploadPlatform } from './upload-store.js'

export interface UploadSidecar {
  platform: UploadPlatform
  video_id: string
  /** Our local account id (see upload-store). */
  account_id: string
  /** Platform's channel/page id at the time of upload (for Reconcile anchoring). */
  channel_id: string
  uploaded_at: string
  last_sync_at: string
  /** ISO 8601 publishAt. `null` = already public, i.e. no scheduled transition. */
  scheduled_for: string | null
  privacy_status: 'private' | 'unlisted' | 'public'
  title: string
  description: string
  tags: string[]
  thumbnail_set: boolean
  /** Optional: free-form error note from the last sync, e.g. "thumbnail_failed_verification". */
  last_error?: string
  /**
   * Tombstone — set when the upstream video is no longer accessible
   * (takedown, manual deletion in YouTube Studio, or the user explicitly
   * marking it via the row action). Either ISO 8601 timestamp of the
   * deletion / sync that detected it, or null when the link is healthy.
   *
   * Why a tombstone instead of just deleting the sidecar:
   * - Keeps the historical link (prior video_id, account_id, channel_id)
   *   so reconciliation can still attribute past work.
   * - Lets bulk actions skip these rows by default (Upload won't pick
   *   them up — we don't want to re-upload after a takedown).
   * - User can still reset via "Forget link" if they decide they DO
   *   want a fresh upload of the same episode.
   */
  deleted_at?: string | null
  /**
   * Why this sidecar was tombstoned. Two values today:
   *   `'sync_404'`  — sync-from-youtube saw the video_id missing in the
   *                   videos.list response.
   *   `'manual'`    — user clicked "Mark as deleted upstream" on the row.
   * Free-form so future detection paths can stamp their own reason.
   */
  deleted_reason?: string
}

function sidecarPath(episodeDir: string, platform: UploadPlatform): string {
  return path.join(episodeDir, `${platform}_upload.json`)
}

export async function readSidecar(slug: string, episode_code: string, fallback_title: string, platform: UploadPlatform): Promise<UploadSidecar | null> {
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title || '')
  const p = sidecarPath(paths.episode_dir, platform)
  if (!existsSync(p)) return null
  try {
    const raw = await fsp.readFile(p, 'utf-8')
    const data = JSON.parse(raw)
    if (!data?.video_id) return null
    return data as UploadSidecar
  } catch {
    return null
  }
}

export async function writeSidecar(slug: string, episode_code: string, fallback_title: string, sidecar: UploadSidecar): Promise<void> {
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title || '')
  // Ensure the episode dir exists — shouldn't fail, but writing to a missing
  // parent directory would otherwise throw before the atomic write's temp
  // file is even created.
  await fsp.mkdir(paths.episode_dir, { recursive: true })
  await writeJsonAtomic(sidecarPath(paths.episode_dir, sidecar.platform), sidecar)
}

export async function deleteSidecar(slug: string, episode_code: string, fallback_title: string, platform: UploadPlatform): Promise<void> {
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title || '')
  const p = sidecarPath(paths.episode_dir, platform)
  if (existsSync(p)) await fsp.rm(p, { force: true })
}
