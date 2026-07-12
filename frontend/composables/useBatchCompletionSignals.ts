/**
 * In-window cross-tab signals for pipeline batch completion.
 *
 * The Electron main process already fires native OS notifications via
 * `electron/server/services/job-notifier.ts` — those work regardless of
 * which page the operator is on (or whether the app is even focused).
 *
 * What's missing: when the operator is *inside* the Story Studio window
 * but on a page other than /jobs (e.g. drafting a new pipeline run, or
 * editing a script), they have no in-window signal that a long batch
 * has finished. The post-bulk banner on the Jobs page only helps if
 * they're already looking at it.
 *
 * This composable fills that gap with two signals:
 *   1. A persistent toast ("View jobs" action) via the existing useToast
 *      system. Cross-tab — fires from any page in the dashboard layout.
 *   2. A document.title prefix ("(✓ batch done) ...") that survives
 *      page navigations until the operator visits /jobs.
 *
 * Skipped when the operator is already on /projects/:slug/jobs — the
 * banner there is the durable summary; an extra toast would be noise.
 *
 * Native notification is intentionally NOT replicated here. The Electron
 * main process owns that codepath (single source of truth, no double-pop).
 */
import { watch, ref } from 'vue'
import type { Job } from './useJobs.js'

const TITLE_BADGE = '(✓ batch done) '

function isJobsRoute(path: string): boolean {
  return /^\/projects\/[^/]+\/jobs\/?$/.test(path)
}

interface BatchSeenState {
  /** Has this batch ever had a queued/running job in our observation window? */
  hadActive: boolean
  /** Have we already fired in-window signals for this batch? */
  notified: boolean
}

/**
 * Subscribe to job updates and fire toast + title-badge when a pipeline
 * batch settles. Idempotent per batch_id — won't double-fire if the same
 * batch's stats get re-emitted (e.g. account-attribution writes after
 * terminal state).
 */
export function useBatchCompletionSignals(getJobs: () => readonly Job[]) {
  if (!import.meta.client) return

  const route = useRoute()
  const { showAction } = useToast()
  const isUnread = ref(false)

  // Per-batch state. Survives across navigations (composable instance is
  // tied to the dashboard layout, which Nuxt keeps mounted between same-
  // layout routes). On a hard reload the map resets — a batch that was
  // already settled at boot won't re-fire signals because its first
  // observation has hadActive=false.
  const batchStates = new Map<string, BatchSeenState>()

  function applyBadge() {
    if (typeof document === 'undefined') return
    if (!document.title.startsWith(TITLE_BADGE)) {
      document.title = TITLE_BADGE + document.title
    }
  }

  function stripBadge() {
    if (typeof document === 'undefined') return
    if (document.title.startsWith(TITLE_BADGE)) {
      document.title = document.title.slice(TITLE_BADGE.length)
    }
  }

  function summarizeBatch(jobs: Job[]): { total: number; success: number; failed: number; slug: string } {
    // Per-episode rollup mirrors useBatchSummary's logic: an episode is
    // "failed" if any of its chain steps errored, "success" only when
    // every step is done. Cancelled jobs collapse into neither bucket.
    const byEpisode = new Map<string, Job[]>()
    for (const j of jobs) {
      const arr = byEpisode.get(j.episode_id) || []
      arr.push(j)
      byEpisode.set(j.episode_id, arr)
    }
    let success = 0
    let failed = 0
    for (const arr of byEpisode.values()) {
      const statuses = arr.map(j => j.status)
      if (statuses.some(s => s === 'error')) failed++
      else if (statuses.every(s => s === 'done')) success++
    }
    return { total: byEpisode.size, success, failed, slug: jobs[0]?.project_slug || '' }
  }

  function fireSignals(jobs: Job[]) {
    const { total, success, failed, slug } = summarizeBatch(jobs)
    const msg = failed > 0
      ? `Pipeline finished — ${success}/${total} succeeded, ${failed} failed`
      : `Pipeline finished — ${success}/${total} episodes complete`
    const target = slug ? `/projects/${slug}/jobs` : '/'
    showAction(msg, 'View jobs', async () => { await navigateTo(target) }, failed > 0 ? 'info' : 'success')
    isUnread.value = true
    applyBadge()
  }

  // v1.0.72: was `watch(..., { deep: true })`, which fired on every
  // output_lines push from any running batch job. Since this composable
  // is mounted globally (via the layout) it dragged the UI thread
  // alongside useGenerating during chunked expansion. Now derives a
  // signal of relevant batch-job statuses and watches THAT — fires once
  // per terminal transition, not per progress tick.
  const batchJobsSignal = computed(() => {
    const list = getJobs()
    const lines: string[] = []
    for (const j of list) {
      const bid = j.params?.pipeline_batch_id
      if (typeof bid !== 'string' || !bid) continue
      lines.push(`${bid}:${j.job_id}:${j.status}`)
    }
    return lines.sort().join('|')
  })
  watch(batchJobsSignal, () => {
    const byBatch = new Map<string, Job[]>()
    for (const j of getJobs()) {
      const bid = j.params?.pipeline_batch_id
      if (typeof bid !== 'string' || !bid) continue
      const arr = byBatch.get(bid) || []
      arr.push(j as Job)
      byBatch.set(bid, arr)
    }

    for (const [bid, arr] of byBatch.entries()) {
      const state = batchStates.get(bid) || { hadActive: false, notified: false }
      const anyActive = arr.some(j => j.status === 'running' || j.status === 'queued')

      if (anyActive) {
        state.hadActive = true
      } else if (state.hadActive && !state.notified) {
        // Transition: previously had active jobs, now all settled.
        // This is the "batch just finished while we were watching" edge
        // — exactly the moment the operator wants a ping.
        state.notified = true
        if (!isJobsRoute(route.path)) {
          fireSignals(arr)
        }
      }
      batchStates.set(bid, state)
    }
  })

  // Re-apply / clear the title badge across navigations. useHead in each
  // page sets a fresh document.title on mount, so we need to re-prepend
  // after the page's title resolves. nextTick lets Nuxt's head plugin
  // settle first; otherwise we'd race and lose the badge.
  watch(() => route.path, async (path) => {
    await nextTick()
    if (isJobsRoute(path)) {
      isUnread.value = false
      stripBadge()
    } else if (isUnread.value) {
      applyBadge()
    }
  })
}
