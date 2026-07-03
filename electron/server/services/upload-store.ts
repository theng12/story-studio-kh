/**
 * Upload Center persistence — per-project storage for:
 *   - OAuth client (client_id + client_secret) per platform
 *   - Upload tokens (access_token, refresh_token, expires_at) per account
 *   - Connected accounts (public metadata: channel title, channel_id, label)
 *   - Default account selection per platform
 *
 * Tokens + client secrets live in `secrets.json` (mode 0600). Everything
 * user-visible (labels, channel IDs, default pointer) lives in `config.json`.
 *
 * Data boundary intentionally mirrors the existing ProviderAccounts pattern:
 *   - `config.upload_accounts.{platform}` = array of public account records
 *   - `config.upload_default_account.{platform}` = active account id
 *   - `secrets.upload.{platform}.{account_id}` = OAuth token bundle
 *   - `secrets.upload_oauth_client.{platform}` = { client_id, client_secret }
 *
 * Using `readSecretsV2` / `writeSecretsV2` under the hood so we share the
 * same atomic-with-lock write path as the existing provider secrets.
 */

import { randomUUID } from 'crypto'
import * as pm from './project-manager.js'
import { readSecretsV2, writeSecretsV2, type SecretsV2 } from './secrets-store.js'
import { revokeToken } from '../lib/youtube-oauth.js'
import type { OAuthTokenBundle } from '../lib/youtube-oauth.js'

// Platforms we know about. YouTube is the only live integration in v1;
// TikTok + Facebook exist as strings so the UI can render "Coming Soon"
// rows without a second enum elsewhere.
export const UPLOAD_PLATFORMS = ['youtube', 'tiktok', 'facebook'] as const
export type UploadPlatform = typeof UPLOAD_PLATFORMS[number]

export interface UploadAccount {
  id: string
  platform: UploadPlatform
  label: string
  /** Platform-specific identifier (YouTube channel_id, TikTok open_id, FB page_id). */
  remote_id: string
  /** Human-readable name (channel title / page name). */
  remote_title: string
  custom_url?: string
  thumbnail_url?: string
  connected_at: string
}

export interface OAuthClientCreds {
  client_id: string
  client_secret: string
}

// ── Secrets extension ──────────────────────────────────────────────────────
// We tack two new optional buckets onto SecretsV2. The base `readSecretsV2`
// returns `any`-flavored v2 because the TS type only declares `providers`;
// we cast to this richer view locally.

interface SecretsV2Upload extends SecretsV2 {
  upload?: Partial<Record<UploadPlatform, Record<string, OAuthTokenBundle>>>
  upload_oauth_client?: Partial<Record<UploadPlatform, OAuthClientCreds>>
}

// ── OAuth client storage ──────────────────────────────────────────────────

export async function readOAuthClient(slug: string, platform: UploadPlatform): Promise<OAuthClientCreds | null> {
  const v2 = await readSecretsV2(slug) as SecretsV2Upload
  const creds = v2.upload_oauth_client?.[platform]
  if (!creds?.client_id || !creds?.client_secret) return null
  return { client_id: creds.client_id, client_secret: creds.client_secret }
}

export async function writeOAuthClient(slug: string, platform: UploadPlatform, creds: OAuthClientCreds): Promise<void> {
  await writeSecretsV2(slug, (v2) => {
    const rich = v2 as SecretsV2Upload
    if (!rich.upload_oauth_client) rich.upload_oauth_client = {}
    rich.upload_oauth_client[platform] = { client_id: creds.client_id, client_secret: creds.client_secret }
  })
}

export async function deleteOAuthClient(slug: string, platform: UploadPlatform): Promise<void> {
  await writeSecretsV2(slug, (v2) => {
    const rich = v2 as SecretsV2Upload
    if (rich.upload_oauth_client?.[platform]) {
      delete rich.upload_oauth_client[platform]
    }
  })
}

// ── Token storage ─────────────────────────────────────────────────────────

export async function readTokens(slug: string, platform: UploadPlatform, account_id: string): Promise<OAuthTokenBundle | null> {
  const v2 = await readSecretsV2(slug) as SecretsV2Upload
  const rec = v2.upload?.[platform]?.[account_id]
  if (!rec?.access_token || !rec?.refresh_token) return null
  return rec
}

export async function writeTokens(slug: string, platform: UploadPlatform, account_id: string, tokens: OAuthTokenBundle): Promise<void> {
  await writeSecretsV2(slug, (v2) => {
    const rich = v2 as SecretsV2Upload
    if (!rich.upload) rich.upload = {}
    if (!rich.upload[platform]) rich.upload[platform] = {}
    rich.upload[platform]![account_id] = tokens
  })
}

export async function deleteTokens(slug: string, platform: UploadPlatform, account_id: string): Promise<void> {
  await writeSecretsV2(slug, (v2) => {
    const rich = v2 as SecretsV2Upload
    const bucket = rich.upload?.[platform]
    if (bucket && bucket[account_id]) {
      delete bucket[account_id]
      if (!Object.keys(bucket).length) delete rich.upload![platform]
    }
  })
}

// ── Public accounts (config.json) ─────────────────────────────────────────

export async function listAccounts(slug: string, platform: UploadPlatform): Promise<UploadAccount[]> {
  const config = (await pm.getConfig(slug)) as any
  const list = config?.upload_accounts?.[platform]
  return Array.isArray(list) ? list : []
}

export async function listAllAccounts(slug: string): Promise<Partial<Record<UploadPlatform, UploadAccount[]>>> {
  const out: Partial<Record<UploadPlatform, UploadAccount[]>> = {}
  for (const p of UPLOAD_PLATFORMS) {
    out[p] = await listAccounts(slug, p)
  }
  return out
}

export async function getDefaultAccountId(slug: string, platform: UploadPlatform): Promise<string> {
  const config = (await pm.getConfig(slug)) as any
  return typeof config?.upload_default_account?.[platform] === 'string'
    ? config.upload_default_account[platform]
    : ''
}

export async function setDefaultAccountId(slug: string, platform: UploadPlatform, accountId: string): Promise<void> {
  const config = (await pm.getConfig(slug)) as any
  const next = { ...(config?.upload_default_account || {}), [platform]: accountId }
  await pm.updateConfig(slug, { upload_default_account: next } as any)
}

// ── Upload mode (apply-plan vs private-first) ─────────────────────────────
// Per-platform toggle. `apply-plan` (default) means our Plan schedules get
// pushed to YouTube's `publishAt` field on upload and whenever the user
// clicks Apply. `private` means uploads go up as `private` with no
// publishAt — the user takes over scheduling inside YouTube Studio.

export type UploadMode = 'apply-plan' | 'private'

export async function getUploadMode(slug: string, platform: UploadPlatform): Promise<UploadMode> {
  const config = (await pm.getConfig(slug)) as any
  const mode = config?.upload_mode?.[platform]
  return mode === 'private' ? 'private' : 'apply-plan'
}

export async function setUploadMode(slug: string, platform: UploadPlatform, mode: UploadMode): Promise<void> {
  const config = (await pm.getConfig(slug)) as any
  const next = { ...(config?.upload_mode || {}), [platform]: mode }
  await pm.updateConfig(slug, { upload_mode: next } as any)
}

export async function addAccount(slug: string, platform: UploadPlatform, partial: Omit<UploadAccount, 'id' | 'platform' | 'connected_at'>): Promise<UploadAccount> {
  const config = (await pm.getConfig(slug)) as any
  const existing: UploadAccount[] = Array.isArray(config?.upload_accounts?.[platform])
    ? config.upload_accounts[platform]
    : []

  // Single-account-per-project enforcement. Multi-account was the root
  // cause of the "uploaded to wrong account by accident" class of bugs —
  // the UI and mental model are much simpler when each project maps to
  // exactly one channel/page per platform. If the remote_id matches the
  // existing record, replace it (re-connect flow) and keep the same id so
  // sidecars/playlists referring to it stay valid. If the remote_id
  // differs the user has swapped channels: mint a FRESH id. Old sidecars
  // still pointing at the previous account_id will then hit the friendly
  // "No tokens for this account — reconnect YouTube" path in
  // youtube-client.ts, which signposts the per-row Reset button instead
  // of silently routing PATCH calls to the wrong channel and surfacing
  // an opaque YouTube 404.
  const matchByRemote = existing.find(a => a.remote_id === partial.remote_id)
  let id: string
  if (matchByRemote) {
    id = matchByRemote.id
  } else if (existing[0]) {
    id = `acc_${randomUUID()}`
    // Drop the previous account's tokens — they're orphaned now that the
    // record is being replaced.
    try { await deleteTokens(slug, platform, existing[0].id) } catch { /* non-fatal */ }
  } else {
    // v1.0.502 — Disconnect → Connect of the SAME channel used to mint a
    // fresh id here (removeAccount had already wiped the list, so
    // matchByRemote couldn't match), orphaning every plan + sidecar that
    // referenced the old account id — the "No tokens for this account"
    // error right after a reconnect that the auth banner itself
    // recommends. removeAccount now stashes the removed account's
    // (id, remote_id); when the user reconnects the SAME channel we
    // reuse the old id so all existing references keep working. A
    // different channel still gets a fresh id.
    const last = (config?.upload_last_removed_account || {})[platform]
    id = (last && typeof last.id === 'string' && last.remote_id === partial.remote_id)
      ? last.id
      : `acc_${randomUUID()}`
  }
  const record: UploadAccount = {
    id,
    platform,
    label: partial.label,
    remote_id: partial.remote_id,
    remote_title: partial.remote_title,
    custom_url: partial.custom_url,
    thumbnail_url: partial.thumbnail_url,
    connected_at: new Date().toISOString(),
  }
  // Always keep the list at exactly one element — we replaced whatever was there.
  const nextList = [record]
  const nextAccounts = { ...(config?.upload_accounts || {}), [platform]: nextList }

  // Always set as default — single account = single default.
  const nextDefault = { ...(config?.upload_default_account || {}), [platform]: id }

  await pm.updateConfig(slug, {
    upload_accounts: nextAccounts,
    upload_default_account: nextDefault,
  } as any)
  return record
}

export async function removeAccount(slug: string, platform: UploadPlatform, accountId: string): Promise<boolean> {
  const config = (await pm.getConfig(slug)) as any
  const existing: UploadAccount[] = Array.isArray(config?.upload_accounts?.[platform])
    ? config.upload_accounts[platform]
    : []
  const nextList = existing.filter(a => a.id !== accountId)
  if (nextList.length === existing.length) return false

  // Capture the refresh_token BEFORE wiping local storage so we can ask
  // Google to invalidate its server-side grant too. Best-effort: any
  // failure here is swallowed inside revokeToken itself.
  const tokens = await readTokens(slug, platform, accountId)
  if (tokens?.refresh_token && platform === 'youtube') {
    // Fire-and-forget — don't block the user's disconnect on Google's
    // response time. Failure only leaves Story Studio in their
    // authorized-apps list; local tokens are wiped regardless.
    revokeToken(tokens.refresh_token).catch(() => {})
  }

  const nextAccounts = { ...(config?.upload_accounts || {}), [platform]: nextList }
  const nextDefault = { ...(config?.upload_default_account || {}) }
  if (nextDefault[platform] === accountId) {
    nextDefault[platform] = nextList[0]?.id || ''
  }
  // v1.0.502 — remember the removed account's identity so a reconnect of the
  // SAME channel can reuse its id (see addAccount) instead of orphaning every
  // plan/sidecar that references it.
  const removed = existing.find(a => a.id === accountId)
  const nextLastRemoved = {
    ...(config?.upload_last_removed_account || {}),
    [platform]: removed ? { id: removed.id, remote_id: removed.remote_id } : undefined,
  }
  await pm.updateConfig(slug, {
    upload_accounts: nextAccounts,
    upload_default_account: nextDefault,
    upload_last_removed_account: nextLastRemoved,
  } as any)
  // Drop tokens too.
  await deleteTokens(slug, platform, accountId)
  return true
}

/**
 * v1.0.502 — resolve a possibly-STALE account id to one that actually has
 * tokens. Projects are single-account-per-platform by design (see addAccount),
 * so when a stored reference (plan.account_id / sidecar.account_id) points at
 * an account that no longer exists — the disconnect→reconnect flow used to
 * mint a fresh id — falling back to the project's current (only) account is
 * safe and is what the user means. Returns `preferredId` unchanged when its
 * tokens exist OR when no healthier fallback is available (callers then hit
 * the friendly "No tokens" error as before).
 */
export async function resolveUsableAccountId(
  slug: string,
  platform: UploadPlatform,
  preferredId: string | null | undefined,
): Promise<string> {
  const preferred = preferredId || ''
  if (preferred && await readTokens(slug, platform, preferred)) return preferred
  const config = (await pm.getConfig(slug)) as any
  const accounts: UploadAccount[] = Array.isArray(config?.upload_accounts?.[platform])
    ? config.upload_accounts[platform]
    : []
  // Only fall back when the preferred account is GONE from the list — if it
  // still exists but merely lost its tokens, "reconnect" is the right fix and
  // silently rerouting could cross channels.
  if (accounts.some(a => a.id === preferred)) return preferred
  const currentId = (config?.upload_default_account?.[platform] as string) || accounts[0]?.id || ''
  if (currentId && await readTokens(slug, platform, currentId)) return currentId
  return preferred
}
