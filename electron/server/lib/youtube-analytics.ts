/**
 * YouTube Analytics API v2 client.
 *
 * Pulls per-video performance rows for an authenticated channel:
 *   - views, watch time, avg view duration / percentage (retention)
 *   - click-through rate (CTR) and impressions
 *   - likes, comments, shares
 *
 * Auth: same OAuth tokens minted by `youtube-oauth.ts`, but the channel
 *   must have granted the `yt-analytics.readonly` scope. Routes that
 *   call into here should first verify the scope is present (see
 *   `tokenHasAnalyticsScope` in youtube-oauth.ts) and surface a
 *   re-auth CTA when missing.
 *
 * Caching is in-memory only (per-process) for v1. Refresh pulls a new
 * snapshot from YouTube. If the user wants persistent cache, we add a
 * disk-backed layer behind `getEpisodeAnalytics` later.
 *
 * Scope of v1: pull all videos owned by the connected channel within
 * the requested date range, sorted by views desc, capped at 200 (the
 * API page limit for one call). Pagination not yet implemented —
 * channels with >200 videos in the date range get the top 200 by views.
 */

import { fetchWithAuthRetry, youtubeTransport } from './youtube-client.js'
import type { AnalyticsResult, EpisodeAnalytics } from '../models/types.js'
import { logLine } from '../services/logger.js'
import { recordYouTubeQuotaAttempt } from '../services/youtube-quota-ledger.js'

const ANALYTICS_ENDPOINT = 'https://youtubeanalytics.googleapis.com/v2/reports'

export interface FetchAnalyticsOptions {
  /** Inclusive YYYY-MM-DD start date. Defaults to 90 days ago. */
  startDate?: string
  /** Inclusive YYYY-MM-DD end date. Defaults to today. */
  endDate?: string
  /** Cap on rows returned. Defaults to 50; max 200 per the API. */
  maxResults?: number
}

/** Format a Date as YYYY-MM-DD in UTC. Stable across timezones. */
function toApiDate(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function defaultStart(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 90)
  return toApiDate(d)
}

function defaultEnd(): string {
  return toApiDate(new Date())
}

/** Surface the YouTube Analytics API error in a way humanize-error can
 *  forward as-is. We attach `statusCode` so respondWithError honours it. */
class AnalyticsApiError extends Error {
  readonly statusCode: number
  readonly raw: string
  constructor(status: number, raw: string) {
    const trimmed = raw.length > 400 ? raw.slice(0, 400) + '…' : raw
    super(`YouTube Analytics API error (${status}): ${trimmed}`)
    this.name = 'AnalyticsApiError'
    this.statusCode = status >= 400 && status < 600 ? status : 502
    this.raw = raw
  }
}

/**
 * Run a single Analytics API report. Caller specifies dimensions /
 * metrics / filters; this just handles auth, the URL build, and the
 * response shape. Returns the raw `{ columnHeaders, rows }` from the
 * API so per-call parsing stays in the caller.
 */
export async function runReport(
  slug: string,
  accountId: string,
  params: Record<string, string>,
): Promise<{ columnHeaders: Array<{ name: string }>; rows: any[][] }> {
  const url = new URL(ANALYTICS_ENDPOINT)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  // Through the shared transport seam, as every other YouTube caller does.
  // Behaviour is identical (it defaults to global fetch); what it adds is that
  // a provider-free test can intercept this call, which is why the comments
  // library was moved onto it in Phase 7. This one was missed.
  const resp = await fetchWithAuthRetry(slug, accountId, async (accessToken, identity) => {
    try {
      return await youtubeTransport(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    } finally {
      // Analytics has a separate provider-owned allowance with no guessed
      // local ceiling. Record each real reports.query attempt, including the
      // first 401 when auth retry makes a second request.
      await recordYouTubeQuotaAttempt({
        ...identity,
        bucket: 'analytics',
        operation: 'reports.query',
        amount: 1,
      }).catch((error: unknown) => {
        logLine('warn', `[youtube-analytics] quota ledger write failed: ${(error as Error)?.message || 'unknown'}`, {
          slug,
          bucket: 'analytics',
        })
      })
    }
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new AnalyticsApiError(resp.status, text)
  }
  const data = await resp.json() as any
  return {
    columnHeaders: Array.isArray(data.columnHeaders) ? data.columnHeaders : [],
    rows: Array.isArray(data.rows) ? data.rows : [],
  }
}

/** Map a row array → an object keyed by column name. */
export function asKeyed(headers: Array<{ name: string }>, row: any[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (let i = 0; i < headers.length; i++) {
    out[headers[i]!.name] = row[i]
  }
  return out
}

/**
 * Fetch per-episode analytics rows for a channel, plus the channel-level
 * totals for the same date range. Returns an `AnalyticsResult` ready to
 * cache + serve to the frontend.
 *
 * The function makes two API calls:
 *   1. Per-video report (dimensions=video) — one row per video.
 *   2. Channel totals (no dimensions) — single-row summary for the header.
 *
 * Failures on the totals call are non-fatal — we return `rows` without
 * `totals` rather than failing the whole request.
 */
export async function getEpisodeAnalytics(
  slug: string,
  accountId: string,
  options: FetchAnalyticsOptions = {},
): Promise<AnalyticsResult> {
  const startDate = options.startDate || defaultStart()
  const endDate = options.endDate || defaultEnd()
  const maxResults = Math.min(Math.max(options.maxResults || 50, 1), 200)

  // Per-video report. CTR + impressions are advertised metrics and may
  // be omitted by YouTube for very new videos or restricted accounts;
  // we treat them as optional in the typed shape.
  const videoReport = await runReport(slug, accountId, {
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics: [
      'views',
      'estimatedMinutesWatched',
      'averageViewDuration',
      'averageViewPercentage',
      'likes',
      'comments',
      'shares',
      'cardImpressions',
      'cardClickRate',
    ].join(','),
    dimensions: 'video',
    sort: '-views',
    maxResults: String(maxResults),
  })

  // Map column-name → index once, lookups inside the row loop are O(1).
  const rows: EpisodeAnalytics[] = []
  for (const raw of videoReport.rows) {
    const r = asKeyed(videoReport.columnHeaders, raw)
    const videoId = String(r.video || '')
    if (!videoId) continue
    rows.push({
      video_id: videoId,
      title: '',          // filled in by enrichWithVideoTitles below
      published_at: '',   // filled in by enrichWithVideoTitles below
      views: Number(r.views || 0),
      watch_minutes: Number(r.estimatedMinutesWatched || 0),
      avg_view_seconds: Number(r.averageViewDuration || 0),
      avg_view_percentage: Number(r.averageViewPercentage || 0),
      ctr_percentage: typeof r.cardClickRate === 'number' ? r.cardClickRate : undefined,
      impressions: typeof r.cardImpressions === 'number' ? r.cardImpressions : undefined,
      likes: Number(r.likes || 0),
      comments: Number(r.comments || 0),
      shares: Number(r.shares || 0),
    })
  }

  // Enrich with title + publishedAt via the Data API. Skip silently if
  // the lookup fails — analytics rows are still useful with empty titles.
  if (rows.length) {
    try {
      const enriched = await fetchVideoMetadata(slug, accountId, rows.map(r => r.video_id))
      for (const r of rows) {
        const meta = enriched[r.video_id]
        if (meta) {
          r.title = meta.title
          r.published_at = meta.published_at
        }
      }
    } catch { /* leave titles blank — rows are still useful */ }
  }

  // Channel-level totals — one row, no dimensions. Optional; if it
  // fails, return the per-video data without totals.
  let totals: AnalyticsResult['totals']
  try {
    const totalsReport = await runReport(slug, accountId, {
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views,estimatedMinutesWatched,averageViewPercentage',
    })
    if (totalsReport.rows.length) {
      const r = asKeyed(totalsReport.columnHeaders, totalsReport.rows[0]!)
      totals = {
        views: Number(r.views || 0),
        watch_minutes: Number(r.estimatedMinutesWatched || 0),
        avg_view_percentage: Number(r.averageViewPercentage || 0),
      }
    }
  } catch { /* non-fatal */ }

  return {
    fetched_at: new Date().toISOString(),
    start_date: startDate,
    end_date: endDate,
    rows,
    totals,
  }
}

/**
 * Pull `snippet.title` + `snippet.publishedAt` for the given video ids
 * via the Data API (`videos.list`). Batches in groups of 50 (the API
 * limit per request). Returns a map keyed by video id.
 */
export async function fetchVideoMetadata(
  slug: string,
  accountId: string,
  videoIds: string[],
): Promise<Record<string, { title: string; published_at: string }>> {
  const out: Record<string, { title: string; published_at: string }> = {}
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50)
    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('id', batch.join(','))
    // Through the shared seam, like every other YouTube call in this file.
    // The last bare `fetch` here: identical behaviour, but a provider-free test
    // can intercept it instead of reaching the ambient network.
    const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
      youtubeTransport(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      'videos_list',
    )
    if (!resp.ok) continue
    const data = await resp.json() as any
    for (const item of (data.items || [])) {
      out[item.id] = {
        title: String(item.snippet?.title || ''),
        published_at: String(item.snippet?.publishedAt || ''),
      }
    }
  }
  return out
}

/** ISO-8601 duration ("PT1H2M3S") in seconds; null for anything else or zero. */
export function isoDurationSeconds(text: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text)
  if (!match) return null
  const [, d, h, m, sec] = match.map(part => Number(part ?? 0))
  const total = d! * 86400 + h! * 3600 + m! * 60 + sec!
  // "P0D" is what YouTube sends for a live or upcoming stream: no length yet,
  // which is an absence, not a zero-second video.
  return total > 0 ? total : null
}

/**
 * Published date and length per video, for the Analytics table.
 *
 * `videos.list part=snippet,contentDetails` in batches of 50 through the same
 * transport seam. A batch that fails leaves its ids ABSENT, and so does a video
 * YouTube did not return; the caller turns absence into `not_available`, never
 * into a blank or a zero. A field YouTube sent but we cannot read is `null`.
 */
export async function fetchVideoFacts(
  slug: string,
  accountId: string,
  videoIds: string[],
): Promise<Record<string, { published_ms: number | null; duration_seconds: number | null }>> {
  const out: Record<string, { published_ms: number | null; duration_seconds: number | null }> = {}
  const unique = [...new Set(videoIds.filter(Boolean))]
  for (let i = 0; i < unique.length; i += 50) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('part', 'snippet,contentDetails')
    url.searchParams.set('fields', 'items(id,snippet/publishedAt,contentDetails/duration)')
    url.searchParams.set('id', unique.slice(i, i + 50).join(','))
    try {
      const resp = await fetchWithAuthRetry(slug, accountId, (accessToken) =>
        youtubeTransport(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } }),
        'videos_list',
      )
      if (!resp.ok) continue
      const data = await resp.json() as any
      for (const item of (data.items || [])) {
        if (!item?.id) continue
        const published = Date.parse(String(item.snippet?.publishedAt ?? ''))
        out[item.id] = {
          published_ms: Number.isFinite(published) ? published : null,
          duration_seconds: isoDurationSeconds(String(item.contentDetails?.duration ?? '')),
        }
      }
    } catch { /* this batch's ids stay absent: "not available", with the reason */ }
  }
  return out
}

// ── Two-tier cache (memory + disk) ─────────────────────────────────────────
//
// Keyed by `${slug}::${accountId}::${start}::${end}::${maxResults}`. TTL
// is 6 hours — analytics data updates ~daily on YouTube's side, so 6h
// cuts API calls without showing stale numbers on a working session.
// The Refresh button bypasses both layers.
//
//   L1 (memory): zero-latency hits within a session
//   L2 (disk):   ${userData}/analytics-cache/{slug}_{accountId}.json
//                survives Electron restart so the next launch doesn't
//                burn fresh quota for the same window
//
// Disk writes are best-effort — IO failures are logged and ignored.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
interface CacheEntry { fetchedAt: number; result: AnalyticsResult }
const cache = new Map<string, CacheEntry>()

function cacheKey(slug: string, accountId: string, opts: FetchAnalyticsOptions): string {
  return `${slug}::${accountId}::${opts.startDate || ''}::${opts.endDate || ''}::${opts.maxResults || ''}`
}

/** Sanitize an account id (or slug) for use as a path segment. */
function safePathSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

async function diskCachePath(slug: string, accountId: string): Promise<string> {
  const fs = await import('fs/promises')
  const path = await import('path')
  const pm = await import('../services/project-manager.js')
  const dir = path.join(pm.getUserDataDir(), 'analytics-cache')
  await fs.mkdir(dir, { recursive: true }).catch(() => {})
  return path.join(dir, `${safePathSegment(slug)}_${safePathSegment(accountId)}.json`)
}

interface DiskCacheFile {
  /** Schema version — bump if entry shape changes. */
  schemaVersion: 1
  /** Map of cacheKey → cache entry. */
  entries: Record<string, CacheEntry>
}

async function readDiskCache(slug: string, accountId: string): Promise<DiskCacheFile | null> {
  try {
    const fs = await import('fs/promises')
    const filePath = await diskCachePath(slug, accountId)
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed?.schemaVersion !== 1 || !parsed?.entries) return null
    return parsed as DiskCacheFile
  } catch {
    return null
  }
}

async function writeDiskCache(slug: string, accountId: string, file: DiskCacheFile): Promise<void> {
  try {
    const fs = await import('fs/promises')
    const filePath = await diskCachePath(slug, accountId)
    await fs.writeFile(filePath, JSON.stringify(file), 'utf-8')
  } catch {
    // Best-effort — disk failures should never break a render.
  }
}

/** Cached wrapper. Returns the cached snapshot when fresh (memory > disk),
 *  otherwise fetches from YouTube and writes both tiers. `force: true`
 *  skips both layers. */
export async function getEpisodeAnalyticsCached(
  slug: string,
  accountId: string,
  opts: FetchAnalyticsOptions & { force?: boolean } = {},
): Promise<AnalyticsResult> {
  const key = cacheKey(slug, accountId, opts)
  if (!opts.force) {
    const memHit = cache.get(key)
    if (memHit && Date.now() - memHit.fetchedAt < CACHE_TTL_MS) {
      return memHit.result
    }
    const diskFile = await readDiskCache(slug, accountId)
    const diskHit = diskFile?.entries?.[key]
    if (diskHit && Date.now() - diskHit.fetchedAt < CACHE_TTL_MS) {
      // Promote to memory so subsequent reads in this session are L1 hits.
      cache.set(key, diskHit)
      return diskHit.result
    }
  }
  const result = await getEpisodeAnalytics(slug, accountId, opts)
  const entry: CacheEntry = { fetchedAt: Date.now(), result }
  cache.set(key, entry)

  // Read-modify-write the disk file so we don't stomp other date-range
  // entries cached for the same (slug, accountId).
  const existing = await readDiskCache(slug, accountId)
  const merged: DiskCacheFile = existing ?? { schemaVersion: 1, entries: {} }
  merged.entries[key] = entry
  // Drop expired entries while we're here so the file doesn't grow forever.
  const now = Date.now()
  for (const k of Object.keys(merged.entries)) {
    if (now - merged.entries[k]!.fetchedAt > CACHE_TTL_MS * 4) delete merged.entries[k]
  }
  await writeDiskCache(slug, accountId, merged)

  return result
}

/** Test-only — wipe the L1 (memory) cache between cases. */
export function _clearAnalyticsCache(): void {
  cache.clear()
}

/** Test-only — wipe the L2 (disk) cache directory entirely. Tests that
 *  rely on `useTempDataDir` get isolated paths but the directory itself
 *  persists across cases inside a single suite, so we need this to keep
 *  cases independent. */
export async function _clearDiskAnalyticsCache(): Promise<void> {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    const pm = await import('../services/project-manager.js')
    const dir = path.join(pm.getUserDataDir(), 'analytics-cache')
    await fs.rm(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

// ── Top-performer feedback ─────────────────────────────────────────────────
//
// The Ideas + Metadata generators consume this to inject "channel-vibe"
// inspiration into LLM prompts. Best-effort — if the project has no
// connected account, no analytics scope, or the API is down, we return
// an empty array so generation proceeds without the bonus context.

export interface TopPerformer {
  title: string
  views: number
  ctr_percentage?: number
}

type TopPerformerUnavailableReason = 'not_connected' | 'scope_missing' | 'analytics_unavailable'

function noteTopPerformerUnavailable(slug: string, reason: TopPerformerUnavailableReason): void {
  logLine('info', '[youtube-analytics] top-performer enrichment unavailable; generation will continue without it', {
    slug,
    reason,
  })
}

/**
 * Pull the top N video titles by views for the project's default
 * YouTube account, using the analytics cache when available. Failures
 * (no account, no scope, transient API error) collapse to an empty
 * array — the caller skips the inspiration block silently.
 *
 * The cache TTL is 6 hours, so generators called repeatedly within a
 * session reuse the same fixture without burning Analytics quota.
 */
export async function getTopPerformersForSlug(
  slug: string,
  limit: number = 5,
): Promise<TopPerformer[]> {
  try {
    const { resolveYouTubeCredential } = await import('../services/youtube-credential.js')
    const { readYouTubeChannelTokensForServer } = await import('../services/youtube-connection-store.js')
    const { tokenHasAnalyticsScope } = await import('./youtube-oauth.js')
    const credential = await resolveYouTubeCredential(slug)
    if (!credential) {
      noteTopPerformerUnavailable(slug, 'not_connected')
      return []
    }
    const accountId = credential.accountId
    const tokens = await readYouTubeChannelTokensForServer(credential.channelId)
    if (!tokens) {
      noteTopPerformerUnavailable(slug, 'not_connected')
      return []
    }
    if (!tokenHasAnalyticsScope(tokens.scope)) {
      noteTopPerformerUnavailable(slug, 'scope_missing')
      return []
    }
    const result = await getEpisodeAnalyticsCached(slug, accountId, {
      maxResults: Math.max(limit * 2, 20),
    })
    return result.rows
      .filter(r => r.title && r.title.length > 0)
      .slice(0, limit)
      .map(r => ({
        title: r.title,
        views: r.views,
        ctr_percentage: r.ctr_percentage,
      }))
  } catch {
    // Generators must never break because analytics is unavailable.
    noteTopPerformerUnavailable(slug, 'analytics_unavailable')
    return []
  }
}
