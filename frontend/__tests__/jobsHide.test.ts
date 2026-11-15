import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const jobs = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)

test('the Jobs page has one hidden state: the server\'s hidden_at', () => {
  assert.match(jobs, /function isJobHidden\(job: RJob\): boolean \{ return Boolean\(job\.hidden_at\) \}/)
  assert.match(jobs, /await post\(`\$\{jobQueuePath\(job\)\}\/hide`, \{\}\)/)
  assert.match(jobs, /await post\(`\$\{jobQueuePath\(job\)\}\/unhide`, \{\}\)/)
  assert.doesNotMatch(jobs, /HIDDEN_JOBS_KEY|hiddenJobIds|story-studio:hidden-jobs/)
})

test('the Hidden filter reads the hidden history instead of a display status', () => {
  // Neither "hidden" nor "superseded" is a display status: both are separate
  // record sets the server owns, so the view filter must pass "all" for both.
  assert.match(jobs, /status: statusFilter\.value === 'hidden' \|\| statusFilter\.value === 'superseded' \? 'all' : statusFilter\.value/)
  assert.match(jobs, /hiddenHistory\.load\('\/jobs\/all\/history', \{ \.\.\.query, hidden: '1' \}\)/)
  assert.match(jobs, /hiddenHistory\.load\(`\/projects\/\$\{slug\.value\}\/jobs\/history`, \{ hidden: '1' \}\)/)
})
