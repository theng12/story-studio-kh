/**
 * v1.0.524 — classifyThumbnailError decides whether a failed thumbnails.set is
 * worth retrying. The "video still processing" race (transient 400/409) used to
 * be swallowed as a permanent skip; verified-permanent errors (403 not-verified,
 * 413 too-large, generic bad-image 400) must NOT retry.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { classifyThumbnailError } from '../lib/youtube-client.js'

describe('classifyThumbnailError', () => {
  test('transient statuses retry', () => {
    for (const s of [409, 429, 500, 502, 503]) {
      assert.equal(classifyThumbnailError(s, ''), 'retry', `status ${s}`)
    }
  })
  test('400 while the video is still processing retries', () => {
    assert.equal(classifyThumbnailError(400, 'The video is still being processed. Try again later.'), 'retry')
    assert.equal(classifyThumbnailError(400, 'resource not yet ready'), 'retry')
  })
  test('permanent statuses do not retry', () => {
    assert.equal(classifyThumbnailError(403, 'The channel is not verified.'), 'permanent')
    assert.equal(classifyThumbnailError(413, 'Media too large'), 'permanent')
    assert.equal(classifyThumbnailError(400, 'invalid image content'), 'permanent')
  })
})
