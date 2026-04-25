/**
 * Tests for the unified model projection helpers.
 *
 * Round-trip guarantee: `fromUnified(toUnified(catalogs))` must reproduce
 * the input catalogs for the default catalog shipped in `defaults.ts`,
 * so generators keying off the legacy dicts continue to see what they saw
 * before the refactor.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toUnified, fromUnified } from '../models/unified.js'
import {
  DEFAULT_IMAGE_MODELS,
  DEFAULT_AUDIO_MODELS,
  DEFAULT_VIDEO_MODELS,
} from '../models/defaults.js'
import type { UnifiedModel } from '../models/types.js'

describe('toUnified', () => {
  test('lifts every image/audio/video default into a UnifiedModel', () => {
    const list = toUnified({
      image_models: DEFAULT_IMAGE_MODELS,
      audio_models: DEFAULT_AUDIO_MODELS,
      video_models: DEFAULT_VIDEO_MODELS,
    })
    const imgCount = Object.keys(DEFAULT_IMAGE_MODELS).length
    const audCount = Object.keys(DEFAULT_AUDIO_MODELS).length
    const vidCount = Object.keys(DEFAULT_VIDEO_MODELS).length
    assert.equal(list.length, imgCount + audCount + vidCount)
  })

  test('defaults image provider to "kie" when unset', () => {
    const list = toUnified({
      image_models: { foo: { label: 'F', credits_per_image: 1, endpoint: '/x', poll: '/y', type: 'jobs', api_model: 'z' } },
    })
    assert.equal(list[0].provider, 'kie')
  })

  test('preserves explicit image provider when set', () => {
    const list = toUnified({
      image_models: { foo: { label: 'F', credits_per_image: 1, endpoint: '/x', poll: '/y', type: 'jobs', api_model: 'z', provider: 'replicate' } as any },
    })
    assert.equal(list[0].provider, 'replicate')
  })

  test('falls back to audio prefix inference when provider field is missing', () => {
    const list = toUnified({
      audio_models: {
        'eleven_legacy':   { label: 'L1', cost_per_1k_chars: 0.1 } as any,
        'genaipro-legacy': { label: 'L2', cost_per_1k_chars: 0.1 } as any,
        'other-legacy':    { label: 'L3', cost_per_1k_chars: 0.1 } as any,
      },
    })
    const byId = Object.fromEntries(list.map(m => [m.id, m]))
    assert.equal(byId['eleven_legacy'].provider, 'elevenlabs')
    assert.equal(byId['genaipro-legacy'].provider, 'genaipro')
    assert.equal(byId['other-legacy'].provider, 'fal')
  })

  test('appends custom models that do not collide with legacy dict ids', () => {
    const customs: UnifiedModel[] = [
      { id: 'user-made', provider: 'kie', type: 'image', label: 'User', params: { credits_per_image: 1 } },
    ]
    const list = toUnified({ image_models: DEFAULT_IMAGE_MODELS }, { customs })
    const custom = list.find(m => m.id === 'user-made')
    assert.ok(custom)
    assert.equal(custom!.is_custom, true)
  })

  test('does not duplicate a custom entry that already lives in the legacy dict', () => {
    const id = Object.keys(DEFAULT_IMAGE_MODELS)[0]
    const customs: UnifiedModel[] = [
      { id, provider: 'kie', type: 'image', label: 'Dup', params: {} },
    ]
    const list = toUnified({ image_models: DEFAULT_IMAGE_MODELS }, { customs })
    const matches = list.filter(m => m.id === id)
    assert.equal(matches.length, 1)
  })
})

describe('fromUnified', () => {
  test('round-trips the default catalog losslessly', () => {
    const unified = toUnified({
      image_models: DEFAULT_IMAGE_MODELS,
      audio_models: DEFAULT_AUDIO_MODELS,
      video_models: DEFAULT_VIDEO_MODELS,
    })
    const split = fromUnified(unified)

    // Image: provider tags added; compare structurally.
    for (const [id, expected] of Object.entries(DEFAULT_IMAGE_MODELS)) {
      const actual = split.image_models[id]
      assert.ok(actual, `image model ${id} missing after round-trip`)
      assert.equal(actual.label, expected.label)
      assert.equal(actual.credits_per_image, expected.credits_per_image)
      assert.equal(actual.api_model, expected.api_model)
      assert.equal(actual.provider, expected.provider ?? 'kie')
    }

    for (const [id, expected] of Object.entries(DEFAULT_AUDIO_MODELS)) {
      const actual = split.audio_models[id]
      assert.ok(actual, `audio model ${id} missing after round-trip`)
      assert.equal(actual.label, expected.label)
      assert.equal(actual.cost_per_1k_chars, expected.cost_per_1k_chars)
    }

    for (const [id, expected] of Object.entries(DEFAULT_VIDEO_MODELS)) {
      const actual = split.video_models[id]
      assert.ok(actual, `video model ${id} missing after round-trip`)
      assert.equal(actual.label, expected.label)
      assert.equal(actual.credits_per_video, expected.credits_per_video)
      assert.equal(actual.provider, expected.provider)
    }
  })

  test('ignores "text" unified entries (no legacy dict for them yet)', () => {
    const split = fromUnified([
      { id: 'gpt-x', provider: 'openai', type: 'text', label: 'GPT X', params: {} },
    ])
    assert.equal(Object.keys(split.image_models).length, 0)
    assert.equal(Object.keys(split.audio_models).length, 0)
    assert.equal(Object.keys(split.video_models).length, 0)
  })

  test('is_custom round-trips through fromUnified → toUnified', () => {
    const split = fromUnified([
      { id: 'custom-img', provider: 'kie', type: 'image', label: 'Custom', is_custom: true,
        params: { credits_per_image: 3, endpoint: '/x', poll: '/y', type: 'jobs', api_model: 'foo' } },
      { id: 'custom-aud', provider: 'fal', type: 'audio', label: 'Custom TTS', is_custom: true,
        params: { cost_per_1k_chars: 0.05 } },
      { id: 'custom-vid', provider: 'fal-video', type: 'video', label: 'Custom Video', is_custom: true,
        params: { credits_per_video: 10, modes: ['text'] } },
    ])
    assert.equal(split.image_models['custom-img'].is_custom, true)
    assert.equal(split.audio_models['custom-aud'].is_custom, true)
    assert.equal(split.video_models['custom-vid'].is_custom, true)

    const back = toUnified(split)
    const byId = Object.fromEntries(back.map(m => [m.id, m]))
    assert.equal(byId['custom-img']?.is_custom, true)
    assert.equal(byId['custom-aud']?.is_custom, true)
    assert.equal(byId['custom-vid']?.is_custom, true)
  })

  test('built-in defaults round-trip WITHOUT spuriously acquiring is_custom', () => {
    const unified = toUnified({ image_models: DEFAULT_IMAGE_MODELS })
    for (const m of unified) {
      assert.notEqual(m.is_custom, true, `built-in model ${m.id} should not be flagged custom`)
    }
  })
})
