import { computed, readonly, ref } from 'vue'
import { useApi } from './useApi.js'
import type { Job, JobStats } from './useJobs.js'
import type { JobListResponse } from '@shared/contracts'

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

function refreshed() {
  refreshFailures.value = 0
  lastRefreshError.value = ''
}

function failed(error: unknown) {
  refreshFailures.value++
  lastRefreshError.value = error instanceof Error ? error.message : 'Could not refresh Jobs.'
}

function recomputeStats() {
  const next = { ...EMPTY_STATS }
  for (const job of jobs.value) {
    if (job.status === 'running') next.running++
    else if (job.status === 'queued') next.queued++
    else if (job.status === 'paused') next.paused++
    else if (job.status === 'done') next.done++
    else if (job.status === 'error') next.error++
    next.total++
  }
  stats.value = next
}

function applySnapshot(snapshot: JobListResponse) {
  jobs.value = snapshot.jobs
  stats.value = snapshot.stats
  refreshed()
}

function applyUpdate(job: Job) {
  const next = [...jobs.value]
  const index = next.findIndex(item => item.job_id === job.job_id)
  if (index >= 0) next[index] = job
  else next.unshift(job)
  jobs.value = next
  recomputeStats()
}

/** Apply a confirmed replacement without leaving its retired terminal row visible. */
function replaceJob(replacedJobId: string, job: Job) {
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
  try {
    const snapshot = await get<JobListResponse>('/jobs/all')
    if (epoch === transportEpoch) applySnapshot(snapshot)
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
  pollTimer = setInterval(() => void refresh(), 15_000)
}

function startTransport() {
  stopTransport()
  if (typeof EventSource === 'undefined') return startFallback()
  try { source = new EventSource('/api/jobs/all/stream') } catch { return startFallback() }
  const stream = source
  source.addEventListener('snapshot', event => {
    if (source !== stream) return
    streamFailures = 0
    try { applySnapshot(JSON.parse((event as MessageEvent).data)) } catch (error) { failed(error) }
  })
  source.addEventListener('update', event => {
    if (source !== stream) return
    streamFailures = 0
    try { applyUpdate(JSON.parse((event as MessageEvent).data)); refreshed() } catch (error) { failed(error) }
  })
  source.addEventListener('cleared', event => {
    if (source !== stream) return
    try {
      const payload = JSON.parse((event as MessageEvent).data || '{}') as { job_ids?: string[] }
      const removed = new Set(payload.job_ids || [])
      jobs.value = jobs.value.filter(job => !removed.has(job.job_id))
      recomputeStats()
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
    if (subscribers === 1) startTransport()
  }

  function stop() {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0) stopTransport()
  }

  return {
    jobs: readonly(jobs),
    stats: readonly(stats),
    jobsStale,
    lastRefreshError: readonly(lastRefreshError),
    applyUpdate,
    replaceJob,
    refresh,
    start,
    stop,
  }
}
