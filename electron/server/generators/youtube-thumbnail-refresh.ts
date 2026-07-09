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
import type { Job } from '../models/types.js'
import * as im from '../services/idea-manager.js'
import * as store from '../services/upload-store.js'
import { isCancelled } from '../services/job-queue.js'
import { resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
import { resolveUploadMetadata } from '../lib/upload-metadata.js'
import { setThumbnail } from '../lib/youtube-client.js'
import { readQuota, QUOTA_COST } from '../services/upload-quota.js'
import type { UploadSidecar } from '../services/upload-sidecar.js'
import type { UploadPlatform } from '../services/upload-store.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

export interface RefreshRow {
  episode_code: string
  title: string
  episode_dir: string
  sidecar_path: string
  video_id: string
  account_id: string
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
  opts: { mode: 'missing' | 'all'; accountId: string },
): RefreshRow[] {
  return rows.filter(r =>
    !!r.video_id
    && !r.deleted_at
    && r.account_id === opts.accountId
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
    } catch { return }
    const sidecarFile = path.join(dir, sidecarName)
    if (!existsSync(sidecarFile)) return
    let sc: UploadSidecar
    try { sc = JSON.parse(await fsp.readFile(sidecarFile, 'utf-8')) } catch { return }
    if (!sc?.video_id) return
    rows.push({
      episode_code: code,
      title: idea.title || code,
      episode_dir: dir,
      sidecar_path: sidecarFile,
      video_id: sc.video_id,
      account_id: sc.account_id || '',
      thumbnail_set: !!sc.thumbnail_set,
      deleted_at: sc.deleted_at || null,
    })
  }))
  return rows
}

/** Merge thumbnail_set / last_error into the sidecar in place (by path). */
async function patchSidecarThumbnail(sidecarPath: string, set: boolean, error?: string): Promise<void> {
  let sc: UploadSidecar
  try { sc = JSON.parse(await fsp.readFile(sidecarPath, 'utf-8')) } catch { return }
  sc.thumbnail_set = set
  sc.last_error = error || undefined
  sc.last_sync_at = new Date().toISOString()
  await writeJsonAtomic(sidecarPath, sc)
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
  const accountId = (opts.accountId || '').trim() || await store.getDefaultAccountId(slug, platform)
  const all = await enumerateUploadRows(slug, platform)
  const targets = selectEpisodesNeedingThumbnail(all, { mode: opts.mode, accountId })
  let willFix = 0, noImage = 0
  await Promise.all(targets.map(async (row) => {
    const meta = await resolveUploadMetadata({ slug, episode_code: row.episode_code, fallback_title: row.title, platform }).catch(() => null)
    if (meta?.thumbnailPath && existsSync(meta.thumbnailPath)) willFix++
    else noImage++
  }))
  return { total_uploaded: all.length, will_fix: willFix, no_image: noImage, account_id: accountId, mode: opts.mode }
}

export async function generateThumbnailRefresh(job: Job): Promise<void> {
  const slug = job.project_slug
  const params = (job.params ?? {}) as { account_id?: string; mode?: 'missing' | 'all' }
  const platform: UploadPlatform = 'youtube'
  const mode: 'missing' | 'all' = params.mode === 'all' ? 'all' : 'missing'
  const accountId = (params.account_id || '').trim() || await store.getDefaultAccountId(slug, platform)
  if (!accountId) throw new Error('No active YouTube account for this project — connect one in the Upload Center.')

  const all = await enumerateUploadRows(slug, platform)
  const targets = selectEpisodesNeedingThumbnail(all, { mode, accountId })
  job.output_lines.push(`Thumbnail backfill: ${targets.length} of ${all.length} uploaded episode(s) to process (mode=${mode}).`)

  const cost = QUOTA_COST.thumbnails_set
  let done = 0, failed = 0, noImage = 0, remaining = 0
  let stopped: '' | 'cancelled' | 'quota' = ''

  for (let i = 0; i < targets.length; i++) {
    if (isCancelled(job.job_id)) { stopped = 'cancelled'; remaining = targets.length - i; break }
    const row = targets[i]!
    // Quota pre-check — stop BEFORE the call so we never half-spend.
    const snap = await readQuota(slug).catch(() => null)
    if (snap && snap.used + cost > snap.block_at) { stopped = 'quota'; remaining = targets.length - i; break }
    job.progress = Math.round((i / Math.max(1, targets.length)) * 100)

    const meta = await resolveUploadMetadata({ slug, episode_code: row.episode_code, fallback_title: row.title, platform }).catch(() => null)
    if (!meta?.thumbnailPath || !existsSync(meta.thumbnailPath)) {
      noImage++
      job.output_lines.push(`• ${row.episode_code}: no thumbnail image on disk — make/pin one first.`)
      continue
    }
    try {
      await setThumbnail({ slug, accountId, videoId: row.video_id, filePath: meta.thumbnailPath })
      await patchSidecarThumbnail(row.sidecar_path, true, undefined)
      done++
      job.output_lines.push(`✓ ${row.episode_code}: thumbnail set.`)
    } catch (e: any) {
      const msg = String(e?.message || 'thumbnail failed')
      await patchSidecarThumbnail(row.sidecar_path, false, msg).catch(() => {})
      if (/quota/i.test(msg)) { stopped = 'quota'; remaining = targets.length - (i + 1); break }
      failed++
      job.output_lines.push(`⚠ ${row.episode_code}: ${msg}`)
    }
  }

  job.progress = 100
  const summary = `Backfill complete — set ${done}, failed ${failed}, no-image ${noImage}` +
    (remaining > 0 ? `, ${remaining} remaining (stopped: ${stopped === 'quota' ? 'daily quota reached — re-run tomorrow' : 'cancelled'}).` : '.')
  job.output_lines.push(summary)
}
