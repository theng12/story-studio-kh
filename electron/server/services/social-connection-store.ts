/**
 * The Facebook / Instagram / TikTok connection registry.
 *
 * Mirrors `youtube-connection-store.ts` deliberately: one application per OAuth
 * provider, a map of connected accounts, and a per-project assignment. The
 * public file holds identity only; every secret lives in the owner-only
 * `app-secrets.json` bucket (`SocialSecretBucket`) and never crosses this
 * boundary.
 *
 * One deliberate difference from YouTube: there is no quota ledger and no
 * "pending registry transaction". Meta and TikTok publish no comparable daily
 * allowance, and the two-file update this file does (registry + secrets) is
 * ordered so that a crash leaves a connectable account rather than a half
 * credential — see `saveSocialAccountGrant`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { writeJsonAtomic, withCrossProcessLock } from '../lib/atomic-store.js'
import {
  PLATFORM_PROVIDER,
  SOCIAL_PLATFORMS,
  SocialError,
  isValidSocialAccountId,
  type SocialAccountRecord,
  type SocialApplicationRecord,
  type SocialOAuthProvider,
  type SocialPlatform,
} from '../contracts/social-publishing.js'
import { readAppSecrets, writeAppSecrets, type SocialAccountTokenSecret } from './app-secrets-store.js'
import { getConfig, getUserDataDir } from './project-manager.js'

export interface SocialConnectionRegistryV1 {
  schema_version: 1
  applications: Partial<Record<SocialOAuthProvider, SocialApplicationRecord>>
  /** Keyed by `${platform}:${remote_id}`. */
  accounts: Record<string, SocialAccountRecord>
}

const REGISTRY_CORRUPT = 'The Facebook, Instagram and TikTok connection registry is corrupt.'

export function socialConnectionsPath(): string {
  return path.join(getUserDataDir(), 'social', 'connections.json')
}

function emptyRegistry(): SocialConnectionRegistryV1 {
  return { schema_version: 1, applications: {}, accounts: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function corrupt(): SocialError {
  return new SocialError(500, 'SOCIAL_CONNECTION_REGISTRY_CORRUPT', REGISTRY_CORRUPT)
}


export function socialAccountKey(platform: SocialPlatform, remoteId: string): string {
  return `${platform}:${remoteId}`
}

function decodeApplication(provider: SocialOAuthProvider, value: unknown): SocialApplicationRecord {
  if (!isRecord(value)) throw corrupt()
  for (const field of ['application_id', 'client_id', 'redirect_uri', 'configured_at', 'updated_at'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) throw corrupt()
  }
  if (value.provider !== provider) throw corrupt()
  return {
    provider,
    application_id: value.application_id as string,
    client_id: value.client_id as string,
    redirect_uri: value.redirect_uri as string,
    configured_at: value.configured_at as string,
    updated_at: value.updated_at as string,
  }
}

function decodeAccount(key: string, value: unknown): SocialAccountRecord {
  if (!isRecord(value)) throw corrupt()
  const platform = value.platform
  if (!SOCIAL_PLATFORMS.includes(platform as SocialPlatform)) throw corrupt()
  if (key !== socialAccountKey(platform as SocialPlatform, String(value.remote_id))) throw corrupt()
  if (!isValidSocialAccountId(value.remote_id)) throw corrupt()
  for (const field of ['application_id', 'remote_name', 'connected_at', 'updated_at'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) throw corrupt()
  }
  if (value.status !== 'connected' && value.status !== 'reconnect_required') throw corrupt()
  if (value.page_id !== undefined && !isValidSocialAccountId(value.page_id)) throw corrupt()
  const record: SocialAccountRecord = {
    platform: platform as SocialPlatform,
    provider: PLATFORM_PROVIDER[platform as SocialPlatform],
    application_id: value.application_id as string,
    remote_id: value.remote_id as string,
    remote_name: value.remote_name as string,
    connected_at: value.connected_at as string,
    updated_at: value.updated_at as string,
    status: value.status,
  }
  if (typeof value.page_id === 'string') record.page_id = value.page_id
  return record
}

function decodeRegistry(raw: unknown): SocialConnectionRegistryV1 {
  if (!isRecord(raw) || raw.schema_version !== 1) throw corrupt()
  const registry = emptyRegistry()
  if (raw.applications !== undefined) {
    if (!isRecord(raw.applications)) throw corrupt()
    for (const [provider, value] of Object.entries(raw.applications)) {
      if (provider !== 'meta' && provider !== 'tiktok') throw corrupt()
      registry.applications[provider] = decodeApplication(provider, value)
    }
  }
  if (raw.accounts !== undefined) {
    if (!isRecord(raw.accounts)) throw corrupt()
    for (const [key, value] of Object.entries(raw.accounts)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw corrupt()
      registry.accounts[key] = decodeAccount(key, value)
    }
  }
  return registry
}

async function readRegistryUnlocked(filePath: string): Promise<SocialConnectionRegistryV1> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
    throw error
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw corrupt() }
  return decodeRegistry(raw)
}

async function writeRegistryUnlocked(filePath: string, registry: SocialConnectionRegistryV1): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await writeJsonAtomic(filePath, registry, { mode: 0o600 })
}

export async function readSocialConnectionRegistry(): Promise<SocialConnectionRegistryV1> {
  const filePath = socialConnectionsPath()
  return withCrossProcessLock(filePath, () => readRegistryUnlocked(filePath))
}

/**
 * Save one OAuth application. Replacing the application invalidates every
 * grant that came from the old one — the caller reports how many, because a
 * silent invalidation turns into "reconnect required" with no explanation.
 */
export async function configureSocialApplication(input: {
  provider: SocialOAuthProvider
  client_id: string
  client_secret: string
  redirect_uri: string
}): Promise<{ application: SocialApplicationRecord; invalidated_accounts: number }> {
  const clientId = input.client_id.trim()
  const clientSecret = input.client_secret.trim()
  const redirectUri = input.redirect_uri.trim()
  if (!clientId || !clientSecret) {
    throw new SocialError(400, 'SOCIAL_APPLICATION_NOT_CONFIGURED', 'A client ID and client secret are both required.')
  }
  if (!/^https?:\/\/[^\s]+$/.test(redirectUri)) {
    throw new SocialError(400, 'SOCIAL_APPLICATION_NOT_CONFIGURED', 'The redirect URI must be an absolute http or https address.')
  }

  // The fingerprint is what makes "same application" a fact rather than a
  // guess: the provider never returns a stable app id we can compare.
  const applicationId = `${input.provider}:${clientId}`
  const now = new Date().toISOString()
  const filePath = socialConnectionsPath()
  let result: { application: SocialApplicationRecord; invalidated_accounts: number } | null = null

  await withCrossProcessLock(filePath, async () => {
    const registry = await readRegistryUnlocked(filePath)
    const previous = registry.applications[input.provider]
    let invalidated = 0
    if (previous && previous.application_id !== applicationId) {
      for (const [key, account] of Object.entries(registry.accounts)) {
        if (account.provider !== input.provider) continue
        registry.accounts[key] = { ...account, status: 'reconnect_required', updated_at: now }
        invalidated += 1
      }
    }
    const application: SocialApplicationRecord = {
      provider: input.provider,
      application_id: applicationId,
      client_id: clientId,
      redirect_uri: redirectUri,
      configured_at: previous?.configured_at ?? now,
      updated_at: now,
    }
    registry.applications[input.provider] = application
    await writeRegistryUnlocked(filePath, registry)
    result = { application, invalidated_accounts: invalidated }
  })

  await writeAppSecrets((secrets) => {
    const social = secrets.social ?? {}
    social.applications = { ...(social.applications ?? {}), [input.provider]: { application_id: applicationId, client_secret: clientSecret } }
    secrets.social = social
  })

  return result!
}

/** The client secret, for the server only. Never returned by a route. */
export async function readSocialApplicationSecret(provider: SocialOAuthProvider): Promise<{
  application: SocialApplicationRecord
  client_secret: string
} | null> {
  const registry = await readSocialConnectionRegistry()
  const application = registry.applications[provider]
  if (!application) return null
  const bucket = (await readAppSecrets()).social?.applications?.[provider]
  if (!bucket || bucket.application_id !== application.application_id) return null
  return { application, client_secret: bucket.client_secret }
}

/**
 * Save one connected account and its tokens.
 *
 * Order matters. The tokens are written FIRST and the public account record
 * second, so an interruption leaves an unreferenced credential (harmless,
 * overwritten on the next connect) rather than an account the UI calls
 * connected with nothing to sign in with.
 */
export async function saveSocialAccountGrant(input: {
  platform: SocialPlatform
  application_id: string
  remote_id: string
  remote_name: string
  page_id?: string
  tokens: SocialAccountTokenSecret
}): Promise<SocialAccountRecord> {
  const key = socialAccountKey(input.platform, input.remote_id)
  await writeAppSecrets((secrets) => {
    const social = secrets.social ?? {}
    social.account_tokens = { ...(social.account_tokens ?? {}), [key]: { ...input.tokens } }
    secrets.social = social
  })

  const filePath = socialConnectionsPath()
  let saved: SocialAccountRecord | null = null
  await withCrossProcessLock(filePath, async () => {
    const registry = await readRegistryUnlocked(filePath)
    const now = new Date().toISOString()
    const previous = registry.accounts[key]
    const account: SocialAccountRecord = {
      platform: input.platform,
      provider: PLATFORM_PROVIDER[input.platform],
      application_id: input.application_id,
      remote_id: input.remote_id,
      remote_name: input.remote_name,
      connected_at: previous?.connected_at ?? now,
      updated_at: now,
      status: 'connected',
      ...(input.page_id ? { page_id: input.page_id } : {}),
    }
    registry.accounts[key] = account
    await writeRegistryUnlocked(filePath, registry)
    saved = account
  })
  return saved!
}

export async function readSocialAccountTokens(platform: SocialPlatform, remoteId: string): Promise<SocialAccountTokenSecret | null> {
  const bucket = (await readAppSecrets()).social?.account_tokens?.[socialAccountKey(platform, remoteId)]
  return bucket ?? null
}

/** Persist a refreshed token bundle without touching the public record. */
export async function updateSocialAccountTokens(platform: SocialPlatform, remoteId: string, tokens: SocialAccountTokenSecret): Promise<void> {
  const key = socialAccountKey(platform, remoteId)
  await writeAppSecrets((secrets) => {
    const social = secrets.social ?? {}
    social.account_tokens = { ...(social.account_tokens ?? {}), [key]: { ...tokens } }
    secrets.social = social
  })
}

export async function disconnectSocialAccount(platform: SocialPlatform, remoteId: string): Promise<void> {
  const key = socialAccountKey(platform, remoteId)
  await writeAppSecrets((secrets) => {
    if (!secrets.social?.account_tokens) return
    delete secrets.social.account_tokens[key]
  })
  const filePath = socialConnectionsPath()
  await withCrossProcessLock(filePath, async () => {
    const registry = await readRegistryUnlocked(filePath)
    delete registry.accounts[key]
    await writeRegistryUnlocked(filePath, registry)
  })
}

/** The account this channel posts to, per platform. Absent means the channel did not connect it. */
export async function readProjectSocialAccounts(slug: string): Promise<Partial<Record<SocialPlatform, string>>> {
  const config = await getConfig(slug)
  const raw = (config as Record<string, unknown> | null)?.social_accounts
  if (!isRecord(raw)) return {}
  const result: Partial<Record<SocialPlatform, string>> = {}
  for (const platform of SOCIAL_PLATFORMS) {
    const value = raw[platform]
    if (isValidSocialAccountId(value)) result[platform] = value
  }
  return result
}

/**
 * The platforms this channel posts to by default.
 *
 * Absent is not "none": it is "the owner has not chosen yet", which the upload
 * page renders as unticked. The distinction is the whole opt-in rule — a
 * channel that never opened this setting must post to nothing.
 */
export async function readProjectSocialOptIn(slug: string): Promise<SocialPlatform[]> {
  const config = await getConfig(slug)
  const raw = (config as Record<string, unknown> | null)?.social_platforms
  if (!Array.isArray(raw)) return []
  const chosen = new Set(raw.filter(value => SOCIAL_PLATFORMS.includes(value as SocialPlatform)))
  return SOCIAL_PLATFORMS.filter(platform => chosen.has(platform))
}

/**
 * Whether a channel may post to a platform right now: it has a connected
 * account for it. The per-upload tick is the gate — a platform the owner
 * ticked but never connected is not "ready", and saying which one is the
 * difference between a clear refusal and a mystery failure.
 */
export async function resolveSocialTargets(slug: string, requested: readonly SocialPlatform[]): Promise<{
  ready: Array<{ platform: SocialPlatform; account: SocialAccountRecord }>
  notConnected: SocialPlatform[]
}> {
  const accounts = await readProjectSocialAccounts(slug)
  const registry = await readSocialConnectionRegistry()
  const ready: Array<{ platform: SocialPlatform; account: SocialAccountRecord }> = []
  const notConnected: SocialPlatform[] = []
  for (const platform of requested) {
    const remoteId = accounts[platform]
    const account = remoteId ? registry.accounts[socialAccountKey(platform, remoteId)] : undefined
    if (!account || account.status !== 'connected') { notConnected.push(platform); continue }
    ready.push({ platform, account })
  }
  return { ready, notConnected }
}
