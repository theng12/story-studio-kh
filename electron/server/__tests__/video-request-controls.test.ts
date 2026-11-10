import assert from 'node:assert/strict'
import test from 'node:test'
import { videoRequestControls, videoControlIdentity } from '../lib/video-request-controls.js'
import { buildGenStudioVideoIdempotencyKey } from '../lib/genstudio-client.js'
import { selectSceneClipNarrationVariant } from '../generators/scene-clip.js'
import { publishedVideoCapabilities, videoCapabilityRefusal } from '../contracts/video-capabilities.js'

const published = [{ name: 'enhance', type: 'boolean' }, { name: 'stabilize', type: 'boolean' }]

test('extra video choices preserve false, reject unadvertised and protected fields', () => {
  assert.deepEqual(videoRequestControls(published, { enhance: false }), { enhance: false })
  assert.throws(() => videoRequestControls(published, { unknown: true }), /does not publish/)
  assert.throws(() => videoRequestControls(published, { enhance: 'false' }), /true or false/)
  assert.throws(() => videoRequestControls([{ name: 'model_id', type: 'boolean' }], { model_id: true }), /does not publish/)
  for (const name of ['reference_asset_id', 'reference_asset_ids', 'end_image_asset_id', 'output_count', 'n', 'duration']) {
    assert.throws(() => videoControlIdentity({ [name]: true }), /Unsupported/)
    assert.throws(() => videoRequestControls([{ name, type: 'boolean' }], { [name]: true }), /does not publish/)
  }
})

test('capability metadata preserves each exact browser bound, empty resolutions and unknown prices', () => {
  for (const seconds of [4, 8, 3, 10]) {
    const row = {
      duration_seconds: { min: seconds, max: seconds, step: 1, default: seconds },
      resolutions: [], output_counts: [1], support_status: 'bounded',
      support_reason: 'Verified copied model bounds only.', resolution_status: 'update_required',
      pricing_status: 'unknown', supports_start_frame: false, supports_end_frame: false,
      supports_reference_images: true, max_reference_images: 1, reference_image_kinds: ['image'],
      capability_source: 'curated', capability_as_of: '2026-11-09',
    }
    assert.deepEqual(publishedVideoCapabilities(row), row)
    assert.equal(videoCapabilityRefusal(row), '')
    assert.equal('variants' in publishedVideoCapabilities(row), false)
  }
  const unknown = { duration_seconds: null, support_status: 'update_required', support_reason: 'Mapping missing. Update required.', output_counts: [], resolutions: [], activation_blockers: ['Mapping missing.'], availability: 'unavailable', capability_as_of: null }
  assert.deepEqual(publishedVideoCapabilities(unknown), unknown)
  assert.equal(videoCapabilityRefusal(unknown), unknown.support_reason)
})

test('malformed metadata supplies no guessed bounds and count rules stay optional for other providers', () => {
  assert.deepEqual(publishedVideoCapabilities({}), {})
  for (const duration of [null, 4, { min: true, max: 10, step: 1 }, { min: 10, max: 3, step: 1 }, { min: 3, max: 10, step: 0 }]) {
    assert.equal(publishedVideoCapabilities({ duration_seconds: duration }).duration_seconds, null)
  }
  assert.deepEqual(publishedVideoCapabilities({ duration_seconds: { min: 3, max: 9, step: 2, default: 4, auto: true } }).duration_seconds, { min: 3, max: 9, step: 2, auto: true })
  assert.equal(videoCapabilityRefusal({}), '')
  assert.equal(videoCapabilityRefusal({ output_counts: [] }), '')
  assert.equal(videoCapabilityRefusal({ output_counts: [1, 2] }), '')
  assert.match(videoCapabilityRefusal({ output_counts: [2] }), /one clip per scene/)
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
