/**
 * Publish keeps its place in the URL: search, status chip, sort and how many
 * rows are shown. Back, reload and the Overview's "Needs you" links all land on
 * the same view. `episode_id` is the older Jobs deep link and still seeds the
 * search; the page writes `q` from then on.
 */
import { readQueryState, writeQueryState, type UrlQuery } from './route-query-state'

/** Rows rendered at first and added by each "Show More". */
export const PUBLISH_PAGE = 50

export const PUBLISH_STATUSES = ['all', 'ready', 'missing', 'in_progress', 'planned', 'missed', 'uploaded', 'scheduled', 'published', 'attention'] as const
export type PublishStatus = typeof PUBLISH_STATUSES[number]
export const PUBLISH_SORTS = ['episode_newest', 'episode_oldest', 'schedule_soonest', 'status'] as const
export type PublishSort = typeof PUBLISH_SORTS[number]

export type PublishView = { q: string; status: PublishStatus; sort: PublishSort; shown: number }

const DEFAULTS = { q: '', status: 'all', sort: 'episode_newest', shown: PUBLISH_PAGE }

export function readPublishView(query: Record<string, unknown>): PublishView {
  const raw = readQueryState(query, DEFAULTS)
  return {
    q: raw.q || (typeof query.episode_id === 'string' ? query.episode_id : ''),
    status: (PUBLISH_STATUSES as readonly string[]).includes(raw.status) ? raw.status as PublishStatus : 'all',
    sort: (PUBLISH_SORTS as readonly string[]).includes(raw.sort) ? raw.sort as PublishSort : 'episode_newest',
    // Whole pages only, never fewer than one.
    shown: Math.max(PUBLISH_PAGE, Math.ceil(raw.shown / PUBLISH_PAGE) * PUBLISH_PAGE),
  }
}

export type PublishQuery = UrlQuery

export function writePublishView(query: UrlQuery, view: PublishView): PublishQuery {
  const { episode_id: _seed, ...rest } = query
  return writeQueryState<typeof DEFAULTS>(rest, view, DEFAULTS)
}

/**
 * True while a row's Final Check is still being measured.
 *
 * Measuring a finished 2–2.5 h video is one full decode and takes minutes, so the check runs in the
 * background and the POST that starts it answers straight away. The page keeps reloading the list
 * while this is true, and stops as soon as every row has its verdict.
 */
export function finalChecksRunning(episodes: Array<{ final_check?: { running?: boolean } }>): boolean {
  return episodes.some(episode => episode.final_check?.running === true)
}
