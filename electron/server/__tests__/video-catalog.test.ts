import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VIDEO_MODELS } from '../models/defaults.js'
import { sanitizeVideoCatalog } from '../models/video-catalog.js'

describe('image-to-video catalog policy', () => {
  test('seeds no executable direct-provider video defaults', () => {
    assert.deepEqual(DEFAULT_VIDEO_MODELS, {})
  })

  test('drops text-only and unavailable saved entries and normalizes mixed entries', () => {
    const clean = sanitizeVideoCatalog({
      textOnly: { label: 'Text only', provider: 'fal-video', credits_per_video: 1, modes: ['text'], available: true } as any,
      mixed: { label: 'Mixed', provider: 'fal-video', credits_per_video: 2, modes: ['text', 'frames'], available: true } as any,
      unavailable: { label: 'Unavailable', provider: 'fal-video', credits_per_video: 3, modes: ['frames'], available: false } as any,
      legacy: { label: 'Legacy, never published available', provider: 'kie-video', credits_per_video: 4, modes: ['frames'] } as any,
    })
    assert.deepEqual(Object.keys(clean), ['mixed'])
    assert.deepEqual(clean.mixed.modes, ['frames'])
  })

  test('retires every legacy saved entry by contract, never by matching a name', () => {
    // A retired model is a legacy saved entry that never published
    // `available`, so it drops — the same way any other unpublished entry
    // does. Nothing here inspects a label.
    const retired = sanitizeVideoCatalog({
      legacyOne: { label: 'A Retired Video Model', provider: 'fal-video', credits_per_video: 3, modes: ['frames'] } as any,
      legacyTwo: { label: 'Another Retired Video Model', provider: 'kie-video', credits_per_video: 4, modes: ['frames'] } as any,
    })
    assert.deepEqual(Object.keys(retired), [])

    // And the mechanism is availability, not the name: a model whose label
    // still contains a retired name survives when it publishes availability,
    // while an innocuously-named entry that does not, does not. A substring
    // test over a display string could produce neither result.
    const byContract = sanitizeVideoCatalog({
      'renamed-live': { label: 'Legacy Name Successor', provider: 'genstudio', credits_per_video: 5, modes: ['frames'], available: true } as any,
      'plain-name': { label: 'Perfectly Ordinary Model', provider: 'genstudio', credits_per_video: 6, modes: ['frames'], available: false } as any,
    })
    assert.deepEqual(Object.keys(byContract), ['renamed-live'])
  })
})
