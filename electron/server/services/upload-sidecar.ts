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

/**
 * Why a sidecar's upstream link was tombstoned. Closed enum so new
 * detection paths have to declare themselves explicitly instead of
 * stamping arbitrary strings (which was the v1.0.34 reality and made
 * future analytics on takedown trends impossible). Values:
 *
 *   - `sync_404`  — sync-from-youtube saw the video_id missing in the
 *                   videos.list response (auto-detected takedown,
 *                   manual delete in YouTube Studio, or a privacy flip
 *                   to a tier our token can't see).
 *   - `manual`    — user explicitly clicked "Mark as deleted upstream"
 *                   on the row.
 *   - `takedown`  — RESERVED for a future hook when YouTube returns a
 *                   takedown reason via the API. No write-site uses
 *                   this today; the value exists so we don't have to
 *                   refactor the type when that ships.
 *   - `duplicate` — RESERVED for cross-project dedup detection (same
 *                   final video uploaded from two projects). Same
 *                   "future-proofed but unused" status as `takedown`.
 *
 * Read-side widening: existing on-disk sidecars from v1.0.34/35/36 may
 * carry arbitrary strings here. The typed union is enforced on writes
 * only; reads accept any string and the UI surfaces unknown values
 * as-is. After a release or two, all live sidecars will conform.
 */
export type DeletedReason = 'sync_404' | 'manual' | 'takedown' | 'duplicate'

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
   * Why this sidecar was tombstoned. See `DeletedReason` for the
   * canonical write-time values. Typed as `string` here (not the union)
   * so reads of older v1.0.34/35/36 sidecars carrying arbitrary strings
   * don't fail validation. New writes should always use a `DeletedReason`
   * value — see `markSidecarDeleted` callers.
   */
  deleted_reason?: DeletedReason | string
}

function sidecarPath(episodeDir: string, platform: UploadPlatform): string {
  return path.join(episodeDir, `${platform}_upload.json`)
}

/**
 * Returns the parsed sidecar only when the episode is actually uploaded
 * (i.e. carries a non-empty `video_id`). The video_id gate is what makes
 * sidecar existence the canonical "is this row uploaded?" check throughout
 * the codebase — see `inQueue = hasFinal || !!sidecar?.video_id` in
 * buildQueueIndex.
 *
 * Item I-eager added a second sidecar shape: planning-only stubs with
 * `video_id === ''` that carry a `scheduled_for` so the per-item schedule
 * map can be retired. Those stubs are filtered out here so callers that
 * use `readSidecar` to mean "uploaded?" keep working unchanged. To read
 * planning stubs (or any sidecar regardless of upload state), use
 * `readSidecarRaw`.
 */
export async function readSidecar(slug: string, episode_code: string, fallback_title: string, platform: UploadPlatform): Promise<UploadSidecar | null> {
  const data = await readSidecarRaw(slug, episode_code, fallback_title, platform)
  if (!data?.video_id) return null
  return data
}

/**
 * Returns the parsed sidecar regardless of upload state — including
 * planning stubs whose only meaningful field is `scheduled_for`. Use
 * this when the question is "what's the planned schedule / privacy /
 * etc. for this episode?" rather than "is this episode uploaded?".
 */
export async function readSidecarRaw(slug: string, episode_code: string, fallback_title: string, platform: UploadPlatform): Promise<UploadSidecar | null> {
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title || '')
  const p = sidecarPath(paths.episode_dir, platform)
  if (!existsSync(p)) return null
  try {
    const raw = await fsp.readFile(p, 'utf-8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
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

/**
 * Item I-eager: planning-only sidecar stub used when an episode has a
 * `scheduled_for` written through plans / per-row edit BEFORE its
 * upload has run. All upload-related fields are empty so reads through
 * `readSidecar` (the video_id-gated variant) keep returning null —
 * which is exactly what every "uploaded?" check needs to see for an
 * episode that isn't uploaded yet.
 *
 * After the actual upload runs, `writeSidecar` overwrites this stub
 * with the real (`video_id`-bearing) sidecar — the planning state
 * was just a transient placeholder for `scheduled_for`.
 */
function makePlanningStubSidecar(platform: UploadPlatform, scheduled_for: string | null): UploadSidecar {
  return {
    platform,
    video_id: '',
    account_id: '',
    channel_id: '',
    uploaded_at: '',
    last_sync_at: '',
    scheduled_for,
    privacy_status: 'private',
    title: '',
    description: '',
    tags: [],
    thumbnail_set: false,
  }
}

/**
 * Set / clear the `scheduled_for` field on an episode's sidecar.
 * Replaces the per-config `upload_item_schedule` map (item I-eager).
 *
 * Behaviour matrix:
 *   - sidecar exists, iso truthy        → update scheduled_for, write back
 *   - sidecar exists, iso null          → set scheduled_for=null. If the
 *                                          sidecar is a planning stub
 *                                          (no video_id) AND has nothing
 *                                          else load-bearing, delete the
 *                                          file entirely so the disk
 *                                          stays clean.
 *   - sidecar absent, iso truthy        → write a planning stub
 *   - sidecar absent, iso null          → no-op (already clear)
 *
 * Idempotent — repeat calls with the same input produce the same final
 * state without churning the file.
 */
export async function setScheduledFor(
  slug: string,
  episode_code: string,
  fallback_title: string,
  platform: UploadPlatform,
  scheduled_for: string | null,
): Promise<void> {
  const existing = await readSidecarRaw(slug, episode_code, fallback_title, platform)
  if (!existing) {
    if (!scheduled_for) return
    await writeSidecar(slug, episode_code, fallback_title, makePlanningStubSidecar(platform, scheduled_for))
    return
  }
  // No-op when the field is already in the desired state — saves a write
  // and keeps the migration's "second run is free" property honest.
  if (existing.scheduled_for === scheduled_for) return
  if (!scheduled_for && !existing.video_id) {
    // Planning stub being cleared — nothing else to keep, drop the file.
    await deleteSidecar(slug, episode_code, fallback_title, platform)
    return
  }
  const next: UploadSidecar = { ...existing, scheduled_for }
  await writeSidecar(slug, episode_code, fallback_title, next)
}
