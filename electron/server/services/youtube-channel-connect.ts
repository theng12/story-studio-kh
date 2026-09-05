/**
 * Connecting one YouTube channel grant to the owner's single OAuth application.
 *
 * This owns the part of the flow that has to happen *after* Google answers: the
 * grant must be durably saved before anything tells the UI the channel is
 * connected, or a client that polls and immediately re-reads the registry sees
 * a channel that is not there yet.
 *
 * The provider seam is `OAuthFlowDeps`, exactly as Phase 1 defined it, so tests
 * inject fakes and production passes nothing.
 */

import {
  YOUTUBE_OWNER_SCOPES,
  YOUTUBE_OAUTH_TERMINAL_RETENTION_MS,
  getFlowStatus,
  startOAuthFlow,
  type OAuthFlowDeps,
} from '../lib/youtube-oauth.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import {
  readYouTubeOAuthClientForServer,
  saveYouTubeChannelGrant,
} from './youtube-connection-store.js'

export interface YouTubeConnectChannel {
  channel_id: string
  channel_title: string
  custom_url?: string
  thumbnail_url?: string
}

export type YouTubeChannelConnectStatus =
  | { status: 'pending'; flow_id: string }
  | {
      status: 'success'
      flow_id: string
      channel: YouTubeConnectChannel
      granted_scopes: string[]
      scope_upgrade_required: boolean
    }
  | { status: 'error'; flow_id: string; error: string; error_code: string }
  | {
      status: 'unknown'
      flow_id: string
      error: 'This OAuth flow is no longer available. Start again.'
      error_code: 'YOUTUBE_OAUTH_FLOW_UNKNOWN'
    }

interface SaveOutcome {
  ok: boolean
  channel?: YouTubeConnectChannel
  granted_scopes?: string[]
  scope_upgrade_required?: boolean
  error?: { error: string; error_code: string }
}

/**
 * Flow id → the save that must finish before success is reported. Entries use
 * the same bounded terminal lifetime as the OAuth result they accompany.
 */
const saves = new Map<string, Promise<SaveOutcome>>()

function scheduleSavePurge(flowId: string): void {
  const timer = setTimeout(() => { saves.delete(flowId) }, YOUTUBE_OAUTH_TERMINAL_RETENTION_MS)
  timer.unref?.()
}

function grantedScopesOf(scopes: string[] | undefined): string[] {
  return scopes ? [...scopes] : []
}

function coversOwnerScopes(granted: string[]): boolean {
  return YOUTUBE_OWNER_SCOPES.every(scope => granted.includes(scope))
}

/**
 * Start a channel connection. Returns the authorization URL for the caller to
 * open — production never opens a browser from here, matching the Phase 1
 * contract.
 */
export async function startYouTubeChannelConnect(input: {
  expected_channel_id?: string
  timeout_ms?: number
  deps?: OAuthFlowDeps
}): Promise<{ flow_id: string; auth_url: string }> {
  const client = await readYouTubeOAuthClientForServer()
  if (!client) {
    throw new YouTubeFoundationError(
      409,
      'YOUTUBE_APPLICATION_NOT_CONFIGURED',
      'Configure a YouTube OAuth application before connecting a channel.',
    )
  }

  const flow = await startOAuthFlow({
    client_id: client.client_id,
    client_secret: client.client_secret,
    ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
    ...(input.deps ? { deps: input.deps } : {}),
  })

  const save = flow.promise.then(
    async (result): Promise<SaveOutcome> => {
      // A reconnect must land on the channel the owner asked to reconnect. A
      // different channel is a new grant the owner did not ask for, so it is
      // refused before anything is written.
      if (input.expected_channel_id && input.expected_channel_id !== result.channel.channel_id) {
        return {
          ok: false,
          error: {
            error: 'That Google account authorized a different YouTube channel. Reconnect the same channel.',
            error_code: 'YOUTUBE_CHANNEL_MISMATCH',
          },
        }
      }

      const granted = grantedScopesOf(result.tokens.scope?.split(/\s+/).filter(Boolean))
      const channel: YouTubeConnectChannel = { ...result.channel }
      // The requested scope list is never proof of a grant. A partial grant is
      // persisted as `scope_upgrade_required` in the SAME write as the tokens,
      // so no interruption can leave a durable record claiming permission the
      // grant does not have.
      const upgrade = !coversOwnerScopes(granted)
      await saveYouTubeChannelGrant({
        expected_application_id: client.application_id,
        channel: {
          channel_id: channel.channel_id,
          title: channel.channel_title,
          ...(channel.custom_url ? { handle: channel.custom_url } : {}),
          ...(channel.thumbnail_url ? { thumbnail_url: channel.thumbnail_url } : {}),
          granted_scopes: granted,
        },
        tokens: result.tokens,
        status: upgrade ? 'scope_upgrade_required' : 'connected',
      })

      return { ok: true, channel, granted_scopes: granted, scope_upgrade_required: upgrade }
    },
  ).catch((error: unknown): SaveOutcome => ({
    ok: false,
    error: error instanceof YouTubeFoundationError
      ? { error: error.detail, error_code: error.code }
      : {
          error: 'Story Studio could not save that YouTube channel. Try connecting it again.',
          error_code: 'YOUTUBE_OAUTH_UNAVAILABLE',
        },
  }))
  saves.set(flow.flow_id, save)
  void save.then(() => { scheduleSavePurge(flow.flow_id) })

  return { flow_id: flow.flow_id, auth_url: flow.auth_url }
}

/**
 * Read a connect flow. `success` is only reported once the grant is durably
 * saved, so a caller that sees it can read the channel back immediately.
 */
export async function readYouTubeChannelConnectStatus(
  flow_id: string,
): Promise<YouTubeChannelConnectStatus> {
  const status = getFlowStatus(flow_id)
  if (status.status === 'pending') return { status: 'pending', flow_id }

  const save = saves.get(flow_id)
  if (status.status === 'success') {
    if (!save) return { status: 'unknown', flow_id, error: 'This OAuth flow is no longer available. Start again.', error_code: 'YOUTUBE_OAUTH_FLOW_UNKNOWN' }
    // Deliberately NOT deleted here. Reading a terminal status is a safe,
    // repeatable GET: a second tab, a retried request, or a poller that was
    // still in flight must get the same answer the OAuth layer still gives
    // for its retention window, not "start again". The entry is dropped
    // below, once that window has expired and the flow reads `unknown`.
    const outcome = await save
    if (!outcome.ok) {
      return {
        status: 'error',
        flow_id,
        error: outcome.error?.error ?? 'Story Studio could not save that YouTube channel. Try connecting it again.',
        error_code: outcome.error?.error_code ?? 'YOUTUBE_OAUTH_UNAVAILABLE',
      }
    }
    return {
      status: 'success',
      flow_id,
      channel: outcome.channel!,
      granted_scopes: outcome.granted_scopes ?? [],
      scope_upgrade_required: outcome.scope_upgrade_required === true,
    }
  }

  saves.delete(flow_id)
  if (status.status === 'error') {
    return { status: 'error', flow_id, error: status.error, error_code: status.error_code }
  }
  return { status: 'unknown', flow_id, error: status.error, error_code: status.error_code }
}
