/**
 * The Jobs list's finished history, shared by the backend that serves it and
 * the page that renders it.
 *
 * WHY THIS FILE EXISTS. The page used to hold every job of every channel in
 * memory and do its searching, sorting, paging and select-all there — 14k rows
 * and ~128 MB per read at production size, most of it `output_lines` no row
 * shows until it is expanded. The heavy half moved to the server
 * (`GET /jobs/all/history`), which means the rules that decide WHICH rows match
 * and HOW a row reads must exist once and be used by both sides, or the server
 * page and the client's own view of the same job drift apart.
 *
 * Zero-dependency: imported by the Electron server and by the frontend runtime.
 */

/** Rows per history page. The page's own "Page N of M" arithmetic reads it too. */
export const HISTORY_PAGE_SIZE = 50

export type HistoryStatusBucket =
  | 'all' | 'running' | 'queued' | 'paused' | 'error' | 'done' | 'recovered' | 'cancelled' | 'skipped'

/** The fields the history rules read. Structural so both Job shapes satisfy it. */
export interface HistoryRowJob {
  job_id: string
  status?: string
  type?: string
  project_slug?: string
  episode_id?: string | null
  title?: string | null
  created_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  resolved?: unknown
  /** Set by the backend when this step did not run because the channel's own settings switch it off. */
  skipped?: unknown
  params?: Record<string, unknown> | null
  output_lines?: readonly string[] | null
  output_dir?: string | null
  /** Server-computed row fields (see `summariseHistoryRow`). */
  summary_line?: string | null
  progress_counter?: string | null
  output_line_count?: number
}

/** Episode code or episode title contains the query, ignoring case. An empty query matches everything. */
export function matchesEpisodeSearch(job: HistoryRowJob, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || [job.episode_id, job.title].some(value => typeof value === 'string' && value.toLowerCase().includes(q))
}

/** The steps a completed episode recovery must have behind it for a failed subtitle row to read recovered. */
const AFTER_SUBTITLES = new Set<unknown>([null, 'scene_plan_run', 'contextual_cues', 'continuity_render'])

/** The old attempt stays failed; this only describes its now-verified subtitle output. */
export function isVerifiedRecoveredSubtitleJob(job: HistoryRowJob): boolean {
  if (job.type !== 'subtitles_transcribe' || job.status !== 'error' || job.params?.force === true
    || (job.params?.generation_action as { kind?: unknown } | undefined)?.kind === 'fresh') return false
  const recovery = job.params?.episode_recovery as {
    id?: unknown
    completed?: readonly unknown[]
    first_unresolved?: unknown
  } | undefined
  const recoveryId = recovery?.id
  if (typeof recoveryId !== 'string' || !recoveryId.trim()
    || typeof job.params?.episode_recovery_id !== 'string'
    || recoveryId !== job.params.episode_recovery_id) return false
  return Array.isArray(recovery?.completed)
    && recovery.completed.includes('subtitle_sections')
    && recovery.completed.includes('subtitle_stitch')
    && AFTER_SUBTITLES.has(recovery.first_unresolved)
}

/** A failed row whose work was finished later: kept as history, no longer needs attention. */
export function isRecoveredFailure(job: HistoryRowJob): boolean {
  return job.status === 'error' && (!!job.resolved || isVerifiedRecoveredSubtitleJob(job))
}

/**
 * A step that did not run because the channel's own settings switch it off
 * (AGENTS.md §8). Nothing failed and nothing is missing, so it is not a failure
 * and not a job to retry — it reads `skipped`.
 *
 * Two rows carry the marker: the job the queue settled as skipped
 * (`job.skipped`, status `done`), and an older row that already failed for a
 * step the channel has since switched off — the server classifies that one at
 * read time in `serializeJob`, so no history is rewritten.
 */
export function isSkippedJob(job: HistoryRowJob): boolean {
  return !!job.skipped
}

/** The status the page shows. A recovered failure is history that reads `recovered`, not `error`. */
export function jobDisplayStatus(job: HistoryRowJob): string {
  if (isSkippedJob(job)) return 'skipped'
  return isRecoveredFailure(job) ? 'recovered' : String(job.status || '')
}

const asTime = (value?: string | null) => Date.parse(value || '') || 0
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The finished list's one order: newest finished first, then newest created,
 * then job_id so two rows that tie never swap places between pages. Identical
 * to the finished branch of the page's `orderJobsForDisplay`, which is what
 * makes a server page and a client-held row agree.
 */
export function compareHistoryRows(a: HistoryRowJob, b: HistoryRowJob): number {
  return asTime(b.finished_at) - asTime(a.finished_at)
    || asTime(b.created_at) - asTime(a.created_at)
    || byText(a.job_id, b.job_id)
}

/**
 * True when `job` sorts strictly after the cursor row under `compareHistoryRows`.
 * `cursor` is `[finished_at, created_at, job_id]`; encoding it is the server's
 * business (`jobs-history-query.ts`), so this file stays browser-safe.
 */
export function isAfterHistoryCursor(job: HistoryRowJob, cursor: readonly [string, string, string]): boolean {
  return compareHistoryRows(job, { job_id: cursor[2], finished_at: cursor[0], created_at: cursor[1] }) > 0
}

/** How long a job ran, in ms. A still-running job is measured to `nowMs`. */
export function jobDurationMs(job: HistoryRowJob, nowMs: number): number {
  if (!job.started_at) return 0
  const start = new Date(job.started_at).getTime()
  const end = job.finished_at ? new Date(job.finished_at).getTime() : nowMs
  return end - start
}

export function formatJobDuration(job: HistoryRowJob, nowMs: number): string {
  if (!job.started_at) return job.status === 'queued' ? 'Waiting...' : '-'
  const secs = Math.floor(jobDurationMs(job, nowMs) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/** The log lines a summary is chosen from. */
function linesOf(job: HistoryRowJob): readonly string[] {
  return job.output_lines || []
}

/**
 * The most recent "N / Total" or "Chapter 3/13" marker in a running job's log,
 * e.g. "3 / 13". Last line first, so the latest step wins.
 */
export function pickProgressCounter(job: HistoryRowJob): string | null {
  const lines = linesOf(job)
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = (lines[i] || '').match(/(\d+)\s*\/\s*(\d+)/)
    if (match && parseInt(match[2]!, 10) > 1) return `${match[1]} / ${match[2]}`
  }
  return null
}

/**
 * The last log line worth showing on a collapsed card — RAW, because the page
 * redacts request identities out of it before display and the server must not
 * invent a second wording. `null` when no line reads as a summary.
 */
export function pickSummaryLine(job: HistoryRowJob): string | null {
  const lines = linesOf(job)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (line.includes('generated successfully') || line.includes('All images') ||
        line.includes('All audio') || line.includes('saved to') ||
        line.includes('Completed') || line.includes('tagged')) {
      return line
    }
  }
  return null
}

/**
 * The folder a job wrote into, for "Open in Finder".
 *
 * Reads `output_dir` (set by each generator since Apr 2026). For jobs persisted
 * before that field shipped it walks the log from newest to oldest for a
 * summary prefix followed by an absolute path, then folds a file path to its
 * parent so the user lands on a folder they can browse. The matcher is
 * deliberately permissive: any line carrying an absolute path counts.
 */
export function deriveOutputDir(job: HistoryRowJob): string | null {
  const fromField = job.output_dir
  if (typeof fromField === 'string' && fromField) return fromField

  const lines = linesOf(job)
  // Paths contain spaces (".../Story Studio/..."), so the path cannot be
  // terminated at the first space: anchor on a summary prefix or a leading "/",
  // take the rest of the line, then strip trailing sentence punctuation.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] || ''
    const colonIdx = line.lastIndexOf(': /')
    const arrowIdx = line.indexOf('→ /')
    const atIdx = line.indexOf(' at /')
    let start = -1
    if (colonIdx >= 0) start = colonIdx + 2
    else if (arrowIdx >= 0) start = arrowIdx + 2
    else if (atIdx >= 0) start = atIdx + 4
    else if (line.startsWith('/')) start = 0
    if (start < 0) continue
    let raw = line.slice(start).trim()
    const sentenceEnd = raw.search(/\.\s+\S/)
    if (sentenceEnd > 0) raw = raw.slice(0, sentenceEnd)
    raw = raw.replace(/[.,;)]+$/, '')
    if (!raw.startsWith('/')) continue
    return /\.[a-z0-9]{1,5}$/i.test(raw) ? raw.replace(/\/[^/]+$/, '') : raw
  }
  return null
}

/**
 * The three small fields a history row carries instead of its log: the page's
 * collapsed card needs a summary line, a progress counter and the output
 * folder, and none of them justifies shipping the whole `output_lines` array.
 */
export function summariseHistoryRow(job: HistoryRowJob): {
  summary_line: string | null
  progress_counter: string | null
  output_line_count: number
  output_dir: string | null
} {
  return {
    summary_line: pickSummaryLine(job),
    progress_counter: pickProgressCounter(job),
    output_line_count: linesOf(job).length,
    output_dir: deriveOutputDir(job),
  }
}

/**
 * The summary line a card shows: the server's when the row is a history row,
 * otherwise computed from the log the live stream still carries. One call site,
 * so a row read from either source reads the same.
 */
export function rowSummaryLine(job: HistoryRowJob): string | null {
  return job.summary_line === undefined ? pickSummaryLine(job) : job.summary_line
}

/** The "3 / 13" counter, from the server's field when the row is a history row. */
export function rowProgressCounter(job: HistoryRowJob): string | null {
  return job.progress_counter === undefined ? pickProgressCounter(job) : job.progress_counter
}

/** How many log steps the row had, for the "Completed in 4m 12s (37 steps)" fallback. */
export function rowOutputLineCount(job: HistoryRowJob): number {
  return job.output_line_count ?? linesOf(job).length
}
