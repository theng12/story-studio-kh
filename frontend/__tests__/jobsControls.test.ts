import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const jobs = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)
const remote = readFileSync(
  fileURLToPath(new URL('../pages/remote.vue', import.meta.url)),
  'utf8',
)

test('Jobs renders only the server-provided job control and dispatches its exact action', () => {
  assert.match(jobs, /job\.control/)
  assert.match(jobs, /control\.reason/)
  assert.match(jobs, /control\.action === 'cancel-before-submit'/)
  assert.match(jobs, /control\.action === 'stop-local'/)
  assert.match(jobs, /control\.action === 'request-remote-cancel'/)
  assert.match(jobs, /await post\(`\$\{jobQueuePath\(job\)\}\/cancel`, \{\}\)/)
  assert.match(jobs, /control\.action === 'clear-history'/)
  assert.match(jobs, /await del\(jobQueuePath\(job\)\)/)
  assert.match(jobs, /:disabled="!job\.control\.enabled \|\| controlBusy\.has\(job\.job_id\)"/)
  assert.doesNotMatch(jobs, /COST_INCURRING_TYPES/)
  assert.doesNotMatch(jobs, /REMOTE_CANCELLABLE_TYPES/)
})

test('Jobs keeps a requested cancellation active and explains reconciliation', () => {
  assert.match(jobs, /job\.control\.label/)
  assert.match(jobs, /Story Studio is reconciling/)
  assert.match(jobs, /files or billing records/i)
})

test('Remote uses the same server controls and bulk-manages only safe actions', () => {
  assert.match(remote, /job\.control\.label/)
  assert.match(remote, /job\.control\.reason/)
  assert.match(remote, /bulkControlJobs/)
  assert.match(remote, /cancel-before-submit.*stop-local.*request-remote-cancel/s)
  assert.match(remote, /await post\(`\$\{jobQueuePath\(job\)\}\/cancel`, \{\}\)/)
  assert.match(remote, /Requested safe action for/)
  assert.match(remote, /left \$\{unchanged\} unchanged/)
  assert.doesNotMatch(remote, />Stop all</)
  assert.doesNotMatch(remote, />Stop</)
})

test('Remote includes paused jobs and counts failed bulk requests as unchanged', () => {
  assert.match(remote, /j\.status === 'paused'/)
  assert.match(remote, /const outcomes = await Promise\.all\(snapshot\.map\(job => runJobControl\(job\)\)\)/)
  assert.match(remote, /const requested = outcomes\.filter\(Boolean\)\.length/)
  assert.match(remote, /const total = activeJobs\.value\.length/)
  assert.match(remote, /const unchanged = total - requested/)
  assert.match(remote, /left \$\{unchanged\} unchanged/)
  assert.match(remote, /\.rm-stopall \{ height: 44px;/)
})

test('Remote keeps job details readable beside touch controls on narrow screens', () => {
  assert.match(remote, /@media \(max-width: 420px\)[\s\S]*\.rm-job \{ flex-wrap: wrap;/)
  assert.match(remote, /@media \(max-width: 420px\)[\s\S]*\.rm-job-main \{ flex: 1 0 100%; \}/)
  assert.match(remote, /\.rm-job-btn \{ height: 44px;/)
})
