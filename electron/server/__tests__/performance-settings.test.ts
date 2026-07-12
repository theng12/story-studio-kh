import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  LAUNCH_STAGGER_DEFAULT_MS,
  LAUNCH_STAGGER_MAX_MS,
  PERFORMANCE_CONCURRENCY_DEFAULT,
  resolveLaunchStaggerMs,
  resolvePerformanceConcurrency,
} from '../lib/performance-settings.js'

describe('performance setting defaults', () => {
  test('all unset concurrency values start at three', () => {
    assert.equal(resolvePerformanceConcurrency(undefined), PERFORMANCE_CONCURRENCY_DEFAULT)
    assert.equal(resolvePerformanceConcurrency(null), PERFORMANCE_CONCURRENCY_DEFAULT)
    assert.equal(PERFORMANCE_CONCURRENCY_DEFAULT, 3)
  })

  test('stagger defaults to two seconds but preserves an explicit zero', () => {
    assert.equal(resolveLaunchStaggerMs(undefined), LAUNCH_STAGGER_DEFAULT_MS)
    assert.equal(LAUNCH_STAGGER_DEFAULT_MS, 2_000)
    assert.equal(resolveLaunchStaggerMs(0), 0)
  })

  test('stagger is capped at twenty seconds', () => {
    assert.equal(resolveLaunchStaggerMs(99_000), LAUNCH_STAGGER_MAX_MS)
    assert.equal(LAUNCH_STAGGER_MAX_MS, 20_000)
  })
})
