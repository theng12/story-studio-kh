import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_AUDIO_MODELS } from '../models/defaults.js'

test('GenStudio owns TTS pricing and Story Studio ships no provider price catalog', () => {
  assert.deepEqual(DEFAULT_AUDIO_MODELS, {})
})
