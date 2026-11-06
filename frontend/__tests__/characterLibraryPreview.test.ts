import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// 1.4.384: the Channel Characters page is a redirect adapter; the roster and
// its record editor live on the Character Sheet, so the recovery states are
// pinned where the editor now is.
const page = readFileSync(resolve(import.meta.dirname, '../components/CharacterRecordEditor.vue'), 'utf8')

test('channel character reference previews provide an actionable recovery state', () => {
  assert.match(page, /@error="markReferencePreviewFailed/)
  assert.match(page, /Preview unavailable/)
  assert.match(page, /Retry Preview/)
  assert.match(page, /function retryReferencePreview/)
  assert.match(page, /referencePreviewVersion/)
})
