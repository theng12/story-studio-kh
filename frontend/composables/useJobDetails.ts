/**
 * Full job records for the cards a page actually shows.
 *
 * The live job streams send a slim job: no `genstudio_jobs`, `params.genstudio_recovery` or
 * `params.scenes` (on a 400-episode channel those made each frame 100–400 KB and each snapshot tens
 * of MB). The Jobs page still needs the full Gateway evidence for the cards on screen — credits,
 * exceptions, the ledger, the request preview — so it asks for them here, one per-job GET each,
 * refetched only when the streamed summary says the evidence changed (at most every 10 s for a
 * running job).
 */
import { shallowReactive } from 'vue'
import { useApi } from './useApi.js'

type DetailJob = {
  readonly job_id: string
  readonly project_slug: string
  readonly status: string
  readonly output_lines?: readonly string[] | null
  readonly params?: Readonly<Record<string, any>> | null
  readonly genstudio_jobs?: readonly unknown[] | null
  readonly genstudio_jobs_count?: number
  readonly genstudio_jobs_updated_at?: string
}

export const RUNNING_DETAIL_REFRESH_MS = 10_000

/**
 * A streamed job whose full record holds something the stream left out.
 *
 * The live streams send a slim job with no `genstudio_jobs`. History rows
 * (`/jobs/all/history`) go further and drop `output_lines` too — the log is
 * tens of MB across a fleet and no closed card renders it — so a history row
 * needs its detail as well, whether or not it ever called the Gateway.
 */
export function needsJobDetail(job: DetailJob): boolean {
  if (job.genstudio_jobs) return false
  return (job.genstudio_jobs_count || 0) > 0 || job.output_lines === undefined
}

/** Changes whenever the full record's evidence can have changed. */
export function jobDetailKey(job: DetailJob): string {
  return `${job.status}|${job.genstudio_jobs_count || 0}|${job.genstudio_jobs_updated_at || ''}|${job.output_lines === undefined ? 'log' : ''}`
}

/**
 * The streamed job (fresher) over the fetched one, keeping the fields only the
 * fetch carries. A history row has no `output_lines` of its own, so the log —
 * and the params the row did not need — come from the full record; a row that
 * does carry a log keeps the fresher streamed copy.
 */
export function mergeJobDetail<T extends DetailJob>(streamed: T, full: DetailJob | undefined): T {
  if (!full || streamed.genstudio_jobs) return streamed
  return {
    ...streamed,
    genstudio_jobs: full.genstudio_jobs,
    ...(streamed.output_lines === undefined && full.output_lines !== undefined
      ? { output_lines: full.output_lines }
      : {}),
    params: { ...full.params, ...streamed.params },
  } as T
}

function jobPath(job: DetailJob): string {
  const id = encodeURIComponent(job.job_id)
  return job.project_slug === '_app_' ? `/jobs/app/${id}` : `/projects/${encodeURIComponent(job.project_slug)}/jobs/${id}`
}

export function useJobDetails(
  fetchJob: (path: string) => Promise<DetailJob> = path => useApi().get<DetailJob>(path, { cache: 'no-store' }),
  now: () => number = Date.now,
) {
  const details = shallowReactive(new Map<string, { key: string, job: DetailJob }>())
  const inflight = new Map<string, string>()
  const fetchedAt = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const latest = new Map<string, { job: DetailJob, key: string }>()
  let wantedIds = new Set<string>()

  async function load(job: DetailJob, key: string): Promise<void> {
    inflight.set(job.job_id, key)
    fetchedAt.set(job.job_id, now())
    try {
      const full = await fetchJob(jobPath(job))
      if (inflight.get(job.job_id) === key && full?.job_id === job.job_id) details.set(job.job_id, { key, job: full })
    } catch { /* the card keeps the streamed summary; the next change retries */ }
    finally { if (inflight.get(job.job_id) === key) inflight.delete(job.job_id) }
  }

  /** Fetch what `wanted` (streamed jobs) lacks; forget jobs no longer wanted. */
  function ensure(wanted: readonly DetailJob[]): void {
    const ids = wantedIds = new Set(wanted.map(job => job.job_id))
    for (const id of [...details.keys()]) if (!ids.has(id)) details.delete(id)
    for (const job of wanted) {
      if (!needsJobDetail(job)) continue
      const key = jobDetailKey(job)
      if (details.get(job.job_id)?.key === key || inflight.get(job.job_id) === key) continue
      const wait = job.status === 'running' && details.has(job.job_id)
        ? (fetchedAt.get(job.job_id) || 0) + RUNNING_DETAIL_REFRESH_MS - now()
        : 0
      if (wait <= 0) { void load(job, key); continue }
      latest.set(job.job_id, { job, key })
      if (timers.has(job.job_id)) continue
      timers.set(job.job_id, setTimeout(() => {
        timers.delete(job.job_id)
        const next = latest.get(job.job_id)
        latest.delete(job.job_id)
        if (next && wantedIds.has(job.job_id)) void load(next.job, next.key)
      }, wait))
    }
  }

  function withDetail<T extends DetailJob>(job: T): T {
    return mergeJobDetail(job, details.get(job.job_id)?.job)
  }

  function stop(): void {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return { ensure, withDetail, stop, details }
}
