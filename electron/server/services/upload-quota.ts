/**
 * YouTube Data API quota tracker.
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
 * This module:
 *   1. Tracks outbound units per-project in config.json (cheap to render
 *      in the UI; secrets.json is wrong bucket since usage isn't secret).
 *   2. Resets the counter automatically when the current Pacific day rolls.
 *   3. Offers a pre-check so callers refuse to start an upload that would
 *      go over the ceiling.
 *   4. Parses 403 bodies for `reason: 'quotaExceeded'` so error messages
 *      can be translated to actionable copy rather than raw JSON.
 *
 * The counter is best-effort and local. If the user's Google Cloud project
 * has a different quota OR they used it from another tool, our count
 * underreports. The server-side 403 is still the source of truth; we just
 * try to flag locally before we burn an upload on a doomed attempt.
 */

import * as pm from './project-manager.js'
import { logLine } from './logger.js'

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

/** 80% of ceiling → show the warning banner. */
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

export async function readQuota(slug: string): Promise<QuotaSnapshot> {
  const config = (await pm.getConfig(slug)) as any
  const stored = config?.youtube_quota
  const stale = config?.youtube_quota_ledger_stale === true
  const today = pacificDayString()
  const ceiling = Number(stored?.ceiling) || YOUTUBE_DEFAULT_QUOTA
  // Auto-reset if the tracking day has rolled. Don't persist the reset
  // here — the next increment will write.
  if (stored?.tracking_day !== today) {
    return {
      used: 0,
      ceiling,
      tracking_day: today,
      resets_at: nextMidnightPacific().toISOString(),
      warn_at: warnThreshold(ceiling),
      block_at: blockThreshold(ceiling),
      stale,
    }
  }
  return {
    used: Number(stored.used) || 0,
    ceiling,
    tracking_day: today,
    resets_at: nextMidnightPacific().toISOString(),
    warn_at: warnThreshold(ceiling),
    block_at: blockThreshold(ceiling),
    stale,
  }
}

export async function setQuotaCeiling(slug: string, ceiling: number): Promise<void> {
  const snap = await readQuota(slug)
  await pm.updateConfig(slug, {
    youtube_quota: { used: snap.used, ceiling, tracking_day: snap.tracking_day },
  } as any)
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
  const snap = await readQuota(slug)
  const nextUsed = snap.used + QUOTA_COST[key]
  try {
    // On a successful write, also clear the stale flag — the ledger is
    // back in sync with what we've actually spent.
    await pm.updateConfig(slug, {
      youtube_quota: {
        used: nextUsed,
        ceiling: snap.ceiling,
        tracking_day: snap.tracking_day,
      },
      youtube_quota_ledger_stale: false,
    } as any)
  } catch (err) {
    // Best-effort: try to mark the ledger stale so the UI can warn. If
    // this write also fails (the original cause likely persists), swallow
    // the secondary error — the primary error is what callers need to see.
    await pm.updateConfig(slug, { youtube_quota_ledger_stale: true } as any).catch((flagErr) => {
      logLine('warn', '[upload-quota] failed to set stale flag after ledger write failed', {
        slug,
        key,
        flag_error: (flagErr as any)?.message || 'unknown',
      })
    })
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
