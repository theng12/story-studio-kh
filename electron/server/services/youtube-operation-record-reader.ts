import fs from 'node:fs/promises'
import path from 'node:path'

import { YOUTUBE_VIDEO_LIFECYCLES, YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import type { YouTubeVideoLifecycle } from '../contracts/youtube-upload-center.js'

type ResumableState = {
  session_url_hash: string
  source_bytes: number
  created_at: string
  last_confirmed_offset: number
}

type FinalPayload = {
  snippet_json: string
  status_json: string
  source_sha256: string
}

type ProcessingState = {
  checked_at: string
  provider_status?: string
  failure_reason?: string
  rejection_reason?: string
}

type PlaylistState = {
  operation_id: string
  receipt_id?: string
  state: 'pending' | 'present' | 'removed' | 'failed'
  updated_at: string
  error_code?: string
}

type RemoteSnapshot = {
  fetched_at: string
  title: string
  description: string
  tags: string[]
  privacy_status: string
  scheduled_for: string | null
  thumbnail_etag?: string
}

type DriftState = {
  state: 'match' | 'local_changed' | 'youtube_changed' | 'conflict' | 'keep_youtube'
  decided_at?: string
}

export type YouTubeOperationActionClassification = 'whole_upload' | 'independent_post_accept'

type ActionState = {
  action_id: string
  action: string
  classification: YouTubeOperationActionClassification
  state: 'started' | 'accepted' | 'succeeded' | 'failed' | 'uncertain'
  occurred_at: string
  error_code?: string
}

export type YouTubeOperationRecordBaseV1 = {
  schema_version: 1
  revision: number
  operation_id: string
  project_slug: string
  episode_code: string
  channel_id: string
  source_revision: string
  metadata_revision: string
  created_at: string
  updated_at: string
  lifecycle: YouTubeVideoLifecycle
  video_id?: string
  accepted_at?: string
  resumable?: ResumableState
  final_payload?: FinalPayload
  processing?: ProcessingState
  playlists: Record<string, PlaylistState>
  remote_snapshot?: RemoteSnapshot
  /**
   * The snapshot `remote_snapshot` replaced at the last sync.
   *
   * Spec section 11 compares THREE records: local intent, what YouTube said
   * last time, and what YouTube says now. Without keeping the previous one,
   * "YouTube changed this" is undetectable — every sync would overwrite the
   * only evidence that it used to say something else.
   *
   * Optional: a record written before this field, or never synced twice, has
   * no previous snapshot and must stay valid.
   */
  previous_remote_snapshot?: RemoteSnapshot
  drift: Record<string, DriftState>
  actions: ActionState[]
}

export type YouTubeOperationRecordV1 = YouTubeOperationRecordBaseV1 & {
  origin: 'manual'
  final_action: 'manual_upload' | 'private_upload'
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const RESERVED_PATH_SEGMENTS = new Set([
  '__proto__', 'constructor', 'prototype',
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])
const ACTION_CLASSIFICATIONS: ReadonlyMap<string, YouTubeOperationActionClassification> = new Map([
  ['thumbnail_update', 'independent_post_accept'],
  ['failed', 'whole_upload'],
  ['manual_upload', 'whole_upload'],
  ['private_upload', 'whole_upload'],
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

function isReservedPathSegment(value: string): boolean {
  const lower = value.toLowerCase()
  const stem = lower.split('.')[0]
  return RESERVED_PATH_SEGMENTS.has(lower) || RESERVED_PATH_SEGMENTS.has(stem)
}

function corrupt(detail = 'The YouTube operation record is corrupt.'): Error {
  return new YouTubeFoundationError(
    409,
    'YOUTUBE_OPERATION_RECORD_CORRUPT',
    detail,
  )
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw corrupt(`The YouTube operation record contains an unexpected field: ${key}.`)
  }
  for (const key of required) {
    if (!hasOwn(value, key) || value[key] === undefined) {
      throw corrupt(`The YouTube operation record is missing ${key}.`)
    }
  }
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.trim() !== value || hasControlCharacters(value)) {
    throw corrupt(`The YouTube operation record has an invalid ${name}.`)
  }
  return value
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name)
  if (result === '.' || result === '..' || result.includes('/') || result.includes('\\') || isReservedPathSegment(result)) {
    throw corrupt(`The YouTube operation record has an invalid ${name}.`)
  }
  return result
}

function mapKey(value: string, name: string): void {
  if (!value || value.trim() !== value || hasControlCharacters(value) || value.includes('/') || value.includes('\\') || isReservedPathSegment(value)) {
    throw corrupt(`The YouTube operation record has an invalid ${name} map key.`)
  }
}

function canonicalRelativePath(value: unknown, name: string): string {
  const result = text(value, name)
  if (path.isAbsolute(result) || /^[A-Za-z]:/.test(result) || result.includes('\\') || result.includes(':')) {
    throw corrupt(`The YouTube operation record has an invalid ${name}.`)
  }
  const segments = result.split('/')
  if (segments.some(segment => (
    !segment
    || segment === '.'
    || segment === '..'
    || isReservedPathSegment(segment)
  )) || segments.join('/') !== result) {
    throw corrupt(`The YouTube operation record has an invalid ${name}.`)
  }
  return result
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name)
  const match = TIMESTAMP.exec(result)
  if (!match) {
    throw corrupt(`The YouTube operation record has an invalid ${name}.`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59
    || (match[8] !== 'Z' && (Number(match[9]) > 23 || Number(match[10]) > 59))
    || !Number.isFinite(Date.parse(result))) {
    throw corrupt(`The YouTube operation record has an invalid ${name}.`)
  }
  return result
}

function finiteInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw corrupt(`The YouTube operation record has an invalid ${name}.`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw corrupt(`The YouTube operation record has an invalid ${name}.`)
  }
  return value as T
}

function optionalText(value: Record<string, unknown>, key: string, name = key): string | undefined {
  if (!hasOwn(value, key)) return undefined
  return text(value[key], name)
}

function decodeResumable(value: unknown): ResumableState {
  if (!isRecord(value)) throw corrupt('The YouTube operation resumable state is invalid.')
  exactKeys(value, ['session_url_hash', 'source_bytes', 'created_at', 'last_confirmed_offset'])
  const sourceBytes = finiteInteger(value.source_bytes, 'resumable.source_bytes')
  const offset = finiteInteger(value.last_confirmed_offset, 'resumable.last_confirmed_offset')
  if (offset > sourceBytes) throw corrupt('The YouTube operation resumable offset is invalid.')
  const sessionHash = text(value.session_url_hash, 'resumable.session_url_hash')
  if (/[:/\\]/.test(sessionHash)) throw corrupt('The YouTube operation resumable session hash is invalid.')
  return {
    session_url_hash: sessionHash,
    source_bytes: sourceBytes,
    created_at: timestamp(value.created_at, 'resumable.created_at'),
    last_confirmed_offset: offset,
  }
}

function decodeFinalPayload(value: unknown): FinalPayload {
  if (!isRecord(value)) throw corrupt('The YouTube operation final payload is invalid.')
  exactKeys(value, ['snippet_json', 'status_json', 'source_sha256'])
  const snippet = text(value.snippet_json, 'final_payload.snippet_json')
  const status = text(value.status_json, 'final_payload.status_json')
  try {
    if (!isRecord(JSON.parse(snippet)) || !isRecord(JSON.parse(status))) throw new Error('not an object')
  } catch {
    throw corrupt('The YouTube operation final payload JSON is invalid.')
  }
  return { snippet_json: snippet, status_json: status, source_sha256: text(value.source_sha256, 'final_payload.source_sha256') }
}

function decodeProcessing(value: unknown): ProcessingState {
  if (!isRecord(value)) throw corrupt('The YouTube operation processing state is invalid.')
  exactKeys(value, ['checked_at'], ['provider_status', 'failure_reason', 'rejection_reason'])
  return {
    checked_at: timestamp(value.checked_at, 'processing.checked_at'),
    ...(optionalText(value, 'provider_status') !== undefined ? { provider_status: value.provider_status as string } : {}),
    ...(optionalText(value, 'failure_reason') !== undefined ? { failure_reason: value.failure_reason as string } : {}),
    ...(optionalText(value, 'rejection_reason') !== undefined ? { rejection_reason: value.rejection_reason as string } : {}),
  }
}

function decodePlaylist(value: unknown, playlistId: string): PlaylistState {
  mapKey(playlistId, 'playlist')
  if (!isRecord(value)) throw corrupt('The YouTube operation playlist state is invalid.')
  exactKeys(value, ['operation_id', 'state', 'updated_at'], ['receipt_id', 'error_code'])
  return {
    operation_id: identifier(value.operation_id, 'playlist.operation_id'),
    ...(hasOwn(value, 'receipt_id') ? { receipt_id: text(value.receipt_id, 'playlist.receipt_id') } : {}),
    state: oneOf(value.state, ['pending', 'present', 'removed', 'failed'], 'playlist.state'),
    updated_at: timestamp(value.updated_at, 'playlist.updated_at'),
    ...(hasOwn(value, 'error_code') ? { error_code: text(value.error_code, 'playlist.error_code') } : {}),
  }
}

function decodePlaylists(value: unknown): Record<string, PlaylistState> {
  if (!isRecord(value)) throw corrupt('The YouTube operation playlists are invalid.')
  return Object.fromEntries(Object.entries(value).map(([id, state]) => [id, decodePlaylist(state, id)]))
}

function decodeRemoteSnapshot(value: unknown): RemoteSnapshot {
  if (!isRecord(value)) throw corrupt('The YouTube operation remote snapshot is invalid.')
  exactKeys(value, ['fetched_at', 'title', 'description', 'tags', 'privacy_status', 'scheduled_for'], ['thumbnail_etag'])
  if (!Array.isArray(value.tags)) {
    throw corrupt('The YouTube operation remote snapshot tags are invalid.')
  }
  const tags = value.tags.map((tag, index) => text(tag, `remote_snapshot.tags[${index}]`, true))
  if (value.scheduled_for !== null) timestamp(value.scheduled_for, 'remote_snapshot.scheduled_for')
  return {
    fetched_at: timestamp(value.fetched_at, 'remote_snapshot.fetched_at'),
    title: text(value.title, 'remote_snapshot.title', true),
    description: text(value.description, 'remote_snapshot.description', true),
    tags,
    privacy_status: text(value.privacy_status, 'remote_snapshot.privacy_status'),
    scheduled_for: value.scheduled_for as string | null,
    ...(hasOwn(value, 'thumbnail_etag') ? { thumbnail_etag: text(value.thumbnail_etag, 'remote_snapshot.thumbnail_etag') } : {}),
  }
}

function decodeDrift(value: unknown): Record<string, DriftState> {
  if (!isRecord(value)) throw corrupt('The YouTube operation drift map is invalid.')
  return Object.fromEntries(Object.entries(value).map(([field, state]) => {
    mapKey(field, 'drift')
    if (!isRecord(state)) throw corrupt('The YouTube operation drift entry is invalid.')
    exactKeys(state, ['state'], ['decided_at'])
    return [field, {
      state: oneOf(state.state, ['match', 'local_changed', 'youtube_changed', 'conflict', 'keep_youtube'], 'drift.state'),
      ...(hasOwn(state, 'decided_at') ? { decided_at: timestamp(state.decided_at, 'drift.decided_at') } : {}),
    }]
  }))
}

function decodeAction(value: unknown): ActionState {
  if (!isRecord(value)) throw corrupt('The YouTube operation action is invalid.')
  exactKeys(value, ['action_id', 'action', 'classification', 'state', 'occurred_at'], ['error_code'])
  const action = text(value.action, 'action.action')
  const classification = oneOf(value.classification, ['whole_upload', 'independent_post_accept'], 'action.classification')
  if (ACTION_CLASSIFICATIONS.get(action) !== classification) {
    throw corrupt(`The YouTube operation action ${action} has an invalid classification.`)
  }
  return {
    action_id: identifier(value.action_id, 'action.action_id'),
    action,
    classification,
    state: oneOf(value.state, ['started', 'accepted', 'succeeded', 'failed', 'uncertain'], 'action.state'),
    occurred_at: timestamp(value.occurred_at, 'action.occurred_at'),
    ...(hasOwn(value, 'error_code') ? { error_code: text(value.error_code, 'action.error_code') } : {}),
  }
}

function decodeActions(value: unknown): ActionState[] {
  if (!Array.isArray(value)) throw corrupt('The YouTube operation actions are invalid.')
  const actions = value.map(decodeAction)
  if (new Set(actions.map(action => action.action_id)).size !== actions.length) {
    throw corrupt('The YouTube operation action ids are duplicated.')
  }
  return actions
}

const BASE_REQUIRED = [
  'schema_version', 'revision', 'operation_id', 'project_slug', 'episode_code', 'channel_id',
  'source_revision', 'metadata_revision', 'created_at', 'updated_at', 'lifecycle', 'playlists', 'drift', 'actions',
] as const
const BASE_OPTIONAL = [
  'video_id', 'accepted_at', 'resumable', 'final_payload', 'processing', 'remote_snapshot',
  'previous_remote_snapshot',
] as const
const UNION_KEYS = ['origin', 'final_action'] as const

function decodeBase(raw: Record<string, unknown>): YouTubeOperationRecordBaseV1 {
  exactKeys(raw, [...BASE_REQUIRED, 'origin', 'final_action'], BASE_OPTIONAL)
  if (raw.schema_version !== 1) throw corrupt('The YouTube operation schema version is invalid.')
  const revision = finiteInteger(raw.revision, 'revision')
  const lifecycle = oneOf(raw.lifecycle, YOUTUBE_VIDEO_LIFECYCLES, 'lifecycle')
  if (['accepted', 'processing', 'ready'].includes(lifecycle)
    && (!hasOwn(raw, 'video_id') || !hasOwn(raw, 'accepted_at'))) {
    throw corrupt('Accepted, processing, and ready operations require an accepted video identity.')
  }
  return {
    schema_version: 1,
    revision,
    operation_id: identifier(raw.operation_id, 'operation_id'),
    project_slug: identifier(raw.project_slug, 'project_slug'),
    episode_code: identifier(raw.episode_code, 'episode_code'),
    channel_id: identifier(raw.channel_id, 'channel_id'),
    source_revision: text(raw.source_revision, 'source_revision'),
    metadata_revision: text(raw.metadata_revision, 'metadata_revision'),
    created_at: timestamp(raw.created_at, 'created_at'),
    updated_at: timestamp(raw.updated_at, 'updated_at'),
    lifecycle,
    ...(hasOwn(raw, 'video_id') ? { video_id: identifier(raw.video_id, 'video_id') } : {}),
    ...(hasOwn(raw, 'accepted_at') ? { accepted_at: timestamp(raw.accepted_at, 'accepted_at') } : {}),
    ...(hasOwn(raw, 'resumable') ? { resumable: decodeResumable(raw.resumable) } : {}),
    ...(hasOwn(raw, 'final_payload') ? { final_payload: decodeFinalPayload(raw.final_payload) } : {}),
    ...(hasOwn(raw, 'processing') ? { processing: decodeProcessing(raw.processing) } : {}),
    playlists: decodePlaylists(raw.playlists),
    ...(hasOwn(raw, 'remote_snapshot') ? { remote_snapshot: decodeRemoteSnapshot(raw.remote_snapshot) } : {}),
    ...(hasOwn(raw, 'previous_remote_snapshot') ? { previous_remote_snapshot: decodeRemoteSnapshot(raw.previous_remote_snapshot) } : {}),
    drift: decodeDrift(raw.drift),
    actions: decodeActions(raw.actions),
  }
}

export function decodeYouTubeOperationRecord(raw: unknown): YouTubeOperationRecordV1 {
  if (!isRecord(raw)) throw corrupt('The YouTube operation record must be an object.')
  const base = decodeBase(raw)
  if (raw.origin !== 'manual' || (raw.final_action !== 'manual_upload' && raw.final_action !== 'private_upload')) {
    throw corrupt('The YouTube operation origin or action is illegal.')
  }
  return { ...base, origin: 'manual', final_action: raw.final_action }
}

function normalizeProjectDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || hasControlCharacters(value) || !path.isAbsolute(value)) {
    throw corrupt('The YouTube operation project directory is invalid.')
  }
  return path.resolve(value)
}

function normalizeOperationId(value: unknown): string {
  const result = identifier(value, 'operation_id')
  if (RESERVED_KEYS.has(result) || result.includes('/') || result.includes('\\')) {
    throw corrupt('The YouTube operation id is invalid.')
  }
  return result
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function isCorruptError(error: unknown): error is YouTubeFoundationError {
  return error instanceof YouTubeFoundationError && error.code === 'YOUTUBE_OPERATION_RECORD_CORRUPT'
}

export function youtubeOperationsDirectory(project_dir: string): string {
  return path.join(normalizeProjectDirectory(project_dir), 'youtube', 'operations')
}

export function youtubeOperationRecordPath(project_dir: string, operation_id: string): string {
  return path.join(youtubeOperationsDirectory(project_dir), `${normalizeOperationId(operation_id)}.json`)
}

export async function readYouTubeOperationRecord(input: {
  project_dir: string
  operation_id: string
}): Promise<YouTubeOperationRecordV1 | null> {
  let recordPath: string
  let operationId: string
  try {
    recordPath = youtubeOperationRecordPath(input.project_dir, input.operation_id)
    operationId = normalizeOperationId(input.operation_id)
  } catch (error) {
    if (isCorruptError(error)) throw error
    throw corrupt()
  }

  let bytes: Buffer
  try {
    bytes = await fs.readFile(recordPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw corrupt()
  }

  let raw: unknown
  try {
    const textValue = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    raw = JSON.parse(textValue)
  } catch {
    throw corrupt()
  }

  let record: YouTubeOperationRecordV1
  try {
    record = decodeYouTubeOperationRecord(raw)
  } catch (error) {
    if (isCorruptError(error)) throw error
    throw corrupt()
  }
  if (record.operation_id !== operationId) throw corrupt('The YouTube operation record identity does not match its path.')
  return record
}
