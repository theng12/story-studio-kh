/**
 * useAppJobs: once the live stream is back, the fallback poll stops.
 *
 * After any SSE error it started a 4 s `setInterval` and only cleared it on unmount, so the B-Roll
 * Library page polled forever after a single hiccup. What this cannot catch: the poll's own cadence.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { __appJobsTransportForTests as transport } from '../composables/useAppJobs.js'

class Stream {
  static last: Stream
  listeners: Record<string, Function> = {}
  onerror: (() => void) | null = null
  constructor(public url: string) { Stream.last = this }
  addEventListener(type: string, fn: Function) { this.listeners[type] = fn }
  fire(type: string, payload: unknown) { this.listeners[type]?.({ data: JSON.stringify(payload) }) }
  close() {}
}

test('an SSE error starts the fallback poll and the next snapshot ends it', () => {
  ;(globalThis as any).EventSource = Stream
  ;(globalThis as any).$fetch = async () => ({ jobs: [], stats: null })
  transport.start()
  try {
    assert.equal(transport.pollActive(), false)
    Stream.last.onerror?.()
    assert.equal(transport.pollActive(), true)
    Stream.last.fire('snapshot', { jobs: [], stats: { running: 0, queued: 0, done: 0, error: 0, total: 0 } })
    assert.equal(transport.pollActive(), false, 'the stream recovered, so the poll must stop')
  } finally {
    transport.stop()
  }
})
