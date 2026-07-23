import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  GENSTUDIO_LOCAL_ADMISSION_MAX,
  resolveGenStudioLocalFanout,
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
