import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  LAUNCH_STAGGER_DEFAULT_MS,
  LAUNCH_STAGGER_MAX_MS,
  PERFORMANCE_CONCURRENCY_DEFAULT,
  resolveGenerationConcurrency,
  resolveGenerationLaunchStaggerMs,
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

describe('local fleet and cloud dispatch policy', () => {
  test('cloud work honours the configured concurrency and launch stagger', () => {
    assert.equal(resolveGenerationConcurrency(3, 'cloud', 10, 8), 3)
    assert.equal(resolveGenerationLaunchStaggerMs(1_200, 'cloud'), 1_200)
  })

  test('local Direct work ignores the cloud cap and uses every reachable Mac', () => {
    assert.equal(resolveGenerationConcurrency(3, 'local-direct', 10, 6), 6)
    assert.equal(resolveGenerationConcurrency(50, 'local-direct', 10, 1), 1)
    assert.equal(resolveGenerationLaunchStaggerMs(2_000, 'local-direct'), 0)
  })

  test('local Hub work follows live fleet capacity and starts without stagger', () => {
    assert.equal(resolveGenerationConcurrency(3, 'local-hub', 10, 6), 6)
    assert.equal(resolveGenerationConcurrency(1, 'local-hub', 4, 6), 4)
    assert.equal(resolveGenerationLaunchStaggerMs(2_000, 'local-hub'), 0)
  })
})
