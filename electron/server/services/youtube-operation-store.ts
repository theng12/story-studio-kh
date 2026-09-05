import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import type { YouTubeFoundationErrorCode } from '../contracts/youtube-upload-center.js'
import { getProjectDir, getUserDataDir } from './project-manager.js'
import { authorizeProjectYouTubeAction } from './youtube-connection-store.js'
import {
  linkYouTubeEpisodeVideo,
  readYouTubeProjectPublishingState,
} from './youtube-project-publishing-store.js'
import {
  decodeYouTubeOperationRecord,
  readYouTubeOperationRecord,
  youtubeOperationRecordPath,
  youtubeOperationsDirectory,
} from './youtube-operation-record-reader.js'
import type { YouTubeOperationRecordV1 } from './youtube-operation-record-reader.js'

export type { YouTubeOperationRecordV1 } from './youtube-operation-record-reader.js'

type YouTubeOperationCreateBaseV1 = {
  project_slug: string
  episode_code: string
  channel_id: string
  source_revision: string
  metadata_revision: string
  final_payload?: NonNullable<YouTubeOperationRecordV1['final_payload']>
}

export type YouTubeOperationCreateInput = YouTubeOperationCreateBaseV1 & {
  origin: 'manual'
  final_action: 'manual_upload' | 'private_upload'
}

type ProjectResolution = { project_slug: string; project_dir: string }

interface YouTubeOperationIndexV1 {
  schema_version: 1
  project_slug: string
  operation_ids: string[]
}

interface YouTubeVideoClaimV1 {
  channel_id: string
  video_id: string
  project_slug: string
  operation_id: string
}

interface YouTubeVideoClaimsV1 {
  schema_version: 1
  claims: YouTubeVideoClaimV1[]
}

const CREATE_KEYS = new Set([
  'project_slug', 'episode_code', 'channel_id', 'source_revision', 'metadata_revision',
  'origin', 'final_action', 'final_payload',
])
const IMMUTABLE_KEYS = [
  'schema_version', 'operation_id', 'project_slug', 'episode_code', 'channel_id',
  'source_revision', 'metadata_revision', 'created_at', 'origin', 'final_action',
  'final_payload', 'video_id', 'accepted_at',
] as const
const OPTIONAL_OPERATION_KEYS = [
  'resumable', 'processing', 'remote_snapshot',
] as const
const LIFECYCLE_ORDER: Record<string, number> = {
  preparing: 0,
  uploading: 1,
  accepted: 2,
  processing: 3,
  ready: 4,
}
const TERMINAL_LIFECYCLES = new Set(['failed', 'rejected'])
const CLAIM_KEYS = ['channel_id', 'video_id', 'project_slug', 'operation_id'] as const
// Failure and rejection evidence is immutable, always: once YouTube has said
// why it refused a video, nothing may quietly rewrite that.
const PROTECTED_PROCESSING_KEYS = ['failure_reason', 'rejection_reason'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function foundationError(code: YouTubeFoundationErrorCode, detail: string): YouTubeFoundationError {
  return new YouTubeFoundationError(409, code, detail)
}

function corrupt(detail: string): YouTubeFoundationError {
  return foundationError('YOUTUBE_OPERATION_RECORD_CORRUPT', `The YouTube operation store is corrupt (${detail}). Refusing to replace it.`)
}

function operationNotFound(operationId: string): YouTubeFoundationError {
  return foundationError('YOUTUBE_OPERATION_NOT_FOUND', `The YouTube operation '${operationId}' was not found.`)
}



function cloneRecord(record: YouTubeOperationRecordV1): YouTubeOperationRecordV1 {
  return structuredClone(record)
}

function operationIndexPath(projectDir: string): string {
  return path.join(youtubeOperationsDirectory(projectDir), 'index.json')
}

function assertStoreOperationId(operationId: unknown): asserts operationId is string {
  if (typeof operationId !== 'string') throw corrupt('the operation id is invalid')
  // Keep Task 6's path validation as the public path seam, then add the
  // store-level reserved name for the sibling index file.
  youtubeOperationRecordPath('/tmp/youtube-operation-id-validation', operationId)
  if (operationId.toLowerCase() === 'index') {
    throw corrupt('the operation id is reserved for the operation index file')
  }
}

async function resolveProject(projectSlug: string): Promise<ProjectResolution> {
  // Task 6 owns strict project.json validation. Do this before deriving any operation path.
  await readYouTubeProjectPublishingState(projectSlug)
  const projectDir = getProjectDir(projectSlug)
  if (!projectDir) throw new Error(`YouTube project '${projectSlug}' was not found`)
  return { project_slug: projectSlug, project_dir: path.resolve(projectDir) }
}

async function readJsonStrict(filePath: string): Promise<unknown | null> {
  let bytes: Buffer
  try {
    bytes = await fs.readFile(filePath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw corrupt(`${path.basename(filePath)} could not be read`)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw corrupt(`${path.basename(filePath)} contains malformed JSON`)
  }
}

function validateIndex(raw: unknown, projectSlug: string): YouTubeOperationIndexV1 {
  if (!isRecord(raw) || raw.schema_version !== 1 || raw.project_slug !== projectSlug || !Array.isArray(raw.operation_ids)) {
    throw corrupt('the operation index schema or project identity is invalid')
  }
  const indexKeys = Object.keys(raw)
  if (indexKeys.length !== 3 || indexKeys.some(key => !['schema_version', 'project_slug', 'operation_ids'].includes(key))) {
    throw corrupt('the operation index contains unexpected fields')
  }
  const operationIds = raw.operation_ids
  if (!operationIds.every(operationId => typeof operationId === 'string' && operationId.trim() === operationId && !!operationId)) {
    throw corrupt('the operation index contains an invalid operation id')
  }
  if (new Set(operationIds).size !== operationIds.length) {
    throw corrupt('the operation index contains duplicate operation ids')
  }
  for (const operationId of operationIds) assertStoreOperationId(operationId)
  return { schema_version: 1, project_slug: projectSlug, operation_ids: [...operationIds] }
}

async function readIndexUnlocked(indexPath: string, projectSlug: string): Promise<YouTubeOperationIndexV1> {
  const raw = await readJsonStrict(indexPath)
  if (raw === null) return { schema_version: 1, project_slug: projectSlug, operation_ids: [] }
  return validateIndex(raw, projectSlug)
}

function videoClaimsPath(): string {
  return path.join(path.resolve(getUserDataDir()), 'youtube', 'video-claims.json')
}

function claimText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value
    || [...value].some(character => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    })
    || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw corrupt(`the video claim ${name} is invalid`)
  }
  return value
}

function claimKey(channelId: string, videoId: string): string {
  return `${channelId}\u0000${videoId}`
}

function claimOwnerKey(projectSlug: string, operationId: string): string {
  return `${projectSlug}\u0000${operationId}`
}

function validateVideoClaims(raw: unknown): YouTubeVideoClaimsV1 {
  if (!isRecord(raw) || raw.schema_version !== 1 || !Array.isArray(raw.claims)) {
    throw corrupt('the video claim schema is invalid')
  }
  const keys = Object.keys(raw)
  if (keys.length !== 2 || keys.some(key => !['schema_version', 'claims'].includes(key))) {
    throw corrupt('the video claim file contains unexpected fields')
  }
  const tupleKeys = new Set<string>()
  const ownerKeys = new Set<string>()
  const claims = raw.claims.map((value) => {
    if (!isRecord(value) || Object.keys(value).length !== CLAIM_KEYS.length
      || Object.keys(value).some(key => !CLAIM_KEYS.includes(key as typeof CLAIM_KEYS[number]))) {
      throw corrupt('the video claim contains unexpected fields')
    }
    const claim = {
      channel_id: claimText(value.channel_id, 'channel_id'),
      video_id: claimText(value.video_id, 'video_id'),
      project_slug: claimText(value.project_slug, 'project_slug'),
      operation_id: claimText(value.operation_id, 'operation_id'),
    }
    assertStoreOperationId(claim.operation_id)
    const tuple = claimKey(claim.channel_id, claim.video_id)
    const owner = claimOwnerKey(claim.project_slug, claim.operation_id)
    if (tupleKeys.has(tuple)) throw corrupt('the video claim file contains duplicate channel/video identities')
    if (ownerKeys.has(owner)) throw corrupt('the video claim file contains duplicate operation owners')
    tupleKeys.add(tuple)
    ownerKeys.add(owner)
    return claim
  })
  return { schema_version: 1, claims }
}

async function readVideoClaimsUnlocked(): Promise<YouTubeVideoClaimsV1> {
  const raw = await readJsonStrict(videoClaimsPath())
  if (raw === null) return { schema_version: 1, claims: [] }
  return validateVideoClaims(raw)
}

async function writeVideoClaimsUnlocked(claims: YouTubeVideoClaimsV1): Promise<void> {
  await writeJsonAtomic(videoClaimsPath(), validateVideoClaims(claims), { mode: 0o600 })
}

function withVideoClaimsLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(videoClaimsPath(), fn)
}

function assertNoDuplicateVideoIdentities(records: YouTubeOperationRecordV1[]): void {
  const seen = new Set<string>()
  for (const record of records) {
    if (record.video_id === undefined) continue
    const key = claimKey(record.channel_id, record.video_id)
    if (seen.has(key)) {
      throw foundationError('YOUTUBE_VIDEO_ID_CONFLICT', 'The operation store contains duplicate channel/video identities.')
    }
    seen.add(key)
  }
}

function claimVideoIdentity(
  claims: YouTubeVideoClaimsV1,
  record: YouTubeOperationRecordV1,
): { claims: YouTubeVideoClaimsV1; changed: boolean } {
  if (record.video_id === undefined) return { claims, changed: false }
  const existing = claims.claims.find(claim => claimKey(claim.channel_id, claim.video_id) === claimKey(record.channel_id, record.video_id!))
  if (existing) {
    if (existing.project_slug !== record.project_slug || existing.operation_id !== record.operation_id) {
      throw foundationError(
        'YOUTUBE_VIDEO_ID_CONFLICT',
        `The YouTube video is already claimed by project '${existing.project_slug}' operation '${existing.operation_id}'.`,
      )
    }
    return { claims, changed: false }
  }
  const ownedTuple = claims.claims.find(claim => claimOwnerKey(claim.project_slug, claim.operation_id)
    === claimOwnerKey(record.project_slug, record.operation_id))
  if (ownedTuple) {
    throw foundationError('YOUTUBE_VIDEO_ID_CONFLICT', 'A YouTube operation cannot claim more than one channel/video identity.')
  }
  return {
    claims: {
      schema_version: 1,
      claims: [...claims.claims, {
        channel_id: record.channel_id,
        video_id: record.video_id,
        project_slug: record.project_slug,
        operation_id: record.operation_id,
      }],
    },
    changed: true,
  }
}

async function readRecordUnlocked(project: ProjectResolution, operationId: string): Promise<YouTubeOperationRecordV1 | null> {
  assertStoreOperationId(operationId)
  const record = await readYouTubeOperationRecord({ project_dir: project.project_dir, operation_id: operationId })
  if (record && record.project_slug !== project.project_slug) {
    throw corrupt(`operation '${operationId}' has the wrong project identity`)
  }
  return record
}

async function diskOperationIds(projectDir: string): Promise<string[]> {
  const operationsDir = youtubeOperationsDirectory(projectDir)
  let entries: Array<import('node:fs').Dirent>
  try {
    entries = await fs.readdir(operationsDir, { withFileTypes: true })
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return []
    throw corrupt('the operations directory could not be read')
  }
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'index.json') continue
    if (!entry.name.endsWith('.json')) continue
    const operationId = entry.name.slice(0, -'.json'.length)
    try {
      assertStoreOperationId(operationId)
    } catch {
      throw corrupt('the operations directory contains an invalid record filename')
    }
    ids.push(operationId)
  }
  return ids.sort()
}

async function readAllUnlocked(
  project: ProjectResolution,
  index: YouTubeOperationIndexV1,
  skipLockedOperationId?: string,
): Promise<{ index: YouTubeOperationIndexV1; records: YouTubeOperationRecordV1[]; repaired: boolean }> {
  const foundOnDisk = await diskOperationIds(project.project_dir)
  const ids = [...index.operation_ids]
  for (const operationId of foundOnDisk) if (!ids.includes(operationId)) ids.push(operationId)
  const records: YouTubeOperationRecordV1[] = []
  for (const operationId of ids) {
    const recordPath = youtubeOperationRecordPath(project.project_dir, operationId)
    const record = operationId === skipLockedOperationId
      ? await readRecordUnlocked(project, operationId)
      : await withLock(recordPath, () => readRecordUnlocked(project, operationId))
    if (!record) throw corrupt(`the index references missing operation '${operationId}'`)
    records.push(record)
  }
  assertNoDuplicateVideoIdentities(records)
  const repaired = !isDeepStrictEqual(index.operation_ids, ids)
  return {
    index: { schema_version: 1, project_slug: project.project_slug, operation_ids: ids },
    records,
    repaired,
  }
}

async function writeIndexUnlocked(indexPath: string, index: YouTubeOperationIndexV1): Promise<void> {
  await writeJsonAtomic(indexPath, validateIndex(index, index.project_slug), { mode: 0o600 })
}

async function writeRecordUnlocked(projectDir: string, record: YouTubeOperationRecordV1): Promise<void> {
  // Task 6 is the only runtime authority for the closed record union.
  const decoded = decodeYouTubeOperationRecord(record)
  await writeJsonAtomic(youtubeOperationRecordPath(projectDir, decoded.operation_id), decoded, { mode: 0o600 })
}

function assertCreateInputShape(input: unknown): asserts input is YouTubeOperationCreateInput {
  if (!isRecord(input)) throw new Error('YouTube operation create input is invalid')
  for (const key of Object.keys(input)) {
    if (!CREATE_KEYS.has(key)) throw new Error(`YouTube operation create input contains an unexpected field: ${key}`)
  }
}

function operationAction(input: YouTubeOperationCreateInput, now: string): YouTubeOperationRecordV1['actions'][number] {
  return {
    action_id: `action_${randomUUID()}`,
    action: input.final_action,
    classification: 'whole_upload',
    state: 'started',
    occurred_at: now,
  }
}

function createCandidate(input: YouTubeOperationCreateInput, operationId: string, now: string): unknown {
  const { final_payload, ...identity } = input
  return {
    ...identity,
    schema_version: 1,
    revision: 1,
    operation_id: operationId,
    created_at: now,
    updated_at: now,
    lifecycle: 'preparing',
    playlists: {},
    drift: {},
    actions: [operationAction(input, now)],
    ...(final_payload ? { final_payload } : {}),
  }
}

function immutableSnapshot(record: YouTubeOperationRecordV1): Record<string, unknown> {
  return Object.fromEntries(IMMUTABLE_KEYS.map(key => [key, hasOwn(record as unknown as Record<string, unknown>, key)
    ? (record as unknown as Record<string, unknown>)[key]
    : undefined]))
}

function assertImmutable(before: YouTubeOperationRecordV1, after: YouTubeOperationRecordV1): void {
  if (!isDeepStrictEqual(immutableSnapshot(before), immutableSnapshot(after))) {
    throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'Immutable YouTube operation identity cannot be changed.')
  }
}

function assertActionsAppendOnly(before: YouTubeOperationRecordV1, after: YouTubeOperationRecordV1): void {
  if (after.actions.length < before.actions.length
    || before.actions.some((action, index) => !isDeepStrictEqual(action, after.actions[index]))) {
    throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'Existing YouTube operation actions are immutable and append-only.')
  }
  const existingIds = new Set(before.actions.map(action => action.action_id))
  if (after.actions.slice(before.actions.length).some(action => existingIds.has(action.action_id))) {
    throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'A YouTube operation action ID cannot be reused.')
  }
}

function assertProcessingEvidencePreserved(before: YouTubeOperationRecordV1, after: YouTubeOperationRecordV1): void {
  const beforeProcessing = before.processing as unknown as Record<string, unknown> | undefined
  if (!beforeProcessing) return
  const afterProcessing = after.processing as unknown as Record<string, unknown> | undefined
  for (const key of PROTECTED_PROCESSING_KEYS) {
    if (hasOwn(beforeProcessing, key)
      && (!afterProcessing || !hasOwn(afterProcessing, key)
        || !isDeepStrictEqual(beforeProcessing[key], afterProcessing[key]))) {
      throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'YouTube processing failure and rejection evidence is immutable.')
    }
  }

  // `provider_status` is the CURRENT word from YouTube, not evidence of an
  // outcome, so it has to be able to move `uploaded` → `processed` — that is
  // the documented Processing → Ready progression. Freezing it unconditionally
  // made that progression impossible and left every video stuck on its first
  // observed status.
  //
  // It is still frozen where it IS evidence: once a failure or rejection
  // reason exists, or the lifecycle is terminal, nothing may relabel the
  // outcome as processed.
  const settled = hasOwn(beforeProcessing, 'failure_reason')
    || hasOwn(beforeProcessing, 'rejection_reason')
    || TERMINAL_LIFECYCLES.has(before.lifecycle)
  if (!settled) return
  if (hasOwn(beforeProcessing, 'provider_status')
    && (!afterProcessing || !hasOwn(afterProcessing, 'provider_status')
      || !isDeepStrictEqual(beforeProcessing.provider_status, afterProcessing.provider_status))) {
    throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'YouTube processing failure and rejection evidence is immutable.')
  }
}

function mergeOperationalSections(before: YouTubeOperationRecordV1, after: YouTubeOperationRecordV1): void {
  after.playlists = { ...before.playlists, ...after.playlists }
  after.drift = { ...before.drift, ...after.drift }

  const beforeRecord = before as unknown as Record<string, unknown>
  const afterRecord = after as unknown as Record<string, unknown>
  for (const key of OPTIONAL_OPERATION_KEYS) {
    if (hasOwn(beforeRecord, key) && !hasOwn(afterRecord, key)) afterRecord[key] = structuredClone(beforeRecord[key])
  }
}

function assertLifecycleAdvance(before: YouTubeOperationRecordV1, after: YouTubeOperationRecordV1): void {
  if (TERMINAL_LIFECYCLES.has(before.lifecycle) && before.lifecycle !== after.lifecycle) {
    throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'A terminal YouTube operation lifecycle cannot be reopened through the generic update path.')
  }
  const previous = LIFECYCLE_ORDER[before.lifecycle]
  const next = LIFECYCLE_ORDER[after.lifecycle]
  if (previous !== undefined && next !== undefined && next < previous) {
    throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'A YouTube operation lifecycle cannot move backwards.')
  }
  if (before.actions.some(action => action.classification === 'whole_upload' && action.state === 'uncertain')
    && ['preparing', 'uploading'].includes(after.lifecycle)) {
    throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'An uncertain accepted YouTube upload cannot return to preparing or uploading.')
  }
}

async function authorizeCurrent(projectSlug: string, channelId: string, videoId?: string): Promise<void> {
  await authorizeProjectYouTubeAction({
    project_slug: projectSlug,
    expected_channel_id: channelId,
    ...(videoId !== undefined ? { video_channel_id: channelId } : {}),
  })
}



export async function createYouTubeOperation(input: YouTubeOperationCreateInput): Promise<YouTubeOperationRecordV1> {
  assertCreateInputShape(input)
  const project = await resolveProject(input.project_slug)
  await authorizeCurrent(project.project_slug, input.channel_id)

  const operationId = `youtube_operation_${randomUUID()}`
  const now = new Date().toISOString()
  const candidate = decodeYouTubeOperationRecord(createCandidate(input, operationId, now))
  assertStoreOperationId(candidate.operation_id)
  const indexPath = operationIndexPath(project.project_dir)
  const recordPath = youtubeOperationRecordPath(project.project_dir, operationId)

  return withLock(indexPath, async () => withLock(recordPath, async () => {
    const index = await readIndexUnlocked(indexPath, project.project_slug)
    const loaded = await readAllUnlocked(project, index, candidate.operation_id)
    // Assignment is rechecked immediately before operation/index persistence.
    await authorizeCurrent(project.project_slug, candidate.channel_id)
    await writeRecordUnlocked(project.project_dir, candidate)
    await authorizeCurrent(project.project_slug, candidate.channel_id)
    await writeIndexUnlocked(indexPath, {
      schema_version: 1,
      project_slug: project.project_slug,
      operation_ids: [...loaded.index.operation_ids, candidate.operation_id],
    })
    return cloneRecord(candidate)
  }))
}



export async function acceptYouTubeOperation(input: {
  project_slug: string
  operation_id: string
  expected_revision: number
  channel_id: string
  video_id: string
  accepted_at: string
  final_payload: NonNullable<YouTubeOperationRecordV1['final_payload']>
}): Promise<YouTubeOperationRecordV1> {
  const project = await resolveProject(input.project_slug)
  assertStoreOperationId(input.operation_id)
  const indexPath = operationIndexPath(project.project_dir)
  const recordPath = youtubeOperationRecordPath(project.project_dir, input.operation_id)

  return withVideoClaimsLock(async () => {
    let claims = await readVideoClaimsUnlocked()
    return withLock(indexPath, async () => withLock(recordPath, async () => {
      const index = await readIndexUnlocked(indexPath, project.project_slug)
      const loaded = await readAllUnlocked(project, index, input.operation_id)
      const current = loaded.records.find(record => record.operation_id === input.operation_id)
      if (!current) throw operationNotFound(input.operation_id)
      if (current.channel_id !== input.channel_id) {
        throw foundationError('YOUTUBE_CHANNEL_MISMATCH', 'The accepted YouTube video belongs to a different channel.')
      }
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision !== current.revision) {
        throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'The YouTube operation changed; reload it and try again.')
      }
      if (current.video_id === undefined && (!input.video_id || !input.accepted_at)) {
        throw corrupt('the accepted video identity is invalid')
      }
    if (current.video_id !== undefined) {
      if (current.video_id !== input.video_id || current.channel_id !== input.channel_id) {
        throw foundationError('YOUTUBE_VIDEO_ID_CONFLICT', 'The YouTube operation already has a different immutable video identity.')
      }
      // A replay after the operation checkpoint repairs any discovered index
      // entry and the project link without changing the accepted record.
      if (loaded.repaired) {
        await writeIndexUnlocked(indexPath, loaded.index)
      }
      // This replays evidence for the immutable channel already pinned by the
      // operation. A later project reassignment cannot invalidate a provider
      // success that happened under the old channel.
      await linkYouTubeEpisodeVideo({
        project_slug: project.project_slug,
        episode_code: current.episode_code,
        channel_id: current.channel_id,
        video_id: current.video_id,
        source: 'upload',
        decided_at: current.accepted_at ?? input.accepted_at,
      })
      return cloneRecord(current)
    }

    if (loaded.records.some(record => record.operation_id !== current.operation_id
      && record.channel_id === input.channel_id && record.video_id === input.video_id)) {
      throw foundationError('YOUTUBE_VIDEO_ID_CONFLICT', 'That YouTube video is already claimed by another operation in this project.')
    }

    const next = cloneRecord(current) as YouTubeOperationRecordV1
    const nextRaw = next as unknown as Record<string, unknown>
    nextRaw.video_id = input.video_id
    nextRaw.accepted_at = input.accepted_at
    if (current.final_payload && !isDeepStrictEqual(current.final_payload, input.final_payload)) {
      throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'The accepted YouTube payload does not match the payload saved before upload.')
    }
    nextRaw.final_payload = structuredClone(current.final_payload ?? input.final_payload)
    next.lifecycle = 'accepted'
    next.actions.push({
      action_id: `action_${randomUUID()}`,
      action: next.final_action,
      classification: 'whole_upload',
      state: 'accepted',
      occurred_at: input.accepted_at,
    })
    next.revision = current.revision + 1
    next.updated_at = new Date().toISOString()
    const decoded = decodeYouTubeOperationRecord(next)

    const claimed = claimVideoIdentity(claims, decoded)
    claims = claimed.claims
    // Reserve the immutable identity before the record write. If the process
    // crashes after this write, a retry by the same operation is still safe,
    // while another project cannot claim the same provider video.
    if (claimed.changed) await writeVideoClaimsUnlocked(claims)

    // Pre-provider operation creation/uploading checks pin the channel. Once
    // the provider has accepted bytes, record that immutable result even if
    // the project's current assignment changed while the request was in flight.
    await writeRecordUnlocked(project.project_dir, decoded)
    if (!loaded.index.operation_ids.includes(decoded.operation_id)) {
      await writeIndexUnlocked(indexPath, {
        schema_version: 1,
        project_slug: project.project_slug,
        operation_ids: [...loaded.index.operation_ids, decoded.operation_id],
      })
    }
    await linkYouTubeEpisodeVideo({
      project_slug: project.project_slug,
      episode_code: decoded.episode_code,
      channel_id: decoded.channel_id,
      video_id: decoded.video_id!,
      source: 'upload',
      decided_at: decoded.accepted_at!,
    })
    return cloneRecord(decoded)
    }))
  })
}

export async function readYouTubeOperation(project_slug: string, operation_id: string): Promise<YouTubeOperationRecordV1 | null> {
  const project = await resolveProject(project_slug)
  assertStoreOperationId(operation_id)
  const recordPath = youtubeOperationRecordPath(project.project_dir, operation_id)
  return withLock(recordPath, async () => {
    const record = await readRecordUnlocked(project, operation_id)
    return record ? cloneRecord(record) : null
  })
}

export async function listYouTubeOperations(project_slug: string): Promise<YouTubeOperationRecordV1[]> {
  const project = await resolveProject(project_slug)
  const indexPath = operationIndexPath(project.project_dir)
  return withLock(indexPath, async () => {
    const index = await readIndexUnlocked(indexPath, project.project_slug)
    const loaded = await readAllUnlocked(project, index)
    if (loaded.repaired) await writeIndexUnlocked(indexPath, loaded.index)
    return loaded.records.map(cloneRecord)
  })
}

type OperationUpdateInput = {
  project_slug: string
  operation_id: string
  expected_revision: number
  mutate(record: YouTubeOperationRecordV1): void
}

async function updateOperation(
  input: OperationUpdateInput,
  pinnedChannelId?: string,
): Promise<YouTubeOperationRecordV1> {
  const project = await resolveProject(input.project_slug)
  assertStoreOperationId(input.operation_id)
  const indexPath = operationIndexPath(project.project_dir)
  const recordPath = youtubeOperationRecordPath(project.project_dir, input.operation_id)
  return withLock(indexPath, async () => withLock(recordPath, async () => {
      const index = await readIndexUnlocked(indexPath, project.project_slug)
      const loaded = await readAllUnlocked(project, index, input.operation_id)
      const current = loaded.records.find(record => record.operation_id === input.operation_id)
      if (!current) throw operationNotFound(input.operation_id)
      if (pinnedChannelId !== undefined && current.channel_id !== pinnedChannelId) {
        throw foundationError('YOUTUBE_CHANNEL_MISMATCH', 'The YouTube result belongs to a different operation channel.')
      }
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision !== current.revision) {
        throw foundationError('YOUTUBE_RECORD_REVISION_CONFLICT', 'The YouTube operation changed; reload it and try again.')
      }
      if (typeof input.mutate !== 'function') throw new Error('YouTube operation mutate function is required')
      const next = cloneRecord(current)
      input.mutate(next)
      assertImmutable(current, next)
      assertActionsAppendOnly(current, next)
      assertProcessingEvidencePreserved(current, next)
      mergeOperationalSections(current, next)
      assertLifecycleAdvance(current, next)
      next.revision = current.revision + 1
      next.updated_at = new Date().toISOString()
      const decoded = decodeYouTubeOperationRecord(next)
      // User-initiated and pre-provider writes remain bound to the current
      // project assignment. A result from an already-authorized provider call
      // is instead pinned to the operation's immutable channel so a concurrent
      // reassignment cannot discard or relabel the receipt.
      if (pinnedChannelId === undefined) {
        await authorizeCurrent(project.project_slug, current.channel_id, current.video_id)
      }
      await writeRecordUnlocked(project.project_dir, decoded)
      if (!loaded.index.operation_ids.includes(decoded.operation_id)) {
        if (pinnedChannelId === undefined) {
          await authorizeCurrent(project.project_slug, decoded.channel_id, decoded.video_id)
        }
        await writeIndexUnlocked(indexPath, {
          schema_version: 1,
          project_slug: project.project_slug,
          operation_ids: [...loaded.index.operation_ids, decoded.operation_id],
        })
      }
      return cloneRecord(decoded)
    }))
}

export async function updateYouTubeOperation(input: OperationUpdateInput): Promise<YouTubeOperationRecordV1> {
  return updateOperation(input)
}

/** Persist the outcome of provider work already authorised for this operation. */
export async function updatePinnedYouTubeOperation(input: OperationUpdateInput & {
  expected_channel_id: string
}): Promise<YouTubeOperationRecordV1> {
  return updateOperation(input, input.expected_channel_id)
}

export async function assertYouTubeOperationAuthorized(project_slug: string, operation_id: string): Promise<YouTubeOperationRecordV1> {
  const record = await readYouTubeOperation(project_slug, operation_id)
  if (!record) throw operationNotFound(operation_id)
  await authorizeProjectYouTubeAction({
    project_slug,
    expected_channel_id: record.channel_id,
    ...(record.video_id !== undefined ? { video_channel_id: record.channel_id } : {}),
  })
  return cloneRecord(record)
}
