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

// Types re-exported under the old names so existing importers keep working.
export type Job = JobEnqueuedResponse
export type JobStats = JobListResponse['stats']

// v1.0.298 — keep this in sync with the JobType union (models/types.ts). A
// missing entry falls back to the raw type string (e.g. "metadata"), which is
// what made the Jobs panel + completion toasts read like internal slugs. Every
// user-facing job type now has a human label.
const JOB_TYPE_LABELS: Record<string, string> = {
  idea_campaign: 'Idea Campaign',
  'script-only': 'Script (chapters)',
  'introduction-only': 'Introduction',
  'chapter-only': 'Chapter regen',
  outline_only: 'Outline',
  expand_chapters: 'Chapter expansion',
  image_prompts: 'Image prompts',
  images: 'Images',
  scene_images: 'Scene Images',
  thumb_images: 'Thumbnail Images',
  images_repair: 'Image repair',
  audio: 'Audio',
  audio_merge: 'Audio merge',
  metadata: 'Metadata',
  video: 'Video (AI scenes)',
  video_assembly: 'Video assembly',
  subtitles_transcribe: 'Subtitles',
  youtube_upload: 'YouTube upload',
  youtube_playlist_update: 'YouTube playlist',
  broll_normalize: 'B-roll normalize',
  broll_assemble: 'B-roll assembly',
  broll_select: 'B-roll selection',
  broll_autotag: 'B-roll auto-tag',
  research_run: 'Research',
  scene_plan_run: 'Scene plan',
  contextual_cues: 'Contextual cues',
  scene_image_generate: 'Scene image',
  scene_clips_batch: 'Motion clips',
  continuity_render: 'Continuity render',
  composition_generate: 'Composition',
}

function jobLabel(job: Job): string {
  if (job.type === 'image_prompts' && (job.params as any)?.mode === 'thumbnails') return 'Thumbnail prompts'
  if (job.type === 'image_prompts' && (job.params as any)?.mode === 'scenes') return 'Scene prompts'
  return JOB_TYPE_LABELS[job.type] || job.type
}

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

let source: EventSource | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null
let currentSlug: string | null = null
let streamFailures = 0

const MAX_STREAM_FAILURES = 3
const FALLBACK_POLL_MS = 10_000

// Track previous statuses to detect completion transitions for toasts.
const previousStatuses = new Map<string, string>()

function resetJobsState() {
  jobs.value = []
  stats.value = { ...EMPTY_STATS }
  previousStatuses.clear()
}

function recomputeStats(): JobStats {
  const s = { ...EMPTY_STATS }
  for (const j of jobs.value) {
    if (j.status === 'running') s.running++
    else if (j.status === 'queued') s.queued++
    else if (j.status === 'paused') s.paused++
    else if (j.status === 'done') s.done++
    else if (j.status === 'error') s.error++
    s.total++
  }
  return s
}

function announceTransitions(next: Job[]) {
  // Toast on queued/running → done/error, same behaviour as the old poller.
  if (!import.meta.client || previousStatuses.size === 0) {
    previousStatuses.clear()
    for (const job of next) previousStatuses.set(job.job_id, job.status)
    return
  }
  const { success, info, error: showError } = useToast()
  for (const job of next) {
    const prev = previousStatuses.get(job.job_id)
    if (prev && (prev === 'running' || prev === 'queued')) {
      const label = jobLabel(job)
      if (job.status === 'done') {
        const notice = jobCompletionNotice(job, label)
        if (notice.kind === 'success') success(notice.message)
        else info(notice.message)
      }
      else if (job.status === 'error') showError(`${label} needs attention: ${job.episode_id}`)
    }
  }
  previousStatuses.clear()
  for (const job of next) previousStatuses.set(job.job_id, job.status)
}

export function jobCompletionNotice(
  job: Pick<Job, 'job_id' | 'type' | 'episode_id' | 'result' | 'output_lines'>,
  label = jobLabel(job as Job),
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
  announceTransitions(snapshot.jobs)
  jobs.value = snapshot.jobs
  stats.value = snapshot.stats
}

function applyUpdate(job: Job, slug = currentSlug) {
  if (currentSlug !== slug || job.project_slug !== slug) return
  // Merge: replace existing or prepend. Sorting stays consistent with the
  // server's `order` in getJobs() because on snapshot we already match it.
  const next = [...jobs.value]
  const idx = next.findIndex(j => j.job_id === job.job_id)
  if (idx >= 0) next[idx] = job
  else next.unshift(job)
  announceTransitions([job])
  jobs.value = next
  stats.value = recomputeStats()
}

async function refreshFull(slug: string) {
  // Used after `cleared` events and as the fallback polling body.
  // Race guard: route transitions can call this mid-tick when slug is
  // briefly undefined or the literal "undefined" string (template-
  // literal artifact). Skip — /projects/undefined/jobs is always 404.
  if (!slug || slug === 'undefined') return
  const { get } = useApi()
  try {
    const data = await get<JobListResponse>(`/projects/${slug}/jobs`)
    if (currentSlug !== slug) return
    applySnapshot(data, slug)
    refreshFailures.value = 0
    lastRefreshError.value = ''
  } catch (e: any) {
    // Don't toast on every retry — that's noise fatigue. Bump a counter
    // instead; the UI surfaces a "data may be stale" badge once we cross
    // STALE_THRESHOLD, so a single network hiccup stays quiet but a
    // sustained outage is visible to the operator.
    refreshFailures.value++
    lastRefreshError.value = e?.data?.detail || e?.message || 'Failed to refresh jobs'
  }
}

function startStream(slug: string) {
  stopTransport()
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

  source.addEventListener('snapshot', (ev: MessageEvent) => {
    streamFailures = 0
    try {
      const payload = JSON.parse(ev.data) as JobListResponse
      applySnapshot(payload, slug)
      refreshFailures.value = 0
      lastRefreshError.value = ''
    } catch (e: any) {
      // Bad frame: don't apply it, but bump the stale counter — a stream
      // that's emitting unparseable JSON is broken even if the connection
      // is technically alive.
      refreshFailures.value++
      lastRefreshError.value = `SSE snapshot parse failed: ${e?.message || 'invalid JSON'}`
    }
  })

  source.addEventListener('update', (ev: MessageEvent) => {
    streamFailures = 0
    try {
      const payload = JSON.parse(ev.data) as Job
      applyUpdate(payload, slug)
      refreshFailures.value = 0
      lastRefreshError.value = ''
    } catch (e: any) {
      // One bad update frame stalls the progress UI silently in the old
      // code. Bump the counter so the stale indicator surfaces if frames
      // keep failing.
      refreshFailures.value++
      lastRefreshError.value = `SSE update parse failed: ${e?.message || 'invalid JSON'}`
    }
  })

  source.addEventListener('cleared', (ev: MessageEvent) => {
    // Reconcile locally instead of downloading and re-rendering the full job
    // history after every dismissal. The server sends the exact removed ids.
    try {
      const payload = JSON.parse(ev.data || '{}') as { job_ids?: string[] }
      const removed = new Set(payload.job_ids || [])
      if (!removed.size) return
      jobs.value = jobs.value.filter(job => !removed.has(job.job_id))
      for (const id of removed) previousStatuses.delete(id)
      stats.value = recomputeStats()
    } catch {
      void refreshFull(slug)
    }
  })

  source.onerror = () => {
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
  if (source) {
    try { source.close() } catch {}
    source = null
  }
  if (pollInterval) clearInterval(pollInterval)
  refreshFull(slug)
  pollInterval = setInterval(() => refreshFull(slug), FALLBACK_POLL_MS)
}

function stopTransport() {
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
   * repeated connection failures. The `intervalMs` parameter is honoured
   * for the fallback path; it's otherwise unused.
   */
  function startPolling(slug: string, _intervalMs = 3000) {
    if (currentSlug !== slug) resetJobsState()
    currentSlug = slug
    startStream(slug)
  }

  function stopPolling() {
    stopTransport()
    previousStatuses.clear()
  }

  return {
    jobs: readonly(jobs),
    stats: readonly(stats),
    jobsStale,
    lastRefreshError: readonly(lastRefreshError),
    applyUpdate,
    isJobActiveFor,
    fetchJobs,
    startPolling,
    stopPolling,
  }
}
