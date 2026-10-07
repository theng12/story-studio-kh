/**
 * Jobs page list and bulk-action wording (owner-approved UX sweep, 2026-10-07).
 * Pure so search, paging, the Active cap and the confirmations are tested
 * without mounting the 4,000-line page.
 */
import { isFreeFleetWork } from '@shared/provider-task-state'

export const HISTORY_PAGE_SIZE = 50
export const ACTIVE_LIST_CAP = 25

/** Episode code or episode title contains the query, ignoring case. An empty query matches everything. */
export function matchesEpisodeSearch(job: { episode_id?: string | null; title?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || [job.episode_id, job.title].some(value => typeof value === 'string' && value.toLowerCase().includes(q))
}

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

/** One vocabulary for row buttons: "Remove From List", everything else in Title Case. */
export function controlLabel(control: { action: string; label?: string }): string {
  if (control.action === 'clear-history') return 'Remove From List'
  return (control.label || '').replace(/\b[a-z]/g, letter => letter.toUpperCase())
}
