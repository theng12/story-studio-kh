import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eventLoopLagFrom, readEventLoopLag, startEventLoopMonitor } from '../lib/event-loop-lag.js'

test('lag percentiles are reported in milliseconds, from the same shape the histogram gives', () => {
  assert.deepEqual(
    eventLoopLagFrom({ p50: 5_000_000, p90: 218_000_000, p99: 1_200_000_000, max: 2_900_000_000, count: 42 }),
    { p50_ms: 5, p90_ms: 218, p99_ms: 1200, max_ms: 2900, samples: 42 },
  )
})

test('the live histogram answers before anything is enabled, and after', () => {
  const idle = readEventLoopLag()
  assert.equal(typeof idle.p50_ms, 'number')
  assert.equal(typeof idle.samples, 'number')
  startEventLoopMonitor()
  const live = readEventLoopLag()
  assert.ok(Number.isFinite(live.max_ms))
  assert.ok(live.samples >= 0)
})
