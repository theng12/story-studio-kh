/**
 * Tests for provider registry: registration, lookup, supportsModel(), error handling.
 * Mocks HTTP calls — we do NOT make real API requests.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

let registry: typeof import('../providers/registry.js')['registry']

before(async () => {
  // Import registry and all providers (self-register on import)
  registry = (await import('../providers/registry.js')).registry
  await import('../providers/image/kie.js')
  await import('../providers/image/fal-image.js')
  await import('../providers/image/openai-image.js')
  await import('../providers/audio/fal.js')
  await import('../providers/text/openai.js')
  await import('../providers/text/deepseek.js')
  await import('../providers/text/openrouter.js')
  await import('../providers/text/lmstudio.js')
})

describe('Registry registration', () => {
  test('has kie image provider registered', () => {
    const p = registry.getImageProvider('kie')
    assert.ok(p, 'kie image provider should be registered')
    assert.equal(p?.meta.id, 'kie')
    assert.equal(p?.meta.apiKeyField, 'kie_api_key')
  })

  test('has fal audio provider registered', () => {
    const p = registry.getAudioProvider('fal')
    assert.ok(p, 'fal audio provider should be registered')
    assert.equal(p?.meta.id, 'fal')
    assert.equal(p?.meta.apiKeyField, 'fal_api_key')
  })

  test('has openai text provider registered (kie text removed in v1.0.248)', () => {
    assert.ok(registry.getTextProvider('openai'))
    assert.equal(registry.getTextProvider('kie'), undefined, 'kie text provider should no longer be registered')
  })

  test('has openai-image (OpenAI direct) image provider registered', () => {
    const p = registry.getImageProvider('openai-image')
    assert.ok(p, 'openai-image provider should be registered')
    assert.equal(p?.meta.id, 'openai-image')
    assert.equal(p?.meta.apiKeyField, 'openai_api_key')
  })

  test('has fal-image image provider registered', () => {
    const p = registry.getImageProvider('fal-image')
    assert.ok(p, 'fal-image provider should be registered')
    assert.equal(p?.meta.id, 'fal-image')
    assert.equal(p?.meta.providerId, 'fal')
  })

  test('listImageProviders / listAudioProviders / listTextProviders', () => {
    const img = registry.listImageProviders()
    const audio = registry.listAudioProviders()
    const text = registry.listTextProviders()
    assert.ok(img.length >= 1)
    assert.ok(audio.length >= 1)
    assert.ok(text.length >= 3, `expected >=3 text providers, got ${text.length}`)
  })
})

describe('Text provider supportsModel()', () => {
  test('openai claims gpt-* and o1* models', () => {
    const p = registry.getTextProvider('openai')!
    assert.equal(p.supportsModel('gpt-4o'), true)
    assert.equal(p.supportsModel('gpt-4o-mini'), true)
    assert.equal(p.supportsModel('o1-mini'), true)
    assert.equal(p.supportsModel('claude-opus-4-6'), false)
    // …but NOT the kie-routed GPT ids.
    assert.equal(p.supportsModel('gpt-5-2-kie'), false)
  })

  test('lmstudio claims only lmstudio: prefixed ids — no cloud cross-claim', () => {
    const lm = registry.getTextProvider('lmstudio')!
    assert.ok(lm, 'lmstudio text provider should be registered')
    assert.equal(lm.meta.apiKeyField, 'lmstudio_base_url')
    assert.equal(lm.supportsModel('lmstudio:google/gemma-3-4b-it'), true)
    assert.equal(lm.supportsModel('lmstudio:gpt-oss-20b'), true)
    // Must NOT claim bare cloud ids.
    assert.equal(lm.supportsModel('gpt-4o'), false)
    assert.equal(lm.supportsModel('deepseek-v4-flash'), false)
    // The prefix exists precisely so OpenAI doesn't steal a local gpt-* model.
    const openai = registry.getTextProvider('openai')!
    assert.equal(openai.supportsModel('lmstudio:gpt-oss-20b'), false)
    // Routing resolves a local id to the lmstudio provider.
    assert.equal(registry.findTextProviderForModel('lmstudio:gpt-oss-20b')?.meta.id, 'lmstudio')
  })

  test('lmstudio throws a helpful error when no URL is configured', async () => {
    const lm = registry.getTextProvider('lmstudio')!
    await assert.rejects(
      lm.callText({ model: 'lmstudio:gemma', system: 's', userMessage: 'u', apiKey: '' }),
      /LM Studio URL/i,
    )
  })

  test('deepseek + openrouter claim their exact ids only (no cross-claim)', () => {
    const ds = registry.getTextProvider('deepseek')!
    const or = registry.getTextProvider('openrouter')!
    assert.equal(ds.supportsModel('deepseek-v4-flash'), true)
    assert.equal(ds.supportsModel('deepseek-v4-pro'), true)
    // deepseek provider must NOT steal the OpenRouter-routed id.
    assert.equal(ds.supportsModel('deepseek-v4-flash-openrouter'), false)
    assert.equal(or.supportsModel('deepseek-v4-flash-openrouter'), true)
    assert.equal(or.supportsModel('deepseek-v4-flash'), false)
  })
})

describe('findTextProviderForModel dispatch', () => {
  test('routes gpt-* to openai', () => {
    const p = registry.findTextProviderForModel('gpt-4o-mini')
    assert.equal(p?.meta.id, 'openai')
  })

  test('routes official DeepSeek + OpenRouter ids to their providers', () => {
    assert.equal(registry.findTextProviderForModel('deepseek-v4-flash')?.meta.id, 'deepseek')
    assert.equal(registry.findTextProviderForModel('deepseek-v4-flash-openrouter')?.meta.id, 'openrouter')
  })

  test('returns undefined for unknown / retired / removed-kie model', () => {
    assert.equal(registry.findTextProviderForModel('unknown-model-xyz-123'), undefined)
    // Direct Anthropic + kie DeepSeek were retired, and kie text was removed in
    // v1.0.248 — no provider claims any of them (callAi remaps via
    // LEGACY_MODEL_ALIASES before dispatch).
    assert.equal(registry.findTextProviderForModel('claude-opus-4-6'), undefined)
    assert.equal(registry.findTextProviderForModel('deepseek-v3-kie'), undefined)
    assert.equal(registry.findTextProviderForModel('claude-opus-4-8-kie'), undefined)
    assert.equal(registry.findTextProviderForModel('gpt-5-2-kie'), undefined)
    assert.equal(registry.findTextProviderForModel('gemini-2.5-flash-kie'), undefined)
  })
})

describe('Image provider (kie)', () => {
  test('supportsModel returns true for any model with endpoint config', () => {
    const p = registry.getImageProvider('kie')!
    assert.equal(p.supportsModel('grok-imagine', { endpoint: '/jobs/createTask' }), true)
    // Without endpoint param, supportsModel should return false
    assert.equal(p.supportsModel('anything', {}), false)
  })

  test('generateImage throws without API key', async () => {
    const p = registry.getImageProvider('kie')!
    await assert.rejects(() =>
      p.generateImage({
        prompt: 'a cat', apiKey: '', aspectRatio: '16:9',
        modelId: 'grok-imagine',
        providerParams: { endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'jobs', api_model: 'grok' },
      }),
      /No kie\.ai API key configured/i,
    )
  })
})

describe('Audio provider (fal)', () => {
  test('generateAudio throws without API key', async () => {
    const p = registry.getAudioProvider('fal')!
    await assert.rejects(() =>
      p.generateAudio({
        text: 'hello world',
        apiKey: '',
        modelId: 'turbo-v2.5',
      }),
      /No fal\.ai API key configured/i,
    )
  })
})

describe('Text providers error handling', () => {
  test('deepseek throws without API key', async () => {
    const p = registry.getTextProvider('deepseek')!
    await assert.rejects(() =>
      p.callText({ model: 'deepseek-v4-flash', system: 's', userMessage: 'u', apiKey: '' }),
      /No DeepSeek API key configured/i,
    )
  })

  test('openrouter throws without API key', async () => {
    const p = registry.getTextProvider('openrouter')!
    await assert.rejects(() =>
      p.callText({ model: 'deepseek-v4-flash-openrouter', system: 's', userMessage: 'u', apiKey: '' }),
      /No OpenRouter API key configured/i,
    )
  })

  test('openai throws without API key', async () => {
    const p = registry.getTextProvider('openai')!
    await assert.rejects(() =>
      p.callText({ model: 'gpt-4o-mini', system: 's', userMessage: 'u', apiKey: '' }),
      /No OpenAI API key configured/i,
    )
  })
})
