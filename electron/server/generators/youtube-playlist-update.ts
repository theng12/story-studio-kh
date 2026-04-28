/**
 * YouTube playlist-update job executor.
 *
 * Pushes an already-uploaded video into a playlist via
 * `playlistItems.insert`. The action is intentionally **add-only / never
 * destructive**: we never call `playlistItems.delete`, so playlists the
 * app didn't track stay intact. If the video is already in the target
 * playlist, YouTube returns success and the row's last-sync timestamp
 * advances — the user sees a clean "✓ Synced" with no surprise removals.
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
import { readSidecar } from '../services/upload-sidecar.js'
import * as store from '../services/upload-store.js'
import * as playlistsSvc from '../services/upload-playlists.js'
import { addVideoToPlaylist } from '../lib/youtube-client.js'

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

export async function generateYoutubePlaylistUpdate(job: Job): Promise<void> {
  const slug = job.project_slug
  const params = (job.params || {}) as YoutubePlaylistUpdateParams
  const episodeId = params.episode_id || job.episode_id
  if (!episodeId) throw new Error('episode_id is required')

  job.output_lines.push(`YouTube playlist update — ${episodeId}`)

  // Resolve account.
  const accountId = params.account_id || (await store.getDefaultAccountId(slug, 'youtube'))
  if (!accountId) throw new Error('No YouTube account connected. Open Upload Center and connect a channel first.')
  const accounts = await store.listAccounts(slug, 'youtube')
  const account = accounts.find(a => a.id === accountId)
  if (!account) throw new Error(`YouTube account ${accountId} not found — reconnect in Upload Center.`)
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

  await addVideoToPlaylist({
    slug,
    accountId,
    playlistId,
    videoId: sidecar.video_id,
  })
  job.output_lines.push(`Added video ${sidecar.video_id} to playlist ${playlistId} ✓`)
  job.progress = 100
}
