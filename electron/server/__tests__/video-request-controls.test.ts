import assert from 'node:assert/strict'
import test from 'node:test'
import { videoRequestControls, videoControlIdentity } from '../lib/video-request-controls.js'
import { buildGenStudioVideoIdempotencyKey } from '../lib/genstudio-client.js'
import { selectSceneClipNarrationVariant } from '../generators/scene-clip.js'

const published = [{ name: 'enhance', type: 'boolean' }, { name: 'stabilize', type: 'boolean' }]

test('extra video choices preserve false, reject unadvertised and protected fields', () => {
  assert.deepEqual(videoRequestControls(published, { enhance: false }), { enhance: false })
  assert.throws(() => videoRequestControls(published, { unknown: true }), /does not publish/)
  assert.throws(() => videoRequestControls(published, { enhance: 'false' }), /true or false/)
  assert.throws(() => videoRequestControls([{ name: 'model_id', type: 'boolean' }], { model_id: true }), /does not publish/)
  assert.throws(() => videoControlIdentity({ reference_asset_id: true }), /Unsupported/)
})

test('new count and extension control types require an update rather than silent defaults', () => {
  for (const name of ['num_videos', 'extension_seconds']) {
    assert.throws(() => videoRequestControls([{ name, type: 'integer' }], {}), /Update Story Studio/)
  }
})

test('extra choices are stable across property order and change purchase identity', () => {
  const request = { prompt: 'Slow motion', modelId: 'published-model', operation: 'image-to-video', durationSeconds: 8, resolution: '360p' }
  const key = (extraControls?: Record<string, boolean>) => buildGenStudioVideoIdempotencyKey({ ...request, extraControls })
  assert.equal(key({ enhance: false, stabilize: true }), key({ stabilize: true, enhance: false }))
  assert.notEqual(key({ enhance: false }), key({ enhance: true }))
  assert.notEqual(key(), key({ enhance: false }))
  assert.equal(key(), key({}))
})

test('narration uses the exact canvas and mode, caps with hold rather than a four-second fallback', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ operation: 'image-to-video', duration_seconds: i + 3, resolution: '360p', aspect_ratio: '9:16', credits_per_video: i + 3, minimum_credits: 1, price_version: 'fixture' }))
  rows.unshift({ ...rows[0]!, duration_seconds: 4, aspect_ratio: '16:9' })
  assert.equal(selectSceneClipNarrationVariant(rows, '360p', 4.2, '9:16').duration_seconds, 5)
  assert.equal(selectSceneClipNarrationVariant(rows, '360p', 14, '9:16').duration_seconds, 10)
  assert.throws(() => selectSceneClipNarrationVariant(rows, '360p', 4.2, '1:1'), /publishes no/)
  assert.throws(() => selectSceneClipNarrationVariant(rows, '360p', 4.2, '9:16', 'text-to-video'), /publishes no/)
})
