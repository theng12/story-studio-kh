import { readonly, ref } from 'vue'
import { useApi } from './useApi.js'
import type { Job, JobStats } from './useJobs.js'
import type { JobListResponse } from '@shared/contracts'

const EMPTY_STATS: JobStats = { running: 0, queued: 0, done: 0, error: 0, total: 0 }
const jobs = ref<Job[]>([])
const stats = ref<JobStats>({ ...EMPTY_STATS })

let source: EventSource | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let subscribers = 0

function recomputeStats() {
  const next = { ...EMPTY_STATS }
  for (const job of jobs.value) {
    if (job.status === 'running') next.running++
    else if (job.status === 'queued') next.queued++
    else if (job.status === 'done') next.done++
    else if (job.status === 'error') next.error++
    next.total++
  }
  stats.value = next
}

function applySnapshot(snapshot: JobListResponse) {
  jobs.value = snapshot.jobs
  stats.value = snapshot.stats
}

function applyUpdate(job: Job) {
  const next = [...jobs.value]
  const index = next.findIndex(item => item.job_id === job.job_id)
  if (index >= 0) next[index] = job
  else next.unshift(job)
  jobs.value = next
  recomputeStats()
}

async function refresh() {
  const { get } = useApi()
  applySnapshot(await get<JobListResponse>('/jobs/all'))
}

function stopTransport() {
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
  source = new EventSource('/api/jobs/all/stream')
  source.addEventListener('snapshot', event => {
    try { applySnapshot(JSON.parse((event as MessageEvent).data)) } catch {}
  })
  source.addEventListener('update', event => {
    try { applyUpdate(JSON.parse((event as MessageEvent).data)) } catch {}
  })
  source.addEventListener('cleared', event => {
    try {
      const payload = JSON.parse((event as MessageEvent).data || '{}') as { job_ids?: string[] }
      const removed = new Set(payload.job_ids || [])
      jobs.value = jobs.value.filter(job => !removed.has(job.job_id))
      recomputeStats()
    } catch { void refresh() }
  })
  source.onerror = () => {
    // EventSource reconnects on brief interruptions. The explicit refresh
    // keeps the universal view accurate without polling every project.
    void refresh()
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
    refresh,
    start,
    stop,
  }
}
