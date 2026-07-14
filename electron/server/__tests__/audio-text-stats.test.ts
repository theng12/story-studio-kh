import assert from 'node:assert/strict'
import test from 'node:test'
import { narrationTextStats } from '../services/audio-reconciler.js'

test('narration text stats count words and billing characters after trimming', () => {
  assert.deepEqual(narrationTextStats('  Once upon a quiet night.  '), {
    wordCount: 5,
    characterCount: 24,
  })
})

test('narration text stats handle multiline and empty sections', () => {
  assert.deepEqual(narrationTextStats('First line.\nSecond\tline.'), {
    wordCount: 4,
    characterCount: 24,
  })
  assert.deepEqual(narrationTextStats('   \n\t  '), {
    wordCount: 0,
    characterCount: 0,
  })
})
