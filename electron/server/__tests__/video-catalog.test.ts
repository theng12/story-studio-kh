import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VIDEO_MODELS } from '../models/defaults.js'
import { sanitizeVideoCatalog } from '../models/video-catalog.js'

describe('image-to-video catalog policy', () => {
  test('seeds no executable direct-provider video defaults', () => {
    assert.deepEqual(DEFAULT_VIDEO_MODELS, {})
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
})
