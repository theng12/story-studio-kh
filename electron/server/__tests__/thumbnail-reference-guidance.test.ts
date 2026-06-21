import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  thumbnailReferenceGuidance,
  thumbnailReferenceStrengthValue,
} from '../generators/images.js'

describe('thumbnail reference adaptation', () => {
  test('strength values increase monotonically', () => {
    assert.ok(thumbnailReferenceStrengthValue('loose') < thumbnailReferenceStrengthValue('balanced'))
    assert.ok(thumbnailReferenceStrengthValue('balanced') < thumbnailReferenceStrengthValue('strong'))
  })

  test('every strength replaces source content and branding', () => {
    for (const strength of ['loose', 'balanced', 'strong'] as const) {
      const guidance = thumbnailReferenceGuidance(strength)
      assert.match(guidance, /replac|do not copy/i)
      assert.match(guidance, /text|words/i)
      assert.match(guidance, /branding/i)
      assert.match(guidance, /episode|prompt content/i)
    }
  })

  test('strong guidance preserves structure, not literal content', () => {
    const guidance = thumbnailReferenceGuidance('strong')
    assert.match(guidance, /structural layout/i)
    assert.match(guidance, /fully replacing/i)
  })
})
