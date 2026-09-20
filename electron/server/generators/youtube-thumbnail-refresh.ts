/**
 * YouTube thumbnail backfill (v1.0.524).
 *
 * Retroactively sets thumbnails on ALREADY-UPLOADED videos that are missing
 * one — no re-upload, just a thumbnails.set on the existing video_id. Built to
 * fix the ~225 episodes that lost their thumbnail to the three upload bugs
 * (413 too-large, title-drift silent skip, processing race) before those fixes
 * landed.
 *
 * Robustness:
 *   - Enumerates + reads/writes each sidecar BY CODE (resolveEpisodePathsBy-
 *     CodeWithSidecar), so a drifted `{code} - {oldTitle}` folder is still
 *     found (the readSidecar/writeSidecar title-based path would miss it).
 *   - setThumbnail already downscales (≤2MB) + retries transient errors.
 *   - Quota-aware + resumable: stops gracefully before exceeding the daily
 *     ledger and reports how many remain; a re-run picks up the rest.
 */

import path from 'path'
import { existsSync } from 'fs'
import { promises as fsp } from 'fs'
import { randomUUID } from 'crypto'
import type { Job } from '../models/types.js'
import * as im from '../services/idea-manager.js'
import * as store from '../services/upload-store.js'
import { resolveYouTubeCredential } from '../services/youtube-credential.js'
import { isCancelled } from '../services/job-queue.js'
import { resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
import { resolveUploadMetadata } from '../lib/upload-metadata.js'
import { setThumbnail } from '../lib/youtube-client.js'
import {
  auditThumbnailCheckpointAtPath,
  checkpointThumbnailStateAtPath,
  type UploadSidecar,
} from '../services/upload-sidecar.js'
import type { UploadPlatform } from '../services/upload-store.js'
import { requireJobCompletion } from '../services/job-completion.js'
import {
  assertYouTubeOperationAuthorized,
  readYouTubeOperation,
  updatePinnedYouTubeOperation,
  updateYouTubeOperation,
} from '../services/youtube-operation-store.js'

export interface RefreshRow {
  episode_code: string
  title: string
  episode_dir: string
  sidecar_path: string
  video_id: string
  account_id: string
  channel_id: string
  thumbnail_set: boolean
  deleted_at: string | null
}

/**
 * Pure: which uploaded episodes to (re)set a thumbnail for. Only videos that
 * exist on the ACTIVE account and aren't deleted; `missing` skips ones already
 * set, `all` re-pushes every one.
 */
export function selectEpisodesNeedingThumbnail(
  rows: RefreshRow[],
  opts: { mode: 'missing' | 'all'; channelId: string },
): RefreshRow[] {
  return rows.filter(r =>
    !!r.video_id
    && !r.deleted_at
    && !!opts.channelId
    && r.channel_id === opts.channelId
    && (opts.mode === 'all' ? true : !r.thumbnail_set),
  )
}

/** Enumerate every uploaded episode's sidecar row, resolved by code. */
export async function enumerateUploadRows(slug: string, platform: UploadPlatform = 'youtube'): Promise<RefreshRow[]> {
  const ideas = await im.getIdeas(slug, 'accepted')
  const rows: RefreshRow[] = []
  await Promise.all(ideas.filter(i => i.episode_code).map(async (idea) => {
    const code = idea.episode_code!
    const sidecarName = `${platform}_upload.json`
    let dir = ''
    try {
      const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, sidecarName)
      dir = paths.episode_dir
    } catch {
      throw new Error(`${code}: could not resolve ${sidecarName}.`)
    }
    const sidecarFile = path.join(dir, sidecarName)
    let raw: string
    try {
      raw = await fsp.readFile(sidecarFile, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`${code}: ${sidecarName} is unreadable or inaccessible.`)
    }
    let sc: UploadSidecar
    try { sc = JSON.parse(raw) } catch {
      throw new Error(`${code}: ${sidecarName} is malformed.`)
    }
    if (!sc?.video_id) return
    rows.push({
      episode_code: code,
      title: idea.title || code,
      episode_dir: dir,
      sidecar_path: sidecarFile,
      video_id: sc.video_id,
      account_id: sc.account_id || '',
      channel_id: sc.channel_id || '',
      thumbnail_set: !!sc.thumbnail_set,
      deleted_at: sc.deleted_at || null,
    })
  }))
  return rows
}

export interface RefreshPreview {
  total_uploaded: number
  will_fix: number
  no_image: number
  account_id: string
  mode: 'missing' | 'all'
}

/**
 * Dry-run: count what a run WOULD do without spending any quota. Resolves each
 * target's thumbnail path to split "will fix" (image on disk) from "no image".
 */
export async function previewThumbnailRefresh(
  slug: string,
  opts: { mode: 'missing' | 'all'; accountId?: string; platform?: UploadPlatform },
): Promise<RefreshPreview> {
  const platform = opts.platform || 'youtube'
  const credential = platform === 'youtube' ? await resolveYouTubeCredential(slug) : null
  const requestedAccountId = (opts.accountId || '').trim()
  const accountId = platform === 'youtube'
    ? (!requestedAccountId || requestedAccountId === credential?.accountId ? credential?.accountId ?? '' : '')
    : requestedAccountId || await store.getDefaultAccountId(slug, platform)
  const all = await enumerateUploadRows(slug, platform)
  const targets = selectEpisodesNeedingThumbnail(all, { mode: opts.mode, channelId: credential?.channelId ?? '' })
  let willFix = 0, noImage = 0
  await Promise.all(targets.map(async (row) => {
    const meta = await resolveUploadMetadata({ slug, episode_code: row.episode_code, fallback_title: row.title, platform }).catch(() => null)
    if (meta?.thumbnailPath && existsSync(meta.thumbnailPath)) willFix++
    else noImage++
  }))
  return {
    total_uploaded: all.length,
    will_fix: willFix,
    no_image: noImage,
    account_id: accountId,
    mode: opts.mode,
  }
}

/**
 * Did this episode's thumbnail update actually get recorded durably?
 *
 * Extracted so the completion decision is testable without driving the
 * generator, which uploads to YouTube. It replaces an
 * `{ expected: 1, completed: 1 }` tautology at the call site: the declaration
 * now comes from reading the operation record back rather than from having
 * reached a line of code.
 *
 * Returns false for a missing record, an unreadable store, or a record with no
 * `succeeded` `thumbnail_update` action — so an upload the provider took but
 * Story Studio failed to record cannot be reported complete.
 */
export async function thumbnailUpdateWasRecorded(slug: string, operationId: string): Promise<boolean> {
  try {
    const operation = await readYouTubeOperation(slug, operationId)
    return operation?.actions.some(action =>
      action.action === 'thumbnail_update' && action.state === 'succeeded') === true
  } catch {
    return false
  }
}

export async function generateThumbnailRefresh(job: Job): Promise<void> {
  const slug = job.project_slug
  const params = (job.params ?? {}) as {
    account_id?: string
    mode?: 'missing' | 'all'
    operation_id?: string
    thumbnail_filename?: string
  }
  if (params.operation_id) {
    const record = await assertYouTubeOperationAuthorized(slug, params.operation_id)
    if (!record.video_id) throw new Error('That operation has no accepted YouTube video to update.')
    const uncertain = [...record.actions].reverse()
      .find(action => action.action === 'thumbnail_update')
    if (uncertain?.state === 'started' || uncertain?.state === 'uncertain') {
      throw new Error('The previous thumbnail update may have reached YouTube but was not recorded. Check the video in YouTube Studio before trying again.')
    }
    const credential = await resolveYouTubeCredential(slug)
    if (!credential || credential.channelId !== record.channel_id) {
      throw new Error('Reconnect the assigned channel in Settings → YouTube before updating the thumbnail.')
    }
    const idea = (await im.getIdeas(slug, 'accepted'))
      .find(item => item.episode_code === record.episode_code)
    if (!idea) throw new Error(`Accepted idea not found for ${record.episode_code}.`)
    const meta = await resolveUploadMetadata({
      slug,
      episode_code: record.episode_code,
      fallback_title: idea.title || record.episode_code,
      platform: 'youtube',
      ...(params.thumbnail_filename ? { thumbnail_filename: params.thumbnail_filename } : {}),
    })
    if (!meta.thumbnailPath || !existsSync(meta.thumbnailPath)) {
      throw new Error(`No local thumbnail is available for ${record.episode_code}. Make or pin one first.`)
    }

    const startedAt = new Date().toISOString()
    const started = await updateYouTubeOperation({
      project_slug: slug,
      operation_id: record.operation_id,
      expected_revision: record.revision,
      mutate(current) {
        current.actions.push({
          action_id: `action_${randomUUID()}`,
          action: 'thumbnail_update',
          classification: 'independent_post_accept',
          state: 'started',
          occurred_at: startedAt,
        })
      },
    })
    let remoteAccepted = false
    try {
      await setThumbnail({
        slug,
        accountId: credential.accountId,
        videoId: record.video_id,
        filePath: meta.thumbnailPath,
      })
      remoteAccepted = true
      await updatePinnedYouTubeOperation({
        project_slug: slug,
        operation_id: record.operation_id,
        expected_revision: started.revision,
        expected_channel_id: record.channel_id,
        mutate(current) {
          current.actions.push({
            action_id: `action_${randomUUID()}`,
            action: 'thumbnail_update',
            classification: 'independent_post_accept',
            state: 'succeeded',
            occurred_at: new Date().toISOString(),
          })
        },
      })
    } catch (error) {
      if (remoteAccepted) {
        throw new Error('YouTube accepted the thumbnail, but Story Studio could not record the result. Check YouTube Studio before trying again.')
      }
      await updatePinnedYouTubeOperation({
        project_slug: slug,
        operation_id: record.operation_id,
        expected_revision: started.revision,
        expected_channel_id: record.channel_id,
        mutate(current) {
          current.actions.push({
            action_id: `action_${randomUUID()}`,
            action: 'thumbnail_update',
            classification: 'independent_post_accept',
            state: 'failed',
            occurred_at: new Date().toISOString(),
            error_code: (error as { code?: string }).code ?? 'provider_error',
          })
        },
      }).catch(() => {})
      throw error
    }
    // READ THE EVIDENCE BACK, rather than asserting a constant.
    //
    // This was `{ expected: 1, completed: 1 }` — a tautology that certifies on
    // the strength of reaching the line. The two facts that actually make this
    // job complete ARE established by here (the provider accepted, and the
    // durable `thumbnail_update` action was recorded as `succeeded` — a failed
    // record write throws above), but a constant does not SAY so, and a later
    // edit that moves this call out of that guarantee would silently start
    // certifying an unrecorded upload. AGENTS.md §8: "a generator returning
    // without throwing is not evidence".
    const confirmed = await thumbnailUpdateWasRecorded(slug, record.operation_id)
    requireJobCompletion(job, {
      label: 'YouTube thumbnail update',
      expected: 1,
      completed: confirmed ? 1 : 0,
      missing: confirmed ? [] : ['a recorded succeeded thumbnail update'],
      retry_hint: 'Retry re-reads the recorded result before uploading the thumbnail again.',
    })
    job.output_lines.push(`Updated ${record.episode_code}'s thumbnail on YouTube ✓`)
    job.progress = 100
    return
  }
  const platform: UploadPlatform = 'youtube'
  const mode: 'missing' | 'all' = params.mode === 'all' ? 'all' : 'missing'
  const credential = await resolveYouTubeCredential(slug)
  const requestedAccountId = (params.account_id || '').trim()
  const accountId = !requestedAccountId || requestedAccountId === credential?.accountId ? credential?.accountId ?? '' : ''
  if (!accountId) throw new Error('No active YouTube account for this project — connect one in the Upload Center.')

  const all = await enumerateUploadRows(slug, platform)
  const targets = selectEpisodesNeedingThumbnail(all, { mode, channelId: credential!.channelId })
  const runStartedAt = new Date().toISOString()
  job.output_lines.push(`Thumbnail backfill: ${targets.length} of ${all.length} uploaded episode(s) to process (mode=${mode}).`)

  let done = 0, failed = 0, noImage = 0, remaining = 0
  const unresolved: string[] = []
  let stopped: '' | 'cancelled' | 'quota' = ''

  for (let i = 0; i < targets.length; i++) {
    if (isCancelled(job.job_id)) { stopped = 'cancelled'; remaining = targets.length - i; break }
    const row = targets[i]!
    job.progress = Math.round((i / Math.max(1, targets.length)) * 100)

    const meta = await resolveUploadMetadata({ slug, episode_code: row.episode_code, fallback_title: row.title, platform }).catch(() => null)
    if (!meta?.thumbnailPath || !existsSync(meta.thumbnailPath)) {
      noImage++
      unresolved.push(row.episode_code)
      job.output_lines.push(`• ${row.episode_code}: no thumbnail image on disk — make/pin one first.`)
      continue
    }
    let remoteAccepted = false
    try {
      await setThumbnail({ slug, accountId, videoId: row.video_id, filePath: meta.thumbnailPath })
      remoteAccepted = true
      const saved = await checkpointThumbnailStateAtPath(
        row.sidecar_path,
        { video_id: row.video_id, account_id: accountId, channel_id: credential!.channelId },
        { set: true, remotely_verified: true },
      )
      const checkpointErrors = (await auditThumbnailCheckpointAtPath(row.sidecar_path, {
        video_id: row.video_id,
        account_id: accountId,
        verified_after: runStartedAt,
      })).invalid
      if (checkpointErrors.length || !saved.thumbnail_set) {
        throw new Error(`Thumbnail was accepted remotely but its local checkpoint is incomplete: ${checkpointErrors.join('; ') || 'thumbnail_set is false'}`)
      }
      done++
      job.output_lines.push(`✓ ${row.episode_code}: thumbnail set.`)
    } catch (e: any) {
      const msg = String(e?.message || 'thumbnail failed')
      if (!remoteAccepted) {
        await checkpointThumbnailStateAtPath(
          row.sidecar_path,
          { video_id: row.video_id, account_id: accountId, channel_id: credential!.channelId },
          { set: false, error: msg, remotely_verified: false },
        ).catch(checkpointError => {
          job.output_lines.push(`⚠ ${row.episode_code}: could not save failure checkpoint — ${checkpointError?.message || checkpointError}`)
        })
      } else {
        job.output_lines.push(`⚠ ${row.episode_code}: YouTube accepted the thumbnail, but its local completion checkpoint failed. Retry will verify this row again.`)
      }
      if (/quota/i.test(msg)) {
        unresolved.push(row.episode_code)
        stopped = 'quota'
        remaining = targets.length - (i + 1)
        break
      }
      failed++
      unresolved.push(row.episode_code)
      job.output_lines.push(`⚠ ${row.episode_code}: ${msg}`)
    }
  }

  job.progress = 100
  const summary = `Backfill complete — set ${done}, failed ${failed}, no-image ${noImage}` +
    (remaining > 0 ? `, ${remaining} remaining (stopped: ${stopped === 'quota' ? 'daily quota reached — re-run tomorrow' : 'cancelled'}).` : '.')
  job.output_lines.push(summary)
  if (remaining > 0) {
    const processed = targets.length - remaining
    for (const row of targets.slice(processed)) unresolved.push(row.episode_code)
  }
  // Counters are useful progress feedback, but the saved sidecars are the
  // authoritative completion proof. Re-read every requested row before Done.
  const durable = new Set<string>()
  for (const row of targets) {
    const audit = await auditThumbnailCheckpointAtPath(row.sidecar_path, {
      video_id: row.video_id,
      account_id: accountId,
      verified_after: runStartedAt,
    })
    if (!audit.invalid.length) durable.add(row.episode_code)
  }
  const finalMissing = targets
    .filter(row => !durable.has(row.episode_code))
    .map(row => row.episode_code)
  requireJobCompletion(job, {
    label: 'YouTube thumbnail backfill', expected: targets.length, completed: durable.size,
    missing: [...new Set([...unresolved, ...finalMissing])],
    retry_hint: stopped === 'quota'
      ? 'Daily quota was reached; Retry tomorrow. Completed thumbnails remain set.'
      : 'Completed thumbnails remain set; add missing images or Retry failed uploads.',
  })
}
