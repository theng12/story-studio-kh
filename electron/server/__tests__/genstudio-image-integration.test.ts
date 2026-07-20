import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveImageModelConfig } from '../services/image-model-resolver.js'
import { hashStylePreviewKey } from '../services/style-preview-cache.js'

test('live GenStudio image models resolve without being copied into project config', () => {
  const model = resolveImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1')

  assert.equal(model?.provider, 'genstudio-image')
  assert.equal(model?.api_model, 'genstudio-image-fast-v1')
  assert.equal(model?.supports_reference_images, false)
  assert.equal(model?.provider_params?.default_steps, 4)
})

test('style preview cache separates GenStudio steps and deterministic seeds', () => {
  const base = {
    styleTag: 'textured paper collage',
    modelId: 'genstudio-image-fast-v1',
    aspectRatio: '16:9',
    imageSteps: 4,
  }

  assert.notEqual(
    hashStylePreviewKey(base),
    hashStylePreviewKey({ ...base, imageSteps: 6 }),
  )
  assert.notEqual(
    hashStylePreviewKey({ ...base, seed: 12 }),
    hashStylePreviewKey({ ...base, seed: 13 }),
  )
})
