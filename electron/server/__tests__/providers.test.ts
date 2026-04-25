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
  await import('../providers/audio/fal.js')
  await import('../providers/text/anthropic.js')
  await import('../providers/text/openai.js')
  await import('../providers/text/kie-text.js')
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

  test('has anthropic, openai, kie text providers registered', () => {
    assert.ok(registry.getTextProvider('anthropic'))
    assert.ok(registry.getTextProvider('openai'))
    assert.ok(registry.getTextProvider('kie'))
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
  test('anthropic claims claude-* models', () => {
    const p = registry.getTextProvider('anthropic')!
    assert.equal(p.supportsModel('claude-opus-4-6'), true)
    assert.equal(p.supportsModel('claude-sonnet-4-6'), true)
    assert.equal(p.supportsModel('claude-anything'), true)
    assert.equal(p.supportsModel('gpt-4o'), false)
  })

  test('openai claims gpt-* and o1* models', () => {
    const p = registry.getTextProvider('openai')!
    assert.equal(p.supportsModel('gpt-4o'), true)
    assert.equal(p.supportsModel('gpt-4o-mini'), true)
    assert.equal(p.supportsModel('o1-mini'), true)
    assert.equal(p.supportsModel('claude-opus-4-6'), false)
  })

  test('kie text claims -kie suffixed models', () => {
    const p = registry.getTextProvider('kie')!
    assert.equal(p.supportsModel('deepseek-v3-kie'), true)
    assert.equal(p.supportsModel('deepseek-r1-kie'), true)
    assert.equal(p.supportsModel('gpt-4o'), false)
  })
})

describe('findTextProviderForModel dispatch', () => {
  test('routes claude-* to anthropic', () => {
    const p = registry.findTextProviderForModel('claude-opus-4-6')
    assert.equal(p?.meta.id, 'anthropic')
  })

  test('routes gpt-* to openai', () => {
    const p = registry.findTextProviderForModel('gpt-4o-mini')
    assert.equal(p?.meta.id, 'openai')
  })

  test('routes *-kie to kie', () => {
    const p = registry.findTextProviderForModel('deepseek-v3-kie')
    assert.equal(p?.meta.id, 'kie')
  })

  test('returns undefined for unknown model', () => {
    const p = registry.findTextProviderForModel('unknown-model-xyz-123')
    assert.equal(p, undefined)
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
  test('anthropic throws without API key', async () => {
    const p = registry.getTextProvider('anthropic')!
    await assert.rejects(() =>
      p.callText({ model: 'claude-opus-4-6', system: 's', userMessage: 'u', apiKey: '' }),
      /No Anthropic API key configured/i,
    )
  })

  test('openai throws without API key', async () => {
    const p = registry.getTextProvider('openai')!
    await assert.rejects(() =>
      p.callText({ model: 'gpt-4o-mini', system: 's', userMessage: 'u', apiKey: '' }),
      /No OpenAI API key configured/i,
    )
  })

  test('kie text throws without API key', async () => {
    const p = registry.getTextProvider('kie')!
    await assert.rejects(() =>
      p.callText({ model: 'deepseek-v3-kie', system: 's', userMessage: 'u', apiKey: '' }),
      /No kie\.ai API key configured/i,
    )
  })
})
