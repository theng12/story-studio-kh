/**
 * Tests for `useEpisodes` — the SWR composable that backs every page
 * mounting `/projects/:slug/episodes`.
 *
 * Covers:
 *   - First mount fetches; data populates; isLoading toggles.
 *   - Second mount within the hot-cache window serves cached immediately
 *     without repeating the expensive project-wide status request.
 *   - Concurrent calls dedup to one in-flight fetch.
 *   - `refresh()` always hits the backend with `?refresh=1`.
 *   - `invalidate()` clears the freshness flag without blanking data.
 *
 * `$fetch` is a Nuxt global stubbed in the test process before the module
 * loads. Vue lifecycle hooks (onMounted) require an active component
 * instance — we wrap useEpisodes calls in defineComponent + render via
 * @vue/test-utils' minimal mount.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { defineComponent, h, nextTick, createApp, ref } from 'vue'

// ── Controllable $fetch stub ────────────────────────────────────────────────

type FetchHandler = (url: string) => any | Promise<any>
let fetchHandler: FetchHandler = () => []
let fetchCalls: string[] = []

;(globalThis as any).$fetch = async (url: string) => {
  fetchCalls.push(url)
  return await fetchHandler(url)
}

class FakeEventSource {
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {}
  closed = false
  constructor(public readonly url: string) {
    FakeEventSource.last = this
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    ;(this.listeners[type] ||= []).push(listener)
  }
  fire(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const listener of this.listeners[type] || []) listener(event)
  }
  close() { this.closed = true }
  static last: FakeEventSource | null = null
}

;(globalThis as any).EventSource = FakeEventSource

// useEpisodes wraps the useJobs import in try/catch so unit tests don't need
// to provide an SSE-driven jobs source — auto-invalidation just disables.
const { useEpisodes, invalidateEpisodes } = await import('../composables/useEpisodes.js')
const { useJobs } = await import('../composables/useJobs.js')

function fakeRow(code: string, scriptDone = true) {
  return {
    episode_code: code,
    title: `T${code}`,
    status: {
      script: scriptDone, introduction: false,
      prompts: false, scene_prompts: false, thumb_prompts: false,
      images: false, thumbnails: false,
      audio: false, merged_audio: false,
      video: false, video_assembly: false,
      video_ready: false, publishable: false,
      metadata: false, all_done: false,
    },
  }
}

function fakeJob(overrides: Record<string, unknown> = {}) {
  return {
    job_id: 'job-1',
    project_slug: 'alpha',
    type: 'script-only',
    episode_id: 'EP001',
    title: '',
    status: 'queued',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: [],
    ...overrides,
  }
}

function snapshot(jobs: any[]) {
  const stats = { running: 0, queued: 0, done: 0, error: 0, total: jobs.length }
  for (const job of jobs) {
    if (job.status === 'running') stats.running++
    else if (job.status === 'queued') stats.queued++
    else if (job.status === 'done') stats.done++
    else if (job.status === 'error') stats.error++
  }
  return { jobs, stats }
}

function startJobs(slug: string) {
  const queue = useJobs()
  queue.stopPolling()
  // Force the module-scoped transport to clear any prior test's project.
  queue.startPolling(`${slug}-reset`)
  FakeEventSource.last?.fire('snapshot', snapshot([]))
  queue.startPolling(slug)
  return { queue, stream: FakeEventSource.last! }
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  await nextTick()
}

/**
 * Mount a tiny component that calls the composable, returning a handle
 * to its returned refs. Lets us exercise onMounted-driven side effects.
 */
function mountWithComposable(slug: string | ReturnType<typeof ref>, options: { invalidateOnJobTypes?: string[] | true } = { invalidateOnJobTypes: [] }) {
  let captured: ReturnType<typeof useEpisodes> | null = null
  const Comp = defineComponent({
    setup() {
      captured = useEpisodes(slug, options)
      return () => h('div')
    },
  })
  // Minimal mount: createApp + mount on a detached element.
  const app = createApp(Comp)
  const root = document.createElement('div')
  app.mount(root)
  return { app, captured: captured!, root }
}

describe('useEpisodes', () => {
  beforeEach(() => {
    fetchCalls = []
    fetchHandler = () => []
    // Wipe internal slots between tests.
    invalidateEpisodes('alpha')
    invalidateEpisodes('beta')
  })

  test('first mount fetches and populates episodes', async () => {
    fetchHandler = () => [fakeRow('EP001'), fakeRow('EP002')]
    const { captured, app } = mountWithComposable('alpha')
    // Wait for the onMounted-triggered fetch.
    await nextTick()
    await nextTick()
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    assert.equal(fetchCalls.length, 1, 'one fetch fired')
    assert.match(fetchCalls[0], /\/projects\/alpha\/episodes/)
    assert.equal(captured.episodes.value.length, 2, 'data populated')
    assert.equal(captured.isLoading.value, false, 'isLoading cleared after resolve')
    app.unmount()
  })

  test('second mount serves hot cache without duplicate revalidation', async () => {
    fetchHandler = () => [fakeRow('EP001')]
    const m1 = mountWithComposable('beta')
    await nextTick(); await nextTick()
    await new Promise(r => setTimeout(r, 0)); await nextTick()
    assert.equal(fetchCalls.length, 1, 'first mount fetched')
    m1.app.unmount()

    // Second mount should neither show loading nor repeat the expensive
    // project-wide status scan while the first result is still hot.
    fetchHandler = () => [fakeRow('EP001'), fakeRow('EP002')]  // changed payload
    const m2 = mountWithComposable('beta')
    // Synchronously after mount, before any async resolves: data should
    // already be the cached value.
    assert.equal(m2.captured.episodes.value.length, 1, 'served cached immediately')
    assert.equal(m2.captured.isLoading.value, false, 'no loading state on warm mount')

    await nextTick()
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    assert.equal(fetchCalls.length, 1, 'hot mount did not repeat the status request')
    assert.equal(m2.captured.episodes.value.length, 1, 'cached data remains stable')
    m2.app.unmount()
  })

  test('refresh() forces a fresh fetch with ?refresh=1', async () => {
    fetchHandler = () => [fakeRow('EP001')]
    const m = mountWithComposable('alpha')
    await nextTick()
    await new Promise(r => setTimeout(r, 0)); await nextTick()
    fetchCalls.length = 0  // reset

    fetchHandler = () => [fakeRow('EP001'), fakeRow('EP002')]
    await m.captured.refresh()

    assert.equal(fetchCalls.length, 1, 'one extra fetch fired')
    assert.match(fetchCalls[0], /\?refresh=1/, 'force-refresh query sent')
    assert.equal(m.captured.episodes.value.length, 2, 'new data swapped in')
    m.app.unmount()
  })

  test('invalidate() clears freshness; next mount refetches', async () => {
    fetchHandler = () => [fakeRow('EP001')]
    const m1 = mountWithComposable('alpha')
    await nextTick(); await new Promise(r => setTimeout(r, 0)); await nextTick()
    m1.app.unmount()

    invalidateEpisodes('alpha')
    fetchCalls.length = 0

    fetchHandler = () => [fakeRow('EP002')]
    const m2 = mountWithComposable('alpha')
    await nextTick(); await new Promise(r => setTimeout(r, 0)); await nextTick()

    assert.equal(fetchCalls.length, 1, 'fetched again after invalidate')
    assert.equal(m2.captured.episodes.value.length, 1)
    assert.equal(m2.captured.episodes.value[0].episode_code, 'EP002')
    m2.app.unmount()
  })

  test('mutation refresh bypasses an older request and stale response cannot undo feedback', async () => {
    fetchHandler = () => [fakeRow('EP001', false)]
    const m = mountWithComposable('alpha')
    await nextTick(); await new Promise(r => setTimeout(r, 0)); await nextTick()

    let resolveStale!: (rows: any[]) => void
    let resolveFresh!: (rows: any[]) => void
    const stale = new Promise<any[]>(resolve => { resolveStale = resolve })
    const fresh = new Promise<any[]>(resolve => { resolveFresh = resolve })
    let call = 0
    fetchHandler = () => call++ === 0 ? stale : fresh

    const staleRequest = m.captured.revalidate()
    m.captured.updateEpisode('EP001', ep => ({
      ...ep,
      status_overrides: { script: true },
      status: { ...ep.status, script: true },
    }))
    const mutationRequest = m.captured.revalidateAfterMutation('EP001')

    resolveStale([fakeRow('EP001', false)])
    await staleRequest
    assert.equal(m.captured.episodes.value[0].status.script, true,
      'older response cannot erase immediate mutation feedback')

    const confirmed = fakeRow('EP001', true)
    confirmed.status_overrides = { script: true }
    resolveFresh([confirmed])
    await mutationRequest
    assert.equal(fetchCalls.length >= 2, true, 'mutation starts a distinct request')
    // v1.4.82 — `?mutation=<ts>` only busted the browser cache; the server read
    // it as a plain request and answered from its own pre-mutation status cache.
    assert.match(fetchCalls.at(-1) || '', /invalidate=EP001/)
    assert.equal(m.captured.episodes.value[0].status.script, true)
    assert.deepEqual(m.captured.episodes.value[0].status_overrides, { script: true })
    m.app.unmount()
  })

  test('does not refetch for a historical done job in the initial or reconnect snapshot', async () => {
    fetchHandler = () => [fakeRow('EP001')]
    const { queue, stream } = startJobs('alpha')
    const m = mountWithComposable('alpha', { invalidateOnJobTypes: true })
    await settle()
    assert.equal(fetchCalls.length, 1)

    stream.fire('snapshot', snapshot([fakeJob({
      status: 'done',
      finished_at: '2020-01-01T00:00:00.000Z',
    })]))
    await settle()
    assert.equal(fetchCalls.length, 1, 'historical completion does not duplicate the list fetch')

    // A reconnect can replay the same completed history. It remains seen.
    stream.fire('snapshot', snapshot([fakeJob({
      status: 'done',
      finished_at: '2020-01-01T00:00:00.000Z',
    })]))
    await settle()
    assert.equal(fetchCalls.length, 1, 'reconnect snapshot does not rescan unchanged history')
    queue.stopPolling()
    m.app.unmount()
  })

  test('refetches when a completion lands after the episode list was fetched', async () => {
    let call = 0
    fetchHandler = () => call++ === 0 ? [fakeRow('EP001')] : [fakeRow('EP001'), fakeRow('EP002')]
    const { queue, stream } = startJobs('alpha')
    const m = mountWithComposable('alpha', { invalidateOnJobTypes: true })
    await settle()

    stream.fire('snapshot', snapshot([fakeJob({
      status: 'done',
      finished_at: new Date(Date.now() + 1_000).toISOString(),
    })]))
    await settle()

    assert.equal(fetchCalls.length, 2, 'a newer completion invalidates once')
    assert.equal(m.captured.episodes.value.length, 2)
    queue.stopPolling()
    m.app.unmount()
  })

  test('refetches when completion occurs during a list read and snapshot arrives after it', async () => {
    let resolveInitial!: (rows: any[]) => void
    const initial = new Promise<any[]>(resolve => { resolveInitial = resolve })
    let call = 0
    fetchHandler = () => call++ === 0 ? initial : [fakeRow('EP001'), fakeRow('EP002')]
    const { queue, stream } = startJobs('alpha')
    const m = mountWithComposable('alpha', { invalidateOnJobTypes: true })
    await nextTick()
    await new Promise<void>(resolve => setImmediate(resolve))

    // The completion is recorded after the read starts but before its stale
    // result is published. Delivering the SSE snapshot after that response
    // must still trigger the corrective read.
    const originalNow = Date.now
    const requestStartedAt = originalNow()
    let clock = requestStartedAt + 1
    Date.now = () => clock
    try {
      const finishedAt = new Date(clock).toISOString()
      resolveInitial([fakeRow('EP001')])
      clock++
      await settle()
      assert.equal(fetchCalls.length, 1)
      stream.fire('snapshot', snapshot([fakeJob({ status: 'done', finished_at: finishedAt })]))
      await settle()

      assert.equal(fetchCalls.length, 2, 'completion during the read is not discarded as historical')
      assert.equal(m.captured.episodes.value.length, 2)
    } finally {
      Date.now = originalNow
      queue.stopPolling()
      m.app.unmount()
    }
  })

  test('refetches on a real queued-to-done transition', async () => {
    let call = 0
    fetchHandler = () => call++ === 0 ? [fakeRow('EP001')] : [fakeRow('EP001'), fakeRow('EP002')]
    const { queue, stream } = startJobs('alpha')
    const m = mountWithComposable('alpha', { invalidateOnJobTypes: true })
    await settle()
    const queued = fakeJob({ status: 'queued' })
    stream.fire('snapshot', snapshot([queued]))
    await settle()

    stream.fire('update', {
      ...queued,
      status: 'done',
      // Status transition is authoritative even if the server clock predates
      // the episode-list request.
      finished_at: '2020-01-01T00:00:00.000Z',
    })
    await settle()

    assert.equal(fetchCalls.length, 2, 'only the terminal transition starts a refresh')
    queue.stopPolling()
    m.app.unmount()
  })

  test('supersedes an in-flight list read when a job transitions to done', async () => {
    let resolveInitial!: (rows: any[]) => void
    const initial = new Promise<any[]>(resolve => { resolveInitial = resolve })
    let call = 0
    fetchHandler = () => call++ === 0 ? initial : [fakeRow('EP001'), fakeRow('EP002')]
    const { queue, stream } = startJobs('alpha')
    const m = mountWithComposable('alpha', { invalidateOnJobTypes: true })
    await nextTick()
    await new Promise<void>(resolve => setImmediate(resolve))

    const queued = fakeJob({ status: 'queued' })
    stream.fire('snapshot', snapshot([queued]))
    await settle()
    stream.fire('update', {
      ...queued,
      status: 'done',
      finished_at: '2020-01-01T00:00:00.000Z',
    })
    await settle()
    assert.equal(fetchCalls.length, 1, 'the completion waits for the shared read to settle')

    resolveInitial([fakeRow('EP001')])
    await settle()
    assert.equal(fetchCalls.length, 2, 'a corrective read follows the obsolete in-flight result')
    assert.equal(m.captured.episodes.value.length, 2)
    queue.stopPolling()
    m.app.unmount()
  })

  test('keeps completion invalidation scoped across project switches', async () => {
    let call = 0
    fetchHandler = () => call++ === 0 ? [fakeRow('EP001')] : [fakeRow('EP002')]
    const slug = ref('alpha')
    const first = startJobs('alpha')
    const m = mountWithComposable(slug, { invalidateOnJobTypes: true })
    await settle()

    first.stream.fire('snapshot', snapshot([fakeJob({
      status: 'done',
      finished_at: '2020-01-01T00:00:00.000Z',
    })]))
    await settle()
    assert.equal(fetchCalls.length, 1)

    slug.value = 'beta'
    await settle()
    assert.equal(fetchCalls.length, 2, 'switch loads the new project once')

    // The same job id completing in beta is a distinct scoped completion.
    const second = startJobs('beta')
    second.stream.fire('snapshot', snapshot([fakeJob({
      project_slug: 'beta',
      status: 'done',
      finished_at: new Date(Date.now() + 1_000).toISOString(),
    })]))
    await settle()
    assert.equal(fetchCalls.length, 3, 'beta completion is not hidden by alpha history')
    second.queue.stopPolling()
    m.app.unmount()
  })

  test('switching project scope follows the new slot and ignores delayed old data', async () => {
    let resolveAlpha!: (rows: any[]) => void
    const alpha = new Promise<any[]>(resolve => { resolveAlpha = resolve })
    fetchHandler = (url) => url.includes('/projects/alpha/') ? alpha : [fakeRow('BETA')]

    const slug = ref('alpha')
    const m = mountWithComposable(slug, { invalidateOnJobTypes: [] })
    await nextTick()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(m.captured.isLoading.value, true, 'initial project is still loading')

    slug.value = 'beta'
    await settle()
    assert.deepEqual(m.captured.episodes.value.map(row => row.episode_code), ['BETA'])
    assert.equal(m.captured.isLoading.value, false, 'new project loading state resolved')
    assert.equal(m.captured.isRevalidating.value, false)
    assert.equal(m.captured.error.value, null, 'new project has no error')
    assert.equal(m.captured.isStale.value, false, 'new project data is fresh')

    resolveAlpha([fakeRow('ALPHA')])
    await settle()
    assert.deepEqual(m.captured.episodes.value.map(row => row.episode_code), ['BETA'],
      'delayed old response cannot replace the current project')
    assert.equal(m.captured.error.value, null)
    m.app.unmount()
  })
})
