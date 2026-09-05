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
import { remoteVideoFor } from '../services/youtube-remote-video.js'
import {
  listYouTubeOperations,
  updatePinnedYouTubeOperation,
  updateYouTubeOperation,
} from '../services/youtube-operation-store.js'

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

  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '') === episodeId)
  if (!idea) throw new Error(`Accepted idea not found for ${episodeId}`)
  const operations = await listYouTubeOperations(slug)
  const remote = await remoteVideoFor(slug, episodeId, idea.title || '', account.remote_id, operations)
  if (!remote?.video_id) {
    throw new Error(`No upload found for ${episodeId}. Upload the episode first; playlists can only be applied to videos already on YouTube.`)
  }
  const operation = remote.source === 'operation_record'
    ? operations.find(record => record.episode_code === episodeId
      && record.channel_id === account.remote_id
      && record.video_id === remote.video_id)
    : undefined

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

  if (remote.channel_id && remote.channel_id !== account.remote_id) {
    throw new Error(
      `This episode was uploaded to channel "${remote.channel_id}" but the project is connected to channel "${account.remote_id}" (${account.remote_title}). Reassign the original channel before applying playlists.`,
    )
  }

  let pendingRevision: number | undefined
  if (operation) {
    const pending = await updateYouTubeOperation({
      project_slug: slug,
      operation_id: operation.operation_id,
      expected_revision: operation.revision,
      mutate(current) {
        current.playlists[playlistId] = {
          operation_id: operation.operation_id,
          state: 'pending',
          updated_at: new Date().toISOString(),
        }
      },
    })
    pendingRevision = pending.revision
  }

  let membership
  try {
    membership = await deps.ensureMembership({
      slug,
      accountId,
      playlistId,
      videoId: remote.video_id,
      isCancelled: () => isCancelled(job.job_id),
    })
  } catch (error) {
    if (operation && pendingRevision !== undefined) {
      await updatePinnedYouTubeOperation({
        project_slug: slug,
        operation_id: operation.operation_id,
        expected_revision: pendingRevision,
        expected_channel_id: operation.channel_id,
        mutate(current) {
          current.playlists[playlistId] = {
            operation_id: operation.operation_id,
            state: 'failed',
            updated_at: new Date().toISOString(),
            error_code: (error as { code?: string }).code ?? 'provider_error',
          }
        },
      }).catch(() => {})
    }
    throw error
  }

  let checkpointErrors: string[] = []
  if (operation && pendingRevision !== undefined) {
    const recorded = await updatePinnedYouTubeOperation({
      project_slug: slug,
      operation_id: operation.operation_id,
      expected_revision: pendingRevision,
      expected_channel_id: operation.channel_id,
      mutate(current) {
        current.playlists[playlistId] = {
          operation_id: operation.operation_id,
          state: 'present',
          updated_at: new Date().toISOString(),
        }
      },
    }).then(() => true).catch(() => false)
    if (!recorded) {
      throw new Error('YouTube confirmed the playlist membership, but Story Studio could not record it. Retry only after checking the video in YouTube Studio; the retry verifies membership before inserting.')
    }
  } else if (remote.source === 'legacy_sidecar') {
    // Historical uploads keep their historical receipt authority. New
    // operation-backed videos never write this compatibility sidecar.
    await checkpointPlaylistSync(slug, episodeId, idea.title || '', {
      playlist_id: playlistId,
      video_id: remote.video_id,
      account_id: accountId,
      channel_id: account.remote_id,
    })
    const saved = await readSidecar(slug, episodeId, idea.title || '', 'youtube')
    checkpointErrors = inspectPlaylistSyncCheckpoint(saved, {
      playlist_id: playlistId,
      video_id: remote.video_id,
      account_id: accountId,
    })
  }
  requireJobCompletion(job, {
    label: 'YouTube playlist membership',
    expected: 1,
    completed: checkpointErrors.length ? 0 : 1,
    invalid: checkpointErrors,
    retry_hint: 'Retry verifies remote membership first and will not repeat the 50-unit insert when the video is already present.',
  })
  job.output_lines.push(
    membership.inserted
      ? `Added video ${remote.video_id} to playlist ${playlistId} and verified it ✓`
      : `Video ${remote.video_id} was already in playlist ${playlistId}; no insert quota was spent ✓`,
  )
  job.progress = 100
}
