/**
 * Fetch analytics for a project's videos and shape them as four-state metrics.
 *
 * What this adds over `lib/youtube-analytics.ts`, which it deliberately reuses
 * for the QUERY and nothing else (see the Phase 8 sibling-guard table): the
 * channel the numbers were fetched under, an honest partial report, quota
 * charged to the one Cloud-project ledger, and metrics that can say "no data"
 * and "not available" instead of collapsing both to zero.
 */

import { asKeyed, runReport } from '../lib/youtube-analytics.js'
import { tokenHasAnalyticsScope } from '../lib/youtube-oauth.js'
import { readYouTubeChannelTokensForServer } from './youtube-connection-store.js'
import { registryCredentialFor } from '../lib/youtube-client.js'
import {
  metricNoData,
  metricNotAvailable,
  metricValue,
  type MetricValue,
} from './youtube-analytics-value.js'

/** The metrics this product shows. No monetary figure appears here, ever. */
export const ANALYTICS_METRICS = [
  'views', 'watch_minutes', 'avg_view_seconds', 'avg_view_percentage',
  'likes', 'comments', 'shares',
] as const
export type AnalyticsMetric = typeof ANALYTICS_METRICS[number]

export interface EpisodeMetrics {
  video_id: string
  metrics: Record<AnalyticsMetric, MetricValue>
  // No `title`. Rows are labelled from the LIVE episode link at read time, so a
  // title stored here would be the code as it was at FETCH time - which is the
  // stale-label defect the fourth review found. Written and never read is tell
  // 4; written, never read, and wrong is worse.
}

export interface ProjectAnalytics {
  fetched_at: string
  /**
   * The window these numbers describe, inclusive. Without it a figure is
   * unreadable: a two-year-old video with 500k lifetime views and a quiet
   * quarter is `no_data` here, and a row's "1,204 views" means 1,204 IN THIS
   * WINDOW, not ever. Both are honest only while the window is on screen.
   */
  start_date: string
  end_date: string
  /**
   * The channel these numbers describe. Stored so a read for a DIFFERENT
   * channel is a miss rather than a hit: the same project reassigned would
   * otherwise show the previous channel's performance as its own.
   */
  channel_id: string
  partial: boolean
  partial_reason?:
    | 'quota_exhausted' | 'provider_error' | 'scope_missing' | 'not_connected' | 'report_truncated'
  // No `unreached_video_ids`. The refresh route was its only production reader
  // and the store dropped the field for the same reason: the page derives "not
  // covered" from the live roster at read time, so a list recorded at fetch
  // time has no consumer. `partial_reason` still says WHY a fetch fell short.
  episodes: EpisodeMetrics[]
}

/**
 * The report seam, injected in tests.
 *
 * This is `runReport`, NOT `getEpisodeAnalytics`. The higher-level function
 * coerces every metric with `Number(x || 0)`, so a metric YouTube omitted is
 * already a real 0 by the time it returns - `not_available` was unreachable on
 * real data, and only a hand-built double could produce it. Reusing a function
 * that destroys the distinction this service exists to preserve is not
 * defensible, so the raw report is what we consume.
 *
 * `getEpisodeAnalytics` is left exactly as it is: the legacy `/upload` page
 * renders `row.avg_view_percentage.toFixed(1)`, which an optional number would
 * throw on, and that page is deleted in Phase 9 rather than edited now.
 */
export type FetchReport = typeof runReport

/**
 * The most rows one report returns. The API's own ceiling, and the reason a
 * project with more videos than this needs a partial report rather than a
 * confident set of blanks.
 */
const REPORT_ROW_CAP = 200

/** How far back a report looks when the caller does not say. */
const DEFAULT_WINDOW_DAYS = 90

/** Our metric name → the column YouTube returns it in. */
const METRIC_COLUMNS: Record<AnalyticsMetric, string> = {
  views: 'views',
  watch_minutes: 'estimatedMinutesWatched',
  avg_view_seconds: 'averageViewDuration',
  avg_view_percentage: 'averageViewPercentage',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
}

const apiDate = (date: Date): string => date.toISOString().slice(0, 10)

function isQuotaError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  if (code === 'YOUTUBE_QUOTA_EXHAUSTED') return true
  const status = (error as { statusCode?: number } | null)?.statusCode
  if (status === 429) return true
  // A bare 403 is NOT a quota answer. YouTube returns 403 for
  // `insufficientPermissions` as readily as for `quotaExceeded`, and calling
  // the first one "today's allowance ran out" tells the owner to wait for a
  // reset that will never fix it. Only a 403 that SAYS it is about quota is
  // one.
  if (status !== 403) return false
  // `raw` is the untruncated body; `message` clips it at 400 characters, so a
  // marker further in would be invisible and a real quota refusal would read as
  // a provider error.
  const body = (error as { raw?: string, message?: string } | null)
  const raw = String(body?.raw ?? body?.message ?? '')
  return /quotaExceeded|rateLimitExceeded|dailyLimitExceeded/i.test(raw)
}

/**
 * A row YouTube returned, turned into metrics.
 *
 * A metric the row omits is `not_available` WITH the reason, never 0 and never
 * a ratio derived from its neighbours. `avg_view_percentage` divided out of
 * watch time would be exactly the estimate this phase forbids.
 */
function metricsFromRow(
  row: Record<string, unknown>,
  columns: Set<string>,
  fetchedAt: string,
): Record<AnalyticsMetric, MetricValue> {
  const out = {} as Record<AnalyticsMetric, MetricValue>
  for (const metric of ANALYTICS_METRICS) {
    const column = METRIC_COLUMNS[metric]
    // Two different absences. YouTube not returning the COLUMN at all means it
    // does not offer this metric for this report; the column present with a
    // value we cannot read means the same thing for this row. Neither is a
    // number, and neither may be inferred from its neighbours - a percentage
    // divided out of watch time and views is the estimate this phase forbids.
    if (!columns.has(column)) {
      out[metric] = metricNotAvailable('YouTube did not return this metric for this report.', fetchedAt)
      continue
    }
    const raw = row[column]
    out[metric] = typeof raw === 'number' && Number.isFinite(raw)
      ? metricValue(raw, fetchedAt)
      : metricNotAvailable('YouTube did not report this metric for this video.', fetchedAt)
  }
  return out
}

/** Every metric unknown because YouTube had nothing to say about this video. */
function noDataFor(fetchedAt: string): Record<AnalyticsMetric, MetricValue> {
  const out = {} as Record<AnalyticsMetric, MetricValue>
  for (const metric of ANALYTICS_METRICS) out[metric] = metricNoData(fetchedAt)
  return out
}

/** Every video unreached, for a read that could not be attempted at all. */
function nothingRead(
  input: { channel_id: string },
  videoIds: string[],
  window: { start_date: string, end_date: string },
  reason: NonNullable<ProjectAnalytics['partial_reason']>,
): ProjectAnalytics {
  return {
    fetched_at: new Date().toISOString(),
    channel_id: input.channel_id,
    ...window,
    partial: true,
    partial_reason: reason,
    episodes: [],
  }
}

export async function fetchProjectAnalytics(input: {
  project_slug: string
  account_id: string
  application_id: string
  /** Required, like the comment inbox's: without it the numbers have no owner. */
  channel_id: string
  video_ids: string[]
  /** Inclusive YYYY-MM-DD bounds. Defaults to the last 90 days. */
  start_date?: string
  end_date?: string
  fetchReport?: FetchReport
}): Promise<ProjectAnalytics> {
  const fetchReport = input.fetchReport ?? runReport
  const videoIds = [...new Set(input.video_ids)]
  const endDate = input.end_date ?? apiDate(new Date())
  const startDate = input.start_date
    ?? apiDate(new Date(Date.now() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000))
  const fetchedAt = new Date().toISOString()

  // A grant without the analytics scope is its OWN state, not an allowance
  // problem and not an empty channel. The legacy `/upload` route has checked
  // this since before the redesign (`reauth_required`); the new service
  // declared `scope_missing` in its type and never produced it — a state that
  // reads as available and never fires.
  // Nothing published to this channel means nothing to ask about. Running the
  // report anyway would spend an allowance to be told what we already know.
  if (!videoIds.length) {
    return {
      fetched_at: new Date().toISOString(),
      channel_id: input.channel_id,
      start_date: startDate,
      end_date: endDate,
      partial: false,
      episodes: [],
    }
  }

  const tokens = input.account_id === registryCredentialFor(input.channel_id)
    ? await readYouTubeChannelTokensForServer(input.channel_id)
    : null
  // No credentials at all is a DISCONNECTION, not a missing permission —
  // telling the owner to "grant analytics access" for an account that is not
  // signed in sends them to the wrong screen.
  if (!tokens) {
    return nothingRead(input, videoIds, { start_date: startDate, end_date: endDate }, 'not_connected')
  }
  if (!tokenHasAnalyticsScope(tokens.scope)) {
    return nothingRead(input, videoIds, { start_date: startDate, end_date: endDate }, 'scope_missing')
  }

  let report: Awaited<ReturnType<FetchReport>>
  try {
    report = await fetchReport(input.project_slug, input.account_id, {
      ids: 'channel==MINE',
      startDate,
      endDate,
      dimensions: 'video',
      metrics: Object.values(METRIC_COLUMNS).join(','),
      sort: '-views',
      maxResults: String(REPORT_ROW_CAP),
    })
  } catch (error) {
    // Nothing was read, so nothing is claimed. Naming every video as unreached
    // is what stops an empty screen reading as "this channel has no views".
    // A revoked or unrefreshable grant is a RECONNECT, not a transient fault.
    // "Fetching again may reach the rest" is advice that cannot work.
    const revoked = (error as { code?: string } | null)?.code === 'YOUTUBE_RECONNECT_REQUIRED'
    return nothingRead(
      input, videoIds, { start_date: startDate, end_date: endDate },
      revoked ? 'not_connected' : (isQuotaError(error) ? 'quota_exhausted' : 'provider_error'),
    )
  }

  const columns = new Set(report.columnHeaders.map(header => header.name))
  const rows = new Map<string, Record<string, unknown>>()
  for (const raw of report.rows) {
    const keyed = asKeyed(report.columnHeaders, raw)
    const videoId = String(keyed.video ?? '')
    if (videoId) rows.set(videoId, keyed)
  }

  // The report is capped at REPORT_ROW_CAP rows. When it comes back full there
  // may be videos it simply did not reach, and calling those `no_data` would
  // state that YouTube had nothing to say about them - a claim we cannot make.
  // "The report ran out of room" is a PARTIAL read, not a finding.
  const capped = report.rows.length >= REPORT_ROW_CAP
  const unreached = capped ? videoIds.filter(id => !rows.has(id)) : []

  const episodes: EpisodeMetrics[] = videoIds
    .filter(videoId => !unreached.includes(videoId))
    .map(videoId => {
      const row = rows.get(videoId)
      return {
        video_id: videoId,
        // "YouTube has no row for this video" and "YouTube reported 0 views"
        // are different answers. The first is `no_data`; only the second is a
        // number. Both are read against the WINDOW, which is why the window
        // travels with the result.
        metrics: row ? metricsFromRow(row, columns, fetchedAt) : noDataFor(fetchedAt),
      }
    })

  return {
    fetched_at: fetchedAt,
    channel_id: input.channel_id,
    start_date: startDate,
    end_date: endDate,
    partial: unreached.length > 0,
    ...(unreached.length > 0 ? { partial_reason: 'report_truncated' as const } : {}),
    episodes,
  }
}
