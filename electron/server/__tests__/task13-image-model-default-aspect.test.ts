import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearGenStudioCatalogCache,
  describeGenStudioDetail,
  listImageModels,
} from '../lib/genstudio-client.js'
import {
  resolveConfiguredAspectRatio,
  resolvePublishedAspectRatio,
} from '../services/image-model-resolver.js'

/**
 * An absent catalogue default is not permission to choose a familiar frame.
 * Keep the public string contract, but carry absence as its empty value so
 * callers can require an explicit published/default choice.
 */
test('image catalogue preserves an absent or null aspect-ratio default without inventing 16:9', async () => {
  const originalFetch = globalThis.fetch
  clearGenStudioCatalogCache()
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/image\/models$/)
      return Response.json([
        { id: 'absent-default', display_name: 'Absent default', aspect_ratios: ['4:3'] },
        { id: 'null-default', display_name: 'Null default', aspect_ratios: ['9:16'], default_aspect_ratio: null },
        { id: 'published-default', display_name: 'Published default', aspect_ratios: ['3:2'], default_aspect_ratio: '3:2' },
      ])
    }

    const models = await listImageModels('task13-image-default-aspect')
    assert.deepEqual(models.map(model => [model.id, model.default_aspect_ratio]), [
      ['absent-default', ''],
      ['null-default', ''],
      ['published-default', '3:2'],
    ])
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
})

test('a declared default the model does not publish is refused, never swapped for another frame', () => {
  const model = {
    id: 'square-only', display_name: 'Square Only', default_aspect_ratio: '16:9',
    aspect_ratios: ['16:9', '1:1'],
    output_options: [{ resolution: '1K', aspect_ratio: '1:1', is_default: true }],
  }
  assert.throws(
    () => resolvePublishedAspectRatio(model as any, undefined),
    /Square Only publishes no 16:9 output\. Choose another model or ratio\./,
  )
  assert.throws(
    () => resolveConfiguredAspectRatio({
      label: 'Square Only', api_model: 'square-only', endpoint: '', poll: '', type: 'jobs',
      provider: 'genstudio-image', default_aspect_ratio: '16:9', aspect_ratios: ['16:9', '1:1'],
      output_options: model.output_options,
    } as any, undefined),
    /Square Only publishes no 16:9 output\. Choose another model or ratio\./,
  )

  // The declared default wins when it IS published, and Story's 16:9 preference
  // still applies when both 16:9 and a different declared default are published.
  assert.equal(resolvePublishedAspectRatio({
    ...model, default_aspect_ratio: '1:1', output_options: [{ resolution: '1K', aspect_ratio: '1:1', is_default: true }],
  } as any, undefined), '1:1')
  assert.equal(resolvePublishedAspectRatio({
    ...model, default_aspect_ratio: '1:1',
    output_options: [
      { resolution: '1K', aspect_ratio: '1:1', is_default: true },
      { resolution: '1K', aspect_ratio: '16:9', is_default: false },
    ],
  } as any, undefined), '16:9')

  // An explicit unpublished ratio keeps its existing refusal.
  assert.throws(
    () => resolvePublishedAspectRatio(model as any, '9:16'),
    /does not support 9:16/,
  )
})

test('a Gateway dispatch refusal names the code and every published candidate reason', () => {
  const detail = describeGenStudioDetail({
    detail: {
      code: 'DISPATCH_NO_ELIGIBLE_MACHINE',
      detail: 'No machine able to run this model is available right now.',
      candidates: [
        { machine: 'studio-hub-9f2c1a77', reason: 'MODEL_NOT_PACKAGED' },
        { machine: 'studio-hub-ab12cd34', reason: 'INSUFFICIENT_MEMORY: needs 16 GB, this one has 8 GB' },
        {
          machine: 'studio-hub-ab12cd34',
          reason: 'model files missing at /Users/owner/Library/Models/secret.bin (api_key=sk-live-1234567890)',
        },
      ],
    },
  }, 503)
  assert.match(detail, /DISPATCH_NO_ELIGIBLE_MACHINE/)
  assert.match(detail, /MODEL_NOT_PACKAGED/)
  assert.match(detail, /needs 16 GB/)
  assert.match(detail, /a local path/)
  assert.doesNotMatch(detail, /studio-hub-/)
  assert.doesNotMatch(detail, /\/Users\//)
  assert.doesNotMatch(detail, /sk-live/)
})

