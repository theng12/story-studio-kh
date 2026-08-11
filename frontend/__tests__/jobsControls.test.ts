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
  assert.match(remote, /left \$\{skipped\} unchanged/)
  assert.doesNotMatch(remote, />Stop all</)
  assert.doesNotMatch(remote, />Stop</)
})
