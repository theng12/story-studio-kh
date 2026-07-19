import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const page = readFileSync(resolve(import.meta.dirname, '../pages/character-library.vue'), 'utf8')

test('channel character reference previews provide an actionable recovery state', () => {
  assert.match(page, /@error="markReferencePreviewFailed/)
  assert.match(page, /Preview unavailable/)
  assert.match(page, /Retry preview/)
  assert.match(page, /function retryReferencePreview/)
  assert.match(page, /referencePreviewVersion/)
})
