/**
 * useAppJobs — composable for the app-level job queue (currently
 * broll_normalize, anything else with project_slug='_app_').
 *
 * Mirrors useJobs's SSE-with-polling-fallback shape but scoped to the
 * `/jobs/app` endpoint family. Doesn't pollute per-project jobs lists.
 * Surfaces are responsible for filtering by job type if they only care
 * about a subset (the B-Roll Library page filters by broll_normalize
 * for its inline panel).
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useApi } from './useApi.js'

interface Job {
  job_id: string
  type: string
  project_slug: string
  episode_id?: string
  title?: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  pause_requested?: boolean
  pause_origin?: 'manual' | 'queue'
  params?: any
  output_lines?: string[]
  output_dir?: string
  error?: string | null
  created_at?: string
  finished_at?: string | null
}

interface AppJobsResponse { jobs: Job[]; stats: any }

const jobs = ref<Job[]>([])
const stats = ref<any>(null)
let sseSource: EventSource | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let refCount = 0

// Fires when ANY job transitions to a terminal state (done/error/cancelled).
// Surfaces can subscribe to refresh their data when the relevant job lands.
type DoneListener = (job: Job) => void
const doneListeners = new Set<DoneListener>()
const previousStatuses = new Map<string, Job['status']>()

function recomputeStats() {
  return {
    running: jobs.value.filter(j => j.status === 'running').length,
    queued: jobs.value.filter(j => j.status === 'queued').length,
    done: jobs.value.filter(j => j.status === 'done').length,
    error: jobs.value.filter(j => j.status === 'error').length,
    total: jobs.value.length,
  }
}

function announceTransitions(next: Job[]): void {
  for (const job of next) {
    const prev = previousStatuses.get(job.job_id)
    if (prev && prev !== job.status && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
      for (const l of doneListeners) {
        try { l(job) } catch { /* listener errors must not break the queue */ }
      }
    }
    previousStatuses.set(job.job_id, job.status)
  }
}

async function refreshFull(): Promise<void> {
  const { get } = useApi()
  try {
    const data = await get<AppJobsResponse>(`/jobs/app`)
    announceTransitions(data.jobs)
    jobs.value = data.jobs
    stats.value = data.stats
  } catch {
    /* tolerate transient failures */
  }
}

function startSSE(): void {
  if (sseSource) return
  try {
    sseSource = new EventSource(`/api/jobs/app/stream`)
    sseSource.addEventListener('snapshot', (e: MessageEvent) => {
      // The stream is live again: the fallback poll started by an earlier error is no longer needed
      // (it used to run every 4 s until the page unmounted).
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      try {
        const data = JSON.parse(e.data) as AppJobsResponse
        announceTransitions(data.jobs)
        jobs.value = data.jobs
        stats.value = data.stats
      } catch { /* malformed payload */ }
    })
    sseSource.addEventListener('update', (e: MessageEvent) => {
      try {
        const job = JSON.parse(e.data) as Job
        const next = [...jobs.value]
        const idx = next.findIndex(j => j.job_id === job.job_id)
        if (idx >= 0) next[idx] = job
        else next.unshift(job)
        announceTransitions([job])
        jobs.value = next
      } catch { /* malformed payload */ }
    })
    sseSource.addEventListener('cleared', (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data || '{}') as { job_ids?: string[] }
        const removed = new Set(payload.job_ids || [])
        if (!removed.size) return
        jobs.value = jobs.value.filter(job => !removed.has(job.job_id))
        stats.value = recomputeStats()
      } catch { void refreshFull() }
    })
    sseSource.onerror = () => {
      // Fall back to polling — EventSource auto-retries on its own, but
      // keep polling alive so the user always sees progress even if SSE
      // can't reconnect (proxy issue, etc.).
      if (!pollTimer) pollTimer = setInterval(refreshFull, 4000)
    }
  } catch {
    // Browser doesn't support EventSource — poll.
    if (!pollTimer) pollTimer = setInterval(refreshFull, 4000)
  }
}

function stopAll(): void {
  if (sseSource) { sseSource.close(); sseSource = null }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

/**
 * Mount the composable. First subscriber starts the SSE + polling;
 * subsequent subscribers share the same upstream connection. Unmount
 * decrements the refcount; when it hits zero the SSE closes.
 */
export function useAppJobs() {
  onMounted(() => {
    refCount++
    if (refCount === 1) {
      void refreshFull()
      startSSE()
    }
  })
  onBeforeUnmount(() => {
    refCount--
    if (refCount <= 0) {
      refCount = 0
      stopAll()
    }
  })

  function onJobDone(listener: DoneListener): () => void {
    doneListeners.add(listener)
    return () => doneListeners.delete(listener)
  }

  return {
    jobs: computed(() => jobs.value),
    stats: computed(() => stats.value),
    refresh: refreshFull,
    /** Subscribe to terminal transitions. Returns an unsubscribe fn.
     *  Useful for pages that need to refetch some state when a relevant
     *  job lands (e.g. B-Roll Library refreshing the clip grid after
     *  broll_normalize completes). */
    onJobDone,
  }
}

/** Test seams: the transport without a component lifecycle. */
export const __appJobsTransportForTests = {
  start: startSSE,
  stop: stopAll,
  pollActive: (): boolean => pollTimer !== null,
}
