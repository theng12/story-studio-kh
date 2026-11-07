/**
 * Playlist cache + defaults + channel YouTube settings for the Upload Center (Item 20 / A4 + A5).
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
 *
 * End-screen wiring (Item 20):
 *   config.youtube_end_screen: EndScreenConfig
 * YouTube Data API v3 does not expose an official endpoint for programmatic
 * end-screen mutation. Local video presentation/outro config is managed honestly
 * and separated from remote API capabilities.
 */

import * as pm from './project-manager.js'
import { listPlaylists, type Playlist } from '../lib/youtube-client.js'
import {
  type PlaylistSummary,
  type PlaylistInventoryState,
  type EndScreenConfig,
  type YouTubeEndScreenCapability,
  YOUTUBE_END_SCREEN_CAPABILITY,
  normalizeEndScreenConfig,
} from '../contracts/youtube-channel-settings.js'

const TTL_MS = 60_000
const cache = new Map<string, { fetchedAt: number; playlists: Playlist[] }>()

function cacheKey(slug: string, accountId: string): string {
  return `${slug}:${accountId}`
}

export function _resetPlaylistCacheForTesting(): void {
  cache.clear()
}

export async function getPlaylists(slug: string, accountId: string, force = false): Promise<Playlist[]> {
  if (!accountId || typeof accountId !== 'string' || !accountId.trim()) {
    return []
  }
  const key = cacheKey(slug, accountId.trim())
  const entry = cache.get(key)
  if (!force && entry && Date.now() - entry.fetchedAt < TTL_MS) {
    return entry.playlists
  }
  const playlists = await listPlaylists(slug, accountId.trim())
  cache.set(key, { fetchedAt: Date.now(), playlists })
  return playlists
}

export async function getDefaultPlaylist(slug: string, accountId: string): Promise<string> {
  if (!accountId || typeof accountId !== 'string') return ''
  const config = (await pm.getConfig(slug)) as any
  const map = config?.youtube_default_playlist
  return typeof map?.[accountId] === 'string' ? map[accountId] : ''
}

export async function setDefaultPlaylist(
  slug: string,
  accountId: string,
  playlistId: string,
): Promise<string> {
  const normAccount = typeof accountId === 'string' ? accountId.trim() : ''
  if (!normAccount) {
    throw new Error('Cannot set default playlist without a valid YouTube account ID.')
  }
  const normPlaylist = typeof playlistId === 'string' ? playlistId.trim() : ''
  const config = ((await pm.getConfig(slug)) as any) || {}
  const existingMap = { ...(config.youtube_default_playlist || {}) }

  if (normPlaylist) {
    existingMap[normAccount] = normPlaylist
  } else {
    delete existingMap[normAccount]
  }

  await pm.updateConfig(slug, { youtube_default_playlist: existingMap } as any)
  return normPlaylist
}

export async function getPlaylistInventory(
  slug: string,
  accountId?: string,
  force = false,
): Promise<PlaylistInventoryState> {
  const normAccount = typeof accountId === 'string' ? accountId.trim() : ''
  if (!normAccount) {
    return {
      account_id: '',
      playlists: [],
      default_playlist_id: '',
      cached_at: null,
      count: 0,
      has_connected_account: false,
    }
  }

  const key = cacheKey(slug, normAccount)
  const existingCache = cache.get(key)
  const playlists = await getPlaylists(slug, normAccount, force)
  const defaultPlaylistId = await getDefaultPlaylist(slug, normAccount)
  const entry = cache.get(key) || existingCache

  return {
    account_id: normAccount,
    playlists: playlists.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      privacyStatus: p.privacyStatus,
      itemCount: p.itemCount,
    })),
    default_playlist_id: defaultPlaylistId,
    cached_at: entry?.fetchedAt ?? null,
    count: playlists.length,
    has_connected_account: true,
  }
}

export async function getEndScreenSettings(slug: string): Promise<EndScreenConfig> {
  const config = ((await pm.getConfig(slug)) as any) || {}
  return normalizeEndScreenConfig(config.youtube_end_screen)
}

export async function updateEndScreenSettings(
  slug: string,
  patch: Partial<EndScreenConfig>,
): Promise<EndScreenConfig> {
  const current = await getEndScreenSettings(slug)
  const next = normalizeEndScreenConfig({ ...current, ...patch })
  await pm.updateConfig(slug, { youtube_end_screen: next } as any)
  return next
}

export interface YouTubeChannelSettingsSummary {
  inventory: PlaylistInventoryState
  end_screen: EndScreenConfig
  end_screen_capabilities: YouTubeEndScreenCapability
}

export async function getYouTubeChannelSettings(
  slug: string,
  accountId?: string,
  force = false,
): Promise<YouTubeChannelSettingsSummary> {
  const [inventory, end_screen] = await Promise.all([
    getPlaylistInventory(slug, accountId, force),
    getEndScreenSettings(slug),
  ])

  return {
    inventory,
    end_screen,
    end_screen_capabilities: YOUTUBE_END_SCREEN_CAPABILITY,
  }
}

export async function updateYouTubeChannelSettings(
  slug: string,
  accountId: string,
  input: {
    default_playlist_id?: string
    end_screen?: Partial<EndScreenConfig>
  },
): Promise<YouTubeChannelSettingsSummary> {
  if (typeof input.default_playlist_id === 'string' && accountId) {
    await setDefaultPlaylist(slug, accountId, input.default_playlist_id)
  }
  if (input.end_screen && typeof input.end_screen === 'object') {
    await updateEndScreenSettings(slug, input.end_screen)
  }
  return getYouTubeChannelSettings(slug, accountId)
}

/**
 * Route handler helpers for lead integration.
 * Can be mounted into `routes/upload.ts` or `routes/youtube-upload-center.ts`.
 */
export async function handleGetChannelYouTubeSettings(req: any, res: any): Promise<void> {
  try {
    const slug = req.params.slug
    const accountId = req.query.account_id as string | undefined
    const force = req.query.force === '1' || req.query.force === 'true'
    const settings = await getYouTubeChannelSettings(slug, accountId, force)
    res.json(settings)
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to read YouTube channel settings' })
  }
}

export async function handleUpdateChannelYouTubeSettings(req: any, res: any): Promise<void> {
  try {
    const slug = req.params.slug
    const accountId = (req.body?.account_id || req.query?.account_id || '') as string
    const settings = await updateYouTubeChannelSettings(slug, accountId, req.body || {})
    res.json(settings)
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to update YouTube channel settings' })
  }
}
