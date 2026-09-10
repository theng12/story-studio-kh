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
