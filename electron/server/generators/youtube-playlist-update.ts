/**
 * YouTube playlist-update job executor.
 *
 * Pushes an already-uploaded video into a playlist via
 * `playlistItems.insert`. The action is intentionally **add-only / never
 * destructive**: we never call `playlistItems.delete`, so playlists the
 * app didn't track stay intact. A one-unit membership check skips the
 * 50-unit insert when the video is already present, and a second check
 * proves a new insertion before the job may report success.
 *
 * Why a separate job type rather than a flag on `youtube_upload`:
 *   - 50 quota units vs. 1600+ for an upload — different cost class.
 *   - Bulk runs (10+ rows) need their own queue slot so they don't
 *     stall behind a long resumable upload.
 *   - The Jobs page filter / Logs view reads job type, so a distinct
 *     entry makes the action legible in history (was the failure on
 *     the upload or the playlist sync?).
 */

import type { Job } from '../models/types.js'
import * as im from '../services/idea-manager.js'
import {
  checkpointPlaylistSync,
  inspectPlaylistSyncCheckpoint,
  readSidecar,
} from '../services/upload-sidecar.js'
import * as playlistsSvc from '../services/upload-playlists.js'
import { isCancelled } from '../services/job-queue.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { ensureYoutubePlaylistMembership } from '../services/youtube-playlist-sync.js'
import { describeYouTubeCredential, resolveYouTubeAccountId } from '../services/youtube-credential.js'

interface YoutubePlaylistUpdateParams {
  episode_id: string
  account_id?: string
  /**
   * Target playlist id. When absent/null/empty, the project's default
   * playlist is used. The sentinel `_none_` short-circuits with a no-op
   * (a row explicitly opted out of any playlist — bulk callers filter
   * these out before enqueueing, but defend in depth here).
   */
  playlist_id?: string | null
}

export async function generateYoutubePlaylistUpdate(
  job: Job,
  deps: { ensureMembership: typeof ensureYoutubePlaylistMembership } = {
    ensureMembership: ensureYoutubePlaylistMembership,
  },
): Promise<void> {
  const slug = job.project_slug
  const params = (job.params || {}) as YoutubePlaylistUpdateParams
  const episodeId = params.episode_id || job.episode_id
  if (!episodeId) throw new Error('episode_id is required')

  job.output_lines.push(`YouTube playlist update — ${episodeId}`)

  // Resolve account.
  const accountId = await resolveYouTubeAccountId(slug, params.account_id)
  if (!accountId) throw new Error('Reconnect the assigned channel in Settings → YouTube before updating playlists.')
  const account = await describeYouTubeCredential(slug, accountId)
  if (!account) throw new Error('Reconnect the assigned channel in Settings → YouTube before updating playlists.')
  job.output_lines.push(`Using channel: ${account.remote_title} (${account.remote_id})`)

  // The sidecar is the source of truth for video_id. No upload sidecar →
  // we never uploaded this video → there's nothing to add to a playlist.
  // Surface a friendly error rather than a 404 from YouTube.
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '') === episodeId)
  if (!idea) throw new Error(`Accepted idea not found for ${episodeId}`)
  const sidecar = await readSidecar(slug, episodeId, idea.title || '', 'youtube')
  if (!sidecar?.video_id) {
    throw new Error(`No upload found for ${episodeId}. Upload the episode first; playlists can only be applied to videos already on YouTube.`)
  }

  // Resolve effective playlist: explicit override > project default.
  // Explicit `_none_` is treated as a no-op (bulk callers should filter
  // these out, but we'd rather succeed silently than fail loudly).
  let playlistId = (params.playlist_id || '').trim()
  if (playlistId === '_none_') {
    job.output_lines.push('Playlist override is "Don\'t add" — skipping (no-op).')
    requireJobCompletion(job, { label: 'YouTube playlist opt-out', expected: 0, completed: 0 })
    job.progress = 100
    return
  }
  if (!playlistId) {
    playlistId = (await playlistsSvc.getDefaultPlaylist(slug, accountId)) || ''
  }
  if (!playlistId) {
    throw new Error(
      `No target playlist for ${episodeId}. Set a per-row override in the Upload Queue (kebab → Playlist for this upload), or set a project default in the Playlists tab.`,
    )
  }
  job.output_lines.push(`Target playlist: ${playlistId}`)

  // Channel-mismatch guard — same intent as the upload generator.
  // Adding to a playlist that lives on a different channel would 404
  // confusingly, so surface the channel-rebind path explicitly.
  if (sidecar.channel_id && sidecar.channel_id !== account.remote_id) {
    throw new Error(
      `This episode was uploaded to channel "${sidecar.channel_id}" but your project is now connected to channel "${account.remote_id}" (${account.remote_title}). ` +
      `Click ♻ Reset on this row to clear the old upload record before applying playlists.`,
    )
  }

  const membership = await deps.ensureMembership({
    slug,
    accountId,
    playlistId,
    videoId: sidecar.video_id,
    isCancelled: () => isCancelled(job.job_id),
  })
  await checkpointPlaylistSync(slug, episodeId, idea.title || '', {
    playlist_id: playlistId,
    video_id: sidecar.video_id,
    account_id: accountId,
    channel_id: account.remote_id,
  })
  const saved = await readSidecar(slug, episodeId, idea.title || '', 'youtube')
  const checkpointErrors = inspectPlaylistSyncCheckpoint(saved, {
    playlist_id: playlistId,
    video_id: sidecar.video_id,
    account_id: accountId,
  })
  requireJobCompletion(job, {
    label: 'YouTube playlist membership',
    expected: 1,
    completed: checkpointErrors.length ? 0 : 1,
    invalid: checkpointErrors,
    retry_hint: 'Retry verifies remote membership first and will not repeat the 50-unit insert when the video is already present.',
  })
  job.output_lines.push(
    membership.inserted
      ? `Added video ${sidecar.video_id} to playlist ${playlistId} and verified it ✓`
      : `Video ${sidecar.video_id} was already in playlist ${playlistId}; no insert quota was spent ✓`,
  )
  job.progress = 100
}
