/**
 * Regression coverage for the "don't guess a vendor" fix to
 * `resolveAudioProvider` (frontend/composables/useModelGroups.ts).
 *
 * The function used to fall through to a hardcoded `'fal'` guess for any id
 * it didn't recognize — mislabeling the model picker's optgroup with a
 * specific vendor that may have nothing to do with the actual model. It now
 * groups unrecognized ids under a neutral 'unknown' ("Other") bucket
 * instead of guessing.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { PROVIDER_DISPLAY, resolveAudioProvider } from '../composables/useModelGroups.js'

describe('resolveAudioProvider — no vendor guessing for unrecognized ids', () => {
  test('an id with no explicit provider and no recognized legacy prefix groups as unknown, not fal', () => {
    assert.equal(resolveAudioProvider('turbo-v2.5', {}), 'unknown')
    assert.equal(resolveAudioProvider('some-brand-new-engine-id', {}), 'unknown')
  })

  test('the unknown bucket has a neutral display label, not a vendor name', () => {
    assert.equal(PROVIDER_DISPLAY.unknown, 'Other')
  })

  test('recognized legacy prefixes and explicit provider fields are unaffected', () => {
    assert.equal(resolveAudioProvider('eleven_v2', {}), 'elevenlabs')
    assert.equal(resolveAudioProvider('genaipro-multiling-v2', {}), 'genaipro')
    assert.equal(resolveAudioProvider('voicestudio-kokoro', {}), 'voicestudio')
    assert.equal(resolveAudioProvider('genstudio-tts-regular', {}), 'genstudio')
    assert.equal(resolveAudioProvider('macos-samantha', {}), 'macos')
    assert.equal(resolveAudioProvider('fishaudio-s2.1-pro', {}), 'fishaudio')
    assert.equal(resolveAudioProvider('turbo-v2.5', { provider: 'fal' }), 'fal')
  })
})
