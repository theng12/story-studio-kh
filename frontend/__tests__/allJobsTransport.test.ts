import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useAllJobs } from '../composables/useAllJobs.js'

class Stream {
  static last: Stream
  listeners: Record<string, Function> = {}
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) { Stream.last = this }
  addEventListener(type: string, fn: Function) { this.listeners[type] = fn }
  fire(type: string, payload: unknown) { this.listeners[type]?.({ data: JSON.stringify(payload) }) }
  close() { this.closed = true }
}
const snapshot = (id: string) => ({ jobs: [{ job_id: id, project_slug: 'alpha', status: 'queued' }], stats: { running: 0, queued: 1, paused: 0, done: 0, error: 0, total: 1 } })

test('All Jobs ignores late frames from a closed subscription', () => {
  ;(globalThis as any).EventSource = Stream
  const queue = useAllJobs()
  queue.start()
  const old = Stream.last
  queue.stop()
  queue.start()
  const current = Stream.last
  current.fire('snapshot', snapshot('current'))
  old.fire('snapshot', snapshot('stale'))
  old.fire('cleared', { job_ids: ['current'] })
  assert.deepEqual(queue.jobs.value.map(job => job.job_id), ['current'])
  assert.equal(current.closed, false)
  queue.stop()
})

test('All Jobs reconciles confirmed changes with a delayed initial snapshot', () => {
  ;(globalThis as any).EventSource = Stream
  const queue = useAllJobs()
  queue.start()
  try {
    const stream = Stream.last
    assert.equal(queue.isLoading.value, true)
    queue.applyUpdate({ ...snapshot('confirmed').jobs[0], status: 'cancelled' })
    stream.fire('snapshot', {
      jobs: [
        snapshot('confirmed').jobs[0],
        snapshot('unrelated').jobs[0],
      ],
      stats: { running: 0, queued: 2, paused: 0, done: 0, error: 0, total: 2 },
    })

    assert.deepEqual(queue.jobs.value.find(job => job.job_id === 'confirmed')?.status, 'cancelled')
    assert.ok(queue.jobs.value.some(job => job.job_id === 'unrelated'))
    assert.equal(queue.isLoading.value, false)
  } finally { queue.stop() }
})

test('All Jobs does not resurrect a confirmed deletion from its initial snapshot', () => {
  ;(globalThis as any).EventSource = Stream
  const queue = useAllJobs()
  queue.start()
  queue.removeJobs(['remove-me'])
  Stream.last.fire('snapshot', {
    jobs: [
      snapshot('remove-me').jobs[0],
      snapshot('keep-me').jobs[0],
    ],
    stats: { running: 0, queued: 2, paused: 0, done: 0, error: 0, total: 2 },
  })

  assert.deepEqual(queue.jobs.value.map(job => job.job_id), ['keep-me'])
  assert.equal(queue.stats.value.total, 1)
  queue.stop()
})

test('All Jobs accepts a reconnect snapshot after an update', () => {
  ;(globalThis as any).EventSource = Stream
  const queue = useAllJobs()
  queue.start()
  try {
    const stream = Stream.last
    stream.fire('snapshot', snapshot('before-reconnect'))
    queue.applyUpdate({ ...snapshot('before-reconnect').jobs[0], status: 'cancelled' })
    stream.fire('snapshot', snapshot('after-reconnect'))

    assert.deepEqual(queue.jobs.value.map(job => job.job_id), ['after-reconnect'])
  } finally { queue.stop() }
})

test('All Jobs finishes initial loading when the server reports a snapshot error', () => {
  ;(globalThis as any).EventSource = Stream
  const queue = useAllJobs()
  queue.start()
  try {
    Stream.last.fire('snapshot-error', { detail: 'Could not load All Jobs. Reconnecting…' })
    assert.equal(queue.isLoading.value, false)
    assert.match(queue.lastRefreshError.value, /Could not load All Jobs/)
  } finally { queue.stop() }
})

test('All Jobs keeps a snapshot-error warning through buffered updates until a full snapshot succeeds', () => {
  ;(globalThis as any).EventSource = Stream
  const queue = useAllJobs()
  queue.start()
  try {
    Stream.last.fire('snapshot-error', { detail: 'Could not load All Jobs. Reconnecting…' })
    Stream.last.fire('update', { ...snapshot('buffered').jobs[0], status: 'running' })

    assert.equal(queue.jobs.value.find(job => job.job_id === 'buffered')?.status, 'running')
    assert.match(queue.lastRefreshError.value, /Could not load All Jobs/)

    Stream.last.fire('snapshot', snapshot('recovered'))
    assert.equal(queue.lastRefreshError.value, '')
  } finally { queue.stop() }
})

test('All Jobs treats the first fallback GET as the initial snapshot lifecycle', async () => {
  const originalEventSource = (globalThis as any).EventSource
  const originalFetch = (globalThis as any).$fetch
  let resolveFirst!: (value: ReturnType<typeof snapshot>) => void
  const first = new Promise<ReturnType<typeof snapshot>>(resolve => { resolveFirst = resolve })
  ;(globalThis as any).EventSource = undefined
  ;(globalThis as any).$fetch = () => first
  const queue = useAllJobs()
  queue.start()
  try {
    queue.applyUpdate({ ...snapshot('confirmed').jobs[0], status: 'cancelled' })
    resolveFirst({
      jobs: [snapshot('confirmed').jobs[0], snapshot('unrelated').jobs[0]],
      stats: { running: 0, queued: 2, paused: 0, done: 0, error: 0, total: 2 },
    })
    await first
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(queue.jobs.value.find(job => job.job_id === 'confirmed')?.status, 'cancelled')
    assert.ok(queue.jobs.value.some(job => job.job_id === 'unrelated'))
    queue.removeJobs(['unrelated'])
    ;(globalThis as any).$fetch = async () => snapshot('unrelated')
    await queue.refresh()

    assert.deepEqual(queue.jobs.value.map(job => job.job_id), ['unrelated'],
      'a later fallback GET is authoritative after the first one clears pending reconciliation state')
  } finally {
    queue.stop()
    ;(globalThis as any).EventSource = originalEventSource
    ;(globalThis as any).$fetch = originalFetch
  }
})

test('All Jobs reports repeated refresh failure and clears stale status on a good snapshot', async () => {
  ;(globalThis as any).EventSource = Stream
  ;(globalThis as any).$fetch = async () => { throw new Error('offline') }
  const queue = useAllJobs()
  queue.start()
  try {
    for (let n = 0; n < 3; n++) await queue.refresh()
    assert.equal(queue.jobsStale.value, true)
    assert.match(queue.lastRefreshError.value, /offline/)
    Stream.last.fire('snapshot', snapshot('restored'))
    assert.equal(queue.jobsStale.value, false)
  } finally { queue.stop() }
})


test('sidebar and All Jobs page share one live stream until both leave', () => {
  ;(globalThis as any).EventSource = Stream
  const sidebar = useAllJobs()
  const page = useAllJobs()
  sidebar.start()
  const stream = Stream.last
  page.start()
  try {
    assert.equal(Stream.last, stream, 'opening All Jobs must reuse the sidebar stream')
    stream.fire('snapshot', snapshot('alpha-active'))
    stream.fire('update', { job_id: 'beta-active', project_slug: 'beta', status: 'running' })
    assert.equal(sidebar.stats.value.running + sidebar.stats.value.queued, 2)
    assert.equal(page.stats.value, sidebar.stats.value)
    page.stop()
    assert.equal(stream.closed, false, 'leaving the page must keep the sidebar live')
    stream.fire('update', { ...snapshot('alpha-active').jobs[0], status: 'done' })
    stream.fire('update', { job_id: 'beta-active', project_slug: 'beta', status: 'done' })
    assert.equal(sidebar.stats.value.running + sidebar.stats.value.queued, 0)
  } finally {
    sidebar.stop()
    assert.equal(stream.closed, true)
  }
})

test('a job that fails in a project that is not open raises a failure toast with an Open job action', async () => {
  ;(globalThis as any).EventSource = Stream
  const { useToast } = await import('../composables/useToast.js')
  const queue = useAllJobs()
  queue.start()
  try {
    Stream.last.fire('snapshot', snapshot('far-away'))
    Stream.last.fire('update', { ...snapshot('far-away').jobs[0], status: 'error', type: 'scene_images', episode_id: 'EP0007' })
    const toast = useToast().toasts.value.find(t => t.message.includes('EP0007'))
    assert.ok(toast, 'failure surfaced')
    assert.equal(toast!.type, 'error')
    assert.equal(toast!.action?.label, 'Open job')
    // A job that was already failed is not announced again.
    const before = useToast().toasts.value.length
    Stream.last.fire('update', { ...snapshot('far-away').jobs[0], status: 'error', type: 'scene_images', episode_id: 'EP0007' })
    assert.equal(useToast().toasts.value.length, before)
  } finally { queue.stop() }
})

test('hidden window closes the all-jobs stream; back on screen it asks the history read for the window it missed', async () => {
  ;(globalThis as any).EventSource = Stream
  const originalFetch = (globalThis as any).$fetch
  const { useToast } = await import('../composables/useToast.js')
  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  // A live-only snapshot cannot carry a job that finished while the stream was
  // closed, so the catch-up is a history read for exactly the window we missed.
  const asked: string[] = []
  ;(globalThis as any).$fetch = async (url: string) => {
    asked.push(url)
    return {
      jobs: [
        { job_id: 'was-running', project_slug: 'gamma', status: 'error', episode_id: 'EP0101', type: 'audio', finished_at: new Date().toISOString() },
        { job_id: 'new-unseen', project_slug: 'gamma', status: 'error', episode_id: 'EP0102', type: 'audio', finished_at: new Date().toISOString() },
        { job_id: 'old-failure', project_slug: 'gamma', status: 'error', episode_id: 'EP0103', type: 'audio', finished_at: '2020-01-01T00:00:00Z' },
      ],
      total: 3,
    }
  }
  const queue = useAllJobs()
  queue.start()
  try {
    const first = Stream.last
    first.fire('snapshot', { jobs: [{ job_id: 'was-running', project_slug: 'gamma', status: 'running', episode_id: 'EP0101', type: 'audio' }], stats: { running: 1, queued: 0, paused: 0, done: 0, error: 0, total: 1 } })
    setVisibility('hidden')
    assert.equal(first.closed, true, 'no stream while hidden')
    setVisibility('visible')
    const second = Stream.last
    assert.notEqual(second, first, 'a fresh stream on return')
    second.fire('snapshot', { jobs: [], stats: { running: 0, queued: 0, paused: 0, done: 0, error: 0, total: 1 } })
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.ok(asked.some(url => url.includes('/jobs/all/history?') && url.includes('status=error') && url.includes('since=')),
      `the catch-up must ask the history read for the missed window: ${asked.join(', ')}`)
    const messages = useToast().toasts.value.map(t => t.message).join('\n')
    assert.match(messages, /EP0101/, 'a job that failed while away is announced')
    assert.match(messages, /EP0102/, 'a job that started and failed while away is announced')
    assert.doesNotMatch(messages, /EP0103/, 'an old failure is not re-announced')
  } finally {
    queue.stop()
    ;(globalThis as any).$fetch = originalFetch
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  }
})

test('the All Jobs REST fallback polls the live view, not the fleet\'s whole finished history (S5)', async () => {
  const originalEventSource = (globalThis as any).EventSource
  const originalFetch = (globalThis as any).$fetch
  const urls: string[] = []
  ;(globalThis as any).EventSource = undefined
  ;(globalThis as any).$fetch = async (url: string) => { urls.push(url); return snapshot('live') }
  const queue = useAllJobs()
  try {
    queue.start()
    await queue.refresh()
    assert.ok(urls.length > 0 && urls.every(url => url.endsWith('/jobs/all?view=active')), urls.join(', '))
  } finally {
    queue.stop()
    ;(globalThis as any).EventSource = originalEventSource
    ;(globalThis as any).$fetch = originalFetch
  }
})

test('a finished job leaves the live list but still moves the badge', () => {
  ;(globalThis as any).EventSource = Stream
  const queue = useAllJobs()
  queue.start()
  try {
    Stream.last.fire('snapshot', snapshot('finishing'))
    assert.equal(queue.stats.value.queued, 1)
    assert.equal(queue.stats.value.done, 0)

    Stream.last.fire('update', { ...snapshot('finishing').jobs[0], status: 'done' })
    assert.deepEqual(queue.jobs.value.map(job => job.job_id), [],
      'a finished row is history, and history is not what the live stream carries')
    assert.equal(queue.stats.value.queued, 0)
    assert.equal(queue.stats.value.done, 1, 'the badge still counts the job that just finished')
    assert.equal(queue.stats.value.total, 1)
  } finally { queue.stop() }
})
