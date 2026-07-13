import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VIDEO_MODELS } from '../models/defaults.js'
import { sanitizeUnifiedVideoModels, sanitizeVideoCatalog } from '../models/video-catalog.js'

describe('image-to-video catalog policy', () => {
  test('ships only image-to-video defaults without retired models', () => {
    assert.ok(Object.keys(DEFAULT_VIDEO_MODELS).length > 0)
    for (const [id, model] of Object.entries(DEFAULT_VIDEO_MODELS)) {
      assert.deepEqual(model.modes, ['frames'], `${id} must be image-to-video only`)
      const searchable = `${id} ${model.label} ${JSON.stringify((model as any).provider_params || {})}`
      assert.doesNotMatch(searchable, /sora[-_ ]?2|runway[^a-z0-9]*gen[-_ ]?3|text-to-video/i)
    }
  })

  test('drops text-only and retired saved entries and normalizes mixed entries', () => {
    const clean = sanitizeVideoCatalog({
      textOnly: { label: 'Text only', provider: 'fal-video', credits_per_video: 1, modes: ['text'] } as any,
      mixed: { label: 'Mixed', provider: 'fal-video', credits_per_video: 2, modes: ['text', 'frames'] } as any,
      sora: { label: 'Sora 2 Image-to-Video', provider: 'fal-video', credits_per_video: 3, modes: ['frames'] } as any,
      runway: { label: 'Runway Gen-3', provider: 'kie-video', credits_per_video: 4, modes: ['frames'] } as any,
    })
    assert.deepEqual(Object.keys(clean), ['mixed'])
    assert.deepEqual(clean.mixed.modes, ['frames'])
  })

  test('applies the same policy to unified custom models', () => {
    const clean = sanitizeUnifiedVideoModels([
      { id: 'image', type: 'image', provider: 'kie', label: 'Image', params: {} },
      { id: 't2v', type: 'video', provider: 'kie-video', label: 'T2V', params: { modes: ['text'] } },
      { id: 'i2v', type: 'video', provider: 'kie-video', label: 'I2V', params: { modes: ['text', 'frames'] } },
    ])
    assert.deepEqual(clean.map(model => model.id), ['image', 'i2v'])
    assert.deepEqual(clean[1].params.modes, ['frames'])
  })
})
