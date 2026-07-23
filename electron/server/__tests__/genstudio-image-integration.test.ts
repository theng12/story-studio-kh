import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('style previews use one GenStudio-only proof and no direct provider fallback', () => {
  const source = readFileSync(new URL('../routes/style-preview.ts', import.meta.url), 'utf8')

  assert.match(source, /'style-proof'/)
  assert.match(source, /listImageModels/)
  assert.match(source, /generateImageWithGenStudio/)
  assert.doesNotMatch(source, /resolveImageModelConfig/)
  assert.doesNotMatch(source, /resolveApiKeyForProvider/)
  assert.doesNotMatch(source, /registry\.getImageProvider/)
  assert.doesNotMatch(source, /landscape:|character:|interior:|action:|closeup:/)
})
