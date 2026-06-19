import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { poolMediaOf } from '../composables/useBrollPools.js'

describe('poolMediaOf', () => {
  test('treats legacy pools without a media field as video pools', () => {
    assert.equal(poolMediaOf({}), 'video')
  })

  test('preserves explicit image and video pool kinds', () => {
    assert.equal(poolMediaOf({ media: 'image' }), 'image')
    assert.equal(poolMediaOf({ media: 'video' }), 'video')
  })
})
