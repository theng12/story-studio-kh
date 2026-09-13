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
