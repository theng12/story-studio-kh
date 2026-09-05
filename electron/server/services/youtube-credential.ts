/**
 * WHICH credential this project should use to talk to YouTube.
 *
 * There is one answer to that question and this is where it lives. The archived
 * redesign migrated the Upload Center's own routes onto the connection registry
 * while other callers still resolved through `config.upload_accounts`. On a
 * fresh install those callers saw an empty list and reported that an already
 * connected channel was not connected.
 *
 * The registry is the only source of truth. Older per-project OAuth records
 * remain on disk as historical evidence but are never selected for requests.
 */

import { getProjectYouTubeAssignment, readYouTubeConnectionRegistry } from './youtube-connection-store.js'
import { REGISTRY_CREDENTIAL_PREFIX, registryCredentialFor } from '../lib/youtube-client.js'

export interface YouTubeCredential {
  /** Pass to `fetchWithAuthRetry` / `getValidAccessToken`. */
  accountId: string
  /** The channel it signs in to, when that is known. */
  channelId: string
  source: 'registry'
}

/**
 * The credential, or null when this project has none.
 *
 * Returns null for a healthy, readable registry with no usable assignment.
 * Storage failures and malformed registry state deliberately propagate so a
 * caller cannot misreport corruption as merely "not connected".
 */
export async function resolveYouTubeCredential(slug: string): Promise<YouTubeCredential | null> {
  const assignment = await getProjectYouTubeAssignment(slug)
  const assigned = assignment?.channel_id ?? null

  if (!assigned) return null
  const registry = await readYouTubeConnectionRegistry()
  const granted = registry.channels[assigned]
  if (!granted || !registry.application
    || granted.application_id !== registry.application.application_id
    || granted.status !== 'connected') return null
  return { accountId: registryCredentialFor(assigned), channelId: assigned, source: 'registry' }
}

/** The account id alone, for sites that only need something to pass along. */
export async function resolveYouTubeAccountId(slug: string, requested?: string): Promise<string> {
  const resolved = (await resolveYouTubeCredential(slug))?.accountId ?? ''
  return !requested || requested === resolved ? resolved : ''
}

/**
 * Resolve a durable upload sidecar by immutable channel identity. Historical
 * local account ids are implementation details and may predate the registry;
 * the channel id is the authorization boundary that survives reconnects.
 */
export async function resolveYouTubeAccountIdForChannel(slug: string, channelId: string): Promise<string> {
  const credential = await resolveYouTubeCredential(slug)
  return credential?.channelId === channelId ? credential.accountId : ''
}

/**
 * The channel identity for a current registry credential.
 */
export async function describeYouTubeCredential(
  slug: string,
  accountId: string,
): Promise<{ remote_id: string, remote_title: string } | null> {
  const credential = await resolveYouTubeCredential(slug)
  if (!credential || credential.accountId !== accountId || !accountId.startsWith(REGISTRY_CREDENTIAL_PREFIX)) return null
  const channelId = credential.channelId
  const registry = await readYouTubeConnectionRegistry()
  const channel = registry.channels[channelId]
  if (!channel) return null
  return { remote_id: channelId, remote_title: channel.title || '' }
}
