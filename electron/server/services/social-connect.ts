/**
 * Connecting an account, and getting a usable credential back out.
 *
 * The connect flow is the OAuth layer's, wrapped so that "connected" is only
 * reported once the account is durably saved — the same rule the YouTube
 * connect service follows, and for the same reason: a client that polls and
 * immediately re-reads the registry must find the account there.
 *
 * The credential resolver is deliberately small. Meta has no refresh token in
 * this flow: a Page token lasts about 60 days and then the owner reconnects,
 * which is a fact worth stating rather than hiding behind a retry. TikTok's
 * access token lasts 24 hours and its refresh token 365 days, so it IS
 * refreshed, and the rotated refresh token is persisted because TikTok
 * invalidates the one it replaced.
 */

import { SocialError, PLATFORM_PROVIDER, type SocialPlatform } from '../contracts/social-publishing.js'
import type { SocialAccountTokenSecret } from './app-secrets-store.js'
import {
  readSocialAccountTokens,
  readSocialApplicationSecret,
  saveSocialAccountGrant,
  updateSocialAccountTokens,
} from './social-connection-store.js'
import type { SocialAccountRecord } from '../contracts/social-publishing.js'
import {
  getSocialFlowStatus,
  startSocialOAuthFlow,
  type SocialConnectedAccount,
  type SocialOAuthDeps,
  type SocialOAuthFlowStatus,
} from '../lib/social-oauth.js'
import { socialTransport } from '../lib/social-publish/types.js'
import { logLine } from './logger.js'

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'
/** Refresh this long before expiry so a post never starts on a dying token. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000

interface SavedOutcome {
  ok: boolean
  accounts?: Array<Omit<SocialConnectedAccount, 'tokens'>>
  granted_scopes?: string[]
  error?: { message: string; code: string }
}

const saves = new Map<string, Promise<SavedOutcome>>()

/**
 * Start a connect flow for one provider. Returns the authorization URL for the
 * caller to open; production never opens a browser from here.
 */
export async function startSocialConnect(input: {
  provider: 'meta' | 'tiktok'
  deps?: SocialOAuthDeps
}): Promise<{ flow_id: string; auth_url: string; provider: 'meta' | 'tiktok' }> {
  const saved = await readSocialApplicationSecret(input.provider)
  if (!saved) {
    throw new SocialError(
      409,
      'SOCIAL_APPLICATION_NOT_CONFIGURED',
      `Save the ${input.provider === 'meta' ? 'Meta' : 'TikTok'} application in Settings → Publishing before connecting an account.`,
    )
  }
  const flow = await startSocialOAuthFlow({
    provider: input.provider,
    client_id: saved.application.client_id,
    client_secret: saved.client_secret,
    app_id: saved.application.application_id,
    redirect_uri: saved.application.redirect_uri,
    ...(input.deps ? { deps: input.deps } : {}),
  })

  const save = flow.promise.then(async (result): Promise<SavedOutcome> => {
    const saved: Array<Omit<SocialConnectedAccount, 'tokens'>> = []
    for (const account of result.accounts) {
      await saveSocialAccountGrant({
        platform: account.platform,
        application_id: account.tokens.application_id,
        remote_id: account.remote_id,
        remote_name: account.remote_name,
        ...(account.page_id ? { page_id: account.page_id } : {}),
        tokens: account.tokens,
      })
      saved.push({
        platform: account.platform,
        remote_id: account.remote_id,
        remote_name: account.remote_name,
        ...(account.page_id ? { page_id: account.page_id } : {}),
      })
    }
    return { ok: true, accounts: saved, granted_scopes: result.granted_scopes }
  }).catch((error: unknown): SavedOutcome => {
    const code = (error as { code?: string })?.code
    logLine('warn', `[social-connect] ${input.provider} connect failed: ${(error as Error)?.message || 'unknown'}`)
    return {
      ok: false,
      error: {
        message: (error as Error)?.message || 'Story Studio could not save that account. Try connecting it again.',
        code: typeof code === 'string' ? code : 'SOCIAL_OAUTH_REJECTED',
      },
    }
  })
  saves.set(flow.flow_id, save)
  return { flow_id: flow.flow_id, auth_url: flow.auth_url, provider: input.provider }
}

/**
 * Read a connect flow. `success` is reported only once every account is saved.
 * Terminal entries are retained for the OAuth layer's own retention window so a
 * second poll gets the same answer rather than "start again".
 */
export async function readSocialConnectStatus(flow_id: string): Promise<SocialOAuthFlowStatus> {
  const status = getSocialFlowStatus(flow_id)
  if (status.status === 'pending') return status
  if (status.status === 'unknown') {
    saves.delete(flow_id)
    return status
  }
  const save = saves.get(flow_id)
  if (!save) {
    return { status: 'unknown', flow_id, error: 'This sign-in is no longer available. Start again.', error_code: 'SOCIAL_OAUTH_FLOW_UNKNOWN' }
  }
  const outcome = await save
  if (!outcome.ok) {
    return {
      status: 'error',
      flow_id,
      error: outcome.error?.message || 'The account was not connected.',
      error_code: outcome.error?.code || 'SOCIAL_OAUTH_REJECTED',
    }
  }
  return {
    status: 'success',
    flow_id,
    result: { accounts: outcome.accounts ?? [], granted_scopes: outcome.granted_scopes ?? [] },
  }
}

/**
 * A credential that will work right now, or a clear reason it cannot.
 *
 * TikTok is refreshed proactively and the rotated refresh token persisted —
 * TikTok invalidates the token it replaced, so a refresh that is not saved
 * silently signs the owner out. Meta is not refreshed: there is nothing to
 * refresh, and a rejected Page token is a reconnect.
 */
export async function resolveSocialCredentials(platform: SocialPlatform, account: SocialAccountRecord): Promise<{
  accessToken: string
  pageToken?: string
  pageId?: string
  appId?: string
}> {
  const provider = PLATFORM_PROVIDER[platform]
  const application = await readSocialApplicationSecret(provider)
  if (!application) {
    throw new SocialError(409, 'SOCIAL_APPLICATION_NOT_CONFIGURED', `The ${provider === 'meta' ? 'Meta' : 'TikTok'} application is no longer saved. Save it again in Settings → Publishing.`)
  }
  const tokens = await readSocialAccountTokens(platform, account.remote_id)
  if (!tokens || tokens.application_id !== account.application_id) {
    throw new SocialError(409, 'SOCIAL_RECONNECT_REQUIRED', `Reconnect ${account.remote_name} in Settings → Publishing: its saved sign-in is missing.`)
  }

  const fresh = provider === 'tiktok' && tokens.expires_at - REFRESH_MARGIN_MS <= Date.now()
    ? await refreshTikTokTokens(platform, account, tokens, application.client_secret, application.application.client_id)
    : tokens

  return {
    accessToken: fresh.access_token,
    ...(fresh.page_token ? { pageToken: fresh.page_token } : {}),
    ...(account.page_id ? { pageId: account.page_id } : {}),
    // Facebook's resumable upload session is opened on the app id. The stored
    // application id is `${provider}:${client_id}`, so the client id is what
    // Meta wants as the app id in that path.
    appId: application.application.client_id,
  }
}

async function refreshTikTokTokens(
  platform: SocialPlatform,
  account: SocialAccountRecord,
  tokens: SocialAccountTokenSecret,
  clientSecret: string,
  clientKey: string,
): Promise<SocialAccountTokenSecret> {
  if (!tokens.refresh_token) {
    throw new SocialError(409, 'SOCIAL_RECONNECT_REQUIRED', `Reconnect ${account.remote_name} in Settings → Publishing: its TikTok sign-in expired.`)
  }
  const response = await socialTransport(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }).toString(),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
    throw new SocialError(409, 'SOCIAL_RECONNECT_REQUIRED', `Reconnect ${account.remote_name} in Settings → Publishing: TikTok rejected its saved sign-in.`)
  }
  const expiresIn = Number(body.expires_in)
  const refreshed: SocialAccountTokenSecret = {
    ...tokens,
    access_token: body.access_token,
    // TikTok may rotate the refresh token and says the new one MUST be used.
    refresh_token: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : tokens.refresh_token,
    expires_at: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86_400) * 1000,
  }
  await updateSocialAccountTokens(platform, account.remote_id, refreshed)
  return refreshed
}

/** Test-only: forget the in-memory save promises so one test cannot see another's. */
export function __resetSocialConnectsForTests(): void {
  saves.clear()
}
