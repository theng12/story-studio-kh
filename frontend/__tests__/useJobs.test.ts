/**
 * Tests for `useJobs` — the SSE-driven job queue state machine.
 *
 * `useJobs` owns arguably the most critical piece of real-time frontend
 * state in the app: the live job list the Jobs tab renders, the sidebar
 * badge counts, and the generator-tab "running" indicators all read from
 * its refs. A regression here surfaces as "the UI thinks the job is still
 * running after it finished" or, worse, "two projects' jobs mixed up".
 *
 * Invariants covered:
 *
 *   1. `startPolling(slug)` opens an EventSource against the scoped stream URL.
 *   2. A `snapshot` event replaces the full list + stats.
 *   3. An `update` event REPLACES an existing job in place (by job_id),
 *      leaving order stable.
 *   4. An `update` event with an unseen job_id PREPENDS the job to the list
 *      (server-side sort already put newest first in the snapshot).
 *   5. Events for a different project_slug are IGNORED — cross-project
 *      leakage is exactly the bug scoping was designed to prevent.
 *   6. Switching slug resets the jobs + stats to empty before the new
 *      snapshot lands.
 *   7. `stopPolling()` closes the EventSource and doesn't leak a listener.
 *
 * `EventSource` and `$fetch` are browser/Nuxt globals we stub here. The
 * module-scoped `useJobs` state persists across tests — each test walks
 * through a full lifecycle so it ends clean for the next one.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ── Stubs (installed BEFORE importing useJobs so it captures them) ─────────

interface FakeListener { (ev: MessageEvent): void }

class FakeEventSource {
  url: string
  listeners: Record<string, FakeListener[]> = {}
  onerror: ((ev?: Event) => void) | null = null
  closed = false
  constructor(url: string) {
    this.url = url
    FakeEventSource.last = this
  }
  addEventListener(type: string, fn: FakeListener) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  /** Helper for tests: fire an SSE-style event with a JSON payload. */
  fire(type: string, data: unknown) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const fn of (this.listeners[type] || [])) fn(ev)
  }
  close() { this.closed = true }
  // Track the most recently constructed source so tests can fire into it.
  static last: FakeEventSource | null = null
}

// Install before the composable module initialises.
;(globalThis as any).EventSource = FakeEventSource
// Stub $fetch so accidental `cleared` → refreshFull paths don't blow up.
;(globalThis as any).$fetch = async () => ({ jobs: [], stats: { running: 0, queued: 0, done: 0, error: 0, total: 0 } })

const { useJobs, jobCompletionNotice } = await import('../composables/useJobs.js')
const { resolveActiveSceneRenderJob } = await import('../utils/scene-render-job-state.js')

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkJob(overrides: Partial<any> = {}): any {
  return {
    job_id: 'j-default',
    project_slug: 'alpha',
    type: 'script-only',
    episode_id: 'EP0001',
    title: '',
    status: 'queued',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
    ...overrides,
  }
}

function mkSnapshot(jobs: any[]) {
  const stats = { running: 0, queued: 0, done: 0, error: 0, total: jobs.length }
  for (const j of jobs) {
    if (j.status === 'running') stats.running++
    else if (j.status === 'queued') stats.queued++
    else if (j.status === 'done') stats.done++
    else if (j.status === 'error') stats.error++
  }
  return { jobs, stats }
}

// Each test starts fresh by calling stopPolling() and issuing an empty
// snapshot on a unique slug — since state is module-scoped this keeps
// tests independent without reimporting.
function reset(slug: string) {
  const { startPolling, stopPolling } = useJobs()
  stopPolling()
  startPolling(slug)
  FakeEventSource.last?.fire('snapshot', mkSnapshot([]))
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('useJobs — SSE transport', () => {
  beforeEach(() => {
    FakeEventSource.last = null
  })

  test('startPolling opens an EventSource against the scoped stream URL', () => {
    const { startPolling, stopPolling } = useJobs()
    startPolling('alpha')
    assert.ok(FakeEventSource.last, 'should construct an EventSource')
    assert.equal(FakeEventSource.last!.url, '/api/projects/alpha/jobs/stream')
    stopPolling()
  })

  test('a snapshot event replaces the full jobs list + stats', () => {
    reset('snap-project')
    const { jobs, stats } = useJobs()

    FakeEventSource.last!.fire('snapshot', mkSnapshot([
      mkJob({ job_id: 'a1', project_slug: 'snap-project', status: 'running' }),
      mkJob({ job_id: 'a2', project_slug: 'snap-project', status: 'queued' }),
      mkJob({ job_id: 'a3', project_slug: 'snap-project', status: 'done' }),
    ]))

    assert.equal(jobs.value.length, 3)
    assert.deepEqual(jobs.value.map(j => j.job_id), ['a1', 'a2', 'a3'])
    assert.equal(stats.value.running, 1)
    assert.equal(stats.value.queued, 1)
    assert.equal(stats.value.done, 1)
    assert.equal(stats.value.total, 3)
  })

  test('an update event replaces an existing job in place (stable order)', () => {
    reset('update-project')
    const { jobs, stats } = useJobs()
    FakeEventSource.last!.fire('snapshot', mkSnapshot([
      mkJob({ job_id: 'b1', project_slug: 'update-project', status: 'queued' }),
      mkJob({ job_id: 'b2', project_slug: 'update-project', status: 'queued' }),
    ]))

    // b1 transitions to running — it should stay at index 0, not be re-inserted.
    FakeEventSource.last!.fire('update',
      mkJob({ job_id: 'b1', project_slug: 'update-project', status: 'running' }))

    assert.deepEqual(jobs.value.map(j => j.job_id), ['b1', 'b2'],
      'order must stay stable when updating an existing job')
    assert.equal(jobs.value[0].status, 'running')
    assert.equal(stats.value.running, 1)
    assert.equal(stats.value.queued, 1)
  })

  test('an update for a new job_id prepends it to the list', () => {
    reset('prepend-project')
    const { jobs } = useJobs()
    FakeEventSource.last!.fire('snapshot', mkSnapshot([
      mkJob({ job_id: 'c1', project_slug: 'prepend-project', status: 'done' }),
    ]))

    FakeEventSource.last!.fire('update',
      mkJob({ job_id: 'c2', project_slug: 'prepend-project', status: 'queued' }))

    assert.deepEqual(jobs.value.map(j => j.job_id), ['c2', 'c1'],
      'brand-new job must be prepended (newest first)')
  })

  test('events scoped to a different project_slug are ignored', () => {
    reset('scope-project')
    const { jobs } = useJobs()
    FakeEventSource.last!.fire('snapshot', mkSnapshot([
      mkJob({ job_id: 'mine', project_slug: 'scope-project', status: 'queued' }),
    ]))

    // Spurious event for another project — must NOT leak into our list.
    FakeEventSource.last!.fire('update',
      mkJob({ job_id: 'intruder', project_slug: 'other-project', status: 'queued' }))

    assert.deepEqual(jobs.value.map(j => j.job_id), ['mine'],
      'cross-project events must not mutate our state')
  })

  test('switching slug resets jobs + stats before the next snapshot', () => {
    reset('first-project')
    const { jobs, stats, startPolling } = useJobs()
    FakeEventSource.last!.fire('snapshot', mkSnapshot([
      mkJob({ job_id: 'old', project_slug: 'first-project', status: 'running' }),
    ]))
    assert.equal(jobs.value.length, 1)
    assert.equal(stats.value.running, 1)

    // Navigate to a new project — state clears synchronously BEFORE any
    // events land for the new slug so the UI never shows the old list.
    startPolling('second-project')
    assert.equal(jobs.value.length, 0, 'jobs cleared on slug change')
    assert.equal(stats.value.total, 0, 'stats cleared on slug change')
  })

  test('stopPolling closes the EventSource', () => {
    const { startPolling, stopPolling } = useJobs()
    startPolling('stop-project')
    const src = FakeEventSource.last!
    assert.equal(src.closed, false)
    stopPolling()
    assert.equal(src.closed, true, 'EventSource.close() must be called on stopPolling')
  })

  test('keeps a snapshot-error warning through buffered updates until a full snapshot succeeds', () => {
    const queue = useJobs()
    queue.startPolling('snapshot-error-project')
    const stream = FakeEventSource.last!
    stream.fire('snapshot-error', { detail: 'Could not load project Jobs.' })
    stream.fire('update', mkJob({ job_id: 'buffered', project_slug: 'snapshot-error-project', status: 'running' }))

    assert.equal(queue.jobs.value.find(job => job.job_id === 'buffered')?.status, 'running')
    assert.match(queue.lastRefreshError.value, /Could not load project Jobs/)

    stream.fire('snapshot', mkSnapshot([mkJob({ job_id: 'recovered', project_slug: 'snapshot-error-project' })]))
    assert.equal(queue.lastRefreshError.value, '')
    queue.stopPolling()
  })

  test('treats the first fallback GET as the initial snapshot lifecycle', async () => {
    const originalEventSource = (globalThis as any).EventSource
    const originalFetch = (globalThis as any).$fetch
    let resolveFirst!: (value: ReturnType<typeof mkSnapshot>) => void
    const first = new Promise<ReturnType<typeof mkSnapshot>>(resolve => { resolveFirst = resolve })
    ;(globalThis as any).EventSource = undefined
    ;(globalThis as any).$fetch = () => first
    const queue = useJobs()
    queue.startPolling('fallback-initial-project')
    try {
      queue.applyUpdate(mkJob({ job_id: 'confirmed', project_slug: 'fallback-initial-project', status: 'cancelled' }))
      resolveFirst(mkSnapshot([
        mkJob({ job_id: 'confirmed', project_slug: 'fallback-initial-project', status: 'queued' }),
        mkJob({ job_id: 'unrelated', project_slug: 'fallback-initial-project', status: 'queued' }),
      ]))
      await first
      await new Promise(resolve => setTimeout(resolve, 0))

      assert.equal(queue.jobs.value.find(job => job.job_id === 'confirmed')?.status, 'cancelled')
      assert.ok(queue.jobs.value.some(job => job.job_id === 'unrelated'))
      queue.removeJobs(['unrelated'])
      ;(globalThis as any).$fetch = async () => mkSnapshot([
        mkJob({ job_id: 'unrelated', project_slug: 'fallback-initial-project', status: 'queued' }),
      ])
      await queue.fetchJobs('fallback-initial-project')

      assert.deepEqual(queue.jobs.value.map(job => job.job_id), ['unrelated'],
        'a later fallback GET is authoritative after the first one clears pending reconciliation state')
    } finally {
      queue.stopPolling()
      ;(globalThis as any).EventSource = originalEventSource
      ;(globalThis as any).$fetch = originalFetch
    }
  })
})

describe('useJobs — episode ownership', () => {
  test('a paused scene batch remains an active owner and keeps Generate locked', () => {
    reset('paused-owner-project')
    const { isJobActiveFor } = useJobs()
    FakeEventSource.last!.fire('snapshot', mkSnapshot([
      mkJob({
        job_id: 'paused-scene-batch',
        project_slug: 'paused-owner-project',
        episode_id: 'EP-PAUSED',
        type: 'continuity_render',
        status: 'paused',
      }),
    ]))

    assert.equal(
      isJobActiveFor('EP-PAUSED', ['continuity_render']),
      true,
      'a paused owner must retain the duplicate-submission lock until explicit resume or cancellation',
    )
  })

  test('SSE queued, running, and terminal updates supersede a paused Scene Review snapshot', () => {
    reset('scene-review-sse-project')
    const { jobs } = useJobs()
    const cachedPaused = mkJob({
      job_id: 'scene-review-sse',
      project_slug: 'scene-review-sse-project',
      episode_id: 'EP-SSE',
      type: 'continuity_render',
      status: 'paused',
    })

    assert.equal(resolveActiveSceneRenderJob('EP-SSE', cachedPaused, jobs.value)?.status, 'paused')
    FakeEventSource.last!.fire('snapshot', mkSnapshot([{ ...cachedPaused, status: 'queued' }]))
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', cachedPaused, jobs.value)?.status, 'queued')
    FakeEventSource.last!.fire('update', { ...cachedPaused, status: 'running' })
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', cachedPaused, jobs.value)?.status, 'running')
    FakeEventSource.last!.fire('update', { ...cachedPaused, status: 'cancelled' })
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', cachedPaused, jobs.value), null)
  })
})

describe('image repair completion notices', () => {
  test('does not claim success when no image was recovered', () => {
    const notice = jobCompletionNotice(mkJob({
      job_id: 'repair-1', type: 'images_repair', episode_id: 'SS0069', status: 'done',
      result: { recovered: 0, needs_fresh_generation: 1, unrecoverable: 0 },
    }))
    assert.equal(notice.kind, 'info')
    assert.match(notice.message, /Nothing was restored/)
    assert.match(notice.message, /fresh generation/)
    assert.doesNotMatch(notice.message, /repair-1/)
  })

  test('reports verified recovery without exposing the job id', () => {
    const notice = jobCompletionNotice(mkJob({
      job_id: 'repair-2', type: 'images_repair', episode_id: 'SS0070', status: 'done',
      result: { recovered: 2, needs_fresh_generation: 0, unrecoverable: 0 },
    }))
    assert.equal(notice.kind, 'success')
    assert.match(notice.message, /Restored 2 images/)
    assert.doesNotMatch(notice.message, /repair-2/)
  })

  test('reads legacy repair summaries when structured results are absent', () => {
    const notice = jobCompletionNotice(mkJob({
      job_id: 'repair-3', type: 'images_repair', episode_id: 'SS0071', status: 'done',
      output_lines: ['Done. Recovered 0; 2 need fresh generation; 0 unrecoverable; 3 already on disk.'],
    }))
    assert.equal(notice.kind, 'info')
    assert.match(notice.message, /2 images need fresh generation/)
  })
})


describe('useJobs — closed transport isolation', () => {
  test('old cleared/error frames cannot erase or disconnect a newly selected project', () => {
    reset('old-project')
    const old = FakeEventSource.last!
    const queue = useJobs()
    queue.startPolling('new-project')
    const current = FakeEventSource.last!
    current.fire('snapshot', mkSnapshot([mkJob({ job_id: 'same-id', project_slug: 'new-project' })]))
    old.fire('cleared', { job_ids: ['same-id'] })
    for (let n = 0; n < 3; n++) old.onerror?.()
    assert.deepEqual(queue.jobs.value.map(job => job.job_id), ['same-id'])
    assert.equal(current.closed, false)
    queue.stopPolling()
  })

  test('a closed stream for the same project cannot overwrite its replacement', () => {
    reset('same-project')
    const old = FakeEventSource.last!
    const queue = useJobs()
    queue.startPolling('same-project')
    FakeEventSource.last!.fire('snapshot', mkSnapshot([mkJob({ job_id: 'new', project_slug: 'same-project' })]))
    old.fire('snapshot', mkSnapshot([mkJob({ job_id: 'old', project_slug: 'same-project' })]))
    assert.deepEqual(queue.jobs.value.map(job => job.job_id), ['new'])
    queue.stopPolling()
  })

  test('reconciles confirmed changes with an initial snapshot that arrives late', () => {
    const queue = useJobs()
    queue.startPolling('confirmed-project')
    const stream = FakeEventSource.last!

    assert.equal(queue.isLoading.value, true)
    queue.applyUpdate(mkJob({ job_id: 'confirmed', project_slug: 'confirmed-project', status: 'cancelled' }))
    stream.fire('snapshot', mkSnapshot([
      mkJob({ job_id: 'confirmed', project_slug: 'confirmed-project', status: 'running' }),
      mkJob({ job_id: 'unrelated', project_slug: 'confirmed-project', status: 'queued' }),
    ]))

    assert.deepEqual(queue.jobs.value.map(job => [job.job_id, job.status]), [
      ['confirmed', 'cancelled'],
      ['unrelated', 'queued'],
    ])
    assert.equal(queue.isLoading.value, false)
    queue.stopPolling()
  })

  test('does not resurrect a confirmed history deletion from the initial snapshot', () => {
    const queue = useJobs()
    queue.startPolling('remove-project')
    queue.removeJobs(['remove-me'])
    FakeEventSource.last!.fire('snapshot', mkSnapshot([
      mkJob({ job_id: 'remove-me', project_slug: 'remove-project', status: 'done' }),
      mkJob({ job_id: 'keep-me', project_slug: 'remove-project', status: 'error' }),
    ]))

    assert.deepEqual(queue.jobs.value.map(job => job.job_id), ['keep-me'])
    assert.equal(queue.stats.value.total, 1)
    queue.stopPolling()
  })
})
