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
const contracts = readFileSync(
  fileURLToPath(new URL('../../electron/server/contracts/index.ts', import.meta.url)),
  'utf8',
)

test('Jobs renders all server-provided job controls and dispatches each exact action', () => {
  assert.match(jobs, /job\.control/)
  assert.match(jobs, /job\.controls/)
  assert.match(jobs, /v-for="control in jobControls\(job\)"/)
  assert.match(jobs, /control\.reason/)
  assert.match(jobs, /control\.action === 'cancel-before-submit'/)
  assert.match(jobs, /control\.action === 'stop-local'/)
  assert.match(jobs, /control\.action === 'request-remote-cancel'/)
  assert.match(jobs, /await post\(`\$\{jobQueuePath\(job\)\}\/cancel`, \{\}\)/)
  assert.match(jobs, /control\.action === 'clear-history'/)
  assert.match(jobs, /await del\(jobQueuePath\(job\)\)/)
  assert.match(jobs, /:disabled="!control\.enabled \|\| controlBusy\.has\(job\.job_id\)"/)
  assert.doesNotMatch(jobs, /COST_INCURRING_TYPES/)
  assert.doesNotMatch(jobs, /REMOTE_CANCELLABLE_TYPES/)
})

test('Jobs reports whole-batch completed, settling, cancelled, failed, and not-submitted counts', () => {
  assert.match(jobs, /item_progress\.settling/)
  assert.match(jobs, /item_progress\.cancelled/)
  assert.match(jobs, /item_progress\.not_submitted/)
  assert.match(jobs, /cancelled by customer/i)
})

test('GenStudio batch ledger keeps customer cancellations neutral instead of failed', () => {
  const ledger = readFileSync(
    fileURLToPath(new URL('../components/GenStudioBatchLedger.vue', import.meta.url)),
    'utf8',
  )
  assert.match(ledger, /cancelledCount/)
  assert.match(ledger, /return 'cancelled'/)
  assert.match(ledger, /class="cancelled"/)
})

test('Jobs keeps a requested cancellation active and explains reconciliation', () => {
  assert.match(jobs, /control\.label/)
  assert.match(jobs, /Story Studio is reconciling/)
  assert.match(jobs, /files or billing records/i)
})

test('Jobs contracts carry all six remote operations and published cancellation settlement without invented release copy', () => {
  assert.match(contracts, /'chat\.response' \| 'music\.generation'/)
  assert.match(contracts, /dispatch_state\?: 'pre_dispatch' \| 'dispatched'/)
  assert.match(contracts, /remote_cancellations\?: Record<string, JobRemoteCancellationResponse>/)
  assert.match(jobs, /const released = remote\.released_credits[\s\S]*?accountJob\?\.released_credits/)
  assert.doesNotMatch(jobs, /reservation released/i)
  assert.doesNotMatch(jobs, /post-dispatch Video|Video best effort/i)
})

test('Jobs retries Motion work through the durable queue without reposting legacy params', () => {
  assert.match(
    jobs,
    /job\.type === 'expand_chapters' \|\| job\.type === 'scene_clip_generate' \|\| job\.type === 'scene_clips_batch'/,
  )
  assert.match(
    jobs,
    /await post\(`\$\{jobQueuePath\(job\)\}\/retry`, \{\}\)/,
  )
  const retry = jobs.match(/async function retryJob\(job: RJob\) \{([\s\S]*?)\n\}/)?.[1] || ''
  const motionBranch = retry.match(/if \(job\.type === 'expand_chapters'[\s\S]*?\n  \}/)?.[0] || ''
  assert.doesNotMatch(motionBranch, /await del\(jobQueuePath\(job\)\)/)
})

test('Jobs renders GenStudio standard lanes with optional live burst and tier facts', () => {
  assert.match(jobs, /paid_active_jobs }} active \/ {{ genStudioAdmission\.paid_concurrency_limit }} standard lanes/)
  assert.match(jobs, /genStudioAdmission\.burst_concurrency_ceiling &&\s*genStudioAdmission\.paid_active_jobs > genStudioAdmission\.paid_concurrency_limit/)
  assert.match(jobs, /Temporary boost/)
  assert.match(jobs, /genStudioAdmission\.service_tier\.current\.display_name/)
  assert.match(jobs, /genStudioAdmission\.service_tier\?\.next_tier &&\s*genStudioAdmission\.service_tier\.cents_to_next_tier !== null/)
  assert.match(jobs, /formatGenStudioCents\(genStudioAdmission\.service_tier\.cents_to_next_tier\)/)
  assert.match(jobs, /next_tier\.paid_concurrency_limit/)
  assert.match(jobs, /next_tier\.generation_submissions_per_minute/)
})

test('Jobs makes temporary capacity best effort and directs upgrades to GenStudio', () => {
  assert.match(jobs, /Temporary boost[\s\S]*?best effort, not guaranteed/i)
  assert.match(jobs, /Purchase more standard capacity in GenStudio/i)
  assert.match(jobs, /\.capacity-boost \{[\s\S]*?white-space: normal;[\s\S]*?overflow-wrap: anywhere;/)
})

test('Remote uses the same server controls and bulk-manages only safe actions', () => {
  assert.match(remote, /control\.label/)
  assert.match(remote, /control\.reason/)
  assert.match(remote, /v-for="control in jobControls\(job\)"/)
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
  assert.match(remote, /const outcomes = await Promise\.all\(snapshot\.map\(job => runJobControl\(job, bulkControl\(job\)\)\)\)/)
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
