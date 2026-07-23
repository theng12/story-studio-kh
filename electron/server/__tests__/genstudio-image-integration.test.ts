import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveImageModelConfig } from '../services/image-model-resolver.js'
import { hashStylePreviewKey } from '../services/style-preview-cache.js'
import { registry } from '../providers/registry.js'
import '../providers/image/genstudio.js'

test('live GenStudio image models resolve without being copied into project config', () => {
  const model = resolveImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1')

  assert.equal(model?.provider, 'genstudio-image')
  assert.equal(model?.api_model, 'genstudio-image-fast-v1')
  assert.equal(model?.supports_reference_images, false)
  assert.equal(model?.provider_params?.default_steps, 4)
})

test('GenStudio image adapter always submits the live model default instead of a saved step value', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/image/models')) {
        return Response.json([{
          id: 'genstudio-image-studio-v1',
          display_name: 'GPT Image 2',
          available: true,
          qualification_only: false,
          aspect_ratios: ['16:9'],
          default_aspect_ratio: '16:9',
          default_steps: 1,
          min_steps: 1,
          max_steps: 1,
        }])
      }
      if (url.endsWith('/v1/account/overview')) {
        return Response.json({
          credit_balance: 100,
          credits_used_30d: 0,
          subscription_plan_name: 'Test',
          paid_concurrency_limit: 3,
          paid_active_jobs: 0,
          paid_queued_jobs: 0,
          max_queued_jobs: 25,
          generation_submissions_per_minute: 30,
          relaxed_concurrency_limit: 0,
        })
      }
      if (url.endsWith('/v1/images/generations')) {
        const body = JSON.parse(String(init?.body || '{}'))
        assert.equal(body.steps, 1)
        return Response.json({
          id: 'automatic-image-steps', state: 'succeeded', model_id: body.model_id,
          prompt: body.prompt, width: 1024, height: 576, aspect_ratio: '16:9',
          steps: body.steps, image_url: '/v1/images/automatic-image-steps/file',
        }, { status: 202 })
      }
      if (url.endsWith('/v1/images/automatic-image-steps/file')) {
        return new Response(Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
          'base64',
        ), { headers: { 'Content-Type': 'image/png' } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    const provider = registry.getImageProvider('genstudio-image')
    assert.ok(provider)
    await provider.generateImage({
      prompt: 'A clear moonlit temple above a calm river.',
      apiKey: 'automatic-steps-test-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-studio-v1',
      providerParams: { provider: 'genstudio-image' },
      steps: 4,
      idempotencyIdentity: 'automatic-steps-test',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
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
