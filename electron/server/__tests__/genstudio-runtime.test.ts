import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
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

  test('stages every small batch below its published account ceiling', () => {
    assert.equal(resolveGenStudioLocalFanout(17, 128), 17)
  })

  test('unknown account capacity stays conservative instead of inventing a wide wave', () => {
    assert.equal(resolveGenStudioLocalFanout(500), 1)
  })
})

describe('GenStudio speech dispatch follows the selected model publication', () => {
  const noEnv: NodeJS.ProcessEnv = {}

  test('uses the selected model\'s positive published submit hint', () => {
    assert.equal(GENSTUDIO_TTS_DEFAULT_DISPATCH_LIMIT, 1)
    assert.equal(resolveGenStudioTtsFanout(10, 4, 128, noEnv), 4)
    assert.equal(resolveGenStudioTtsFanout(500, 70, 128, noEnv), 70)
  })

  test('uses the keyed account burst as a staging ceiling when the provider hint is absent', () => {
    assert.equal(resolveGenStudioTtsFanout(500, undefined, 128, noEnv), 128)
  })

  test('uses the tighter provider hint and account burst without treating either as remote authority', () => {
    assert.equal(resolveGenStudioTtsFanout(500, 16, 8, noEnv), 8)
    assert.equal(resolveGenStudioTtsFanout(500, 8, 16, noEnv), 8)
  })

  test('switching selected models immediately changes TTS worker fanout', () => {
    const modelA = { provider_submit_concurrency: 2 }
    const modelB = { provider_submit_concurrency: 6 }
    assert.equal(resolveGenStudioTtsFanout(10, modelA.provider_submit_concurrency, 128, noEnv), 2)
    assert.equal(resolveGenStudioTtsFanout(10, modelB.provider_submit_concurrency, 128, noEnv), 6)
  })

  test('unknown or invalid published hints serialize rather than assuming unlimited capacity', () => {
    assert.equal(resolveGenStudioTtsFanout(10, undefined, undefined, noEnv), 1)
    assert.equal(resolveGenStudioTtsFanout(10, null, undefined, noEnv), 1)
    for (const invalid of [0, -3, 2.5, '4', 'lots', '']) {
      assert.equal(resolveGenStudioTtsFanout(10, invalid, undefined, noEnv), 1)
    }
  })

  test('never dispatches more workers than there is work', () => {
    assert.equal(resolveGenStudioTtsFanout(1, 50, 128, noEnv), 1)
    assert.equal(resolveGenStudioTtsFanout(0, 50, 128, noEnv), 1)
  })

  test('an operator override stays ahead of the selected model hint', () => {
    const env = { [GENSTUDIO_TTS_CONCURRENCY_ENV]: '4' }
    assert.equal(resolveGenStudioTtsFanout(10, 2, 128, env), 4)
    // An explicit local staging override is still bounded by the work, not a
    // hidden global 50-wide cap.
    assert.equal(resolveGenStudioTtsFanout(900, 2, 128, { [GENSTUDIO_TTS_CONCURRENCY_ENV]: '900' }), 900)
    // Junk is ignored rather than silently disabling the pacing.
    for (const value of ['0', '-3', 'lots', '']) {
      assert.equal(resolveGenStudioTtsFanout(10, 2, 128, { [GENSTUDIO_TTS_CONCURRENCY_ENV]: value }), 2)
    }
  })

  test('a fractional operator override falls through to the selected model hint', () => {
    for (const value of ['2.5', '50.9']) {
      assert.equal(resolveGenStudioTtsFanout(100, 7, 128, { [GENSTUDIO_TTS_CONCURRENCY_ENV]: value }), 7)
    }
  })
})
