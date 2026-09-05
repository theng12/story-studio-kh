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
import { resolveEpisodePathsByCodeWithSidecar, resolveEpisodePaths, type ProjectFactsCache } from './utils.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
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
  /** Last thumbnail mutation that was both accepted remotely and durably
   * checkpointed locally. Used by backfill jobs to prove this run completed. */
  thumbnail_sync?: {
    video_id: string
    account_id: string
    verified_at: string
  }
  /** Verified playlist memberships keyed by playlist id. */
  playlist_sync?: Record<string, {
    video_id: string
    account_id: string
    verified_at: string
  }>
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

async function readSidecarAtPath(filePath: string): Promise<UploadSidecar | null> {
  if (!existsSync(filePath)) return null
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data as UploadSidecar : null
  } catch {
    return null
  }
}

async function readSidecarAtPathStrict(filePath: string): Promise<UploadSidecar | null> {
  if (!existsSync(filePath)) return null
  const data = JSON.parse(await fsp.readFile(filePath, 'utf-8'))
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${path.basename(filePath)} is not a sidecar object.`)
  }
  return data as UploadSidecar
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
export async function readSidecarRaw(slug: string, episode_code: string, fallback_title: string, platform: UploadPlatform, cache?: ProjectFactsCache): Promise<UploadSidecar | null> {
  // Drift-tolerant FIRST, exactly as `lib/upload-metadata.ts` does it.
  //
  // `resolveEpisodePaths` derives the folder from the title passed in, so
  // renaming an episode pointed this read at a directory that no longer
  // exists and the sidecar came back null — "never uploaded" for an episode
  // that was live on YouTube. `resolveEpisodePathsByCodeWithSidecar` finds the
  // folder that actually OWNS the sidecar, by code, whatever the title is now.
  // No `.catch()` back to the title-derived path. That fallback was added in
  // the same round that stopped trusting the title, and it hid a real resolver
  // failure behind exactly the read this function exists to replace.
  // The caller's request-scoped facts cache, threaded to the resolver that
  // already accepts one. Without it a sweep re-parsed ideas.json and project.json
  // per episode — the resolver is the expensive part, not the file read.
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episode_code, `${platform}_upload.json`, cache)
  const p = sidecarPath(paths.episode_dir, platform)
  return readSidecarAtPath(p)
}

/**
 * The sidecar, or a THROWN error — never a silent null for a file that exists.
 *
 * `readSidecarAtPath` returns null on any read or parse failure, which is the
 * right answer for the eleven callers asking "what is planned / what is the
 * state?". It is the wrong answer for the ONE caller asking "is this episode
 * already on YouTube?", where null means "go ahead and upload": a truncated,
 * unreadable or non-object sidecar would produce a second public video of an
 * episode that is already published, and YouTube has no replace.
 *
 * So this read distinguishes absent (null, uploadable) from unreadable
 * (throws, refuse loudly). Used ONLY by `remoteVideoFor` — deliberately not
 * offered to the tolerant callers, whose behaviour is unchanged.
 */
export async function readSidecarStrict(slug: string, episode_code: string, platform: UploadPlatform, cache?: ProjectFactsCache): Promise<UploadSidecar | null> {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episode_code, `${platform}_upload.json`, cache)
  const p = sidecarPath(paths.episode_dir, platform)
  return readSidecarAtPathStrict(p)
}

export async function writeSidecar(slug: string, episode_code: string, fallback_title: string, sidecar: UploadSidecar): Promise<void> {
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title || '')
  // Ensure the episode dir exists — shouldn't fail, but writing to a missing
  // parent directory would otherwise throw before the atomic write's temp
  // file is even created.
  await fsp.mkdir(paths.episode_dir, { recursive: true })
  const p = sidecarPath(paths.episode_dir, sidecar.platform)
  await withLock(p, () => writeJsonAtomic(p, sidecar))
}

export function inspectUploadSidecarIdentity(
  sidecar: UploadSidecar | null,
  expected: { platform: UploadPlatform; video_id: string; account_id: string; channel_id: string },
): string[] {
  if (!sidecar) return ['upload sidecar is missing or unreadable']
  const invalid: string[] = []
  if (sidecar.platform !== expected.platform) invalid.push(`platform is ${sidecar.platform || 'empty'}`)
  if (sidecar.video_id !== expected.video_id) invalid.push(`video_id is ${sidecar.video_id || 'empty'}`)
  if (sidecar.account_id !== expected.account_id) invalid.push(`account_id is ${sidecar.account_id || 'empty'}`)
  if (sidecar.channel_id !== expected.channel_id) invalid.push(`channel_id is ${sidecar.channel_id || 'empty'}`)
  if (!sidecar.uploaded_at?.trim()) invalid.push('uploaded_at is empty')
  if (!sidecar.last_sync_at?.trim()) invalid.push('last_sync_at is empty')
  return invalid
}

export async function checkpointUploadSidecarIdentity(
  slug: string,
  episode_code: string,
  fallback_title: string,
  sidecar: UploadSidecar,
): Promise<{ saved: UploadSidecar | null; invalid: string[] }> {
  await writeSidecar(slug, episode_code, fallback_title, sidecar)
  const saved = await readSidecar(slug, episode_code, fallback_title, sidecar.platform)
  return {
    saved,
    invalid: inspectUploadSidecarIdentity(saved, {
      platform: sidecar.platform,
      video_id: sidecar.video_id,
      account_id: sidecar.account_id,
      channel_id: sidecar.channel_id,
    }),
  }
}

/** Record a remotely verified playlist membership without overwriting newer
 * upload metadata or schedule changes written by another operation. */
export async function checkpointPlaylistSync(
  slug: string,
  episode_code: string,
  fallback_title: string,
  expected: { playlist_id: string; video_id: string; account_id: string; channel_id?: string },
): Promise<UploadSidecar> {
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title || '')
  const p = sidecarPath(paths.episode_dir, 'youtube')
  return withLock(p, async () => {
    const current = await readSidecarAtPath(p)
    if (!current?.video_id) throw new Error('Cannot checkpoint playlist membership without a valid YouTube upload sidecar.')
    if (current.video_id !== expected.video_id) {
      throw new Error(`Upload record changed from ${expected.video_id} to ${current.video_id}; playlist checkpoint was not written.`)
    }
    if (expected.channel_id && current.channel_id !== expected.channel_id) {
      throw new Error(`Upload channel changed from ${expected.channel_id} to ${current.channel_id}; playlist checkpoint was not written.`)
    }
    if (!expected.channel_id && current.account_id !== expected.account_id) {
      throw new Error(`Upload account changed from ${expected.account_id} to ${current.account_id}; playlist checkpoint was not written.`)
    }
    const next: UploadSidecar = {
      ...current,
      // A verified remote action on the same immutable channel is the safe
      // point to replace a pre-registry local account id with current identity.
      ...(expected.channel_id ? { account_id: expected.account_id } : {}),
      playlist_sync: {
        ...(current.playlist_sync || {}),
        [expected.playlist_id]: {
          video_id: expected.video_id,
          account_id: expected.account_id,
          verified_at: new Date().toISOString(),
        },
      },
    }
    await writeJsonAtomic(p, next)
    return next
  })
}

export function inspectThumbnailCheckpoint(
  sidecar: UploadSidecar | null,
  expected: { video_id: string; account_id: string; verified_after?: string },
): string[] {
  if (!sidecar) return ['upload sidecar is missing or unreadable']
  const invalid: string[] = []
  if (!sidecar.thumbnail_set) invalid.push('thumbnail_set is false')
  const record = sidecar.thumbnail_sync
  if (!record) return [...invalid, 'thumbnail has no verified checkpoint']
  if (record.video_id !== expected.video_id) invalid.push(`thumbnail checkpoint video_id is ${record.video_id || 'empty'}`)
  if (record.account_id !== expected.account_id) invalid.push(`thumbnail checkpoint account_id is ${record.account_id || 'empty'}`)
  if (!record.verified_at?.trim()) invalid.push('thumbnail checkpoint verified_at is empty')
  if (expected.verified_after && record.verified_at < expected.verified_after) {
    invalid.push(`thumbnail checkpoint predates this run (${record.verified_at})`)
  }
  return invalid
}

/**
 * Merge thumbnail state into an existing upload record by exact path. The
 * operation retries local persistence only; it never repeats the provider
 * request. This prevents a successful thumbnails.set call from being lost or
 * from overwriting a concurrent schedule/playlist update.
 */
export async function checkpointThumbnailStateAtPath(
  filePath: string,
  expected: { video_id: string; account_id: string; channel_id?: string },
  state: { set: boolean; error?: string; remotely_verified: boolean },
): Promise<UploadSidecar> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await withLock(filePath, async () => {
        const current = await readSidecarAtPath(filePath)
        if (!current?.video_id) throw new Error('Cannot checkpoint thumbnail state without a valid upload sidecar.')
        if (current.video_id !== expected.video_id) {
          throw new Error(`Upload record changed from ${expected.video_id} to ${current.video_id}; thumbnail checkpoint was not written.`)
        }
        if (expected.channel_id && current.channel_id !== expected.channel_id) {
          throw new Error(`Upload channel changed from ${expected.channel_id} to ${current.channel_id}; thumbnail checkpoint was not written.`)
        }
        if (!expected.channel_id && current.account_id !== expected.account_id) {
          throw new Error(`Upload account changed from ${expected.account_id} to ${current.account_id}; thumbnail checkpoint was not written.`)
        }
        const next: UploadSidecar = {
          ...current,
          ...(expected.channel_id && state.remotely_verified ? { account_id: expected.account_id } : {}),
          thumbnail_set: state.set,
          last_error: state.error || undefined,
          last_sync_at: new Date().toISOString(),
          thumbnail_sync: state.remotely_verified && state.set
            ? {
                video_id: expected.video_id,
                account_id: expected.account_id,
                verified_at: new Date().toISOString(),
              }
            : current.thumbnail_sync,
        }
        await writeJsonAtomic(filePath, next)
        const saved = await readSidecarAtPath(filePath)
        if (!saved) throw new Error('Thumbnail checkpoint was unreadable after save.')
        return saved
      })
    } catch (error) {
      lastError = error
      const detail = error instanceof Error ? error.message : String(error)
      if (/Upload record changed|Upload account changed|Upload channel changed|without a valid upload sidecar/i.test(detail)) throw error
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 150 * attempt))
    }
  }
  throw new Error(`Could not save thumbnail checkpoint after 5 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export async function auditThumbnailCheckpointAtPath(
  filePath: string,
  expected: { video_id: string; account_id: string; verified_after?: string },
): Promise<{ sidecar: UploadSidecar | null; invalid: string[] }> {
  const sidecar = await readSidecarAtPath(filePath)
  return { sidecar, invalid: inspectThumbnailCheckpoint(sidecar, expected) }
}

export function inspectPlaylistSyncCheckpoint(
  sidecar: UploadSidecar | null,
  expected: { playlist_id: string; video_id: string; account_id: string },
): string[] {
  const record = sidecar?.playlist_sync?.[expected.playlist_id]
  if (!record) return [`playlist ${expected.playlist_id} has no verified checkpoint`]
  const invalid: string[] = []
  if (record.video_id !== expected.video_id) invalid.push(`playlist checkpoint video_id is ${record.video_id || 'empty'}`)
  if (record.account_id !== expected.account_id) invalid.push(`playlist checkpoint account_id is ${record.account_id || 'empty'}`)
  if (!record.verified_at?.trim()) invalid.push('playlist checkpoint verified_at is empty')
  return invalid
}

export async function deleteSidecar(slug: string, episode_code: string, fallback_title: string, platform: UploadPlatform): Promise<void> {
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title || '')
  const p = sidecarPath(paths.episode_dir, platform)
  await withLock(p, async () => {
    if (existsSync(p)) await fsp.rm(p, { force: true })
  })
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
  const paths = await resolveEpisodePaths(slug, episode_code, fallback_title || '')
  await fsp.mkdir(paths.episode_dir, { recursive: true })
  const p = sidecarPath(paths.episode_dir, platform)
  await withLock(p, async () => {
    const existing = await readSidecarAtPathStrict(p)
    if (!existing) {
      if (!scheduled_for) return
      await writeJsonAtomic(p, makePlanningStubSidecar(platform, scheduled_for))
      return
    }
    // No-op when the field is already in the desired state — saves a write
    // and keeps the migration's "second run is free" property honest.
    if (existing.scheduled_for === scheduled_for) return
    if (!scheduled_for && !existing.video_id) {
      // Planning stub being cleared — nothing else to keep, drop the file.
      await fsp.rm(p, { force: true })
      return
    }
    await writeJsonAtomic(p, { ...existing, scheduled_for })
  })
}
