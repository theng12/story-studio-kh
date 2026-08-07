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

describe('GenStudio speech dispatch is paced per voice provider', () => {
  const noEnv: NodeJS.ProcessEnv = {}

  test('an episode is fed to a cloud voice provider one request at a time', () => {
    // The failure this exists for: ten sections dispatched together, six
    // refused by the provider behind the product, every one of them fine on
    // its own afterwards.
    assert.equal(GENSTUDIO_TTS_DEFAULT_DISPATCH_LIMIT, 1)
    assert.equal(resolveGenStudioTtsFanout(10, 'fish-s21-paid', noEnv), 1)
    assert.equal(resolveGenStudioTtsFanout(10, 'elevenlabs-direct', noEnv), 1)
  })

  test('an unattributed model serialises rather than being assumed free', () => {
    // GenStudio publishes `provider_id` only for models that can speak a
    // cloned voice. Absent means "route unknown", and the cheap way to be
    // wrong about an unknown route is to be slow, not to lose six chapters.
    assert.equal(resolveGenStudioTtsFanout(10, '', noEnv), 1)
    assert.equal(resolveGenStudioTtsFanout(10, undefined, noEnv), 1)
    assert.equal(resolveGenStudioTtsFanout(10, null, noEnv), 1)
  })

  test('local fleet speech keeps the shared fan-out', () => {
    // No upstream account meter to exhaust, so a 500-section run is not paid
    // for in wall-clock time. This is the whole reason the limit is per
    // provider instead of one global serial switch.
    assert.equal(resolveGenStudioTtsFanout(500, 'studio-hub-local', noEnv), 50)
    assert.equal(resolveGenStudioTtsFanout(6, 'studio-hub-local', noEnv), 6)
  })

  test('never dispatches more workers than there is work', () => {
    assert.equal(resolveGenStudioTtsFanout(1, 'studio-hub-local', noEnv), 1)
    assert.equal(resolveGenStudioTtsFanout(0, 'fish-s21-paid', noEnv), 1)
  })

  test('an operator on a provider tier with headroom can raise the ceiling', () => {
    const env = { [GENSTUDIO_TTS_CONCURRENCY_ENV]: '4' }
    assert.equal(resolveGenStudioTtsFanout(10, 'fish-s21-paid', env), 4)
    // Still bounded by the staging cap and by the work actually present.
    assert.equal(resolveGenStudioTtsFanout(10, 'fish-s21-paid', { [GENSTUDIO_TTS_CONCURRENCY_ENV]: '900' }), 10)
    // Junk is ignored rather than silently disabling the pacing.
    for (const value of ['0', '-3', 'lots', '']) {
      assert.equal(resolveGenStudioTtsFanout(10, 'fish-s21-paid', { [GENSTUDIO_TTS_CONCURRENCY_ENV]: value }), 1)
    }
  })
})
