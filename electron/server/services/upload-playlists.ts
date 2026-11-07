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
 *
 * The authoritative GET/PUT (`getChannelSettings` / `updateChannelSettings`)
 * is PINNED to the project's assigned channel via the connection registry —
 * the client's `account_id` / `expected_account_id` can only confirm that
 * pin, never choose it. Every config write is one read-modify-write inside
 * `withLock(configPath)` — the same lock `pm.updateConfig` takes — so a
 * merged map can never be written back from a stale read.
 */

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as pm from './project-manager.js'
import { listPlaylists, type Playlist } from '../lib/youtube-client.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { getProjectYouTubeAssignment } from './youtube-connection-store.js'
import { resolveYouTubeCredential, type YouTubeCredential } from './youtube-credential.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import {
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

function statusError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

function mismatchError(): YouTubeFoundationError {
  return new YouTubeFoundationError(
    409,
    'YOUTUBE_CHANNEL_MISMATCH',
    'The assigned YouTube channel changed. Reload the channel settings and try again.',
  )
}

function unassignedError(): YouTubeFoundationError {
  return new YouTubeFoundationError(
    409,
    'YOUTUBE_CHANNEL_NOT_ASSIGNED',
    'Assign a YouTube channel to this project first.',
  )
}

function notConnectedError(): YouTubeFoundationError {
  return new YouTubeFoundationError(
    409,
    'YOUTUBE_CHANNEL_NOT_CONNECTED',
    'The assigned YouTube channel is not connected on this Mac. Reconnect it under This Mac → Connections.',
  )
}

/** A YouTube call that failed is loud and 502 — never folded into "no channel". */
function providerError(action: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return statusError(502, `YouTube could not ${action}: ${detail}`)
}

/**
 * One read-modify-write of config.json under the SAME lock key and helpers
 * `pm.updateConfig` takes (chapter-background-pool pattern). The merge happens
 * inside the lock, so two concurrent writers serialize instead of the second
 * one writing back a map it read before the first finished. A no-op mutate
 * writes nothing: every episode-status row depends on config.json's mtime.
 */
async function mutateConfig(slug: string, mutate: (data: Record<string, any>) => void): Promise<void> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new Error(`Channel "${slug}" has no project directory on this Mac.`)
  const configPath = path.join(projectDir, 'config.json')
  if (!existsSync(configPath)) throw new Error(`Channel "${slug}" has no config.json; nothing was changed.`)
  await withLock(configPath, async () => {
    const raw = await fs.readFile(configPath, 'utf8')
    let data: Record<string, any>
    try {
      data = JSON.parse(raw)
    } catch (error: any) {
      throw new Error(`config.json for channel "${slug}" is corrupt (${error?.message}); nothing was changed.`, { cause: error })
    }
    const before = JSON.stringify(data)
    mutate(data)
    if (JSON.stringify(data) !== before) await writeJsonAtomic(configPath, data)
  })
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
  await mutateConfig(slug, (data) => {
    const existingMap = { ...(data.youtube_default_playlist || {}) }
    if (normPlaylist) {
      existingMap[normAccount] = normPlaylist
    } else {
      delete existingMap[normAccount]
    }
    data.youtube_default_playlist = existingMap
  })
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
  let result: EndScreenConfig = normalizeEndScreenConfig(patch)
  await mutateConfig(slug, (data) => {
    const current = normalizeEndScreenConfig(data.youtube_end_screen)
    result = normalizeEndScreenConfig({ ...current, ...patch })
    data.youtube_end_screen = result
  })
  return result
}

// ── Authoritative channel settings (pinned to the assigned channel) ────────

export interface YouTubeChannelSettingsSummary {
  /** The assigned channel this answer is pinned to; null when there is none. */
  channel_id: string | null
  inventory: PlaylistInventoryState
  end_screen: EndScreenConfig
  end_screen_capabilities: YouTubeEndScreenCapability
}

type PinnedChannel =
  | { state: 'unassigned' }
  | { state: 'not_connected' }
  | { state: 'ready'; credential: YouTubeCredential }

/**
 * The one channel this project publishes to, looked up — never taken from
 * the caller. `resolveYouTubeCredential` already answers null for a healthy
 * registry with no assignment; a second read separates that from an
 * assignment whose channel lost its grant.
 */
async function resolvePinnedChannel(slug: string): Promise<PinnedChannel> {
  const credential = await resolveYouTubeCredential(slug)
  if (credential) return { state: 'ready', credential }
  const assignment = await getProjectYouTubeAssignment(slug)
  return assignment ? { state: 'not_connected' } : { state: 'unassigned' }
}

function emptyInventory(): PlaylistInventoryState {
  return {
    account_id: '',
    playlists: [],
    default_playlist_id: '',
    cached_at: null,
    count: 0,
    has_connected_account: false,
  }
}

async function inventoryFor(slug: string, accountId: string, force: boolean): Promise<PlaylistInventoryState> {
  try {
    return await getPlaylistInventory(slug, accountId, force)
  } catch (error) {
    throw providerError('list playlists for the assigned channel', error)
  }
}

async function assertPlaylistOnChannel(slug: string, accountId: string, playlistId: string): Promise<void> {
  let listed: Playlist[]
  try {
    listed = await getPlaylists(slug, accountId)
  } catch (error) {
    throw providerError('list playlists for the assigned channel', error)
  }
  if (!listed.some((playlist) => playlist.id === playlistId)) {
    throw statusError(400, `Playlist "${playlistId}" is not a playlist on the assigned YouTube channel.`)
  }
}

/**
 * Authoritative read. No assignment → the honest no-account state (200).
 * Assigned but unusable → a loud 409, distinct from "no channel". A YouTube
 * failure → 502, never mistaken for either. `expectedAccountId` only confirms
 * the pin: a stale or foreign id is rejected, not honoured.
 */
export async function getChannelSettings(
  slug: string,
  opts: { force?: boolean; expectedAccountId?: string } = {},
): Promise<YouTubeChannelSettingsSummary> {
  const pinned = await resolvePinnedChannel(slug)
  if (pinned.state === 'not_connected') throw notConnectedError()

  const end_screen = await getEndScreenSettings(slug)
  if (pinned.state === 'unassigned') {
    return {
      channel_id: null,
      inventory: emptyInventory(),
      end_screen,
      end_screen_capabilities: YOUTUBE_END_SCREEN_CAPABILITY,
    }
  }

  const { credential } = pinned
  if (opts.expectedAccountId && opts.expectedAccountId !== credential.accountId) {
    throw mismatchError()
  }
  return {
    channel_id: credential.channelId,
    inventory: await inventoryFor(slug, credential.accountId, opts.force === true),
    end_screen,
    end_screen_capabilities: YOUTUBE_END_SCREEN_CAPABILITY,
  }
}

export interface UpdateYouTubeChannelSettingsInput {
  /** The account the client loaded this screen from; must match the pin. */
  expected_account_id?: string
  /** Present → account-scoped write (set or clear); absent → plan-only save. */
  default_playlist_id?: string
  end_screen?: Partial<EndScreenConfig>
}

/**
 * Authoritative write. One config lock covers every key in the request, so a
 * playlist write and a plan write land together or not at all. A non-empty
 * playlist must belong to the assigned channel (checked against that
 * channel's own inventory; a failed listing is a loud 502, never a pass).
 * The end-screen plan is local-only truth and needs no account.
 */
export async function updateChannelSettings(
  slug: string,
  input: UpdateYouTubeChannelSettingsInput,
): Promise<YouTubeChannelSettingsSummary> {
  const pinned = await resolvePinnedChannel(slug)
  if (pinned.state === 'not_connected') throw notConnectedError()

  const wantsPlaylist = typeof input.default_playlist_id === 'string'
  const playlistId = wantsPlaylist ? input.default_playlist_id!.trim() : ''
  const wantsEndScreen = !!input.end_screen && typeof input.end_screen === 'object'

  if (pinned.state === 'unassigned') {
    // A non-empty playlist without a channel is refused; an explicit clear
    // with no channel has nothing to clear, so only the local plan can land.
    if (playlistId !== '') throw unassignedError()
    if (!wantsEndScreen) return getChannelSettings(slug)
    await updateEndScreenSettings(slug, input.end_screen!)
    return getChannelSettings(slug)
  }

  const { credential } = pinned
  if (wantsPlaylist) {
    const expected = typeof input.expected_account_id === 'string' ? input.expected_account_id.trim() : ''
    if (!expected) {
      throw statusError(400, 'This save must confirm the YouTube channel it was loaded from. Reload the channel settings and try again.')
    }
    if (expected !== credential.accountId) throw mismatchError()
    if (playlistId !== '') await assertPlaylistOnChannel(slug, credential.accountId, playlistId)
  }

  if (!wantsPlaylist && !wantsEndScreen) return getChannelSettings(slug)

  await mutateConfig(slug, (data) => {
    if (wantsPlaylist) {
      const existingMap = { ...(data.youtube_default_playlist || {}) }
      if (playlistId) {
        existingMap[credential.accountId] = playlistId
      } else {
        delete existingMap[credential.accountId]
      }
      data.youtube_default_playlist = existingMap
    }
    if (wantsEndScreen) {
      const current = normalizeEndScreenConfig(data.youtube_end_screen)
      data.youtube_end_screen = normalizeEndScreenConfig({ ...current, ...input.end_screen! })
    }
  })

  return getChannelSettings(slug)
}
