import { computed, readonly, ref } from 'vue'
import { useApi } from './useApi.js'
import { announceJobFailure, isWatchingProject } from './useJobs.js'
import type { Job, JobStats } from './useJobs.js'
import type { JobListResponse } from '@shared/contracts'
import { isRecoveredFailure } from '../utils/episode-recovery.js'

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

function refreshed() {
  refreshFailures.value = 0
  lastRefreshError.value = ''
}

function failed(error: unknown) {
  refreshFailures.value++
  lastRefreshError.value = error instanceof Error ? error.message : 'Could not refresh Jobs.'
  isLoading.value = false
}

function recomputeStats() {
  const next = { ...EMPTY_STATS }
  for (const job of jobs.value) {
    if (job.status === 'running') next.running++
    else if (job.status === 'queued') next.queued++
    else if (job.status === 'paused') next.paused++
    else if (job.status === 'done') next.done++
    else if (job.status === 'error' && !isRecoveredFailure(job)) next.error++
    next.total++
  }
  stats.value = next
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
  if (awaySince !== null) announceFailuresWhileAway(snapshot.jobs, awaySince)
  awaySince = null
  applySnapshot(hasInitialSnapshot ? snapshot : reconcileInitialSnapshot(snapshot))
  if (!hasInitialSnapshot) {
    hasInitialSnapshot = true
    pendingUpdates.clear()
    pendingRemovals.clear()
  }
  refreshed()
}

function announceFailuresWhileAway(next: Job[], since: number) {
  const before = new Map(jobs.value.map(job => [job.job_id, job.status]))
  for (const job of next) {
    if (job.status !== 'error' || isWatchingProject(job.project_slug)) continue
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
    if (job.status === 'running') nextStats.running++
    else if (job.status === 'queued') nextStats.queued++
    else if (job.status === 'paused') nextStats.paused++
    else if (job.status === 'done') nextStats.done++
    else if (job.status === 'error' && !isRecoveredFailure(job)) nextStats.error++
    nextStats.total++
  }
  return { jobs: next, stats: nextStats }
}

function applyUpdate(job: Job) {
  stateRevision++
  if (!hasInitialSnapshot) pendingUpdates.set(job.job_id, job)
  const next = [...jobs.value]
  const index = next.findIndex(item => item.job_id === job.job_id)
  // A failure in a project that is not on screen has no other way to reach the owner.
  const before = index >= 0 ? next[index]!.status : ''
  if ((before === 'running' || before === 'queued') && job.status === 'error' && !isWatchingProject(job.project_slug)) announceJobFailure(job)
  if (index >= 0) next[index] = job
  else next.unshift(job)
  jobs.value = next
  recomputeStats()
}

function removeJobs(jobIds: Iterable<string>) {
  const removed = new Set(jobIds)
  if (!removed.size) return
  stateRevision++
  if (!hasInitialSnapshot) for (const id of removed) pendingRemovals.add(id)
  jobs.value = jobs.value.filter(job => !removed.has(job.job_id))
  recomputeStats()
}

/** Apply a confirmed replacement without leaving its retired terminal row visible. */
function replaceJob(replacedJobId: string, job: Job) {
  stateRevision++
  if (!hasInitialSnapshot) {
    if (replacedJobId !== job.job_id) pendingRemovals.add(replacedJobId)
    pendingUpdates.set(job.job_id, job)
  }
  const next = jobs.value.filter(existing => existing.job_id !== replacedJobId)
  const index = next.findIndex(item => item.job_id === job.job_id)
  if (index >= 0) next[index] = job
  else next.unshift(job)
  jobs.value = next
  recomputeStats()
}

async function refresh() {
  const { get } = useApi()
  const epoch = transportEpoch
  const revision = stateRevision
  try {
    const snapshot = await get<JobListResponse>('/jobs/all')
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
