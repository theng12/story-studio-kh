import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const jobs = readFileSync(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url), 'utf8')

test('a cancelled job shows no auto-retry badge', () => {
  assert.match(jobs, /if \(!retry\?\.eligible \|\| job\.status === 'cancelled'\) return ''/)
  assert.equal(jobs.match(/v-if="autoRetryLabel\(job\)"/g)?.length, 2)
  assert.doesNotMatch(jobs, /v-if="job\.auto_retry\?\.eligible"/)
})
