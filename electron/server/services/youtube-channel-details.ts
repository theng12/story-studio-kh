/**
 * Keep a connected channel's own name, handle and thumbnail current.
 *
 * YouTube owns these three fields: the owner can rename a channel or change
 * its picture at any time, and Story Studio used to freeze whatever it saw at
 * connect. This re-reads them from YouTube — by channel id, so the identity is
 * never inferred from a token — and writes them back to the connection store.
 *
 * Two triggers:
 *   - the channel's access token was refreshed, so the grant is fresh
 *   - the connections list was read and this channel has not been checked for a day
 *
 * A failed read keeps the saved values and says why in the log. It never fails
 * the connections list and never fails an upload.
 */

import { readYouTubeChannelDetails } from '../lib/youtube-client.js'
import { refreshAccessToken } from '../lib/youtube-oauth.js'
import { logLine } from './logger.js'
import { recordYouTubeQuotaAttempt } from './youtube-quota-ledger.js'
import {
  readYouTubeChannelTokensForServer,
  readYouTubeOAuthClientForServer,
  saveYouTubeChannelTokens,
  updateYouTubeChannelDetails,
} from './youtube-connection-store.js'
import type { YouTubeChannelRecord } from '../contracts/youtube-upload-center.js'

/** How long a channel's saved details are trusted before they are re-read. */
export const CHANNEL_DETAILS_INTERVAL_MS = 24 * 60 * 60 * 1000

interface ChannelCredential {
  access_token: string
  application_id: string
}

/**
 * A usable access token for this channel, renewed when the stored one expired.
 *
 * The renewal is the same one an upload would make, so a channel that is only
 * ever looked at in Settings still gets a current name.
 */
async function channelCredential(channelId: string): Promise<ChannelCredential> {
  const token = await readYouTubeChannelTokensForServer(channelId)
  if (!token) throw new Error('This YouTube channel has no usable sign-in.')
  const client = await readYouTubeOAuthClientForServer()
  if (!client) throw new Error('This YouTube OAuth application is not configured.')
  if (token.expires_at - 60_000 > Date.now()) {
    return { access_token: token.access_token, application_id: client.application_id }
  }
  const fresh = await refreshAccessToken({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: token.refresh_token,
    ...(token.scope ? { previous_scope: token.scope } : {}),
  })
  await saveYouTubeChannelTokens({
    channel_id: channelId,
    expected_access_token: token.access_token,
    tokens: fresh,
  })
  return { access_token: fresh.access_token, application_id: client.application_id }
}

async function readCurrentDetails(channelId: string): Promise<{ title: string; handle?: string; thumbnail_url?: string }> {
  const credential = await channelCredential(channelId)
  const details = await readYouTubeChannelDetails(credential.access_token, channelId)
  if (!details) throw new Error('YouTube returned no details for this channel.')
  await recordYouTubeQuotaAttempt({
    application_id: credential.application_id,
    channel_id: channelId,
    bucket: 'other_endpoints',
    operation: 'channels_list',
    amount: 1,
  }).catch((error: unknown) => {
    logLine('warn', `[youtube-channel-details] quota record failed: ${(error as Error)?.message || 'unknown'}`, { channel_id: channelId })
  })
  return details
}

/**
 * Re-read one channel's own details and save them.
 *
 * Never throws: a failed read keeps the saved values and says why.
 */
export async function refreshYouTubeChannelDetails(channelId: string): Promise<boolean> {
  let details: { title: string; handle?: string; thumbnail_url?: string } | undefined
  try {
    details = await readCurrentDetails(channelId)
  } catch (error) {
    logLine('warn', `[youtube-channel-details] could not re-read channel ${channelId}: ${(error as Error)?.message || 'unknown'}`, { channel_id: channelId })
  }
  try {
    return await updateYouTubeChannelDetails({ channel_id: channelId, ...(details ? { details } : {}) })
  } catch (error) {
    logLine('warn', `[youtube-channel-details] could not save channel ${channelId}: ${(error as Error)?.message || 'unknown'}`, { channel_id: channelId })
    return false
  }
}

/**
 * Re-read the channels whose details are older than a day.
 *
 * Returns true when at least one channel was checked, so the caller knows to
 * read the registry again.
 */
export async function refreshStaleYouTubeChannelDetails(
  channels: Array<Pick<YouTubeChannelRecord, 'channel_id' | 'status' | 'details_checked_at'>>,
  now = Date.now(),
): Promise<boolean> {
  let checked = false
  for (const channel of channels) {
    if (channel.status !== 'connected') continue
    const last = channel.details_checked_at ? Date.parse(channel.details_checked_at) : NaN
    if (Number.isFinite(last) && now - last < CHANNEL_DETAILS_INTERVAL_MS) continue
    await refreshYouTubeChannelDetails(channel.channel_id)
    checked = true
  }
  return checked
}
