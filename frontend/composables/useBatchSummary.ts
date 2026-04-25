/**
 * Batch-level post-mortem for bulk pipeline runs.
 *
 * The /pipeline route stamps `params.pipeline_batch_id` on every job it
 * enqueues (see `electron/server/routes/pipeline.ts`). Once the whole batch
 * has settled into terminal states, the Jobs page renders a summary banner
 * that answers the "what happened while I was away" question:
 *   - how many episodes succeeded / failed / were cancelled
 *   - wall-clock elapsed (earliest started_at → latest finished_at)
 *   - the top failure reasons grouped by normalized prefix
 *   - which episodes need repair (so the user can jump to Assets)
 *
 * Exported as a pure function so the aggregation can be unit-tested in
 * isolation from Vue reactivity.
 */
import type { Job } from './useJobs.js'

export interface FailedEpisode {
  episode_id: string
  /** Normalized short reason used as the group key. */
  reason: string
  /** Full untruncated `job.error` for the failing job — shown in the
   *  expand-for-details section so the operator can make retry decisions. */
  full_error: string
  /** Which step in the chain failed (e.g. "images", "audio_merge"). */
  job_type: string
}

export interface BatchSummary {
  batch_id: string
  /** Distinct episodes submitted in this batch. */
  total: number
  success: number
  failed: number
  cancelled: number
  /** Wall-clock ms from earliest started_at to latest finished_at across
   *  all jobs in the batch. 0 if nothing ever started. */
  elapsed_ms: number
  /** Grouped failure reasons, sorted by count desc, top 3. */
  failure_reasons: Array<{ reason: string; count: number }>
  /** Distinct episode_ids that had at least one failed step. */
  episodes_needing_repair: string[]
  /** Per-episode first-failure details for the expand section. */
  failed_episodes: FailedEpisode[]
}

/**
 * Strip the provider-response noise off a raw job error so similar failures
 * collapse into one group. The grouping key needs to be stable across:
 *   - different HTTP response bodies for the same status code ("429 Too Many
 *     Requests {... body ...}" across 4 episodes should become one row)
 *   - task IDs / UUIDs embedded in messages (kie.ai, fal.ai, Veo)
 *   - multi-line stacks (keep the first line only — it's the message)
 *
 * Intentionally conservative: we prefer over-grouping (fewer, broader rows)
 * to under-grouping (one row per episode rendering the banner useless).
 */
export function normalizeErrorReason(raw: string): string {
  const firstLine = (raw || '').split('\n')[0] || ''
  let s = firstLine.trim()
  if (!s) return '(no error message)'

  // Cut at the first body/tail separator. Providers reliably append the
  // upstream body after one of these, and the body is the noisy part.
  const separators = [' — ', ' – ', ' -- ', ': {', ': [', ' (body:', ' body:']
  for (const sep of separators) {
    const i = s.indexOf(sep)
    if (i > 0) { s = s.slice(0, i); break }
  }

  // Scrub UUIDs and long task-id tokens so "Task <id> did not complete"
  // groups across episodes.
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
  s = s.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '<id>')

  // Defensive: drop any bearer tokens that slipped through server-side
  // redaction. Matches the format in electron/server/lib/redact-secrets.ts.
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
  s = s.replace(/\bsk-[A-Za-z0-9._-]{8,}/g, '[REDACTED]')

  // Collapse whitespace and trim sentence-terminal punctuation that clings
  // to the end of a truncated prefix (e.g. "failed:" → "failed").
  s = s.replace(/\s+/g, ' ').replace(/[:;,.\s]+$/, '').trim()

  return s.length > 140 ? s.slice(0, 137) + '…' : s
}

/**
 * Format elapsed milliseconds as "52 min" / "2h 14m" / "45s". Matches the
 * unit grammar the Jobs page uses elsewhere (see formatJobDuration).
 */
export function formatElapsed(ms: number): string {
  if (!ms || ms < 0) return '—'
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hours}h ${remMins}m`
}

function summarize(batch_id: string, jobs: Job[]): BatchSummary {
  // Episode-level rollup: a batch run is a per-episode chain, so status
  // rolls up at episode granularity. An episode is "failed" if any step
  // errored, "cancelled" if any step was cancelled (without errors), and
  // "success" only when every step is done.
  const byEpisode = new Map<string, Job[]>()
  for (const j of jobs) {
    const arr = byEpisode.get(j.episode_id) || []
    arr.push(j)
    byEpisode.set(j.episode_id, arr)
  }

  let success = 0
  let failed = 0
  let cancelled = 0
  const episodes_needing_repair: string[] = []
  const failed_episodes: FailedEpisode[] = []

  for (const [ep, arr] of byEpisode.entries()) {
    const statuses = arr.map(j => j.status)
    if (statuses.some(s => s === 'error')) {
      failed++
      episodes_needing_repair.push(ep)
      // Pick the *first* failing job in the chain — that's the one that
      // broke the chain and the one worth surfacing for retry.
      const errJob = arr
        .filter(j => j.status === 'error')
        .sort((a, b) => new Date(a.finished_at || a.created_at).getTime()
                      - new Date(b.finished_at || b.created_at).getTime())[0]!
      failed_episodes.push({
        episode_id: ep,
        reason: normalizeErrorReason(errJob.error || ''),
        full_error: errJob.error || '(no error message)',
        job_type: errJob.type,
      })
    } else if (statuses.some(s => s === 'cancelled')) {
      cancelled++
    } else if (statuses.every(s => s === 'done')) {
      success++
    }
  }

  // Wall-clock: earliest actual start → latest actual finish. Jobs that
  // never ran (queued-then-cancelled) are excluded so the figure reflects
  // real provider/FFmpeg time, not sit-in-queue time.
  const starts = jobs
    .map(j => j.started_at ? new Date(j.started_at).getTime() : 0)
    .filter(t => t > 0)
  const ends = jobs
    .map(j => j.finished_at ? new Date(j.finished_at).getTime() : 0)
    .filter(t => t > 0)
  const elapsed_ms = (starts.length && ends.length)
    ? Math.max(0, Math.max(...ends) - Math.min(...starts))
    : 0

  // Group reasons by normalized prefix, top 3. Same reason across N
  // episodes collapses to one row — that's the whole point of the
  // normalize step. Ties broken by insertion order (Map iteration).
  const reasonCounts = new Map<string, number>()
  for (const f of failed_episodes) {
    reasonCounts.set(f.reason, (reasonCounts.get(f.reason) || 0) + 1)
  }
  const failure_reasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  return {
    batch_id,
    total: byEpisode.size,
    success,
    failed,
    cancelled,
    elapsed_ms,
    failure_reasons,
    episodes_needing_repair,
    failed_episodes,
  }
}

/**
 * Build a summary for the most-recent-settled pipeline batch in `jobs`.
 *
 * Returns `null` when there is no batch to summarize (no jobs carry a
 * `pipeline_batch_id`, or the newest batch still has running/queued work).
 * "Most recent" = the batch whose latest finished_at across its jobs is
 * greatest — which handles the case of multiple batches in history.
 */
export function buildLatestBatchSummary(jobs: readonly Job[]): BatchSummary | null {
  const byBatch = new Map<string, Job[]>()
  for (const j of jobs) {
    const bid = j.params?.pipeline_batch_id
    if (!bid || typeof bid !== 'string') continue
    const arr = byBatch.get(bid) || []
    arr.push(j as Job)
    byBatch.set(bid, arr)
  }
  if (!byBatch.size) return null

  // Pick the most recently-touched batch and require all its jobs to have
  // settled. If any job is still running/queued, the batch is mid-flight
  // and we don't render the summary yet.
  let pick: { id: string; jobs: Job[]; latest: number } | null = null
  for (const [id, arr] of byBatch.entries()) {
    const latest = arr.reduce((m, j) => {
      const t = new Date(j.finished_at || j.started_at || j.created_at).getTime()
      return Number.isFinite(t) ? Math.max(m, t) : m
    }, 0)
    if (!pick || latest > pick.latest) pick = { id, jobs: arr, latest }
  }
  if (!pick) return null
  const anyActive = pick.jobs.some(j => j.status === 'running' || j.status === 'queued')
  if (anyActive) return null

  return summarize(pick.id, pick.jobs)
}
