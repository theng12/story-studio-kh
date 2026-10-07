/**
 * Job queue state composable.
 *
 * Primary transport: Server-Sent Events via `/api/projects/:slug/jobs/stream`.
 * On subscribe the backend sends a full `snapshot`, then streams `update`
 * and `cleared` events the instant the queue transitions — no more 3-second
 * polling lag.
 *
 * Fallback: if EventSource can't be opened (old runtime, proxy blocking, or
 * repeated errors), we drop to a slow 10-second poll via `useApi`. The
 * fallback triggers only after `MAX_STREAM_FAILURES` consecutive reconnect
 * errors so a single blip doesn't flip us off the stream.
 *
 * API is unchanged for callers — pages keep calling `startPolling(slug)` and
 * `stopPolling()`. Layout/page code did not need to change.
 */

// Explicit Vue + composable imports so this module is usable from plain
// node:test (no Nuxt auto-import context). Nuxt's auto-imports remain
// additive inside .vue files.
import { ref, readonly, computed } from 'vue'
import { useApi } from './useApi.js'
import { useToast } from './useToast.js'
import type { JobEnqueuedResponse, JobListResponse, JobStreamEvent } from '@shared/contracts'
import { jobDisplayLabel } from '../utils/job-presentation.js'
import { isRecoveredFailure } from '../utils/episode-recovery.js'

// Types re-exported under the old names so existing importers keep working.
export type Job = JobEnqueuedResponse
export type JobStats = JobListResponse['stats']

// F-11 — labels come from the ONE authoritative map in
// `utils/job-presentation.ts`. The local copy that used to live here had
// drifted from the live JobType union and rendered raw slugs in toasts.

const EMPTY_STATS: JobStats = { running: 0, queued: 0, paused: 0, done: 0, error: 0, total: 0 }

const jobs = ref<Job[]>([])
const stats = ref<JobStats>({ ...EMPTY_STATS })

// Stale-data tracking. Bumped on every consecutive failure of the
// background refresh paths (refreshFull, SSE frame parse). Reset on the
// next success. The dashboard-layout JobQueueIndicator (and any caller
// that wants to surface freshness) reads `jobsStale` to render a small
// "data may be stale" warning once we cross `STALE_THRESHOLD` — silent
// catches here used to let the UI claim "pending" forever after a
// backend hiccup.
const STALE_THRESHOLD = 3
const refreshFailures = ref(0)
const lastRefreshError = ref<string>('')
const jobsStale = computed(() => refreshFailures.value >= STALE_THRESHOLD)
const isLoading = ref(false)

let source: EventSource | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null
let currentSlug: string | null = null
let streamFailures = 0
let transportEpoch = 0
let stateRevision = 0
let hasInitialSnapshot = false
const pendingUpdates = new Map<string, Job>()
const pendingRemovals = new Set<string>()

const MAX_STREAM_FAILURES = 3
const FALLBACK_POLL_MS = 10_000
// Every Nth poll tick tries the live stream again, so a sleep/wake or backend restart
// does not leave progress lagging by a poll interval for the rest of the session.
const SSE_RETRY_EVERY_TICKS = 6

// Track previous statuses to detect completion transitions for toasts.
const previousStatuses = new Map<string, string>()

// While the window is hidden the stream is closed (nothing on screen reads it).
// On return one fresh snapshot catches up, and failures that happened while
// away still get their toast — including jobs that started and failed unseen.
let pausedWhileHidden = false
let awaySince: number | null = null
function onVisibilityChange() {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'hidden') {
    if (pausedWhileHidden || !currentSlug || !(source || pollInterval)) return
    pausedWhileHidden = true
    awaySince = Date.now()
    stopTransport()
  } else if (pausedWhileHidden) {
    pausedWhileHidden = false
    if (currentSlug) startStream(currentSlug)
  }
}

function resetJobsState() {
  stateRevision++
  jobs.value = []
  stats.value = { ...EMPTY_STATS }
  previousStatuses.clear()
  refreshFailures.value = 0
  lastRefreshError.value = ''
}

function recomputeStats(): JobStats {
  const s = { ...EMPTY_STATS }
  for (const j of jobs.value) {
    if (j.status === 'running') s.running++
    else if (j.status === 'queued') s.queued++
    else if (j.status === 'paused') s.paused++
    else if (j.status === 'done') s.done++
    else if (j.status === 'error' && !isRecoveredFailure(j)) s.error++
    s.total++
  }
  return s
}

function removeJobs(jobIds: Iterable<string>) {
  const removed = new Set(jobIds)
  if (!removed.size) return
  stateRevision++
  if (!hasInitialSnapshot) for (const id of removed) pendingRemovals.add(id)
  jobs.value = jobs.value.filter(job => !removed.has(job.job_id))
  for (const id of removed) previousStatuses.delete(id)
  stats.value = recomputeStats()
}

function announceTransitions(next: Job[]) {
  // Toast on queued/running → done/error, same behaviour as the old poller.
  if (!import.meta.client || (previousStatuses.size === 0 && awaySince === null)) {
    previousStatuses.clear()
    for (const job of next) previousStatuses.set(job.job_id, job.status)
    return
  }
  const { success, info } = useToast()
  for (const job of next) {
    const prev = previousStatuses.get(job.job_id)
    if (prev && (prev === 'running' || prev === 'queued')) {
      const label = jobDisplayLabel(job)
      if (job.status === 'done') {
        const notice = jobCompletionNotice(job, label)
        if (notice.kind === 'success') success(notice.message)
        else info(notice.message)
      }
      else if (job.status === 'error') announceJobFailure(job)
    } else if (!prev && failedWhileAway(job)) announceJobFailure(job)
  }
  previousStatuses.clear()
  for (const job of next) previousStatuses.set(job.job_id, job.status)
}

function failedWhileAway(job: Job): boolean {
  return awaySince !== null && job.status === 'error' && Date.parse(job.finished_at || '') >= awaySince
}

/** A failure toast that says which job and takes the customer straight to it. */
export function announceJobFailure(job: Job) {
  const { showAction } = useToast()
  showAction(
    `${jobDisplayLabel(job)} needs attention: ${job.episode_id}`,
    'Open job',
    async () => { await navigateTo(`/projects/${job.project_slug}/jobs`) },
    'error',
  )
}

/** True while the per-project stream is live for `slug` (so its own toasts already cover it). */
export function isWatchingProject(slug: string): boolean {
  return !!(source || pollInterval) && currentSlug === slug
}

export function jobCompletionNotice(
  job: Pick<Job, 'job_id' | 'type' | 'episode_id' | 'result' | 'output_lines'>,
  label = jobDisplayLabel(job as Job),
): { kind: 'success' | 'info'; message: string } {
  if (job.type !== 'images_repair') {
    return { kind: 'success', message: `${label} completed: ${job.episode_id}` }
  }

  const structured = job.result || {}
  let recovered = Number(structured.recovered)
  let needsFresh = Number(structured.needs_fresh_generation)
  let unrecoverable = Number(structured.unrecoverable)
  if (![recovered, needsFresh, unrecoverable].every(Number.isFinite)) {
    const summary = [...(job.output_lines || [])].reverse().find(line => /^Done\. Recovered \d+;/.test(line)) || ''
    const match = summary.match(/Recovered (\d+); (\d+) need fresh generation; (\d+) unrecoverable/)
    recovered = Number(match?.[1] || 0)
    needsFresh = Number(match?.[2] || 0)
    unrecoverable = Number(match?.[3] || 0)
  }

  const remaining = needsFresh + unrecoverable
  if (recovered === 0 && remaining > 0) {
    return {
      kind: 'info',
      message: `Nothing was restored for ${job.episode_id}. ${remaining} image${remaining === 1 ? '' : 's'} need${remaining === 1 ? 's' : ''} fresh generation.`,
    }
  }
  if (remaining > 0) {
    return {
      kind: 'info',
      message: `Restored ${recovered} image${recovered === 1 ? '' : 's'} for ${job.episode_id}; ${remaining} still need fresh generation.`,
    }
  }
  return {
    kind: 'success',
    message: `Restored ${recovered} image${recovered === 1 ? '' : 's'} for ${job.episode_id}.`,
  }
}

function applySnapshot(snapshot: JobListResponse, slug: string) {
  if (currentSlug !== slug) return
  stateRevision++
  announceTransitions(snapshot.jobs)
  jobs.value = snapshot.jobs
  stats.value = snapshot.stats
  isLoading.value = false
}

/**
 * A full GET or SSE snapshot is the only event that proves the list is
 * complete. Incremental updates can still be useful after a snapshot error,
 * but must leave the incomplete-list warning visible until this succeeds.
 */
function completeSnapshot(snapshot: JobListResponse, slug: string) {
  applySnapshot(hasInitialSnapshot ? snapshot : reconcileInitialSnapshot(snapshot), slug)
  if (!hasInitialSnapshot) {
    hasInitialSnapshot = true
    pendingUpdates.clear()
    pendingRemovals.clear()
  }
  refreshFailures.value = 0
  lastRefreshError.value = ''
  awaySince = null
}

function reconcileInitialSnapshot(snapshot: JobListResponse): JobListResponse {
  const next = snapshot.jobs.filter(job => !pendingRemovals.has(job.job_id))
  for (const job of pendingUpdates.values()) {
    if (pendingRemovals.has(job.job_id)) continue
    const index = next.findIndex(existing => existing.job_id === job.job_id)
    if (index >= 0) next[index] = job
    else next.unshift(job)
  }
  const nextStats = { ...EMPTY_STATS }
  for (const job of next) {
    if (job.status === 'running') nextStats.running++
    else if (job.status === 'queued') nextStats.queued++
    else if (job.status === 'paused') nextStats.paused++
    else if (job.status === 'done') nextStats.done++
    else if (job.status === 'error' && !isRecoveredFailure(job)) nextStats.error++
    nextStats.total++
  }
  return { jobs: next, stats: nextStats }
}

function applyUpdate(job: Job, slug = currentSlug) {
  if (currentSlug !== slug || job.project_slug !== slug) return
  stateRevision++
  if (!hasInitialSnapshot) pendingUpdates.set(job.job_id, job)
  // Merge: replace existing or prepend. Sorting stays consistent with the
  // server's `order` in getJobs() because on snapshot we already match it.
  const next = [...jobs.value]
  const idx = next.findIndex(j => j.job_id === job.job_id)
  if (idx >= 0) next[idx] = job
  else next.unshift(job)
  announceTransitions(next)
  jobs.value = next
  stats.value = recomputeStats()
}

/** Apply a confirmed replacement without leaving its retired terminal row visible. */
function replaceJob(replacedJobId: string, job: Job, slug = currentSlug) {
  if (currentSlug !== slug || job.project_slug !== slug) return
  stateRevision++
  if (!hasInitialSnapshot) {
    if (replacedJobId !== job.job_id) pendingRemovals.add(replacedJobId)
    pendingUpdates.set(job.job_id, job)
  }
  const next = jobs.value.filter(existing => existing.job_id !== replacedJobId)
  const idx = next.findIndex(existing => existing.job_id === job.job_id)
  if (idx >= 0) next[idx] = job
  else next.unshift(job)
  announceTransitions(next)
  jobs.value = next
  stats.value = recomputeStats()
}

async function refreshFull(slug: string) {
  // Used after `cleared` events and as the fallback polling body.
  // Race guard: route transitions can call this mid-tick when slug is
  // briefly undefined or the literal "undefined" string (template-
  // literal artifact). Skip — /projects/undefined/jobs is always 404.
  if (!slug || slug === 'undefined') return
  const epoch = transportEpoch
  const revision = stateRevision
  const { get } = useApi()
  try {
    const data = await get<JobListResponse>(`/projects/${slug}/jobs?view=stream`)
    // Before the first snapshot, concurrent confirmed changes are recorded
    // for reconciliation. They must not make the only authoritative fallback
    // snapshot look stale.
    if (currentSlug !== slug || epoch !== transportEpoch || (revision !== stateRevision && hasInitialSnapshot)) return
    completeSnapshot(data, slug)
  } catch (e: any) {
    if (currentSlug !== slug || epoch !== transportEpoch) return
    // Don't toast on every retry — that's noise fatigue. Bump a counter
    // instead; the UI surfaces a "data may be stale" badge once we cross
    // STALE_THRESHOLD, so a single network hiccup stays quiet but a
    // sustained outage is visible to the operator.
    refreshFailures.value++
    lastRefreshError.value = e?.data?.detail || e?.message || 'Failed to refresh jobs'
    isLoading.value = false
  }
}

function startStream(slug: string) {
  stopTransport()
  hasInitialSnapshot = false
  pendingUpdates.clear()
  pendingRemovals.clear()
  if (typeof EventSource === 'undefined') {
    startFallbackPolling(slug)
    return
  }
  try {
    source = new EventSource(`/api/projects/${slug}/jobs/stream`)
  } catch {
    startFallbackPolling(slug)
    return
  }

  const stream = source
  source.addEventListener('snapshot', (ev: MessageEvent) => {
    if (source !== stream) return
    streamFailures = 0
    try {
      const payload = JSON.parse(ev.data) as JobListResponse
      completeSnapshot(payload, slug)
    } catch (e: any) {
      // Bad frame: don't apply it, but bump the stale counter — a stream
      // that's emitting unparseable JSON is broken even if the connection
      // is technically alive.
      refreshFailures.value++
      lastRefreshError.value = `SSE snapshot parse failed: ${e?.message || 'invalid JSON'}`
      isLoading.value = false
    }
  })

  source.addEventListener('snapshot-error', (ev: MessageEvent) => {
    if (source !== stream) return
    try {
      const payload = JSON.parse(ev.data || '{}') as { detail?: string }
      throw new Error(payload.detail || 'Could not load the live job snapshot.')
    } catch (error) {
      refreshFailures.value++
      lastRefreshError.value = error instanceof Error ? error.message : 'Could not load the live job snapshot.'
      isLoading.value = false
    }
  })

  source.addEventListener('update', (ev: MessageEvent) => {
    if (source !== stream) return
    streamFailures = 0
    try {
      const payload = JSON.parse(ev.data) as Job
      applyUpdate(payload, slug)
    } catch (e: any) {
      // One bad update frame stalls the progress UI silently in the old
      // code. Bump the counter so the stale indicator surfaces if frames
      // keep failing.
      refreshFailures.value++
      lastRefreshError.value = `SSE update parse failed: ${e?.message || 'invalid JSON'}`
    }
  })

  source.addEventListener('cleared', (ev: MessageEvent) => {
    if (source !== stream) return
    // Reconcile locally instead of downloading and re-rendering the full job
    // history after every dismissal. The server sends the exact removed ids.
    try {
      const payload = JSON.parse(ev.data || '{}') as { job_ids?: string[] }
      removeJobs(payload.job_ids || [])
    } catch {
      void refreshFull(slug)
    }
  })

  source.onerror = () => {
    if (source !== stream) return
    // EventSource auto-reconnects; this fires on every reconnect attempt
    // including brief hiccups. Only flip to polling after repeated failures.
    streamFailures++
    if (streamFailures >= MAX_STREAM_FAILURES) {
      console.warn('[useJobs] SSE unreliable — falling back to polling')
      startFallbackPolling(slug)
    }
  }
}

function startFallbackPolling(slug: string) {
  transportEpoch++
  if (source) {
    try { source.close() } catch {}
    source = null
  }
  if (pollInterval) clearInterval(pollInterval)
  refreshFull(slug)
  let ticks = 0
  pollInterval = setInterval(() => {
    if (++ticks % SSE_RETRY_EVERY_TICKS === 0) startStream(slug)
    else void refreshFull(slug)
  }, FALLBACK_POLL_MS)
}

function stopTransport() {
  transportEpoch++
  if (source) {
    try { source.close() } catch {}
    source = null
  }
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
  streamFailures = 0
}

/**
 * Is there a queue-owned (queued, running, or paused) job for this episode?
 *
 * Pass `types` to narrow to specific JobType values (e.g. ['scene_images']);
 * omit to match ANY job type. The `jobs` ref only ever holds the CURRENT
 * project's jobs (the SSE snapshot + stream are per-slug), so no project
 * filter is needed here.
 *
 * This is the canonical "should the Generate button be disabled?" signal.
 * Unlike a page's local `submitting`/`generating` ref — which flips false the
 * instant the enqueue POST returns, while the queued job keeps running in the
 * background — this stays true for the job's whole lifetime, survives page
 * reloads, and reads the same no matter which entry point launched the job.
 * Call it inside a computed or template binding so the caller stays reactive
 * to queue changes (it reads the reactive `jobs` ref).
 */
function isJobActiveFor(episodeId: string | null | undefined, types?: readonly string[]): boolean {
  if (!episodeId) return false
  const typeSet = types && types.length ? new Set(types) : null
  return jobs.value.some(j =>
    j.episode_id === episodeId &&
    (j.status === 'queued' || j.status === 'running' || j.status === 'paused') &&
    (!typeSet || typeSet.has(j.type)),
  )
}

export function useJobs() {
  async function fetchJobs(slug: string) {
    await refreshFull(slug)
  }

  /**
   * `startPolling` is kept for source compatibility with existing callers,
   * but under the hood we prefer SSE and fall back to polling only on
   * repeated connection failures.
   */
  function startPolling(slug: string) {
    if (currentSlug !== slug) resetJobsState()
    currentSlug = slug
    isLoading.value = true
    pausedWhileHidden = false
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
    startStream(slug)
  }

  function stopPolling() {
    stopTransport()
    previousStatuses.clear()
    pausedWhileHidden = false
    awaySince = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  return {
    jobs: readonly(jobs),
    stats: readonly(stats),
    jobsStale,
    lastRefreshError: readonly(lastRefreshError),
    isLoading: readonly(isLoading),
    applyUpdate,
    replaceJob,
    removeJobs,
    isJobActiveFor,
    fetchJobs,
    startPolling,
    stopPolling,
  }
}
