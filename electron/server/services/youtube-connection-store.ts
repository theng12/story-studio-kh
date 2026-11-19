import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import { writeJsonAtomic, withCrossProcessLock } from '../lib/atomic-store.js'
import { registerSecretForRedaction } from '../lib/redact-secrets.js'
import type {
  YouTubeApplicationRecord,
  YouTubeChannelRecord,
  YouTubeFoundationErrorCode,
  YouTubeProjectAssignment,
} from '../contracts/youtube-upload-center.js'
import { isValidYouTubeChannelId, YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import {
  readAppSecrets,
  stageYouTubeSecretRecovery,
  writeAppSecrets,
  type OAuthTokenBundle,
  type YouTubePendingRegistryTransaction,
  type YouTubeSecretBucket,
} from './app-secrets-store.js'
import { getProject, getUserDataDir } from './project-manager.js'

export interface YouTubeConnectionRegistryV1 {
  schema_version: 1
  application: YouTubeApplicationRecord | null
  application_history: Array<{
    application_id: string
    fingerprint: string
    replaced_at: string
  }>
  channels: Record<string, YouTubeChannelRecord>
  assignments: Record<string, YouTubeProjectAssignment>
  assignment_history: Array<{
    project_slug: string
    previous_channel_id: string | null
    next_channel_id: string | null
    changed_at: string
  }>
}

const CHANNEL_STATUSES = ['connected', 'reconnect_required', 'scope_upgrade_required'] as const
type YouTubeChannelStatus = typeof CHANNEL_STATUSES[number]

const CORRUPT_REGISTRY_ERROR = 'YouTube connection registry is corrupt'
const CORRUPT_REGISTRY_CODE = 'YOUTUBE_CONNECTION_REGISTRY_CORRUPT'
const REGISTRY_IO_CODE = 'YOUTUBE_CONNECTION_REGISTRY_IO'
const PENDING_RECOVERY_ERROR = 'YouTube connection registry pending transaction could not be recovered'

function emptyRegistry(): YouTubeConnectionRegistryV1 {
  return {
    schema_version: 1,
    application: null,
    application_history: [],
    channels: {},
    assignments: {},
    assignment_history: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function corruptRegistryError(): Error {
  return Object.assign(new Error(CORRUPT_REGISTRY_ERROR), { code: CORRUPT_REGISTRY_CODE })
}

function registryIoError(error: unknown): Error {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : REGISTRY_IO_CODE
  return Object.assign(new Error(`Unable to read YouTube connection registry (${code})`), { code })
}

function assertNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value) throw corruptRegistryError()
}

function assertMapKey(value: string): void {
  if (value === '__proto__' || value === 'constructor' || value === 'prototype') {
    throw corruptRegistryError()
  }
}

function assertChannelId(value: unknown): asserts value is string {
  if (!isValidYouTubeChannelId(value)) throw corruptRegistryError()
}

function isWritableMapKey(value: string): boolean {
  return value !== '__proto__' && value !== 'constructor' && value !== 'prototype'
}

function assertWritableMapKey(value: string, name: string): void {
  if (!isWritableMapKey(value)) {
    throw new Error(`YouTube ${name} uses a reserved map key`)
  }
  if (name.includes('channel') && !isValidYouTubeChannelId(value)) {
    throw new Error(`YouTube ${name} is invalid`)
  }
}

function decodeApplication(value: unknown): YouTubeApplicationRecord | null {
  if (value === null) return null
  if (!isRecord(value)) throw corruptRegistryError()
  assertNonEmptyString(value.application_id)
  assertNonEmptyString(value.client_id)
  assertNonEmptyString(value.fingerprint)
  assertNonEmptyString(value.configured_at)
  assertNonEmptyString(value.updated_at)
  if (value.google_cloud_project_id !== undefined) assertNonEmptyString(value.google_cloud_project_id)
  return {
    application_id: value.application_id,
    client_id: value.client_id,
    ...(value.google_cloud_project_id !== undefined
      ? { google_cloud_project_id: value.google_cloud_project_id }
      : {}),
    fingerprint: value.fingerprint,
    configured_at: value.configured_at,
    updated_at: value.updated_at,
  }
}

function decodeChannel(value: unknown, expectedChannelId: string): YouTubeChannelRecord {
  if (!isRecord(value)) throw corruptRegistryError()
  assertChannelId(value.channel_id)
  assertChannelId(expectedChannelId)
  if (value.channel_id !== expectedChannelId) throw corruptRegistryError()
  assertNonEmptyString(value.application_id)
  assertNonEmptyString(value.title)
  if (value.handle !== undefined) assertNonEmptyString(value.handle)
  if (value.thumbnail_url !== undefined) assertNonEmptyString(value.thumbnail_url)
  assertNonEmptyString(value.connected_at)
  assertNonEmptyString(value.updated_at)
  if (value.last_refresh_at !== undefined) assertNonEmptyString(value.last_refresh_at)
  if (value.details_checked_at !== undefined) assertNonEmptyString(value.details_checked_at)
  if (value.authorized_at !== undefined) assertNonEmptyString(value.authorized_at)
  if (!Array.isArray(value.granted_scopes) || !value.granted_scopes.every(scope => typeof scope === 'string')) {
    throw corruptRegistryError()
  }
  if (typeof value.status !== 'string' || !(CHANNEL_STATUSES as readonly string[]).includes(value.status)) {
    throw corruptRegistryError()
  }
  return {
    channel_id: value.channel_id,
    application_id: value.application_id,
    title: value.title,
    ...(value.handle !== undefined ? { handle: value.handle } : {}),
    ...(value.thumbnail_url !== undefined ? { thumbnail_url: value.thumbnail_url } : {}),
    connected_at: value.connected_at,
    updated_at: value.updated_at,
    ...(value.last_refresh_at !== undefined ? { last_refresh_at: value.last_refresh_at } : {}),
    ...(value.details_checked_at !== undefined ? { details_checked_at: value.details_checked_at } : {}),
    ...(value.authorized_at !== undefined ? { authorized_at: value.authorized_at } : {}),
    ...(value.seven_day_sign_in === true ? { seven_day_sign_in: true } : {}),
    granted_scopes: [...value.granted_scopes],
    status: value.status as YouTubeChannelStatus,
  }
}

function decodeAssignment(value: unknown, expectedProjectSlug: string): YouTubeProjectAssignment {
  if (!isRecord(value)) throw corruptRegistryError()
  assertMapKey(expectedProjectSlug)
  assertNonEmptyString(value.project_slug)
  assertNonEmptyString(value.channel_id)
  assertChannelId(value.channel_id)
  assertNonEmptyString(value.assigned_at)
  if (value.project_slug !== expectedProjectSlug) throw corruptRegistryError()
  return {
    project_slug: value.project_slug,
    channel_id: value.channel_id,
    assigned_at: value.assigned_at,
  }
}

function decodeRegistry(raw: unknown): YouTubeConnectionRegistryV1 {
  if (!isRecord(raw) || raw.schema_version !== 1 || !Array.isArray(raw.application_history)
    || !isRecord(raw.channels) || !isRecord(raw.assignments) || !Array.isArray(raw.assignment_history)) {
    throw corruptRegistryError()
  }
  const application = decodeApplication(raw.application)
  const applicationHistory = raw.application_history.map(value => {
    if (!isRecord(value)) throw corruptRegistryError()
    assertNonEmptyString(value.application_id)
    assertNonEmptyString(value.fingerprint)
    assertNonEmptyString(value.replaced_at)
    return {
      application_id: value.application_id,
      fingerprint: value.fingerprint,
      replaced_at: value.replaced_at,
    }
  })
  const channelEntries: Array<[string, YouTubeChannelRecord]> = []
  for (const [channelId, value] of Object.entries(raw.channels)) {
    channelEntries.push([channelId, decodeChannel(value, channelId)])
  }
  const assignmentEntries: Array<[string, YouTubeProjectAssignment]> = []
  for (const [projectSlug, value] of Object.entries(raw.assignments)) {
    assignmentEntries.push([projectSlug, decodeAssignment(value, projectSlug)])
  }
  const assignmentHistory = raw.assignment_history.map(value => {
    if (!isRecord(value)) throw corruptRegistryError()
    assertNonEmptyString(value.project_slug)
    if (value.previous_channel_id !== null && value.previous_channel_id !== undefined) {
      assertChannelId(value.previous_channel_id)
    }
    if (value.next_channel_id !== null && value.next_channel_id !== undefined) {
      assertChannelId(value.next_channel_id)
    }
    assertNonEmptyString(value.changed_at)
    if (value.previous_channel_id === undefined || value.next_channel_id === undefined) {
      throw corruptRegistryError()
    }
    return {
      project_slug: value.project_slug,
      previous_channel_id: value.previous_channel_id,
      next_channel_id: value.next_channel_id,
      changed_at: value.changed_at,
    }
  })
  const channelIds = new Set(channelEntries.map(([channelId]) => channelId))
  const assignedChannels = new Set<string>()
  for (const [, assignment] of assignmentEntries) {
    if (!channelIds.has(assignment.channel_id) || assignedChannels.has(assignment.channel_id)) {
      throw corruptRegistryError()
    }
    assignedChannels.add(assignment.channel_id)
  }
  return {
    schema_version: 1,
    application,
    application_history: applicationHistory,
    channels: Object.fromEntries(channelEntries),
    assignments: Object.fromEntries(assignmentEntries),
    assignment_history: assignmentHistory,
  }
}

function foundationError(code: YouTubeFoundationErrorCode, detail: string): YouTubeFoundationError {
  return new YouTubeFoundationError(409, code, detail)
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

async function readRegistryUnlocked(filePath: string): Promise<YouTubeConnectionRegistryV1> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptyRegistry()
    throw registryIoError(error)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw corruptRegistryError()
  }
  try {
    return decodeRegistry(raw)
  } catch {
    throw corruptRegistryError()
  }
}

async function writeRegistryUnlocked(filePath: string, registry: YouTubeConnectionRegistryV1): Promise<void> {
  await writeJsonAtomic(filePath, registry, { mode: 0o600 })
}

function cloneTokenBundle(token: OAuthTokenBundle): OAuthTokenBundle {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: token.expires_at,
    ...(token.scope !== undefined ? { scope: token.scope } : {}),
  }
}

function normalizeTokenBundle(value: unknown): OAuthTokenBundle {
  if (!isRecord(value)
    || typeof value.access_token !== 'string' || !value.access_token.trim()
    || typeof value.refresh_token !== 'string' || !value.refresh_token.trim()
    || typeof value.expires_at !== 'number' || !Number.isFinite(value.expires_at)) {
    throw new Error('YouTube OAuth token bundle is invalid')
  }
  const token: OAuthTokenBundle = {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: value.expires_at,
  }
  if (value.scope !== undefined) {
    if (typeof value.scope !== 'string' || !value.scope.trim()) {
      throw new Error('YouTube OAuth token scope is invalid')
    }
    token.scope = value.scope.trim().split(/\s+/).join(' ')
  }
  registerSecretForRedaction(token.access_token)
  registerSecretForRedaction(token.refresh_token)
  return token
}

function requireCredential(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`YouTube ${name} is required`)
  return value.trim()
}

function normalizeOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`YouTube ${name} is invalid`)
  return value.trim()
}

function normalizeGrantedScopes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('YouTube granted_scopes is invalid')
  return value.map((scope) => {
    if (typeof scope !== 'string' || !scope.trim()) throw new Error('YouTube granted_scopes is invalid')
    return scope.trim()
  })
}

interface NormalizedYouTubeChannelGrant {
  channelId: string
  title: string
  handle?: string
  thumbnail_url?: string
  grantedScopes: string[]
  token: OAuthTokenBundle
}

function normalizeChannelGrant(input: unknown): NormalizedYouTubeChannelGrant {
  if (!isRecord(input) || !isRecord(input.channel)) {
    throw new Error('YouTube channel grant is invalid')
  }
  const channelId = requireCredential(input.channel.channel_id, 'channel_id')
  assertWritableMapKey(channelId, 'channel_id')
  const handle = normalizeOptionalString(input.channel.handle, 'channel handle')
  const thumbnailUrl = normalizeOptionalString(input.channel.thumbnail_url, 'channel thumbnail_url')
  return {
    channelId,
    title: requireCredential(input.channel.title, 'channel title'),
    ...(handle !== undefined ? { handle } : {}),
    ...(thumbnailUrl !== undefined ? { thumbnail_url: thumbnailUrl } : {}),
    grantedScopes: normalizeGrantedScopes(input.channel.granted_scopes),
    token: normalizeTokenBundle(input.tokens),
  }
}


function applicationFingerprint(applicationId: string, clientId: string): string {
  return createHash('sha256').update(`${applicationId}:${clientId}`).digest('hex')
}

function cloneRegistry(registry: YouTubeConnectionRegistryV1): YouTubeConnectionRegistryV1 {
  return {
    schema_version: 1,
    application: registry.application ? { ...registry.application } : null,
    application_history: registry.application_history.map(entry => ({ ...entry })),
    channels: Object.fromEntries(Object.entries(registry.channels).map(([channelId, channel]) => [
      channelId,
      { ...channel, granted_scopes: [...channel.granted_scopes] },
    ])),
    assignments: Object.fromEntries(Object.entries(registry.assignments).map(([projectSlug, assignment]) => [
      projectSlug,
      { ...assignment },
    ])),
    assignment_history: registry.assignment_history.map(entry => ({ ...entry })),
  }
}

function registrySnapshot(registry: YouTubeConnectionRegistryV1): Record<string, unknown> {
  return JSON.parse(JSON.stringify(registry)) as Record<string, unknown>
}

function sameRegistry(left: YouTubeConnectionRegistryV1, right: YouTubeConnectionRegistryV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeProjectSlug(value: unknown): string {
  const slug = requireCredential(value, 'project_slug')
  assertWritableMapKey(slug, 'project_slug')
  if (slug === '.' || slug === '..' || slug.includes('/') || slug.includes('\\') || slug.includes('\0')) {
    throw new Error('YouTube project_slug is invalid')
  }
  return slug
}

/**
 * The same identity rule the publishing store uses: a stored `slug` that differs from the project
 * by case only is that project (macOS folders are case-insensitive, and four projects created
 * before 70691478e kept a lowercased one). The publishing store repairs the file on its next
 * read; here the value is only being trusted, so the case-only form is accepted.
 */
function sameProjectSlug(stored: unknown, projectSlug: string): boolean {
  return typeof stored === 'string' && (stored === projectSlug || stored.toLowerCase() === projectSlug.toLowerCase())
}

function assertProjectMetadata(value: unknown, projectSlug: string): void {
  if (!isRecord(value)
    || typeof value.name !== 'string' || !value.name.trim()
    || !sameProjectSlug(value.slug, projectSlug)
    || typeof value.created_at !== 'string' || !value.created_at.trim()
    || typeof value.episode_prefix !== 'string' || !value.episode_prefix.trim()
    || typeof value.episode_digits !== 'number' || !Number.isInteger(value.episode_digits) || value.episode_digits <= 0
    || typeof value.season_size !== 'number' || !Number.isInteger(value.season_size) || value.season_size <= 0
    || typeof value.season_prefix !== 'string' || !value.season_prefix.trim()
    || typeof value.folder_template !== 'string' || !value.folder_template.trim()
    || !isRecord(value.subfolder_names)) {
    throw new Error(`YouTube project metadata for '${projectSlug}' is invalid`)
  }
}

async function validateProjectForYouTube(projectSlug: string): Promise<void> {
  const project = await getProject(projectSlug)
  if (!project) throw new Error(`YouTube project '${projectSlug}' was not found`)
  assertProjectMetadata(project, projectSlug)
}

function cloneAssignment(assignment: YouTubeProjectAssignment): YouTubeProjectAssignment {
  return { ...assignment }
}

async function readConnectedCurrentChannel(
  registry: YouTubeConnectionRegistryV1,
  channelId: string,
): Promise<{ application: YouTubeApplicationRecord; channel: YouTubeChannelRecord }> {
  const application = registry.application
  if (!application) {
    throw foundationError('YOUTUBE_APPLICATION_NOT_CONFIGURED', 'Configure a YouTube OAuth application before using a channel.')
  }
  if (!Object.prototype.hasOwnProperty.call(registry.channels, channelId)) {
    throw foundationError('YOUTUBE_CHANNEL_NOT_CONNECTED', 'Connect the YouTube channel before assigning it.')
  }
  const channel = registry.channels[channelId]
  if (!channel || channel.status !== 'connected' || channel.application_id !== application.application_id) {
    throw foundationError('YOUTUBE_CHANNEL_NOT_CONNECTED', 'Reconnect the YouTube channel before assigning it.')
  }
  const token = (await readAppSecrets()).youtube?.channel_tokens?.[channelId]
  if (!token || token.application_id !== application.application_id) {
    throw foundationError('YOUTUBE_CHANNEL_NOT_CONNECTED', 'Reconnect the YouTube channel before assigning it.')
  }
  return { application: { ...application }, channel: { ...channel, granted_scopes: [...channel.granted_scopes] } }
}

async function clearPendingRegistryTransaction(transactionId: string): Promise<void> {
  await writeAppSecrets((v3) => {
    const youtube = v3.youtube
    if (!youtube?.pending_registry || youtube.pending_registry.transaction_id !== transactionId) return
    const next: YouTubeSecretBucket = { ...youtube }
    delete next.pending_registry
    if (!next.oauth_client && Object.keys(next.channel_tokens ?? {}).length === 0) delete v3.youtube
    else v3.youtube = next
  })
}

async function recoverPendingRegistryTransaction(filePath: string): Promise<void> {
  const pending = (await readAppSecrets()).youtube?.pending_registry
  if (!pending) return

  let target: YouTubeConnectionRegistryV1
  try {
    target = decodeRegistry(pending.registry)
  } catch {
    throw corruptRegistryError()
  }

  const current = await readRegistryUnlocked(filePath)
  if (!sameRegistry(current, target)) await writeRegistryUnlocked(filePath, target)
  try {
    await clearPendingRegistryTransaction(pending.transaction_id)
  } catch {
    throw new Error(PENDING_RECOVERY_ERROR)
  }
}

async function persistRegistryTransaction(
  filePath: string,
  registry: YouTubeConnectionRegistryV1,
  updateSecrets: (youtube: YouTubeSecretBucket) => void,
): Promise<void> {
  const pending: YouTubePendingRegistryTransaction = {
    transaction_id: randomUUID(),
    registry: registrySnapshot(registry),
  }
  await writeAppSecrets((v3) => {
    const youtube: YouTubeSecretBucket = { ...(v3.youtube ?? {}) }
    updateSecrets(youtube)
    youtube.pending_registry = pending
    v3.youtube = youtube
  })
  await writeRegistryUnlocked(filePath, registry)
  await clearPendingRegistryTransaction(pending.transaction_id)
}

export function youtubeConnectionsPath(): string {
  return path.join(getUserDataDir(), 'youtube', 'connections.json')
}

export async function readYouTubeConnectionRegistry(): Promise<YouTubeConnectionRegistryV1> {
  const filePath = youtubeConnectionsPath()
  return withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    return readRegistryUnlocked(filePath)
  })
}

/**
 * Remove only a readable, recoverably malformed YouTube credential bucket.
 * Public channel identity, project assignments, history and episode sidecars
 * remain; the application is cleared and each retained channel must reconnect.
 */
export async function recoverYouTubeCredentialAuthority(): Promise<YouTubeConnectionRegistryV1> {
  const filePath = youtubeConnectionsPath()
  return withCrossProcessLock(filePath, async () => {
    const registry = await readRegistryUnlocked(filePath)
    const now = new Date().toISOString()
    const target = cloneRegistry(registry)
    target.application = null
    for (const channel of Object.values(target.channels)) {
      channel.status = 'reconnect_required'
      channel.updated_at = now
    }
    const pending: YouTubePendingRegistryTransaction = {
      transaction_id: randomUUID(),
      registry: registrySnapshot(target),
    }
    await stageYouTubeSecretRecovery(pending)
    await writeRegistryUnlocked(filePath, target)
    await clearPendingRegistryTransaction(pending.transaction_id)
    return cloneRegistry(target)
  })
}

export async function configureYouTubeApplication(input: {
  client_id: string
  client_secret: string
  google_cloud_project_id?: string
}): Promise<YouTubeApplicationRecord> {
  const clientId = requireCredential(input.client_id, 'client_id')
  const clientSecret = requireCredential(input.client_secret, 'client_secret')
  const filePath = youtubeConnectionsPath()
  let result: YouTubeApplicationRecord | undefined
  await withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const storedSecrets = await readAppSecrets()
    const storedClient = storedSecrets.youtube?.oauth_client
    const current = registry.application
    const sameCredentials = !!current && storedClient?.application_id === current.application_id
      && storedClient.client_secret === clientSecret && current.client_id === clientId
    const applicationId = sameCredentials && current
      ? current.application_id
      : `youtube_app_${randomUUID()}`
    const now = new Date().toISOString()
    const cloudProject = input.google_cloud_project_id?.trim()
    const application: YouTubeApplicationRecord = {
      application_id: applicationId,
      client_id: clientId,
      ...(cloudProject ? { google_cloud_project_id: cloudProject } : {}),
      fingerprint: sameCredentials && current
        ? current.fingerprint
        : applicationFingerprint(applicationId, clientId),
      configured_at: sameCredentials && current ? current.configured_at : now,
      updated_at: now,
    }

    const nextRegistry = cloneRegistry(registry)
    if (current && !sameCredentials) {
      nextRegistry.application_history.push({
        application_id: current.application_id,
        fingerprint: current.fingerprint,
        replaced_at: now,
      })
      for (const channel of Object.values(nextRegistry.channels)) {
        channel.status = 'reconnect_required'
        channel.updated_at = now
      }
    }
    nextRegistry.application = application
    await persistRegistryTransaction(filePath, nextRegistry, (youtube) => {
      youtube.oauth_client = { application_id: applicationId, client_secret: clientSecret }
      if (current && !sameCredentials) youtube.channel_tokens = {}
    })
    result = { ...application }
  })
  return result!
}

export async function readYouTubeOAuthClientForServer(): Promise<{
  application_id: string
  client_id: string
  client_secret: string
} | null> {
  const registry = await readYouTubeConnectionRegistry()
  if (!registry.application) return null
  const stored = (await readAppSecrets()).youtube?.oauth_client
  if (!stored || stored.application_id !== registry.application.application_id) return null
  registerSecretForRedaction(stored.client_secret)
  return {
    application_id: registry.application.application_id,
    client_id: registry.application.client_id,
    client_secret: stored.client_secret,
  }
}

export async function saveYouTubeChannelGrant(input: {
  /** OAuth application that minted this grant; prevents an in-flight A→B rebind. */
  expected_application_id: string
  channel: Omit<YouTubeChannelRecord, 'application_id' | 'connected_at' | 'updated_at' | 'status'>
  tokens: OAuthTokenBundle
  /**
   * The health this grant actually earned. A partial scope grant must be
   * recorded as `scope_upgrade_required` in the SAME journalled write as the
   * tokens — saving `connected` first and downgrading afterwards leaves a
   * durable record claiming permission the grant does not have if anything
   * interrupts between the two writes. Defaults to `connected`.
   */
  status?: Exclude<YouTubeChannelRecord['status'], 'reconnect_required'>
}): Promise<YouTubeChannelRecord> {
  const grant = normalizeChannelGrant(input)
  const grantedStatus = input.status ?? 'connected'
  if (grantedStatus !== 'connected' && grantedStatus !== 'scope_upgrade_required') {
    throw new Error('YouTube channel grant status is invalid')
  }
  const filePath = youtubeConnectionsPath()
  let result: YouTubeChannelRecord | undefined
  await withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const application = registry.application
    if (!application) throw foundationError('YOUTUBE_APPLICATION_NOT_CONFIGURED', 'Configure a YouTube OAuth application before connecting a channel.')
    if (application.application_id !== input.expected_application_id) {
      throw foundationError(
        'YOUTUBE_APPLICATION_CHANGED',
        'The YouTube OAuth application changed while Google sign-in was open. Start the connection again.',
      )
    }
    const now = new Date().toISOString()
    const nextRegistry = cloneRegistry(registry)
    const existing = nextRegistry.channels[grant.channelId]
    const channel: YouTubeChannelRecord = {
      channel_id: grant.channelId,
      application_id: application.application_id,
      title: grant.title,
      ...(grant.handle !== undefined ? { handle: grant.handle } : {}),
      ...(grant.thumbnail_url !== undefined ? { thumbnail_url: grant.thumbnail_url } : {}),
      connected_at: existing?.connected_at ?? now,
      updated_at: now,
      last_refresh_at: now,
      // The grant's title, handle and thumbnail were read from YouTube moments
      // ago, so the channel's details are current as of now.
      details_checked_at: now,
      authorized_at: now,
      // A reconnect keeps what was learned about this OAuth app's token lifetime.
      ...(existing?.seven_day_sign_in ? { seven_day_sign_in: true } : {}),
      granted_scopes: [...grant.grantedScopes],
      status: grantedStatus,
    }
    nextRegistry.channels[grant.channelId] = channel
    await persistRegistryTransaction(filePath, nextRegistry, (youtube) => {
      const channelTokens = { ...(youtube.channel_tokens ?? {}) }
      channelTokens[grant.channelId] = {
        application_id: application.application_id,
        ...grant.token,
      }
      youtube.channel_tokens = channelTokens
    })
    result = { ...channel, granted_scopes: [...channel.granted_scopes] }
  })
  return result!
}

/**
 * Replace a connected channel's stored tokens after a refresh.
 *
 * Tokens only - the grant, its scopes and its status are unchanged, because a
 * refresh is not a re-consent. Refuses a channel that is not connected under
 * the current application rather than creating one, so a refresh can never
 * resurrect a disconnected grant.
 */
export async function saveYouTubeChannelTokens(input: {
  channel_id: string
  /** Compare-and-swap guard for overlapping refresh attempts. */
  expected_access_token?: string
  tokens: OAuthTokenBundle
}): Promise<boolean> {
  const channelId = requireCredential(input.channel_id, 'channel_id')
  if (!isWritableMapKey(channelId)) throw foundationError('YOUTUBE_CHANNEL_NOT_CONNECTED', 'That YouTube channel id is not usable.')
  const filePath = youtubeConnectionsPath()
  return withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const application = registry.application
    const channel = registry.channels[channelId]
    if (!application || !channel || channel.application_id !== application.application_id
      || channel.status !== 'connected') {
      throw foundationError(
        'YOUTUBE_CHANNEL_NOT_CONNECTED',
        'That YouTube channel is not connected under the current application.',
      )
    }
    if (input.expected_access_token !== undefined) {
      const current = (await readAppSecrets()).youtube?.channel_tokens?.[channelId]
      if (!current || current.application_id !== application.application_id
        || current.access_token !== input.expected_access_token) return false
    }
    const next = cloneRegistry(registry)
    const refreshed: YouTubeChannelRecord = { ...channel, last_refresh_at: new Date().toISOString() }
    // A grant still renewing well past 7 days is not the Testing-status kind
    // (the owner moved the app to production and reconnected).
    if (refreshed.seven_day_sign_in && grantAgeMs(refreshed) > 8 * DAY_MS) delete refreshed.seven_day_sign_in
    next.channels[channelId] = refreshed
    await persistRegistryTransaction(filePath, next, (youtube) => {
      const channelTokens = { ...(youtube.channel_tokens ?? {}) }
      channelTokens[channelId] = { application_id: application.application_id, ...input.tokens }
      youtube.channel_tokens = channelTokens
    })
    return true
  })
}

/**
 * Record what YouTube says about a channel, and when it was last asked.
 *
 * `details` is omitted when the read failed: the saved title, handle and
 * thumbnail stay exactly as they were, and only the check time moves, so a
 * broken read is retried the next day rather than on every page load.
 *
 * The channel id is the identity. The assignment is never touched — a rename
 * on YouTube must not move a project.
 */
export async function updateYouTubeChannelDetails(input: {
  channel_id: string
  details?: { title: string; handle?: string; thumbnail_url?: string }
}): Promise<boolean> {
  const channelId = requireCredential(input.channel_id, 'channel_id')
  if (!isWritableMapKey(channelId)) return false
  const filePath = youtubeConnectionsPath()
  let updated = false
  await withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    if (!Object.prototype.hasOwnProperty.call(registry.channels, channelId)) return
    const next = cloneRegistry(registry)
    const channel = next.channels[channelId]!
    if (input.details) {
      channel.title = input.details.title
      if (input.details.handle !== undefined) channel.handle = input.details.handle
      if (input.details.thumbnail_url !== undefined) channel.thumbnail_url = input.details.thumbnail_url
    }
    channel.details_checked_at = new Date().toISOString()
    // `updated_at` is left alone on purpose: it dates the GRANT, and the
    // 7-day sign-in window is measured from it on records that predate
    // `authorized_at`. A display refresh must not reset that clock.
    await writeRegistryUnlocked(filePath, next)
    updated = true
  })
  return updated
}

export async function readYouTubeChannelTokensForServer(channel_id: string): Promise<OAuthTokenBundle | null> {
  const channelId = requireCredential(channel_id, 'channel_id')
  if (!isValidYouTubeChannelId(channelId)) return null
  const filePath = youtubeConnectionsPath()
  return withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    if (!Object.prototype.hasOwnProperty.call(registry.channels, channelId)) return null
    const channel = registry.channels[channelId]
    if (!channel) return null
    const application = registry.application
    if (!application || channel.application_id !== application.application_id || channel.status !== 'connected') return null
    const token = (await readAppSecrets()).youtube?.channel_tokens?.[channelId]
    if (!token || token.application_id !== application.application_id) return null
    return cloneTokenBundle(token)
  })
}

/** One locked snapshot for a provider request: assignment, OAuth application,
 * client secret, and channel token all describe the same registry generation. */
export async function readYouTubeRequestCredentialForServer(
  project_slug: string,
  channel_id: string,
): Promise<{
  application_id: string
  channel_id: string
  client_id: string
  client_secret: string
  tokens: OAuthTokenBundle
} | null> {
  const channelId = requireCredential(channel_id, 'channel_id')
  if (!isValidYouTubeChannelId(channelId)) return null
  const filePath = youtubeConnectionsPath()
  return withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const application = registry.application
    const assignment = registry.assignments[project_slug]
    const channel = registry.channels[channelId]
    if (!application || assignment?.channel_id !== channelId || !channel
      || channel.status !== 'connected' || channel.application_id !== application.application_id) return null
    const youtube = (await readAppSecrets()).youtube
    const client = youtube?.oauth_client
    const token = youtube?.channel_tokens?.[channelId]
    if (!client || client.application_id !== application.application_id
      || !token || token.application_id !== application.application_id) return null
    registerSecretForRedaction(client.client_secret)
    return {
      application_id: application.application_id,
      channel_id: channelId,
      client_id: application.client_id,
      client_secret: client.client_secret,
      tokens: cloneTokenBundle(token),
    }
  })
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Time since the owner last completed consent; records written before `authorized_at` use `updated_at`. */
export function grantAgeMs(channel: Pick<YouTubeChannelRecord, 'authorized_at' | 'updated_at'>, now = Date.now()): number {
  return now - Date.parse(channel.authorized_at ?? channel.updated_at)
}

/**
 * Google refused this channel's refresh token (`invalid_grant`/`invalid_client`):
 * the grant is gone, so the channel row offers Reconnect. A refusal 6–10 days
 * after consent is the 7-day Testing-status expiry, remembered so the app can
 * say "Signed in until ~date" and warn a day ahead next time.
 */
export async function markYouTubeChannelSignInExpired(channel_id: string, now = Date.now()): Promise<void> {
  const channelId = requireCredential(channel_id, 'channel_id')
  assertWritableMapKey(channelId, 'channel_id')
  const filePath = youtubeConnectionsPath()
  await withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const current = Object.prototype.hasOwnProperty.call(registry.channels, channelId) ? registry.channels[channelId] : undefined
    if (!current) return
    const age = grantAgeMs(current, now)
    current.status = 'reconnect_required'
    current.updated_at = new Date(now).toISOString()
    if (age >= 6 * DAY_MS && age <= 10 * DAY_MS) current.seven_day_sign_in = true
    await writeRegistryUnlocked(filePath, registry)
  })
}

export async function markYouTubeChannelStatus(
  channel_id: string,
  status: YouTubeChannelRecord['status'],
): Promise<YouTubeChannelRecord> {
  const channelId = requireCredential(channel_id, 'channel_id')
  assertWritableMapKey(channelId, 'channel_id')
  if (!(CHANNEL_STATUSES as readonly string[]).includes(status)) throw new Error('YouTube channel status is invalid')
  const filePath = youtubeConnectionsPath()
  let result: YouTubeChannelRecord | undefined
  await withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    if (!Object.prototype.hasOwnProperty.call(registry.channels, channelId)) {
      throw foundationError('YOUTUBE_CHANNEL_NOT_CONNECTED', 'Connect the YouTube channel before changing its status.')
    }
    const current = registry.channels[channelId]
    if (!current) throw foundationError('YOUTUBE_CHANNEL_NOT_CONNECTED', 'Connect the YouTube channel before changing its status.')
    if (status === 'connected' && (current.status !== 'connected'
      || !registry.application || current.application_id !== registry.application.application_id)) {
      throw new Error('A fresh YouTube channel grant is required before restoring connected status')
    }
    current.status = status
    current.updated_at = new Date().toISOString()
    await writeRegistryUnlocked(filePath, registry)
    result = { ...current, granted_scopes: [...current.granted_scopes] }
  })
  return result!
}

/**
 * Remove one channel grant, its stored token bundle, and any project assignment
 * that pointed at it, in one journalled transaction. Historical video identity
 * is untouched: only the live grant and assignment go away.
 */
export async function disconnectYouTubeChannel(input: { channel_id: string }): Promise<void> {
  const channelId = requireCredential(input.channel_id, 'channel_id')
  assertWritableMapKey(channelId, 'channel_id')
  const filePath = youtubeConnectionsPath()
  await withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    if (!Object.prototype.hasOwnProperty.call(registry.channels, channelId)) {
      throw foundationError('YOUTUBE_CHANNEL_NOT_CONNECTED', 'That YouTube channel is not connected.')
    }

    const now = new Date().toISOString()
    const nextRegistry = cloneRegistry(registry)
    delete nextRegistry.channels[channelId]
    for (const assignment of Object.values(registry.assignments)) {
      if (assignment.channel_id !== channelId) continue
      delete nextRegistry.assignments[assignment.project_slug]
      nextRegistry.assignment_history.push({
        project_slug: assignment.project_slug,
        previous_channel_id: channelId,
        next_channel_id: null,
        changed_at: now,
      })
    }

    await persistRegistryTransaction(filePath, nextRegistry, (youtube) => {
      if (!youtube.channel_tokens) return
      const channelTokens = { ...youtube.channel_tokens }
      delete channelTokens[channelId]
      youtube.channel_tokens = channelTokens
    })
  })
}

export async function getProjectYouTubeAssignment(project_slug: string): Promise<YouTubeProjectAssignment | null> {
  const projectSlug = normalizeProjectSlug(project_slug)
  await validateProjectForYouTube(projectSlug)
  const filePath = youtubeConnectionsPath()
  return withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const assignment = Object.prototype.hasOwnProperty.call(registry.assignments, projectSlug)
      ? registry.assignments[projectSlug]
      : undefined
    return assignment ? cloneAssignment(assignment) : null
  })
}

export async function assignProjectYouTubeChannel(input: {
  project_slug: string
  channel_id: string
  expected_previous_channel_id: string | null
}): Promise<YouTubeProjectAssignment> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const channelId = requireCredential(input.channel_id, 'channel_id')
  assertWritableMapKey(channelId, 'channel_id')
  const expectedPrevious = input.expected_previous_channel_id === null
    ? null
    : requireCredential(input.expected_previous_channel_id, 'expected_previous_channel_id')
  if (expectedPrevious !== null) assertWritableMapKey(expectedPrevious, 'expected_previous_channel_id')
  await validateProjectForYouTube(projectSlug)

  const filePath = youtubeConnectionsPath()
  let result: YouTubeProjectAssignment | undefined
  await withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const existing = Object.prototype.hasOwnProperty.call(registry.assignments, projectSlug)
      ? registry.assignments[projectSlug]
      : undefined

    if (existing) {
      if (existing.channel_id === channelId
        && (expectedPrevious === null || expectedPrevious === existing.channel_id)) {
        await readConnectedCurrentChannel(registry, channelId)
        result = cloneAssignment(existing)
        return
      }
      if (expectedPrevious !== existing.channel_id) {
        throw foundationError('YOUTUBE_ASSIGNMENT_CHANGED', 'The project YouTube channel assignment changed; reload it and try again.')
      }
    } else if (expectedPrevious !== null) {
      throw foundationError('YOUTUBE_ASSIGNMENT_CHANGED', 'The project YouTube channel assignment changed; reload it and try again.')
    }

    await readConnectedCurrentChannel(registry, channelId)
    for (const assignment of Object.values(registry.assignments)) {
      if (assignment.channel_id === channelId && assignment.project_slug !== projectSlug) {
        throw foundationError('YOUTUBE_CHANNEL_ALREADY_ASSIGNED', 'That YouTube channel is already assigned to another project.')
      }
    }

    const now = new Date().toISOString()
    const assignment: YouTubeProjectAssignment = {
      project_slug: projectSlug,
      channel_id: channelId,
      assigned_at: now,
    }
    const nextRegistry = cloneRegistry(registry)
    nextRegistry.assignments[projectSlug] = assignment
    nextRegistry.assignment_history.push({
      project_slug: projectSlug,
      previous_channel_id: existing?.channel_id ?? null,
      next_channel_id: channelId,
      changed_at: now,
    })
    await persistRegistryTransaction(filePath, nextRegistry, () => {})
    result = cloneAssignment(assignment)
  })
  return result!
}

export async function unassignProjectYouTubeChannel(input: {
  project_slug: string
  expected_channel_id: string
}): Promise<void> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const expectedChannelId = requireCredential(input.expected_channel_id, 'expected_channel_id')
  assertWritableMapKey(expectedChannelId, 'expected_channel_id')
  await validateProjectForYouTube(projectSlug)

  const filePath = youtubeConnectionsPath()
  await withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const current = Object.prototype.hasOwnProperty.call(registry.assignments, projectSlug)
      ? registry.assignments[projectSlug]
      : undefined
    if (!current) {
      throw foundationError('YOUTUBE_CHANNEL_NOT_ASSIGNED', 'Assign a YouTube channel before changing its assignment.')
    }
    if (current.channel_id !== expectedChannelId) {
      throw foundationError('YOUTUBE_ASSIGNMENT_CHANGED', 'The project YouTube channel assignment changed; reload it and try again.')
    }

    const now = new Date().toISOString()
    const nextRegistry = cloneRegistry(registry)
    delete nextRegistry.assignments[projectSlug]
    nextRegistry.assignment_history.push({
      project_slug: projectSlug,
      previous_channel_id: current.channel_id,
      next_channel_id: null,
      changed_at: now,
    })
    await persistRegistryTransaction(filePath, nextRegistry, () => {})
  })
}

/**
 * The Channels list's view of each project's YouTube link, in the same four
 * honest states the Connections screen already distinguishes:
 *
 *   connected          a channel is assigned and its current token + status are good
 *   needs_reconnect    assigned, but the grant expired, a scope is missing, or
 *                      the assigned channel is no longer in the registry
 *   not_connected      no channel assigned
 *   unknown            the registry could not be read (caller decides; see below)
 *
 * Unassigned projects are absent from the map — the caller reads absence as
 * "not_connected". This function THROWS on an unreadable registry so a caller
 * can render "unknown" rather than inventing "not connected" (AGENTS §6).
 */
export type ProjectYouTubeConnectionState = 'connected' | 'needs_reconnect' | 'not_connected'

export async function readProjectYouTubeConnectionStates(): Promise<Record<string, ProjectYouTubeConnectionState>> {
  const registry = await readYouTubeConnectionRegistry()
  const bucket = (await readAppSecrets()).youtube
  const oauthClient = registry.application
    && bucket?.oauth_client?.application_id === registry.application.application_id
    ? bucket.oauth_client
    : null
  const states: Record<string, ProjectYouTubeConnectionState> = {}
  for (const assignment of Object.values(registry.assignments)) {
    const channel = registry.channels[assignment.channel_id]
    // An assignment to a channel the registry no longer holds cannot upload;
    // it is a reconnect, never a silent "connected".
    if (!channel) {
      states[assignment.project_slug] = 'needs_reconnect'
      continue
    }
    const token = bucket?.channel_tokens?.[channel.channel_id]
    const hasCurrentToken = !!oauthClient && token?.application_id === registry.application?.application_id
    states[assignment.project_slug] = hasCurrentToken && channel.status === 'connected'
      ? 'connected'
      : 'needs_reconnect'
  }
  return states
}

export async function authorizeProjectYouTubeAction(input: {
  project_slug: string
  expected_channel_id?: string
  video_channel_id?: string
}): Promise<{ application: YouTubeApplicationRecord; channel: YouTubeChannelRecord; assignment: YouTubeProjectAssignment }> {
  const projectSlug = normalizeProjectSlug(input.project_slug)
  const expectedChannelId = input.expected_channel_id === undefined
    ? undefined
    : requireCredential(input.expected_channel_id, 'expected_channel_id')
  if (expectedChannelId !== undefined) assertWritableMapKey(expectedChannelId, 'expected_channel_id')
  const videoChannelId = input.video_channel_id === undefined
    ? undefined
    : requireCredential(input.video_channel_id, 'video_channel_id')
  if (videoChannelId !== undefined) assertWritableMapKey(videoChannelId, 'video_channel_id')
  await validateProjectForYouTube(projectSlug)

  const filePath = youtubeConnectionsPath()
  return withCrossProcessLock(filePath, async () => {
    await recoverPendingRegistryTransaction(filePath)
    const registry = await readRegistryUnlocked(filePath)
    const application = registry.application
    if (!application) {
      throw foundationError('YOUTUBE_APPLICATION_NOT_CONFIGURED', 'Configure a YouTube OAuth application before using a channel.')
    }
    const assignment = Object.prototype.hasOwnProperty.call(registry.assignments, projectSlug)
      ? registry.assignments[projectSlug]
      : undefined
    if (!assignment) {
      throw foundationError('YOUTUBE_CHANNEL_NOT_ASSIGNED', 'Assign a YouTube channel before continuing.')
    }
    if (expectedChannelId !== undefined && expectedChannelId !== assignment.channel_id) {
      throw foundationError('YOUTUBE_ASSIGNMENT_CHANGED', 'The project YouTube channel assignment changed; reload it and try again.')
    }
    if (videoChannelId !== undefined && videoChannelId !== assignment.channel_id) {
      throw foundationError('YOUTUBE_CHANNEL_MISMATCH', 'The supplied YouTube video belongs to a different channel.')
    }
    const { channel } = await readConnectedCurrentChannel(registry, assignment.channel_id)
    return {
      application: { ...application },
      channel,
      assignment: cloneAssignment(assignment),
    }
  })
}
