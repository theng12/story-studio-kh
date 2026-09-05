import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { getUserDataDir } from './project-manager.js'

export const YOUTUBE_QUOTA_DEFAULTS = {
  video_uploads: { limit: 100, unit: 'calls' },
  search: { limit: 100, unit: 'calls' },
  other_endpoints: { limit: 10_000, unit: 'units' },
  // The YouTube Analytics API bills against its own allowance, not the Data
  // API's - so it is a second BUCKET here, never a second ledger.
  //
  // The limit is `null` because it is genuinely UNKNOWN: nothing in this
  // repository records the real allowance, and it is per Cloud project rather
  // than a public constant. Null rather than a plausible placeholder on
  // purpose - a comment does not survive a grep-and-reuse, but a type error
  // does. Arithmetic on this limit will not compile.
  //
  // No product setting guesses or overrides this provider-owned allowance.
  analytics: { limit: null, unit: 'units' },
} as const

export type YouTubeQuotaBucket = 'video_uploads' | 'search' | 'other_endpoints' | 'analytics'
type YouTubeQuotaUnit = typeof YOUTUBE_QUOTA_DEFAULTS[YouTubeQuotaBucket]['unit']

const BUCKETS = Object.keys(YOUTUBE_QUOTA_DEFAULTS) as YouTubeQuotaBucket[]
const PACIFIC_TIME_ZONE = 'America/Los_Angeles'
const EXTERNAL_USAGE_NOTE = 'Only calls recorded by this Story Studio installation are known; calls from other installations, OAuth clients, or systems sharing this Cloud project are unknown.'

export interface YouTubeQuotaBucketSnapshot {
  used: number
  /** Null when the allowance is unknown. Never a guess dressed as a number. */
  limit: number | null
  /** Null whenever `limit` is - there is no arithmetic to do. */
  remaining: number | null
  unit: YouTubeQuotaUnit
  stale: boolean
  by_channel: Record<string, number>
  /**
   * Whether the allowance is known. DERIVED from `limit`, not declared
   * alongside it - two fields that must agree eventually disagree.
   */
  limit_verified: boolean
}

export interface YouTubeQuotaSnapshot {
  application_id: string
  tracking_day: string
  resets_at: string
  unknown_before: string
  external_usage_known: false
  external_usage_note: string
  buckets: Record<YouTubeQuotaBucket, YouTubeQuotaBucketSnapshot>
}

type LedgerErrorCode =
  | 'YOUTUBE_QUOTA_INVALID'
  | 'YOUTUBE_QUOTA_LEDGER_CORRUPT'
  | 'YOUTUBE_QUOTA_LEDGER_IO'
  | 'YOUTUBE_QUOTA_EXHAUSTED'

export class YouTubeQuotaLedgerError extends Error {
  readonly code: LedgerErrorCode
  readonly statusCode: number
  readonly expose = true
  readonly filePath?: string

  constructor(code: LedgerErrorCode, message: string, statusCode = 409, filePath?: string) {
    super(message)
    this.name = 'YouTubeQuotaLedgerError'
    this.code = code
    this.statusCode = statusCode
    this.filePath = filePath
  }
}

export class YouTubeQuotaExceededError extends YouTubeQuotaLedgerError {
  readonly bucket: YouTubeQuotaBucket
  readonly snapshot: YouTubeQuotaSnapshot

  constructor(bucket: YouTubeQuotaBucket, amount: number, snapshot: YouTubeQuotaSnapshot) {
    super(
      'YOUTUBE_QUOTA_EXHAUSTED',
      `The YouTube ${bucket} quota bucket cannot record ${amount} more ${snapshot.buckets[bucket].unit}; `
      + `${snapshot.buckets[bucket].used}/${snapshot.buckets[bucket].limit ?? 'an unknown allowance'} is tracked for today. `
      + `The bucket resets at ${snapshot.resets_at}.`,
      429,
    )
    this.name = 'YouTubeQuotaExceededError'
    this.bucket = bucket
    this.snapshot = snapshot
  }
}

interface QuotaMetaV1 {
  schema_version: 1
  application_id: string
  initialized_at: string
  unknown_before: string
  limits: Record<YouTubeQuotaBucket, number | null>
  stale: Record<YouTubeQuotaBucket, boolean>
}

interface QuotaEventV1 {
  attempted_at: string
  channel_id: string
  bucket: YouTubeQuotaBucket
  operation: string
  amount: number
}

interface PacificDateParts {
  year: number
  month: number
  day: number
}

let nowProvider: () => Date = () => new Date()

/** Test-only clock seam; production always uses the system clock. */
export function __setYouTubeQuotaClockForTests(now: Date | (() => Date)): void {
  if (typeof now === 'function') {
    nowProvider = now
    return
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw invalid('YouTube quota test clock is invalid')
  }
  const timestamp = now.getTime()
  nowProvider = () => new Date(timestamp)
}

/** Test-only clock cleanup. */
export function __resetYouTubeQuotaClockForTests(): void {
  nowProvider = () => new Date()
}

function invalid(message: string): YouTubeQuotaLedgerError {
  return new YouTubeQuotaLedgerError('YOUTUBE_QUOTA_INVALID', message)
}

function corrupt(filePath: string, detail: string): YouTubeQuotaLedgerError {
  return new YouTubeQuotaLedgerError(
    'YOUTUBE_QUOTA_LEDGER_CORRUPT',
    `${path.basename(filePath)} is corrupt and cannot be used as a YouTube quota ledger (${detail}). Refusing to replace it with an empty ledger.`,
  )
}

function ioError(filePath: string, error: unknown): YouTubeQuotaLedgerError {
  const code = error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : 'IO_ERROR'
  return new YouTubeQuotaLedgerError(
    'YOUTUBE_QUOTA_LEDGER_IO',
    `Unable to read or write ${path.basename(filePath)} for the YouTube quota ledger (${code}).`,
    409,
    filePath,
  )
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizePathSegment(value: unknown, name: string): string {
  if (typeof value !== 'string') throw invalid(`YouTube quota ${name} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/')
    || normalized.includes('\\') || normalized.includes('\0')
    || normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype') {
    throw invalid(`YouTube quota ${name} is an invalid identifier`)
  }
  return normalized
}

function normalizeBucket(value: unknown): YouTubeQuotaBucket {
  if (typeof value !== 'string' || !BUCKETS.includes(value as YouTubeQuotaBucket)) {
    throw invalid('YouTube quota bucket is invalid')
  }
  return value as YouTubeQuotaBucket
}

function normalizeAmount(value: unknown, name = 'amount'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid(`YouTube quota ${name} must be a finite positive number`)
  }
  return value
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = ISO_TIMESTAMP.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return null
  if (match[7] !== undefined && match[7].length > 9) return null
  if (match[8] !== 'Z' && (Number(match[9]) > 23 || Number(match[10]) > 59)) return null
  const timestamp = Date.parse(value.trim())
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizeTimestamp(value: unknown, name: string): string {
  const timestamp = parseTimestamp(value)
  if (timestamp === null) {
    throw invalid(`YouTube quota ${name} must be a valid timestamp`)
  }
  return new Date(timestamp).toISOString()
}

function currentDate(): Date {
  const value = nowProvider()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalid('YouTube quota clock returned an invalid timestamp')
  }
  return new Date(value.getTime())
}

function defaultLimits(): Record<YouTubeQuotaBucket, number | null> {
  return Object.fromEntries(BUCKETS.map(bucket => [bucket, YOUTUBE_QUOTA_DEFAULTS[bucket].limit])) as Record<YouTubeQuotaBucket, number | null>
}

function defaultStale(): Record<YouTubeQuotaBucket, boolean> {
  return Object.fromEntries(BUCKETS.map(bucket => [bucket, false])) as Record<YouTubeQuotaBucket, boolean>
}

function freshMeta(applicationId: string, initializedAt: string): QuotaMetaV1 {
  return {
    schema_version: 1,
    application_id: applicationId,
    initialized_at: initializedAt,
    unknown_before: initializedAt,
    limits: defaultLimits(),
    stale: defaultStale(),
  }
}

function userDataRoot(): string {
  return path.resolve(getUserDataDir())
}

function quotaDirectory(applicationId: string): string {
  return path.join(userDataRoot(), 'youtube', 'quota', applicationId)
}

function eventsFile(applicationId: string): string {
  return path.join(quotaDirectory(applicationId), 'events.jsonl')
}

function metaFile(applicationId: string): string {
  return path.join(quotaDirectory(applicationId), 'meta.json')
}

function withLedgerLock<T>(applicationId: string, fn: () => Promise<T>): Promise<T> {
  const eventsPath = eventsFile(applicationId)
  const metadataPath = metaFile(applicationId)
  return withLock(eventsPath, () => withLock(metadataPath, fn))
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], filePath: string): void {
  const expected = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw corrupt(filePath, `unexpected field ${key}`)
  }
}

function decodeMeta(raw: unknown, filePath: string, applicationId: string): QuotaMetaV1 {
  if (!isRecord(raw)) throw corrupt(filePath, 'the JSON value is not an object')
  assertExactKeys(raw, ['schema_version', 'application_id', 'initialized_at', 'unknown_before', 'limits', 'stale'], filePath)
  if (raw.schema_version !== 1 || raw.application_id !== applicationId) {
    throw corrupt(filePath, 'schema version or application identity is invalid')
  }
  const initializedAt = normalizeTimestampForRead(raw.initialized_at, filePath, 'initialized_at')
  const unknownBefore = normalizeTimestampForRead(raw.unknown_before, filePath, 'unknown_before')
  if (!isRecord(raw.limits) || !isRecord(raw.stale)) throw corrupt(filePath, 'limits or stale is not an object')
  assertExactKeys(raw.limits, BUCKETS, filePath)
  assertExactKeys(raw.stale, BUCKETS, filePath)
  const limits: Record<YouTubeQuotaBucket, number | null> = defaultLimits()
  const stale = defaultStale()
  for (const bucket of BUCKETS) {
    // A bucket added after this file was written is ABSENT, not invalid. Every
    // ledger on disk predates `analytics`, and treating a missing key as
    // corruption would have condemned every existing installation's quota
    // history the moment a bucket was added.
    const limit = raw.limits[bucket]
    // Three different things, kept apart: ABSENT means the bucket postdates
    // this file, so take the default; NULL means the allowance is known to be
    // unknown, which is a legitimate stored value; anything else must be a
    // positive number.
    if (limit === null) {
      limits[bucket] = null
    } else if (limit !== undefined) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
        throw corrupt(filePath, `${bucket} limit is invalid`)
      }
      limits[bucket] = limit
    }
    const staleFlag = raw.stale[bucket]
    if (staleFlag !== undefined) {
      if (typeof staleFlag !== 'boolean') throw corrupt(filePath, `${bucket} stale flag is invalid`)
      stale[bucket] = staleFlag
    }
  }
  return {
    schema_version: 1,
    application_id: applicationId,
    initialized_at: initializedAt,
    unknown_before: unknownBefore,
    limits,
    stale,
  }
}

function normalizeTimestampForRead(value: unknown, filePath: string, name: string): string {
  const timestamp = parseTimestamp(value)
  if (timestamp === null) {
    throw corrupt(filePath, `${name} is not a valid timestamp`)
  }
  return new Date(timestamp).toISOString()
}

function decodeEvent(raw: unknown, filePath: string): QuotaEventV1 {
  if (!isRecord(raw)) throw corrupt(filePath, 'a JSONL row is not an object')
  assertExactKeys(raw, ['attempted_at', 'channel_id', 'bucket', 'operation', 'amount'], filePath)
  const attemptedAt = normalizeTimestampForRead(raw.attempted_at, filePath, 'attempted_at')
  const channelId = normalizePathSegmentForRead(raw.channel_id, filePath, 'channel_id')
  if (typeof raw.bucket !== 'string' || !BUCKETS.includes(raw.bucket as YouTubeQuotaBucket)) {
    throw corrupt(filePath, 'bucket is invalid')
  }
  if (typeof raw.operation !== 'string' || !raw.operation.trim() || raw.operation.includes('\0')) {
    throw corrupt(filePath, 'operation is invalid')
  }
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0) {
    throw corrupt(filePath, 'amount is invalid')
  }
  return {
    attempted_at: attemptedAt,
    channel_id: channelId,
    bucket: raw.bucket as YouTubeQuotaBucket,
    operation: raw.operation.trim(),
    amount: raw.amount,
  }
}

function normalizePathSegmentForRead(value: unknown, filePath: string, name: string): string {
  if (typeof value !== 'string') throw corrupt(filePath, `${name} is not a string`)
  const normalized = value.trim()
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/')
    || normalized.includes('\\') || normalized.includes('\0')
    || normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype') {
    throw corrupt(filePath, `${name} is an invalid identifier`)
  }
  return normalized
}

function decodeUtf8(filePath: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw corrupt(filePath, 'invalid UTF-8 bytes')
  }
}

async function readMeta(applicationId: string): Promise<QuotaMetaV1 | null> {
  const filePath = metaFile(applicationId)
  let bytes: Buffer
  try {
    bytes = await fs.readFile(filePath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw ioError(filePath, error)
  }
  const text = decodeUtf8(filePath, bytes)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw corrupt(filePath, error instanceof Error ? error.message : 'invalid JSON')
  }
  return decodeMeta(raw, filePath, applicationId)
}

async function readEvents(applicationId: string): Promise<QuotaEventV1[]> {
  const filePath = eventsFile(applicationId)
  let bytes: Buffer
  try {
    bytes = await fs.readFile(filePath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return []
    throw ioError(filePath, error)
  }
  const text = decodeUtf8(filePath, bytes)
  const events: QuotaEventV1[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (!line) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw corrupt(filePath, `invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : 'parse error'}`)
    }
    events.push(decodeEvent(raw, filePath))
  }
  return events
}

async function writeMeta(applicationId: string, meta: QuotaMetaV1): Promise<void> {
  const filePath = metaFile(applicationId)
  await fs.mkdir(quotaDirectory(applicationId), { recursive: true })
  await writeJsonAtomic(filePath, meta, { mode: 0o600 })
}

async function appendEvent(applicationId: string, event: QuotaEventV1): Promise<void> {
  const filePath = eventsFile(applicationId)
  await fs.mkdir(quotaDirectory(applicationId), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
}

interface LedgerState {
  meta: QuotaMetaV1 | null
  events: QuotaEventV1[]
}

async function readState(applicationId: string): Promise<LedgerState> {
  // Read both sources before initializing a missing meta file. A corrupt
  // JSONL file must remain read-only and must not trigger a fresh meta write.
  const events = await readEvents(applicationId)
  const meta = await readMeta(applicationId)
  return { meta, events }
}

function isEventsReadFailure(error: unknown, applicationId: string): boolean {
  return error instanceof YouTubeQuotaLedgerError
    && error.code === 'YOUTUBE_QUOTA_LEDGER_IO'
    && error.filePath === eventsFile(applicationId)
}

async function markBucketStaleAfterEventsFailure(
  applicationId: string,
  bucket: YouTubeQuotaBucket,
): Promise<void> {
  // A failed events read means the append path cannot be opened either (for
  // example, an events.jsonl directory). Mark the bucket when the meta source
  // is still readable, but never replace corrupt meta with a guessed ledger.
  let meta: QuotaMetaV1 | null
  try {
    meta = await readMeta(applicationId)
  } catch {
    return
  }
  const now = currentDate()
  const base = meta ?? freshMeta(applicationId, now.toISOString())
  await writeMeta(applicationId, {
    ...base,
    stale: { ...base.stale, [bucket]: true },
  }).catch(() => {})
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: PACIFIC_TIME_ZONE })
}

function datePartsInPacific(date: Date): PacificDateParts {
  const parts = formatter({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  return {
    year: Number(parts.find(part => part.type === 'year')?.value),
    month: Number(parts.find(part => part.type === 'month')?.value),
    day: Number(parts.find(part => part.type === 'day')?.value),
  }
}

function wallPartsInPacific(date: Date): PacificDateParts & { hour: number; minute: number; second: number } {
  const parts = formatter({
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)
  const rawHour = Number(parts.find(part => part.type === 'hour')?.value)
  return {
    ...datePartsInPacific(date),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(parts.find(part => part.type === 'minute')?.value),
    second: Number(parts.find(part => part.type === 'second')?.value),
  }
}

function shiftCalendarDate(parts: PacificDateParts, days: number): PacificDateParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

function pacificMidnight(parts: PacificDateParts): Date {
  let guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const targetWall = Date.UTC(parts.year, parts.month - 1, parts.day)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = wallPartsInPacific(guess)
    const actualWall = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    const correction = targetWall - actualWall
    if (correction === 0) return guess
    guess = new Date(guess.getTime() + correction)
  }
  return guess
}

function mostRecentPacificMidnight(date: Date): Date {
  const parts = datePartsInPacific(date)
  const midnight = pacificMidnight(parts)
  if (midnight.getTime() <= date.getTime()) return midnight
  return pacificMidnight(shiftCalendarDate(parts, -1))
}

function nextPacificMidnight(date: Date): Date {
  return pacificMidnight(shiftCalendarDate(datePartsInPacific(date), 1))
}

function pacificDayString(date: Date): string {
  const parts = datePartsInPacific(date)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function emptyBucketSnapshot(bucket: YouTubeQuotaBucket, meta: QuotaMetaV1): YouTubeQuotaBucketSnapshot {
  return {
    used: 0,
    limit: meta.limits[bucket],
    remaining: meta.limits[bucket],

    unit: YOUTUBE_QUOTA_DEFAULTS[bucket].unit,
    stale: meta.stale[bucket],
    by_channel: {},
    limit_verified: meta.limits[bucket] !== null,
  }
}

function snapshotFromState(applicationId: string, meta: QuotaMetaV1, events: QuotaEventV1[], now: Date): YouTubeQuotaSnapshot {
  const reset = mostRecentPacificMidnight(now).getTime()
  const buckets = Object.fromEntries(BUCKETS.map(bucket => [bucket, emptyBucketSnapshot(bucket, meta)])) as Record<YouTubeQuotaBucket, YouTubeQuotaBucketSnapshot>
  for (const event of events) {
    if (Date.parse(event.attempted_at) < reset) continue
    const bucket = buckets[event.bucket]
    bucket.used += event.amount
    const previous = Object.prototype.hasOwnProperty.call(bucket.by_channel, event.channel_id)
      ? bucket.by_channel[event.channel_id]
      : 0
    bucket.by_channel[event.channel_id] = previous + event.amount
  }
  for (const bucket of BUCKETS) {
    const value = buckets[bucket]
    // No limit means no remainder. Reporting `used` as the remainder, or 0,
    // would each be a claim about a ceiling nobody knows.
    value.remaining = value.limit === null ? null : Math.max(0, value.limit - value.used)
  }
  return {
    application_id: applicationId,
    tracking_day: pacificDayString(now),
    resets_at: nextPacificMidnight(now).toISOString(),
    unknown_before: meta.unknown_before,
    external_usage_known: false,
    external_usage_note: EXTERNAL_USAGE_NOTE,
    buckets,
  }
}

export async function readYouTubeQuota(application_id: string): Promise<YouTubeQuotaSnapshot> {
  const applicationId = normalizePathSegment(application_id, 'application_id')
  return withLedgerLock(applicationId, async () => {
    const state = await readState(applicationId)
    const now = currentDate()
    const meta = state.meta ?? freshMeta(applicationId, now.toISOString())
    if (!state.meta) await writeMeta(applicationId, meta)
    return snapshotFromState(applicationId, meta, state.events, now)
  })
}



export async function checkYouTubeQuota(
  application_id: string,
  bucket: YouTubeQuotaBucket,
  amount: number,
): Promise<void> {
  const applicationId = normalizePathSegment(application_id, 'application_id')
  const quotaBucket = normalizeBucket(bucket)
  const requested = normalizeAmount(amount)
  const snapshot = await readYouTubeQuota(applicationId)
  const limit = snapshot.buckets[quotaBucket].limit
  if (limit === null) {
    // Loud, not silent. Permitting the call would be a decision made in the
    // dark - "we do not know the ceiling, so assume there is room" is exactly
    // the reasoning this feature must never do quietly.
    throw invalid(`The ${quotaBucket} quota bucket has no confirmed limit, so it cannot be gated`)
  }
  if (snapshot.buckets[quotaBucket].used + requested > limit) {
    throw new YouTubeQuotaExceededError(quotaBucket, requested, snapshot)
  }
}

export async function recordYouTubeQuotaAttempt(input: {
  application_id: string
  channel_id: string
  bucket: YouTubeQuotaBucket
  operation: string
  amount: number
  attempted_at?: string
}): Promise<void> {
  if (!isRecord(input)) throw invalid('YouTube quota attempt must be an object')
  const applicationId = normalizePathSegment(input.application_id, 'application_id')
  const channelId = normalizePathSegment(input.channel_id, 'channel_id')
  const bucket = normalizeBucket(input.bucket)
  const operation = typeof input.operation === 'string' && input.operation.trim() && !input.operation.includes('\0')
    ? input.operation.trim()
    : (() => { throw invalid('YouTube quota operation is invalid') })()
  const amount = normalizeAmount(input.amount)
  const attemptedAt = input.attempted_at === undefined
    ? currentDate().toISOString()
    : normalizeTimestamp(input.attempted_at, 'attempted_at')
  const event: QuotaEventV1 = {
    attempted_at: attemptedAt,
    channel_id: channelId,
    bucket,
    operation,
    amount,
  }

  return withLedgerLock(applicationId, async () => {
    let state: LedgerState
    try {
      state = await readState(applicationId)
    } catch (error) {
      if (isEventsReadFailure(error, applicationId)) {
        await markBucketStaleAfterEventsFailure(applicationId, bucket)
      }
      throw error
    }
    const now = currentDate()
    const meta = state.meta ?? freshMeta(applicationId, now.toISOString())
    try {
      if (!state.meta) {
        await writeMeta(applicationId, meta)
      }
      await appendEvent(applicationId, event)
    } catch (error) {
      const stale = { ...meta.stale, [bucket]: true }
      await writeMeta(applicationId, { ...meta, stale }).catch(() => {})
      throw error
    }

    if (meta.stale[bucket]) {
      // The event is already durable. If this clear fails, the previous
      // stale metadata remains in place and the write error is propagated.
      await writeMeta(applicationId, { ...meta, stale: { ...meta.stale, [bucket]: false } })
    }
  })
}
