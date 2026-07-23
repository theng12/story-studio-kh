import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_IMAGE_MODELS } from '../models/defaults.js'

test('GenStudio owns image inventory and pricing', () => {
  assert.deepEqual(DEFAULT_IMAGE_MODELS, {})
})
