/**
 * Playlist cache + defaults for the Upload Center (A4 + A5).
 *
 * YouTube's `playlists.list` is cheap (1 unit) but repeated calls on
 * every page load waste quota and flash loading spinners. Cache the
 * result for 60s per account. The cache key is `{slug}:{account_id}` so
 * multi-account users don't cross-contaminate.
 *
 * Default-playlist wiring (A5):
 *   config.youtube_default_playlist: { [account_id]: playlistId }
 * Read by the upload job after a successful videos.insert + sidecar write
 * to call addVideoToPlaylist. Failure is a warning, not a hard fail.
 */

import * as pm from './project-manager.js'
import { listPlaylists, type Playlist } from '../lib/youtube-client.js'

const TTL_MS = 60_000
const cache = new Map<string, { fetchedAt: number; playlists: Playlist[] }>()

function cacheKey(slug: string, accountId: string): string {
  return `${slug}:${accountId}`
}

export async function getPlaylists(slug: string, accountId: string, force = false): Promise<Playlist[]> {
  const key = cacheKey(slug, accountId)
  const entry = cache.get(key)
  if (!force && entry && Date.now() - entry.fetchedAt < TTL_MS) {
    return entry.playlists
  }
  const playlists = await listPlaylists(slug, accountId)
  cache.set(key, { fetchedAt: Date.now(), playlists })
  return playlists
}

export async function getDefaultPlaylist(slug: string, accountId: string): Promise<string> {
  const config = (await pm.getConfig(slug)) as any
  const map = config?.youtube_default_playlist
  return typeof map?.[accountId] === 'string' ? map[accountId] : ''
}
