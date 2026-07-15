import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_IMAGE_MODELS } from '../models/defaults.js'
import { resolveImageProviderParams } from '../models/image-provider-params.js'

describe('curated image model pricing and request tiers', () => {
  test('registers Nano Banana 2 Lite at four Kie credits', () => {
    const model = DEFAULT_IMAGE_MODELS['nano-banana-2-lite']
    assert.equal(model.credits_per_image, 4)
    assert.equal(model.api_model, 'nano-banana-2-lite')
    assert.equal(model.refs_field, 'image_urls')
    assert.equal(model.refs_upload, true)
  })

  test('maps Seedream 5 Pro resolution tiers to the provider quality field', () => {
    const model = DEFAULT_IMAGE_MODELS['seedream-5-pro']
    const basic = resolveImageProviderParams(model, '1k')
    const high = resolveImageProviderParams(model, '2k')

    assert.equal(model.tiers?.find(tier => tier.id === '1k')?.credits, 7)
    assert.equal(model.tiers?.find(tier => tier.id === '2k')?.credits, 14)
    assert.deepEqual(basic.input_params, {
      output_format: 'png',
      nsfw_checker: true,
      quality: 'basic',
    })
    assert.deepEqual(high.input_params, {
      output_format: 'png',
      nsfw_checker: true,
      quality: 'high',
    })
    assert.equal(high.api_model, 'seedream/5-pro-text-to-image')
    assert.equal(high.api_model_i2i, 'seedream/5-pro-image-to-image')
  })

  test('removes the static FLUX model outside the requested catalog scope', () => {
    assert.equal('imagestudio-flux2-klein-mlx-4bit' in DEFAULT_IMAGE_MODELS, false)
  })
})
