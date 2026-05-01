/**
 * YouTube Data API quota tracker — per-account JSONL ledger.
 *
 * YouTube's default project quota is 10,000 units/day, reset at midnight
 * Pacific time. Costly operations:
 *   - videos.insert     : 1600 units   (upload a video)
 *   - videos.update     :   50 units   (metadata PATCH)
 *   - thumbnails.set    :   50 units   (custom thumbnail)
 *   - channels.list     :    1 unit
 *   - playlistItems.list:    1 unit / page
 *
 * On the default quota, that's ~6 uploads/day before hitting the ceiling.
 * Storage is per YouTube *account* (not per project) because each OAuth
 * client lives in its own Google Cloud project and therefore has its own
 * quota bucket. Public functions still take `slug` and resolve it to the
 * project's active account internally — call sites stay unchanged.
 *
 * Layout under `<userData>/youtube-quota/`:
 *   - `<accountId>.jsonl`     — append-only events: {"ts","op","units"}
 *   - `<accountId>.meta.json` — { ceiling, stale }
 *
 * Append-only is cheap (single fs.appendFile syscall, atomic for a small
 * line on POSIX/NTFS) and means the meta sidecar never has to be rewritten
 * on the hot path. Reads filter the JSONL by the most recent Pacific
 * midnight boundary and sum `units` — no persisted "tracking_day" needed.
 *
 * The counter is best-effort and local. If the user's Google Cloud project
 * has a different quota OR they used it from another tool, our count
 * underreports. The server-side 403 is still the source of truth; we just
 * try to flag locally before we burn an upload on a doomed attempt.
 */

import fs from 'fs/promises'
import path from 'path'
import * as pm from './project-manager.js'
import * as store from './upload-store.js'
import { logLine } from './logger.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'

export const YOUTUBE_DEFAULT_QUOTA = 10_000

/** Unit cost per API call we make. */
export const QUOTA_COST = {
  videos_insert: 1600,
  videos_update: 50,
  thumbnails_set: 50,
  channels_list: 1,
  playlist_items_list: 1,
  playlists_list: 1,
  playlists_insert: 50,
  playlist_items_insert: 50,
  videos_list: 1,
} as const
export type QuotaKey = keyof typeof QUOTA_COST

export interface QuotaSnapshot {
  /** Total units spent in the current Pacific day. */
  used: number
  /** Configured ceiling (user can override if they've requested a quota bump). */
  ceiling: number
  /** ISO date (YYYY-MM-DD) of the Pacific day the counter tracks. */
  tracking_day: string
  /** ISO 8601 of the next reset boundary (midnight Pacific). */
  resets_at: string
  /** Thresholds the UI and pre-check use. */
  warn_at: number
  block_at: number
  /**
   * True when the most recent `recordQuotaUsage` write failed (disk full,
   * lock contention, permissions drift). The local counter is then behind
   * what YouTube has actually billed; the UI should warn the user that the
   * displayed `used` number is unreliable until the next successful write
   * clears the flag.
   */
  stale?: boolean
}

interface LedgerEntry {
  ts: string
  op: string
  units: number
}

interface MetaFile {
  ceiling?: number
  stale?: boolean
}

/** 80% of ceiling → show the warning badge. */
function warnThreshold(ceiling: number) { return Math.floor(ceiling * 0.8) }
/** 90% of ceiling → pre-check refuses to start the upload. */
function blockThreshold(ceiling: number) { return Math.floor(ceiling * 0.9) }

function pacificDayString(d: Date = new Date()): string {
  // Stable key for "today in Pacific time" regardless of the user's local
  // clock. Collapses DST shifts — midnight Pacific is always midnight
  // Pacific, tz handles the UTC offset delta.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const dd = parts.find(p => p.type === 'day')?.value
  return `${y}-${m}-${dd}`
}

function nextMidnightPacific(d: Date = new Date()): Date {
  // Build "tomorrow in Pacific" at 00:00 local, convert to a UTC instant.
  // Uses the same approach as upload-plans.ts: iterate until round-trip
  // agrees, handles DST transitions gracefully.
  const tomorrowUtc = new Date(d.getTime() + 86_400_000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(tomorrowUtc)
  const y = Number(parts.find(p => p.type === 'year')?.value)
  const m = Number(parts.find(p => p.type === 'month')?.value)
  const dd = Number(parts.find(p => p.type === 'day')?.value)
  // Guess + iterate: same pattern as dateAtTzLocal in upload-plans.ts.
  let guess = new Date(Date.UTC(y, m - 1, dd, 0, 0, 0))
  for (let i = 0; i < 3; i++) {
    const gParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(guess)
    const gy = Number(gParts.find(p => p.type === 'year')?.value)
    const gm = Number(gParts.find(p => p.type === 'month')?.value)
    const gd = Number(gParts.find(p => p.type === 'day')?.value)
    const rawHour = Number(gParts.find(p => p.type === 'hour')?.value)
    const ghh = rawHour === 24 ? 0 : rawHour
    const gmm = Number(gParts.find(p => p.type === 'minute')?.value)
    const wallUtc = Date.UTC(gy, gm - 1, gd, ghh, gmm, 0)
    const targetUtc = Date.UTC(y, m - 1, dd, 0, 0, 0)
    const delta = targetUtc - wallUtc
    if (Math.abs(delta) < 60_000) return guess
    guess = new Date(guess.getTime() + delta)
  }
  return guess
}

/** The most recent Pacific midnight boundary as a UTC instant. */
function mostRecentPacificMidnight(d: Date = new Date()): Date {
  // The next midnight is always within the next 24h; the previous midnight
  // is always exactly 24h earlier from the perspective of nextMidnightPacific
  // applied to the previous day. Easier: compute next midnight, subtract 24h.
  // Note: DST transition days are 23 or 25h, so we compute by stepping back.
  const next = nextMidnightPacific(d)
  // Step back ~24h, then re-forward to the previous midnight using the same
  // round-trip helper. nextMidnightPacific(yesterday) == today's midnight.
  const yesterday = new Date(d.getTime() - 86_400_000)
  return nextMidnightPacific(yesterday)
}

// ── Storage primitives ────────────────────────────────────────────────────

function getQuotaDir(): string {
  return path.join(pm.getUserDataDir(), 'youtube-quota')
}

function ledgerPath(accountId: string): string {
  return path.join(getQuotaDir(), `${accountId}.jsonl`)
}

function metaPath(accountId: string): string {
  return path.join(getQuotaDir(), `${accountId}.meta.json`)
}

async function readLedger(accountId: string): Promise<LedgerEntry[]> {
  let text: string
  try {
    text = await fs.readFile(ledgerPath(accountId), 'utf-8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const out: LedgerEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as LedgerEntry
      if (parsed && typeof parsed.ts === 'string' && typeof parsed.units === 'number') {
        out.push(parsed)
      }
    } catch {
      // Skip malformed lines — append-only ledger may have been touched
      // by an interrupted write; corrupt lines are dropped on read.
    }
  }
  return out
}

async function appendEvent(accountId: string, op: QuotaKey, units: number): Promise<void> {
  await fs.mkdir(getQuotaDir(), { recursive: true })
  const entry: LedgerEntry = { ts: new Date().toISOString(), op, units }
  // appendFile with the default flag is a single syscall — atomic at the OS
  // level for line-sized writes. No lock needed for our volume.
  await fs.appendFile(ledgerPath(accountId), JSON.stringify(entry) + '\n')
}

async function readMeta(accountId: string): Promise<MetaFile> {
  try {
    const text = await fs.readFile(metaPath(accountId), 'utf-8')
    const parsed = JSON.parse(text) as MetaFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeMeta(accountId: string, partial: Partial<MetaFile>): Promise<void> {
  await fs.mkdir(getQuotaDir(), { recursive: true })
  const file = metaPath(accountId)
  await withLock(file, async () => {
    const current = await readMeta(accountId)
    const next: MetaFile = { ...current, ...partial }
    await writeJsonAtomic(file, next)
  })
}

/**
 * Opportunistic trim: if the oldest ledger entry is more than 30 days old,
 * rewrite the file keeping only the last 30 days. Cheap and rare — the file
 * stays small the rest of the time.
 */
async function maybeTrim(accountId: string, entries: LedgerEntry[]): Promise<LedgerEntry[]> {
  if (entries.length === 0) return entries
  const cutoff = Date.now() - 30 * 86_400_000
  const oldestTs = Date.parse(entries[0].ts)
  if (!Number.isFinite(oldestTs) || oldestTs >= cutoff) return entries
  const trimmed = entries.filter(e => {
    const t = Date.parse(e.ts)
    return Number.isFinite(t) && t >= cutoff
  })
  const file = ledgerPath(accountId)
  await withLock(file, async () => {
    const body = trimmed.map(e => JSON.stringify(e)).join('\n') + (trimmed.length ? '\n' : '')
    await fs.writeFile(file, body)
  })
  return trimmed
}

// ── Account resolution ────────────────────────────────────────────────────

async function resolveAccountId(slug: string): Promise<string | null> {
  try {
    const id = await store.getDefaultAccountId(slug, 'youtube')
    return id ? id : null
  } catch {
    return null
  }
}

// ── In-memory cache (5s TTL per account) ──────────────────────────────────

interface CacheEntry { snap: QuotaSnapshot; expiresAt: number }
const snapshotCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5_000

function cacheGet(accountId: string): QuotaSnapshot | null {
  const hit = snapshotCache.get(accountId)
  if (!hit) return null
  if (hit.expiresAt < Date.now()) {
    snapshotCache.delete(accountId)
    return null
  }
  return hit.snap
}

function cachePut(accountId: string, snap: QuotaSnapshot): void {
  snapshotCache.set(accountId, { snap, expiresAt: Date.now() + CACHE_TTL_MS })
}

function cacheInvalidate(accountId: string): void {
  snapshotCache.delete(accountId)
}

// ── Public API ────────────────────────────────────────────────────────────

function zeroSnapshot(ceiling: number, stale = false): QuotaSnapshot {
  return {
    used: 0,
    ceiling,
    tracking_day: pacificDayString(),
    resets_at: nextMidnightPacific().toISOString(),
    warn_at: warnThreshold(ceiling),
    block_at: blockThreshold(ceiling),
    stale,
  }
}

export async function readQuota(slug: string): Promise<QuotaSnapshot> {
  const accountId = await resolveAccountId(slug)
  if (!accountId) {
    return zeroSnapshot(YOUTUBE_DEFAULT_QUOTA)
  }
  const cached = cacheGet(accountId)
  if (cached) return cached

  const meta = await readMeta(accountId)
  const ceiling = Number(meta.ceiling) > 0 ? Number(meta.ceiling) : YOUTUBE_DEFAULT_QUOTA
  const stale = meta.stale === true

  let entries = await readLedger(accountId)
  entries = await maybeTrim(accountId, entries)

  const cutoff = mostRecentPacificMidnight().getTime()
  let used = 0
  for (const e of entries) {
    const t = Date.parse(e.ts)
    if (Number.isFinite(t) && t >= cutoff) used += Number(e.units) || 0
  }

  const snap: QuotaSnapshot = {
    used,
    ceiling,
    tracking_day: pacificDayString(),
    resets_at: nextMidnightPacific().toISOString(),
    warn_at: warnThreshold(ceiling),
    block_at: blockThreshold(ceiling),
    stale,
  }
  cachePut(accountId, snap)
  return snap
}

export async function setQuotaCeiling(slug: string, ceiling: number): Promise<void> {
  const accountId = await resolveAccountId(slug)
  if (!accountId) {
    // No active account → nothing to persist. Surface as a no-op rather
    // than throwing; the UI's PUT will simply read back zero on the GET.
    return
  }
  await writeMeta(accountId, { ceiling })
  cacheInvalidate(accountId)
}

/** Pre-check before an API call. Throws a quota-aware error if we'd cross the block threshold. */
export async function checkQuota(slug: string, key: QuotaKey): Promise<void> {
  const snap = await readQuota(slug)
  const cost = QUOTA_COST[key]
  if (snap.used + cost > snap.block_at) {
    throw new QuotaExceededError(
      `Would exceed today's YouTube API quota budget: ${snap.used}/${snap.ceiling} used, this call costs ${cost}, block threshold is ${snap.block_at}. Resets at ${snap.resets_at} (Pacific midnight). Request a quota increase at console.cloud.google.com → APIs → YouTube Data API → Quotas.`,
      snap,
    )
  }
}

export async function recordQuotaUsage(slug: string, key: QuotaKey): Promise<void> {
  const accountId = await resolveAccountId(slug)
  if (!accountId) {
    // Recording without an active account is meaningless — the call must
    // have used somebody's tokens, but we have nowhere to attribute it.
    // Log at debug rather than throwing so the API call result still
    // bubbles up cleanly to the user.
    // No active account — the call must have used somebody's tokens, but
    // we have nowhere to attribute it. Don't throw; log at info so the
    // operator can spot it in server logs without alarm bells.
    logLine('info', '[upload-quota] skipping record — no active YouTube account', { slug, key })
    return
  }
  const cost = QUOTA_COST[key]
  try {
    await appendEvent(accountId, key, cost)
    cacheInvalidate(accountId)
    // On a successful write, also clear the stale flag — the ledger is
    // back in sync with what we've actually spent.
    const meta = await readMeta(accountId)
    if (meta.stale === true) {
      await writeMeta(accountId, { stale: false })
    }
  } catch (err) {
    // Best-effort: try to mark the ledger stale so the UI can warn. If
    // this write also fails (the original cause likely persists), swallow
    // the secondary error — the primary error is what callers need to see.
    await writeMeta(accountId, { stale: true }).catch((flagErr) => {
      logLine('warn', '[upload-quota] failed to set stale flag after ledger write failed', {
        slug,
        accountId,
        key,
        flag_error: (flagErr as any)?.message || 'unknown',
      })
    })
    cacheInvalidate(accountId)
    throw err
  }
}

export class QuotaExceededError extends Error {
  status = 429
  expose = true
  snapshot: QuotaSnapshot
  constructor(message: string, snapshot: QuotaSnapshot) {
    super(message)
    this.name = 'QuotaExceededError'
    this.snapshot = snapshot
  }
}

/**
 * Parse a Google API error body for quota-related reasons. Returns a
 * friendly string when matched, or null when the error is something else.
 * Call sites use this to translate raw 403 JSON into actionable copy.
 */
export function friendlyQuotaErrorMessage(respStatus: number, body: string): string | null {
  if (respStatus !== 403) return null
  let parsed: any
  try { parsed = JSON.parse(body) } catch { return null }
  const errors: any[] = parsed?.error?.errors || []
  const hit = errors.find(e => e?.reason === 'quotaExceeded' || e?.reason === 'dailyLimitExceeded')
  if (!hit) return null
  return [
    'YouTube API daily quota reached.',
    'This typically means ~6 uploads/day on the default 10K-unit quota.',
    'Retry after midnight Pacific time, or request a quota increase at',
    'console.cloud.google.com → APIs → YouTube Data API → Quotas.',
  ].join(' ')
}

// ── Test-only hooks ───────────────────────────────────────────────────────

/** Test helper: drop the in-memory snapshot cache. */
export function __resetQuotaCache(): void {
  snapshotCache.clear()
}
