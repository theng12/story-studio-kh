/**
 * Jobs page list and bulk-action wording (owner-approved UX sweep, 2026-10-07).
 * Pure so search, paging, the Active cap and the confirmations are tested
 * without mounting the 4,000-line page.
 *
 * The rules that decide WHICH rows match a search, how a history row reads and
 * how finished rows are ordered now live in `electron/server/contracts/jobs-history.ts`,
 * because the server's paged history endpoint applies the same rules. They are
 * re-exported here so the page keeps importing one module.
 */
import { isFreeFleetWork } from '@shared/provider-task-state'

export { matchesEpisodeSearch } from '../../electron/server/contracts/jobs-history'
export {
  deriveOutputDir,
  formatJobDuration,
  rowOutputLineCount,
  rowProgressCounter,
  rowSummaryLine,
} from '../../electron/server/contracts/jobs-history'

export const HISTORY_PAGE_SIZE = 50
export const ACTIVE_LIST_CAP = 25

/** `?episode_id=` may arrive as a string or an array; anything else is no search. */
export function episodeQueryValue(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first : ''
}

export function pageCount(total: number, size = HISTORY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size))
}

export function pageSlice<T>(list: readonly T[], page: number, size = HISTORY_PAGE_SIZE): T[] {
  const start = (Math.min(Math.max(1, page), pageCount(list.length, size)) - 1) * size
  return list.slice(start, start + size)
}

/** The Active list shows the first `cap` rows until "Show All" is pressed. */
export function capList<T>(list: readonly T[], showAll: boolean, cap = ACTIVE_LIST_CAP): T[] {
  return showAll ? [...list] : list.slice(0, cap)
}

export interface JobOrderFields {
  job_id: string
  status: string
  type: string
  created_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  queue_position?: number
}

const asTime = (value?: string | null) => Date.parse(value || '') || 0
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Known kinds keep the page's tab order; unknown ones follow alphabetically. */
function byKind(a: string, b: string, kindRank: Map<string, number>): number {
  const ai = kindRank.get(a)
  const bi = kindRank.get(b)
  if (ai !== undefined && bi !== undefined) return ai - bi
  if (ai !== undefined) return -1
  if (bi !== undefined) return 1
  return byText(a, b)
}

/**
 * The one display order for the Jobs page, independent of how the live store
 * happens to have assembled its array: running first (earliest started),
 * then queued in true dispatch order (kinds in `kindOrder`, then the lane's
 * own `queue_position`), then paused, then finished newest-finished first.
 * Ties fall back to created_at then job_id, so an SSE/poll update can never
 * reshuffle rows that did not change.
 */
export function orderJobsForDisplay<T extends JobOrderFields>(
  list: readonly T[],
  kindOrder: readonly string[] = [],
): T[] {
  const kindRank = new Map(kindOrder.map((type, index) => [type, index]))
  const statusRank = (job: T) => job.status === 'running' ? 0
    : job.status === 'queued' ? 1
      : job.status === 'paused' ? 2
        : 3
  const position = (job: T) => typeof job.queue_position === 'number' && job.queue_position > 0
    ? job.queue_position
    : Number.POSITIVE_INFINITY
  return [...list].sort((a, b) => {
    const rank = statusRank(a) - statusRank(b)
    if (rank) return rank
    if (statusRank(a) === 0) {
      return asTime(a.started_at) - asTime(b.started_at)
        || asTime(a.created_at) - asTime(b.created_at)
        || byText(a.job_id, b.job_id)
    }
    if (statusRank(a) === 1) {
      return byKind(a.type, b.type, kindRank)
        || position(a) - position(b)
        || asTime(a.created_at) - asTime(b.created_at)
        || byText(a.job_id, b.job_id)
    }
    if (statusRank(a) === 2) {
      return asTime(a.created_at) - asTime(b.created_at) || byText(a.job_id, b.job_id)
    }
    return asTime(b.finished_at) - asTime(a.finished_at)
      || asTime(b.created_at) - asTime(a.created_at)
      || byText(a.job_id, b.job_id)
  })
}

/**
 * The page's own paid/free rule, shared with its "Credits:" line: a job spent
 * credits when it sent Gateway requests that were not all free Studio Hub work.
 */
export function isPaidWork(job: { genstudio_jobs?: ReadonlyArray<{ model_id?: unknown }> | null }): boolean {
  return !!job.genstudio_jobs?.length && !isFreeFleetWork(job.genstudio_jobs)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "Retry 12 failed jobs?" — with a credits note only when paid work is included. Repair never charges. */
export function bulkConfirmOptions(kind: 'retry' | 'repair', count: number, paid = 0) {
  if (kind === 'repair') {
    return {
      title: `Repair ${plural(count, 'failed job')}?`,
      message: 'Downloads anything the Gateway already finished for these jobs. Never generates anything new or charges.',
      confirmLabel: 'Repair',
    }
  }
  return {
    title: `Retry ${plural(count, 'failed job')}?`,
    message: [
      'Each one starts again with a fresh request. Work a provider may still be finishing is never sent twice.',
      paid ? `${paid === count ? 'These include' : `${paid} of them include`} paid work, so this may use credits.` : '',
    ].filter(Boolean).join(' '),
    confirmLabel: 'Retry',
  }
}

/**
 * One vocabulary for row buttons.
 *
 * "Hide from list" is the frontend's own button (the restorable replacement for
 * "Remove From List", owner 2026-11-02) and stays as it is. Every
 * other label is the BACKEND's wording, and it is used as the backend wrote
 * it: the controls are written in sentence case ("Return later", "Checking
 * provider status", "Pause new work"), and title-casing them here changed the
 * words the server chose. The server owns the vocabulary of a control; the
 * client only renders it.
 */
export function controlLabel(control: { action: string; label?: string }): string {
  if (control.action === 'clear-history') return 'Hide from list'
  return control.label || ''
}

/**
 * Did the backend answer that this job no longer exists?
 *
 * A row can outlive the job it names. The removal then answers "Job not
 * found", which is not a refusal to remove it: the goal of the removal — that
 * job is not on the list — already holds. The row goes either way.
 */
export function isMissingJobError(error: unknown): boolean {
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; data?: { detail?: unknown } } | null
  const status = candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status
  if (status === 404) return true
  const detail = candidate?.data?.detail
  return typeof detail === 'string' && detail.trim().toLowerCase() === 'job not found'
}
