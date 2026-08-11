import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  GENSTUDIO_LOCAL_ADMISSION_MAX,
  GENSTUDIO_TTS_CONCURRENCY_ENV,
  GENSTUDIO_TTS_DEFAULT_DISPATCH_LIMIT,
  resolveGenStudioLocalFanout,
  resolveGenStudioTtsFanout,
} from '../lib/genstudio-runtime.js'

describe('GenStudio local admission staging', () => {
  test('uses one worker for empty or invalid item counts', () => {
    assert.equal(resolveGenStudioLocalFanout(0), 1)
    assert.equal(resolveGenStudioLocalFanout(undefined), 1)
  })

  test('stages every small batch without inventing an account limit', () => {
    assert.equal(resolveGenStudioLocalFanout(17), 17)
  })

  test('caps local staging while GenStudio remains authoritative', () => {
    assert.equal(GENSTUDIO_LOCAL_ADMISSION_MAX, 50)
    assert.equal(resolveGenStudioLocalFanout(500), 50)
  })
})

describe('GenStudio speech dispatch follows the selected model publication', () => {
  const noEnv: NodeJS.ProcessEnv = {}

  test('uses the selected model\'s positive published submit hint', () => {
    assert.equal(GENSTUDIO_TTS_DEFAULT_DISPATCH_LIMIT, 1)
    assert.equal(resolveGenStudioTtsFanout(10, 4, noEnv), 4)
    assert.equal(resolveGenStudioTtsFanout(500, 70, noEnv), GENSTUDIO_LOCAL_ADMISSION_MAX)
  })

  test('unknown or invalid published hints serialize rather than assuming unlimited capacity', () => {
    assert.equal(resolveGenStudioTtsFanout(10, undefined, noEnv), 1)
    assert.equal(resolveGenStudioTtsFanout(10, null, noEnv), 1)
    for (const invalid of [0, -3, 2.5, '4', 'lots', '']) {
      assert.equal(resolveGenStudioTtsFanout(10, invalid, noEnv), 1)
    }
  })

  test('never dispatches more workers than there is work', () => {
    assert.equal(resolveGenStudioTtsFanout(1, 50, noEnv), 1)
    assert.equal(resolveGenStudioTtsFanout(0, 50, noEnv), 1)
  })

  test('an operator override stays ahead of the selected model hint', () => {
    const env = { [GENSTUDIO_TTS_CONCURRENCY_ENV]: '4' }
    assert.equal(resolveGenStudioTtsFanout(10, 2, env), 4)
    // Still bounded by the staging cap and by the work actually present.
    assert.equal(resolveGenStudioTtsFanout(10, 2, { [GENSTUDIO_TTS_CONCURRENCY_ENV]: '900' }), 10)
    // Junk is ignored rather than silently disabling the pacing.
    for (const value of ['0', '-3', 'lots', '']) {
      assert.equal(resolveGenStudioTtsFanout(10, 2, { [GENSTUDIO_TTS_CONCURRENCY_ENV]: value }), 2)
    }
  })
})
