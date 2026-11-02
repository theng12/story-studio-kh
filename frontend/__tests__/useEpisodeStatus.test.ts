import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { effectScope, nextTick, ref } from 'vue'

import { useEpisodeStatus } from '../composables/useEpisodeStatus.js'
import { useJobs } from '../composables/useJobs.js'
import { _clearApiGetCacheForTests } from '../composables/useApi.js'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function episode(code: string, script = true) {
  return { episode_code: code, status: { script } }
}

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
}

let fetchCalls: string[] = []
let fetchImpl: (url: string) => Promise<unknown> = async () => episode('EP_A')

;(globalThis as any).$fetch = async (url: string) => {
  fetchCalls.push(url)
  return fetchImpl(url)
}

function mountStatus(
  project = 'project-a',
  code = 'EP_A',
  refetchOnJobTypes?: string[],
) {
  const slug = ref(project)
  const episodeId = ref(code)
  const scope = effectScope()
  let status!: ReturnType<typeof useEpisodeStatus>
  scope.run(() => {
    status = useEpisodeStatus(episodeId, slug, { refetchOnJobTypes })
  })
  return { slug, episodeId, status, stop: () => scope.stop() }
}

afterEach(() => {
  fetchCalls = []
  fetchImpl = async () => episode('EP_A')
  _clearApiGetCacheForTests()
})

describe('useEpisodeStatus', () => {
  test('clears the selected row immediately on episode, project, and blank scope changes', async () => {
    const initial = deferred<unknown>()
    const pending = deferred<unknown>()
    fetchImpl = url => url.includes('EP_A') && fetchCalls.length === 1
      ? initial.promise
      : pending.promise

    const mounted = mountStatus()
    await flush()
    assert.deepEqual(fetchCalls, [
      '/api/projects/project-a/episodes/EP_A/status?invalidate=1',
    ])
    assert.equal(mounted.status.scriptReady.value, false)

    initial.resolve(episode('EP_A'))
    await flush()
    assert.equal(mounted.status.selectedEpisode.value?.episode_code, 'EP_A')
    assert.equal(mounted.status.statusKnown.value, true)
    assert.equal(mounted.status.scriptReady.value, true)

    mounted.episodeId.value = 'EP_B'
    assert.equal(mounted.status.selectedEpisode.value, null)
    assert.equal(mounted.status.statusKnown.value, false)
    assert.equal(mounted.status.scriptReady.value, false)

    mounted.slug.value = 'project-b'
    assert.equal(mounted.status.selectedEpisode.value, null)
    assert.equal(mounted.status.statusKnown.value, false)

    mounted.episodeId.value = ''
    assert.equal(mounted.status.selectedEpisode.value, null)
    assert.equal(mounted.status.statusKnown.value, false)
    assert.equal(mounted.status.scriptReady.value, false)
    mounted.stop()
  })

  test('discards superseded success and error, including a pending retry', async t => {
    t.mock.timers.enable()
    const oldRead = deferred<unknown>()
    const currentRead = deferred<unknown>()
    const pendingCurrentScope = deferred<unknown>()
    let callsForOldScope = 0
    fetchImpl = url => {
      if (url.includes('EP_A')) {
        callsForOldScope++
        return oldRead.promise
      }
      return currentRead.promise
    }

    const mounted = mountStatus()
    await flush()
    mounted.episodeId.value = 'EP_B'
    await flush()
    assert.equal(fetchCalls.length, 2)

    oldRead.resolve(episode('EP_A'))
    await flush()
    assert.equal(mounted.status.selectedEpisode.value, null)
    assert.equal(mounted.status.statusKnown.value, false)
    assert.equal(callsForOldScope, 1)

    currentRead.resolve(episode('EP_B'))
    await flush()
    assert.equal(mounted.status.selectedEpisode.value?.episode_code, 'EP_B')
    assert.equal(mounted.status.scriptReady.value, true)

    const firstRetry = deferred<unknown>()
    let currentRefreshCalls = 0
    fetchImpl = url => {
      if (url.includes('/projects/project-a/episodes/EP_B/')) {
        currentRefreshCalls++
        return currentRefreshCalls === 1 ? firstRetry.promise : Promise.resolve(episode('EP_B'))
      }
      if (url.includes('/projects/project-c/')) return pendingCurrentScope.promise
      return Promise.resolve(episode('EP_A'))
    }
    const refresh = mounted.status.refetch()
    await flush()
    firstRetry.reject(new Error('superseded failure'))
    await flush() // Let the failed request schedule its retry before changing scope.
    assert.equal(currentRefreshCalls, 1)
    mounted.slug.value = 'project-c'
    await flush()
    t.mock.timers.tick(400)
    await flush()
    await refresh
    assert.equal(currentRefreshCalls, 1, 'superseded failure must not launch its retry')
    assert.equal(mounted.status.selectedEpisode.value, null)
    assert.equal(mounted.status.statusKnown.value, false)
    mounted.stop()
    t.mock.timers.reset()
  })

  test('keeps scriptReady false after the latest scope exhausts its retries', async t => {
    t.mock.timers.enable()
    const initial = deferred<unknown>()
    let attempts = 0
    fetchImpl = url => url.includes('EP_A') ? initial.promise : Promise.reject(new Error('current status unavailable'))
    const mounted = mountStatus()
    await flush()
    initial.resolve(episode('EP_A'))
    await flush()
    assert.equal(mounted.status.scriptReady.value, true)

    fetchImpl = async () => {
      attempts++
      throw new Error('current status unavailable')
    }
    mounted.episodeId.value = 'EP_B'
    attempts = 0
    await flush()
    t.mock.timers.tick(400)
    await flush()
    t.mock.timers.tick(800)
    await flush()
    assert.equal(attempts, 3)
    assert.equal(mounted.status.selectedEpisode.value, null)
    assert.equal(mounted.status.statusKnown.value, false)
    assert.equal(mounted.status.scriptReady.value, false)
    mounted.stop()
    t.mock.timers.reset()
  })

  test('preserves per-episode invalidation and refetches when a watched job completes', async () => {
    class FakeEventSource {
      listeners = new Map<string, (event: MessageEvent) => void>()
      constructor(public url: string) {}
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener)
      }
      close() {}
      emit(type: string, payload: unknown) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent)
      }
    }

    const originalEventSource = (globalThis as any).EventSource
    ;(globalThis as any).EventSource = FakeEventSource
    const queue = useJobs()
    queue.startPolling('job-project')
    try {
      const mounted = mountStatus('job-project', 'EP_JOB', ['script-only'])
      await flush()
      assert.equal(fetchCalls[0],
        '/api/projects/job-project/episodes/EP_JOB/status?invalidate=1')
      fetchCalls = []

      queue.applyUpdate({
        job_id: 'completed-script-job',
        project_slug: 'job-project',
        episode_id: 'EP_JOB',
        type: 'script-only',
        status: 'done',
      } as any)
      await nextTick()
      await flush()

      assert.deepEqual(fetchCalls, [
        '/api/projects/job-project/episodes/EP_JOB/status?invalidate=1',
      ])
      mounted.stop()
    } finally {
      queue.stopPolling()
      ;(globalThis as any).EventSource = originalEventSource
    }
  })
})
