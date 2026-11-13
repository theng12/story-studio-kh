/**
 * App-level secrets store.
 *
 * One plaintext file per Mac at `<userData>/app-secrets.json`, mode 0600,
 * written atomically. Legacy encryption is handled only by the boot migration.
 *
 * Replaces the per-project `secrets.json` model. Project folders may live
 * in iCloud Drive across multiple Macs, so secrets stored inside them got
 * synced and produced "credentials came from a different machine" warnings
 * on every device switch. App-level state lives in userData (never synced),
 * so each Mac has its own keys and the cross-machine warning is gone.
 *
 * Schema (v3):
 *   {
 *     schema_version: 3,
 *     providers: {
 *       genstudio:  { apiKey: '...' },
 *       ...
 *     }
 *   }
 *
 * Single key per provider — no multi-account support. (Personal-use; if a
 * future need ever justifies it, add an `accounts` array; readers and
 * writers are small enough to migrate.)
 */
import { randomUUID } from 'node:crypto'
import fs from 'fs/promises'
import path from 'path'
import { writeJsonAtomic, withCrossProcessLock } from '../lib/atomic-store.js'
import { registerSecretForRedaction } from '../lib/redact-secrets.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { resolveStoryStudioVersion } from '../lib/app-version.js'
import { logLine } from './logger.js'
import { getUserDataDir } from './project-manager.js'
import { isValidYouTubeChannelId } from '../contracts/youtube-upload-center.js'

export const APP_SECRETS_SCHEMA_VERSION = 3 as const
const MAX_CONTENT_STORE_ANCHOR_KEYS = 100
const MAX_CONTENT_STORE_ANCHORS = 20

export const SECRET_PROVIDERS = [
  // GenStudio KH is the single generation credential.
  'genstudio',
  // Non-generation integrations remain independent from GenStudio.
  'google',
] as const
export type ProviderId = typeof SECRET_PROVIDERS[number]

export interface AppSecretsV3 {
  schema_version: typeof APP_SECRETS_SCHEMA_VERSION
  // `userSet` marks a value the user explicitly saved (vs a default that an
  // older app version carried into storage). Explicitly-saved values are
  // NEVER rewritten by the legacy-default migration — see getApiKey. This
  // is what makes the per-machine local-modal URLs (voicestudio/imagestudio)
  // fully user-controlled: whatever you Save is what the app uses.
  providers: Partial<Record<ProviderId, { apiKey: string; userSet?: boolean; generation?: string }>>
  /** Server-only YouTube credentials; never returned by public routes. */
  youtube?: YouTubeSecretBucket
  /** Server-only Facebook / Instagram / TikTok credentials; never returned by public routes. */
  social?: SocialSecretBucket
}

export interface ContentStoreKeyAnchor {
  origin: string
  account_id: string
  content_account_id: string
  keys: Array<{ key_id: string; public_key_base64: string }>
}

export interface OAuthTokenBundle {
  access_token: string
  refresh_token: string
  expires_at: number
  scope?: string
}

export interface YouTubeOAuthClientSecret {
  application_id: string
  client_secret: string
}

export interface YouTubeChannelTokenSecret extends OAuthTokenBundle {
  application_id: string
}

export interface YouTubePendingRegistryTransaction {
  transaction_id: string
  registry: Record<string, unknown>
}

export interface YouTubeSecretBucket {
  oauth_client?: YouTubeOAuthClientSecret
  channel_tokens?: Record<string, YouTubeChannelTokenSecret>
  pending_registry?: YouTubePendingRegistryTransaction
}

export interface SocialOAuthClientSecret {
  application_id: string
  client_secret: string
}

export interface SocialAccountTokenSecret extends OAuthTokenBundle {
  application_id: string
  /**
   * The Facebook Page access token for Facebook and Instagram posts. A Page
   * token is a DIFFERENT credential from the user token in the fields above:
   * it is what authorizes `POST /{page-id}/video_reels`. Absent for TikTok,
   * which posts with the user token itself.
   */
  page_token?: string
  /** When the Page token stops being usable, when the provider published one. */
  page_token_expires_at?: number
}

/**
 * Facebook, Instagram and TikTok credentials. Same rule as YouTube: the whole
 * bucket is server-only, lives in the owner-only file, and every secret
 * in it is registered for log redaction on read.
 */
export interface SocialSecretBucket {
  /** Keyed by OAuth provider: one Meta app serves Facebook and Instagram. */
  applications?: Partial<Record<'meta' | 'tiktok', SocialOAuthClientSecret>>
  /** Keyed by `${platform}:${remote_id}`. */
  account_tokens?: Record<string, SocialAccountTokenSecret>
}

interface ContentStoreAnchorState {
  schema_version: 1
  anchors: ContentStoreKeyAnchor[]
}

type SecretRead =
  | { kind: 'missing' }
  | { kind: 'plaintext'; value: unknown }
  | { kind: 'legacy-encrypted' }
  | { kind: 'invalid' }
  | { kind: 'io-error'; error: unknown }

async function logSecretMutation(meta: Record<string, unknown>): Promise<void> {
  let appVersion = 'unavailable'
  try { appVersion = await resolveStoryStudioVersion() } catch { /* package metadata may itself be unavailable */ }
  try {
    logLine(meta.result === 'written' ? 'info' : 'warn', 'secret-store mutation', {
      ...meta, app_version: appVersion, pid: process.pid,
    })
  } catch { /* preserve the mutation result even if diagnostics cannot be written */ }
}

export class SecretsFileError extends Error {
  constructor(public readonly stage: 'store-invalid' | 'store-unreadable') {
    super(stage === 'store-invalid' ? 'The saved credentials file is invalid.' : 'The saved credentials file could not be read.')
    this.name = 'SecretsFileError'
  }
}

function emptyV3(): AppSecretsV3 {
  return { schema_version: APP_SECRETS_SCHEMA_VERSION, providers: {} }
}

function isKnownProvider(p: string): p is ProviderId {
  return (SECRET_PROVIDERS as readonly string[]).includes(p)
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
}

function hasOnlyKeys(source: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed)
  return Object.keys(source).every(key => accepted.has(key))
}

/** Strictly parse the bucket so an unrelated provider save can never erase damaged or future fields. */
function parseYouTubeSecretBucket(raw: unknown): YouTubeSecretBucket | null {
  if (!isRecord(raw)) return null
  const source = raw as Record<string, unknown>
  if (!hasOnlyKeys(source, ['oauth_client', 'channel_tokens', 'pending_registry'])) return null
  const result: YouTubeSecretBucket = {}
  if (Object.hasOwn(source, 'oauth_client')) {
    const oauthClient = source.oauth_client
    if (!isRecord(oauthClient) || !hasOnlyKeys(oauthClient, ['application_id', 'client_secret'])) return null
    const value = oauthClient as Record<string, unknown>
    if (typeof value.application_id !== 'string' || !value.application_id
      || typeof value.client_secret !== 'string' || !value.client_secret) return null
    result.oauth_client = { application_id: value.application_id, client_secret: value.client_secret }
  }
  if (Object.hasOwn(source, 'channel_tokens')) {
    const channelTokens = source.channel_tokens
    if (!isRecord(channelTokens)) return null
    const entries: Array<[string, YouTubeChannelTokenSecret]> = []
    for (const [channelId, rawToken] of Object.entries(channelTokens)) {
      if (!isValidYouTubeChannelId(channelId)
        || !isRecord(rawToken)
        || !hasOnlyKeys(rawToken, ['application_id', 'access_token', 'refresh_token', 'expires_at', 'scope'])) return null
      const value = rawToken as Record<string, unknown>
      if (typeof value.application_id !== 'string' || !value.application_id
        || typeof value.access_token !== 'string' || !value.access_token
        || typeof value.refresh_token !== 'string' || !value.refresh_token
        || typeof value.expires_at !== 'number' || !Number.isFinite(value.expires_at)) return null
      const token: YouTubeChannelTokenSecret = {
        application_id: value.application_id,
        access_token: value.access_token,
        refresh_token: value.refresh_token,
        expires_at: value.expires_at,
      }
      if (Object.hasOwn(value, 'scope')) {
        if (typeof value.scope !== 'string' || !value.scope.trim()) return null
        token.scope = value.scope.trim().split(/\s+/).join(' ')
      }
      entries.push([channelId, token])
    }
    result.channel_tokens = Object.fromEntries(entries)
  }
  if (Object.hasOwn(source, 'pending_registry')) {
    const pending = source.pending_registry
    if (!isRecord(pending) || !hasOnlyKeys(pending, ['transaction_id', 'registry'])) return null
    const value = pending as Record<string, unknown>
    if (typeof value.transaction_id !== 'string' || !value.transaction_id) return null
    if (!isRecord(value.registry)) return null
    // `readSecretFile` already JSON-parsed this snapshot, so it is JSON-safe.
    // Keep its full shape; the connection registry's decoder validates it on recovery.
    result.pending_registry = { transaction_id: value.transaction_id, registry: value.registry }
  }
  registerYouTubeSecrets(result)
  return result
}

function registerYouTubeSecrets(bucket: YouTubeSecretBucket | undefined): void {
  if (!bucket) return
  if (bucket.oauth_client) registerSecretForRedaction(bucket.oauth_client.client_secret)
  for (const token of Object.values(bucket.channel_tokens ?? {})) {
    registerSecretForRedaction(token.access_token)
    registerSecretForRedaction(token.refresh_token)
  }
}

/**
 * Same discipline as the YouTube bucket: strict, and a field this build does
 * not know about makes the whole bucket invalid rather than silently dropped.
 * The alternative is a later rewrite that erases a credential the owner
 * connected.
 */
function parseSocialSecretBucket(raw: unknown): SocialSecretBucket | null {
  if (!isRecord(raw)) return null
  const source = raw as Record<string, unknown>
  if (!hasOnlyKeys(source, ['applications', 'account_tokens'])) return null
  const result: SocialSecretBucket = {}
  if (Object.hasOwn(source, 'applications')) {
    const applications = source.applications
    if (!isRecord(applications)) return null
    const parsed: NonNullable<SocialSecretBucket['applications']> = {}
    for (const [provider, rawClient] of Object.entries(applications)) {
      if (provider !== 'meta' && provider !== 'tiktok') return null
      if (!isRecord(rawClient) || !hasOnlyKeys(rawClient, ['application_id', 'client_secret'])) return null
      if (typeof rawClient.application_id !== 'string' || !rawClient.application_id
        || typeof rawClient.client_secret !== 'string' || !rawClient.client_secret) return null
      parsed[provider] = { application_id: rawClient.application_id, client_secret: rawClient.client_secret }
    }
    result.applications = parsed
  }
  if (Object.hasOwn(source, 'account_tokens')) {
    const tokens = source.account_tokens
    if (!isRecord(tokens)) return null
    const entries: Array<[string, SocialAccountTokenSecret]> = []
    for (const [key, rawToken] of Object.entries(tokens)) {
      if (!/^(facebook|instagram|tiktok):[A-Za-z0-9_-]{1,128}$/.test(key)
        || !isRecord(rawToken)
        || !hasOnlyKeys(rawToken, [
          'application_id', 'access_token', 'refresh_token', 'expires_at', 'scope',
          'page_token', 'page_token_expires_at',
        ])) return null
      if (typeof rawToken.application_id !== 'string' || !rawToken.application_id
        || typeof rawToken.access_token !== 'string' || !rawToken.access_token
        || typeof rawToken.refresh_token !== 'string'
        || typeof rawToken.expires_at !== 'number' || !Number.isFinite(rawToken.expires_at)) return null
      const token: SocialAccountTokenSecret = {
        application_id: rawToken.application_id,
        access_token: rawToken.access_token,
        refresh_token: rawToken.refresh_token,
        expires_at: rawToken.expires_at,
      }
      if (Object.hasOwn(rawToken, 'scope')) {
        if (typeof rawToken.scope !== 'string') return null
        token.scope = rawToken.scope
      }
      if (Object.hasOwn(rawToken, 'page_token')) {
        if (typeof rawToken.page_token !== 'string' || !rawToken.page_token) return null
        token.page_token = rawToken.page_token
      }
      if (Object.hasOwn(rawToken, 'page_token_expires_at')) {
        if (typeof rawToken.page_token_expires_at !== 'number'
          || !Number.isFinite(rawToken.page_token_expires_at)) return null
        token.page_token_expires_at = rawToken.page_token_expires_at
      }
      entries.push([key, token])
    }
    result.account_tokens = Object.fromEntries(entries)
  }
  registerSocialSecrets(result)
  return result
}

function registerSocialSecrets(bucket: SocialSecretBucket | undefined): void {
  if (!bucket) return
  for (const client of Object.values(bucket.applications ?? {})) {
    registerSecretForRedaction(client?.client_secret)
  }
  for (const token of Object.values(bucket.account_tokens ?? {})) {
    registerSecretForRedaction(token.access_token)
    registerSecretForRedaction(token.refresh_token)
    registerSecretForRedaction(token.page_token)
  }
}

/**
 * Path is `<userData>/app-secrets.json`. Honours STORY_STUDIO_DATA_DIR for
 * tests via `getUserDataDir()`.
 */
export function appSecretsPath(): string {
  return path.join(getUserDataDir(), 'app-secrets.json')
}

export function contentStoreAnchorsPath(): string {
  return path.join(getUserDataDir(), 'content-store-key-anchors.json')
}

async function readSecretFile(filePath: string): Promise<SecretRead> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'io-error', error }
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { kind: 'invalid' } }
  if (isRecord(raw) && raw.__encrypted === true) return { kind: 'legacy-encrypted' }
  if (isRecord(raw) && '__encrypted' in raw) return { kind: 'invalid' }
  return { kind: 'plaintext', value: raw }
}

function parseV3Base(raw: unknown): AppSecretsV3 | null {
  const out = emptyV3()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.schema_version !== APP_SECRETS_SCHEMA_VERSION || !record.providers
    || typeof record.providers !== 'object' || Array.isArray(record.providers)) return null
  const providers = record.providers as Record<string, unknown>
  if (providers) {
    for (const [k, v] of Object.entries(providers)) {
      if (!isKnownProvider(k) || !isRecord(v) || !hasOnlyKeys(v, ['apiKey', 'userSet', 'generation'])) return null
      if (typeof v.apiKey !== 'string' || !v.apiKey) return null
      if (Object.hasOwn(v, 'userSet') && typeof v.userSet !== 'boolean') return null
      if (Object.hasOwn(v, 'generation')
        && (typeof v.generation !== 'string' || !v.generation || v.generation.length > 128)) return null
      registerSecretForRedaction(v.apiKey)
      out.providers[k] = {
        apiKey: v.apiKey,
        ...(Object.hasOwn(v, 'userSet') ? { userSet: v.userSet as boolean } : {}),
        ...(Object.hasOwn(v, 'generation') ? { generation: v.generation as string } : {}),
      }
    }
  }
  return out
}

export function parseV3(raw: unknown): AppSecretsV3 | null {
  const out = parseV3Base(raw)
  if (!out) return null
  const record = raw as Record<string, unknown>
  if (Object.hasOwn(record, 'youtube')) {
    const youtube = parseYouTubeSecretBucket(record.youtube)
    if (!youtube) return null
    out.youtube = youtube
  }
  if (Object.hasOwn(record, 'social')) {
    const social = parseSocialSecretBucket(record.social)
    if (!social) return null
    out.social = social
  }
  return out
}

async function writeRaw(filePath: string, value: AppSecretsV3): Promise<void> {
  await writeJsonAtomic(filePath, value, { mode: 0o600 })
}

export function parseAnchorState(raw: unknown): ContentStoreAnchorState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.schema_version !== 1 || !Array.isArray(value.anchors) || value.anchors.length > MAX_CONTENT_STORE_ANCHORS) return null
  const anchors: ContentStoreKeyAnchor[] = []
  const scopes = new Set<string>()
  for (const candidate of value.anchors) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const row = candidate as Record<string, unknown>
    if (typeof row.origin !== 'string' || !row.origin || typeof row.account_id !== 'string' || !row.account_id
      || typeof row.content_account_id !== 'string' || !row.content_account_id
      || !Array.isArray(row.keys) || row.keys.length === 0 || row.keys.length > MAX_CONTENT_STORE_ANCHOR_KEYS) return null
    const scope = `${row.origin}\u0000${row.account_id}\u0000${row.content_account_id}`
    if (scopes.has(scope)) return null
    scopes.add(scope)
    const keys: ContentStoreKeyAnchor['keys'] = []
    const keyIds = new Set<string>()
    for (const candidateKey of row.keys) {
      if (!candidateKey || typeof candidateKey !== 'object' || Array.isArray(candidateKey)) return null
      const key = candidateKey as Record<string, unknown>
      if (typeof key.key_id !== 'string' || !key.key_id || typeof key.public_key_base64 !== 'string' || !key.public_key_base64
        || keyIds.has(key.key_id)) return null
      keyIds.add(key.key_id)
      keys.push({ key_id: key.key_id, public_key_base64: key.public_key_base64 })
    }
    anchors.push({ origin: row.origin, account_id: row.account_id, content_account_id: row.content_account_id, keys })
  }
  return { schema_version: 1, anchors }
}

function decodeAnchorState(read: SecretRead): ContentStoreAnchorState {
  if (read.kind === 'missing' || read.kind === 'legacy-encrypted') return { schema_version: 1, anchors: [] }
  if (read.kind === 'io-error') throw new SecretsFileError('store-unreadable')
  if (read.kind === 'invalid') throw new SecretsFileError('store-invalid')
  const parsed = parseAnchorState(read.value)
  if (!parsed) throw new Error('Content Store key anchor payload is malformed or tampered')
  return parsed
}

async function readAnchorState(): Promise<ContentStoreAnchorState> {
  return decodeAnchorState(await readSecretFile(contentStoreAnchorsPath()))
}

async function writeAnchorState(filePath: string, state: ContentStoreAnchorState): Promise<void> {
  await writeJsonAtomic(filePath, state, { mode: 0o600 })
}

async function mutateContentStoreAnchorState(
  mutate: (state: ContentStoreAnchorState) => void | Promise<void>,
): Promise<void> {
  const filePath = contentStoreAnchorsPath()
  assertWriteIsolatedInTests(filePath, 'content-store-key-anchors')
  const operationId = randomUUID()
  let inputState: SecretRead['kind'] | 'not-read' = 'not-read'
  let backupOutcome = 'not-needed'
  let before: number | 'unavailable' = 'unavailable'
  let after: number | 'unavailable' = 'unavailable'
  try {
    await withCrossProcessLock(filePath, async () => {
      const read = await readSecretFile(filePath)
      inputState = read.kind
      const state = decodeAnchorState(read)
      before = state.anchors.reduce((count, anchor) => count + anchor.keys.length, 0)
      await mutate(state)
      after = state.anchors.reduce((count, anchor) => count + anchor.keys.length, 0)
      if (read.kind === 'legacy-encrypted') {
        await fs.rename(filePath, `${filePath}.legacy-encrypted-${Date.now()}`)
        backupOutcome = 'moved-aside'
      }
      await writeAnchorState(filePath, state)
    })
  } catch (error) {
    await logSecretMutation({
      operation: 'anchor-update', input_state: inputState, result: 'refused',
      anchor_key_count_before: before, anchor_key_count_after: before,
      backup_outcome: backupOutcome, operation_id: operationId,
    })
    throw error
  }
  await logSecretMutation({
    operation: 'anchor-update', input_state: inputState, result: 'written',
    anchor_key_count_before: before, anchor_key_count_after: after,
    backup_outcome: backupOutcome, operation_id: operationId,
  })
}

/** Missing and retired legacy files have no current values; corrupt plaintext stays unknown. */
export async function readAppSecrets(): Promise<AppSecretsV3> {
  const read = await readSecretFile(appSecretsPath())
  if (read.kind === 'missing' || read.kind === 'legacy-encrypted') return emptyV3()
  if (read.kind === 'io-error') throw new SecretsFileError('store-unreadable')
  if (read.kind === 'invalid') throw new SecretsFileError('store-invalid')
  const parsed = parseV3(read.value)
  if (!parsed) throw new SecretsFileError('store-invalid')
  return parsed
}

/**
 * Whether the YouTube-only credential bucket can be deliberately removed.
 * General provider corruption remains separate from a malformed YouTube bucket.
 * Legacy envelopes are retired on the next explicit save.
 */
export async function youtubeSecretRecoveryRequired(): Promise<boolean> {
  const read = await readSecretFile(appSecretsPath())
  if (read.kind === 'missing' || read.kind === 'legacy-encrypted') return false
  if (read.kind === 'io-error') throw read.error
  if (read.kind === 'invalid') throw new SecretsFileError('store-invalid')
  const base = parseV3Base(read.value)
  if (!base) throw new Error('App secrets provider payload is invalid')
  const record = read.value as Record<string, unknown>
  if (!Object.hasOwn(record, 'youtube')) return false
  return parseYouTubeSecretBucket(record.youtube) === null
}

/**
 * Stage a scoped YouTube credential reset while retaining valid provider keys.
 * The pending public-registry target makes the two-file update recoverable.
 */
export async function stageYouTubeSecretRecovery(
  pending: YouTubePendingRegistryTransaction,
): Promise<void> {
  const filePath = appSecretsPath()
  assertWriteIsolatedInTests(filePath, 'app-secrets')
  await withCrossProcessLock(filePath, async () => {
    const read = await readSecretFile(filePath)
    if (read.kind === 'io-error') throw read.error
    if (read.kind === 'missing' || read.kind === 'invalid' || read.kind === 'legacy-encrypted') {
      throw new Error('YouTube credentials are not eligible for scoped recovery')
    }
    const base = parseV3Base(read.value)
    if (!base) throw new Error('App secrets provider payload is invalid')
    const record = read.value as Record<string, unknown>
    if (Object.hasOwn(record, 'social')) {
      const social = parseSocialSecretBucket(record.social)
      if (!social) throw new SecretsFileError('store-invalid')
      base.social = social
    }
    const hasYouTube = Object.hasOwn(record, 'youtube')
    const eligible = hasYouTube && parseYouTubeSecretBucket(record.youtube) === null
    if (!eligible) throw new Error('YouTube credentials are not eligible for scoped recovery')
    base.youtube = { pending_registry: pending }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await writeRaw(filePath, base)
  })
  await logSecretMutation({
    operation: 'youtube-secret-recovery', input_state: 'recoverable', result: 'written',
    anchor_key_count_before: 'not-read', anchor_key_count_after: 'not-read',
    backup_outcome: 'not-needed', operation_id: pending.transaction_id,
  })
}

/** Atomically mutate the app-level secrets store. */
export async function writeAppSecrets(
  mutate: (v3: AppSecretsV3) => void | Promise<void>,
): Promise<AppSecretsV3> {
  const filePath = appSecretsPath()
  assertWriteIsolatedInTests(filePath, 'app-secrets')
  let result = emptyV3()
  const operationId = randomUUID()
  let inputState: SecretRead['kind'] = 'missing'
  let backupOutcome = 'not-needed'
  try {
    await withCrossProcessLock(filePath, async () => {
      const read = await readSecretFile(filePath)
      inputState = read.kind
      if (read.kind === 'io-error') throw new SecretsFileError('store-unreadable')
      if (read.kind === 'invalid') throw new SecretsFileError('store-invalid')
      const v3 = read.kind === 'missing' || read.kind === 'legacy-encrypted' ? emptyV3() : parseV3(read.value)
      if (!v3) throw new SecretsFileError('store-invalid')
      await mutate(v3)
      registerYouTubeSecrets(v3.youtube)
      registerSocialSecrets(v3.social)
      // Drop providers with empty keys.
      for (const pid of SECRET_PROVIDERS) {
        const bucket = v3.providers[pid]
        if (bucket && !bucket.apiKey) delete v3.providers[pid]
      }
      try { await fs.mkdir(path.dirname(filePath), { recursive: true }) } catch { /* race-safe */ }
      if (read.kind === 'legacy-encrypted') {
        await fs.rename(filePath, `${filePath}.legacy-encrypted-${Date.now()}`)
        backupOutcome = 'moved-aside'
      }
      await writeRaw(filePath, v3)
      result = v3
    })
  } catch (error) {
    await logSecretMutation({
      operation: 'provider-update', input_state: inputState, result: 'refused',
      anchor_key_count_before: 'not-read', anchor_key_count_after: 'not-read',
      backup_outcome: backupOutcome, operation_id: operationId,
    })
    throw error
  }
  await logSecretMutation({
    operation: 'provider-update', input_state: inputState, result: 'written',
    anchor_key_count_before: 'not-read', anchor_key_count_after: 'not-read',
    backup_outcome: backupOutcome, operation_id: operationId,
  })
  return result
}

/** Insert-only owner-only key mapping; a named GenStudio key can never repoint. */
export async function recordContentStoreKeyAnchor(anchor: ContentStoreKeyAnchor): Promise<void> {
  if (!anchor.origin || !anchor.account_id || !anchor.content_account_id || !anchor.keys.length || anchor.keys.length > MAX_CONTENT_STORE_ANCHOR_KEYS) {
    throw new Error('GenStudio Content Store key anchor is invalid')
  }
  await mutateContentStoreAnchorState(state => {
    const anchors = state.anchors
    const existing = anchors.find(candidate => candidate.origin === anchor.origin
      && candidate.account_id === anchor.account_id && candidate.content_account_id === anchor.content_account_id)
    if (!existing) {
      if (anchors.length >= 20) throw new Error('GenStudio Content Store key-anchor capacity reached')
      anchors.push({ ...anchor, keys: anchor.keys.map(key => ({ ...key })) })
      return
    }
    const additions = new Map<string, { key_id: string; public_key_base64: string }>()
    for (const key of anchor.keys) {
      const pinned = existing.keys.find(candidate => candidate.key_id === key.key_id)
      if (pinned && pinned.public_key_base64 !== key.public_key_base64) {
        throw new Error(`GenStudio Content Store signing key ${key.key_id} was repointed in the saved key anchor`)
      }
      const pending = additions.get(key.key_id)
      if (pending && pending.public_key_base64 !== key.public_key_base64) {
        throw new Error(`GenStudio Content Store signing key ${key.key_id} was repointed in the saved key anchor`)
      }
      if (!pinned) additions.set(key.key_id, { ...key })
    }
    if (existing.keys.length + additions.size > MAX_CONTENT_STORE_ANCHOR_KEYS) {
      throw new Error(`GenStudio Content Store key anchor exceeds ${MAX_CONTENT_STORE_ANCHOR_KEYS} keys`)
    }
    existing.keys.push(...additions.values())
  })
}

/** Returns only the owner-only mapping for one exact Store account/origin. */
export async function readContentStoreKeyAnchor(input: {
  origin: string
  account_id: string
  content_account_id: string
}): Promise<ContentStoreKeyAnchor | null> {
  const anchors = (await readAnchorState()).anchors
  const found = anchors.find(anchor => anchor.origin === input.origin
    && anchor.account_id === input.account_id && anchor.content_account_id === input.content_account_id)
  return found ? { ...found, keys: found.keys.map(key => ({ ...key })) } : null
}

/**
 * Returns the stored key for a known provider, verbatim.
 *
 * Historical note — a `migrateLegacyDefault` step used to sit here. It
 * rewrote stored *local-modal URLs* (the `voicestudio` / `imagestudio`
 * providers, which used "URL-as-secret" semantics) when they still held a
 * default shipped by v1.0.149-v1.0.157, resetting them to '' so the user got
 * the clean "unconfigured" setup state instead of a dead host.
 *
 * That migration became unreachable in v1.0.669 (commit 868a84f9,
 * 2026-07-23), when `voicestudio` and `imagestudio` were dropped from
 * SECRET_PROVIDERS for the GenStudio-only pipeline: `isKnownProvider` now
 * rejects both ids on the first line below, and `normaliseV3` discards their
 * stored entries on read. It survived only as dead code carrying a hardcoded
 * private network address, so it has been removed. No behaviour is lost —
 * no caller has been able to reach it since v1.0.669.
 *
 * `userSet` is still written by setApiKey and preserved by normaliseV3. It is
 * no longer consulted here only because there is no migration left for it to
 * override. If a value-rewriting migration is ever reintroduced, gate it on
 * `userSet` so an explicit Save always wins — that was the v1.0.206 fix.
 */
export async function getApiKey(providerId: string): Promise<string> {
  if (!isKnownProvider(providerId)) return ''
  const v3 = await readAppSecrets()
  return v3.providers[providerId]?.apiKey ?? ''
}

export async function setApiKey(providerId: string, apiKey: string): Promise<void> {
  if (!isKnownProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`)
  const trimmed = apiKey.trim()
  registerSecretForRedaction(trimmed)
  await writeAppSecrets((v3) => {
    if (!trimmed) {
      delete v3.providers[providerId]
    } else {
      v3.providers[providerId] = { apiKey: trimmed, userSet: true, generation: randomUUID() }
    }
  })
}

/** In-memory revalidation scope; generation changes on every explicit key save. */
export async function getApiKeySnapshot(providerId: string): Promise<{ apiKey: string; generation: string }> {
  if (!isKnownProvider(providerId)) return { apiKey: '', generation: '' }
  const bucket = (await readAppSecrets()).providers[providerId]
  return { apiKey: bucket?.apiKey ?? '', generation: bucket?.generation ?? 'legacy' }
}

export async function clearApiKey(providerId: string): Promise<void> {
  return setApiKey(providerId, '')
}

/**
 * Frontend-friendly summary — returns a row per provider with a masked-key
 * preview, so the UI can show "configured" / "missing" without ever
 * exposing the raw key.
 */
export interface ProviderKeySummary {
  providerId: ProviderId
  hasKey: boolean
  keyMasked: string
}

function maskKey(k: string): string {
  if (!k) return ''
  // Short keys have no preview: first4+last4 would expose too much.
  if (k.length < 12) return ''
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

export async function listProviderKeys(): Promise<ProviderKeySummary[]> {
  const v3 = await readAppSecrets()
  return SECRET_PROVIDERS.map((pid) => {
    const k = v3.providers[pid]?.apiKey ?? ''
    return { providerId: pid, hasKey: !!k, keyMasked: maskKey(k) }
  })
}
