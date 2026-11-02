import { computed, readonly, ref } from 'vue'
import { useApi, invalidateProjectCache } from './useApi.js'
import { announceJobFailure, isWatchingProject } from './useJobs.js'
import type { Job, JobStats } from './useJobs.js'
import type { JobHistoryResponse, JobListResponse } from '@shared/contracts'
import { isRecoveredFailure } from '../utils/episode-recovery.js'

/**
 * The fleet's LIVE jobs — queued, running and paused — plus the whole fleet's
 * counts.
 *
 * WHY THIS IS NOT THE WHOLE FLEET. This stream is opened by the dashboard
 * layout on EVERY page, and it used to carry every job of every channel: ~14k
 * rows and ~128 MB at production size, of which a channel's entire finished
 * history was the bulk. A page that only wants the queue and the badge now
 * reads `?view=active`; the finished half is a paged read
 * (`/jobs/all/history`), which the Jobs page makes. The stats still describe
 * the whole fleet, counted server-side without cloning a job, so the badge
 * keeps its meaning.
 *
 * A terminal transition therefore leaves this list rather than staying in it.
 * The counters are adjusted as it leaves, so a job that finishes still moves
 * the badge the moment the SSE frame arrives.
 */
const EMPTY_STATS: JobStats = { running: 0, queued: 0, paused: 0, done: 0, error: 0, total: 0 }
const jobs = ref<Job[]>([])
const stats = ref<JobStats>({ ...EMPTY_STATS })

let source: EventSource | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let subscribers = 0
let transportEpoch = 0
let streamFailures = 0
const refreshFailures = ref(0)
const lastRefreshError = ref('')
const jobsStale = computed(() => refreshFailures.value >= 3)
const isLoading = ref(false)
let stateRevision = 0
let hasInitialSnapshot = false
// Hidden window: the stream is closed. Back on screen, one snapshot catches
// up and every failure that happened while away still gets its toast.
let pausedWhileHidden = false
let awaySince: number | null = null
const pendingUpdates = new Map<string, Job>()
const pendingRemovals = new Set<string>()

/** The status counter a job contributes to, or null for statuses the badge does not show. */
function statsKey(job: Job): 'running' | 'queued' | 'paused' | 'done' | 'error' | null {
  if (job.status === 'error') return isRecoveredFailure(job) ? null : 'error'
  return job.status === 'running' || job.status === 'queued' || job.status === 'paused' || job.status === 'done'
    ? job.status
    : null
}

/** Move the badge by one job. The snapshot's counts are the base; this keeps them live between snapshots. */
function adjustStats(job: Job, delta: number) {
  const key = statsKey(job)
  if (!key) return
  stats.value = { ...stats.value, [key]: Math.max(0, stats.value[key] + delta) }
}

function refreshed() {
  refreshFailures.value = 0
  lastRefreshError.value = ''
}

function failed(error: unknown) {
  refreshFailures.value++
  lastRefreshError.value = error instanceof Error ? error.message : 'Could not refresh Jobs.'
  isLoading.value = false
}

function applySnapshot(snapshot: JobListResponse) {
  stateRevision++
  jobs.value = snapshot.jobs
  stats.value = snapshot.stats
  isLoading.value = false
}

/**
 * A full GET or SSE snapshot is the only event that proves the list is
 * complete. Incremental updates can still be useful after a snapshot error,
 * but must leave the incomplete-list warning visible until this succeeds.
 */
function completeSnapshot(snapshot: JobListResponse) {
  if (awaySince !== null) {
    const since = awaySince
    awaySince = null
    void announceFailuresWhileAway(since)
  }
  applySnapshot(hasInitialSnapshot ? snapshot : reconcileInitialSnapshot(snapshot))
  if (!hasInitialSnapshot) {
    hasInitialSnapshot = true
    pendingUpdates.clear()
    pendingRemovals.clear()
  }
  refreshed()
}

/**
 * Failures that happened while the window was hidden have no other way to
 * reach the owner: the stream was closed, and a live-only snapshot cannot
 * carry them. Ask the history read for exactly the window we were away.
 */
async function announceFailuresWhileAway(since: number) {
  const before = new Map(jobs.value.map(job => [job.job_id, job.status]))
  let recent: Job[]
  try {
    const { get } = useApi()
    const query = `status=error&limit=200&since=${encodeURIComponent(new Date(since).toISOString())}`
    recent = (await get<JobHistoryResponse>(`/jobs/all/history?${query}`, { cache: 'no-store' })).jobs as Job[]
  } catch { return /* best effort: the row is still on the Jobs page */ }
  for (const job of recent) {
    if (isWatchingProject(job.project_slug)) continue
    const prev = before.get(job.job_id)
    const failedNow = prev === 'running' || prev === 'queued'
    const failedUnseen = !prev && Date.parse(job.finished_at || '') >= since
    if (failedNow || failedUnseen) announceJobFailure(job)
  }
}

function onVisibilityChange() {
  if (typeof document === 'undefined' || subscribers === 0) return
  if (document.visibilityState === 'hidden') {
    if (pausedWhileHidden) return
    pausedWhileHidden = true
    awaySince = Date.now()
    stopTransport()
  } else if (pausedWhileHidden) {
    pausedWhileHidden = false
    startTransport()
  }
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
    const key = statsKey(job)
    if (key) nextStats[key]++
    nextStats.total++
  }
  return { jobs: next, stats: nextStats }
}

/** A live job: the statuses this stream carries and the page's Active list shows. */
function isLiveStatus(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'paused'
}

function applyUpdate(job: Job) {
  stateRevision++
  if (!hasInitialSnapshot) pendingUpdates.set(job.job_id, job)
  const previous = jobs.value.find(item => item.job_id === job.job_id)
  const next = jobs.value.filter(item => item.job_id !== job.job_id)
  const live = isLiveStatus(job.status)
  // A failure in a project that is not on screen has no other way to reach the owner.
  if ((previous?.status === 'running' || previous?.status === 'queued')
    && job.status === 'error' && !isWatchingProject(job.project_slug)) {
    announceJobFailure(job)
  }
  // A terminal transition changed the project's episodes/channels on disk —
  // drop its cached reads so no page keeps showing the pre-job picture.
  if ((previous?.status === 'running' || previous?.status === 'queued')
    && !isLiveStatus(job.status)) {
    invalidateProjectCache(job.project_slug, job.episode_id)
  }
  if (previous) {
    // The badge counts the transition even though the row itself leaves the list:
    // a job that just finished is history, and history is not what this stream carries.
    adjustStats(previous, -1)
    adjustStats(job, 1)
  } else if (live) {
    // A job we have never seen, still running: it is new to the fleet.
    stats.value = { ...stats.value, total: stats.value.total + 1 }
    adjustStats(job, 1)
  }
  // An update for an unseen FINISHED row is evidence being refreshed on old
  // history that the snapshot already counted; counting it again would inflate
  // the badge, so it is left alone.
  if (live) next.unshift(job)
  jobs.value = next
  if (previous && !live) scheduleStatsResync()
}

/**
 * The counters are the server's. A local transition keeps the badge instant,
 * but the finished half is not on this stream at all, so re-read the counts
 * rather than trusting local arithmetic over a long session.
 */
let statsTimer: ReturnType<typeof setTimeout> | null = null
function scheduleStatsResync() {
  if (statsTimer) return
  statsTimer = setTimeout(() => { statsTimer = null; void refresh() }, 1_000)
}

function removeJobs(jobIds: Iterable<string>) {
  const removed = new Set(jobIds)
  if (!removed.size) return
  stateRevision++
  if (!hasInitialSnapshot) for (const id of removed) pendingRemovals.add(id)
  const dropped = jobs.value.filter(job => removed.has(job.job_id))
  jobs.value = jobs.value.filter(job => !removed.has(job.job_id))
  for (const job of dropped) { adjustStats(job, -1); stats.value = { ...stats.value, total: Math.max(0, stats.value.total - 1) } }
  // A removed row may never have been on this stream (it is history), so the
  // fleet's counts come back from the server.
  scheduleStatsResync()
}

/** Apply a confirmed replacement without leaving its retired terminal row visible. */
function replaceJob(replacedJobId: string, job: Job) {
  stateRevision++
  if (!hasInitialSnapshot) {
    if (replacedJobId !== job.job_id) pendingRemovals.add(replacedJobId)
    pendingUpdates.set(job.job_id, job)
  }
  const previous = jobs.value.find(existing => existing.job_id === replacedJobId)
  const next = jobs.value.filter(existing => existing.job_id !== replacedJobId)
  const index = next.findIndex(item => item.job_id === job.job_id)
  if (index >= 0) next[index] = job
  else if (isLiveStatus(job.status)) next.unshift(job)
  jobs.value = next
  if (previous) {
    adjustStats(previous, -1)
    adjustStats(job, 1)
  } else if (isLiveStatus(job.status)) {
    adjustStats(job, 1)
    stats.value = { ...stats.value, total: stats.value.total + 1 }
  }
  scheduleStatsResync()
}

async function refresh() {
  const { get } = useApi()
  const epoch = transportEpoch
  const revision = stateRevision
  try {
    const snapshot = await get<JobListResponse>('/jobs/all?view=active', { cache: 'no-store' })
    // Before the first snapshot, concurrent confirmed changes are recorded
    // for reconciliation. They must not make the only authoritative fallback
    // snapshot look stale.
    if (epoch === transportEpoch && (revision === stateRevision || !hasInitialSnapshot)) completeSnapshot(snapshot)
  } catch (error) {
    if (epoch === transportEpoch) failed(error)
  }
}

function stopTransport() {
  transportEpoch++
  streamFailures = 0
  source?.close()
  source = null
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (statsTimer) clearTimeout(statsTimer)
  statsTimer = null
}

function startFallback() {
  stopTransport()
  void refresh()
  let ticks = 0
  // Every 4th tick (~1 min) tries the live stream again.
  pollTimer = setInterval(() => { if (++ticks % 4 === 0) startTransport(); else void refresh() }, 15_000)
}

function startTransport() {
  stopTransport()
  hasInitialSnapshot = false
  pendingUpdates.clear()
  pendingRemovals.clear()
  if (typeof EventSource === 'undefined') return startFallback()
  try { source = new EventSource('/api/jobs/all/stream') } catch { return startFallback() }
  const stream = source
  source.addEventListener('snapshot', event => {
    if (source !== stream) return
    streamFailures = 0
    try {
      const snapshot = JSON.parse((event as MessageEvent).data) as JobListResponse
      completeSnapshot(snapshot)
    } catch (error) { failed(error) }
  })
  source.addEventListener('snapshot-error', event => {
    if (source !== stream) return
    try {
      const payload = JSON.parse((event as MessageEvent).data || '{}') as { detail?: string }
      throw new Error(payload.detail || 'Could not load the live job snapshot.')
    } catch (error) { failed(error) }
  })
  source.addEventListener('update', event => {
    if (source !== stream) return
    streamFailures = 0
    try { applyUpdate(JSON.parse((event as MessageEvent).data)) } catch (error) { failed(error) }
  })
  source.addEventListener('cleared', event => {
    if (source !== stream) return
    try {
      const payload = JSON.parse((event as MessageEvent).data || '{}') as { job_ids?: string[] }
      removeJobs(payload.job_ids || [])
    } catch { void refresh() }
    // Rows the stream never carried still left the fleet: re-read the counts.
    void refresh()
  })
  source.onerror = () => {
    if (source !== stream) return
    streamFailures++
    if (streamFailures >= 3) startFallback()
    else void refresh()
  }
}

export function useAllJobs() {
  function start() {
    subscribers++
    if (subscribers === 1) {
      isLoading.value = true
      pausedWhileHidden = false
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
      startTransport()
    }
  }

  function stop() {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0) {
      stopTransport()
      pausedWhileHidden = false
      awaySince = null
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    }
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
    refresh,
    start,
    stop,
  }
}
