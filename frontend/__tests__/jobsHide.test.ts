import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const jobs = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)

// Owner, 2026-11-18: "why have a hidden instead of just a clear and make it
// gone." Hide is gone from the page; Clear (recoverable) is the only removal.
test('Hide and Discard are gone from the Jobs page', () => {
  assert.doesNotMatch(jobs, /Hide From Jobs/)
  assert.doesNotMatch(jobs, /Hide Finished From List|Hide Failed From List/)
  assert.doesNotMatch(jobs, /Hidden filter|statusFilter === 'hidden'|key: 'hidden'/)
  assert.doesNotMatch(jobs, /\/hide|\/unhide/)
  assert.doesNotMatch(jobs, /Discard/)
  assert.doesNotMatch(jobs, /cannot be undone|for good|permanently/i)
  assert.match(jobs, /function canClearJob\(job: RJob\): boolean/)
  assert.match(jobs, /@click="clearJob\(job\)"/)
})
