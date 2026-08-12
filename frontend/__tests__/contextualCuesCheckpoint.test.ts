import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/contextual-cues.vue', import.meta.url)),
  'utf8',
)

test('Contextual Cues exposes saved partial batches without presenting them as complete', () => {
  assert.match(page, /proposal_progress/)
  assert.match(page, /Saved partial proposal/)
  assert.match(page, /Retry resumes only the missing batches/)
  assert.match(page, /Video Assembly still treats this timeline as incomplete/)
  assert.match(page, /aria-label="Saved partial contextual cue preview"/)
  assert.match(page, /read-only until every batch finishes/)
})
