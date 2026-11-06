import assert from 'node:assert/strict'
import test from 'node:test'
import { checkPictureLength } from '../lib/final-duration-guard.js'

test('a full audio container cannot hide the reported short picture', () => {
  assert.deepEqual(checkPictureLength(2268.100, 2268.380), { state: 'short', shortBySec: 2268.380 - 2268.100 })
  assert.deepEqual(checkPictureLength(2268.280, 2268.380), { state: 'ok' })
  assert.deepEqual(checkPictureLength(2268.380, 2268.380), { state: 'ok' })
  assert.deepEqual(checkPictureLength(2269, 2268.380), { state: 'ok' })
})

test('missing picture evidence never proves completion', () => {
  for (const value of [undefined, null, NaN, Infinity, 0, -1]) {
    assert.deepEqual(checkPictureLength(value, 10), { state: 'unmeasurable' }, String(value))
  }
})

test('an unknown render target is not a verified picture length', () => {
  for (const value of [NaN, Infinity, 0, -1]) {
    assert.deepEqual(checkPictureLength(10, value), { state: 'unmeasurable' }, String(value))
  }
})
