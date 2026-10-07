import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  customerSafeJobText,
  filterJobsForView,
  isVerifiedLiveCapacity,
  jobRequestIds,
  primaryControl,
  secondaryControls,
} from '../utils/job-presentation.js'

const jobs = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)
const statusBadge = readFileSync(
  fileURLToPath(new URL('../components/StatusBadge.vue', import.meta.url)),
  'utf8',
)
const useJobsSource = readFileSync(
  fileURLToPath(new URL('../composables/useJobs.ts', import.meta.url)),
  'utf8',
)
const batchSignals = readFileSync(
  fileURLToPath(new URL('../composables/useBatchCompletionSignals.ts', import.meta.url)),
  'utf8',
)
const remote = readFileSync(
  fileURLToPath(new URL('../pages/remote.vue', import.meta.url)),
  'utf8',
)
const images = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/images.vue', import.meta.url)),
  'utf8',
)
const brollLibrary = readFileSync(
  fileURLToPath(new URL('../pages/broll-library.vue', import.meta.url)),
  'utf8',
)
const contracts = readFileSync(
  fileURLToPath(new URL('../../electron/server/contracts/index.ts', import.meta.url)),
  'utf8',
)

test('Jobs presents one primary control and keeps alternatives in an accessible disclosure', () => {
  assert.match(jobs, /job\.control/)
  assert.match(jobs, /job\.controls/)
  assert.match(jobs, /primaryJobControl\(job\)/)
  assert.match(jobs, /secondaryJobControls\(job\)/)
  assert.match(jobs, /<details[^>]*class="job-more-actions"/)
  assert.match(jobs, /<summary>More actions<\/summary>/)
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

test('terminal visual Scene Plan rows offer explicit paid prompt repair without hiding ordinary Retry', () => {
  assert.match(jobs, /function canOfferScenePromptAutoRepair/)
  assert.match(jobs, /job\.type !== 'scene_plan_run'/)
  assert.match(jobs, /const wasVisualPromptWork = job\.params\.stage === 'visual'/)
  assert.match(jobs, /job\.params\.regenerate_empty_prompts === true/)
  assert.match(jobs, /job\.params\.stage == null && Array\.isArray\(job\.params\.pipeline_chain\)/)
  assert.match(jobs, /job\.params\.model !== 'deterministic-timeline'/)
  assert.match(jobs, /job\.params\.stage !== 'motion'/)
  assert.match(jobs, /regenerate_empty_motion_prompts !== true/)
  assert.match(jobs, /class="btn btn-xs btn-primary prompt-auto-repair-btn"/)
  assert.match(jobs, />\{\{ controlBusy\.has\(job\.job_id\) \? 'Starting…' : 'Auto Repair Prompts · Credits' \}\}<\/button>/)
  assert.match(jobs, /GenStudio credits may be charged/)
  assert.match(jobs, /submits each missing or duplicated scene alone/i)
  assert.match(jobs, /Each scene is a separate Gateway request/)
  assert.match(jobs, /Pause stops new requests after any accepted request settles/)
  assert.match(jobs, /\.job-actions \{ margin-left: 0; width: 100%; justify-content: flex-start; \}/)
  assert.match(jobs, /:aria-label="`Auto repair missing prompts for \$\{job\.episode_id\}; GenStudio credits may be charged`"/)
  assert.match(jobs, /\/auto-repair-scene-prompts`[\s\S]*\{\},/)
  assert.match(jobs, /function canRetryJob\(job: RJob\): boolean/)
  assert.match(jobs, /if \(job\.params\?\.jobs_replace_failed_items\) return canRetryManualFailedItemExactly\(job\)/)
  assert.match(jobs, /const canReplaySavedChat = job\.type === 'outline_only' \|\| job\.type === 'expand_chapters'/)
  assert.equal((jobs.match(/v-if="canRetryJob\(job\)"/g) || []).length, 1)
  assert.match(jobs, /const failedJobsForRetryAll = computed[\s\S]*j\.params\?\.auto_repair_missing_prompts !== true/)
  const paidAction = jobs.indexOf('class="btn btn-xs btn-primary prompt-auto-repair-btn"')
  const ordinaryRetry = jobs.indexOf(':title="retryTooltip(job)"', paidAction)
  assert.ok(paidAction > -1 && ordinaryRetry > paidAction, 'ordinary Retry remains available after paid repair')
})

test('Jobs offers the server-authorized failed-item replacement with explicit checking, queued and blocked states', () => {
  assert.match(jobs, /function canReplaceFailedItems\(job: RJob\): boolean/)
  assert.match(jobs, /job\.type === 'audio'[\s\S]*entry\.operation === 'chat\.response'/)
  assert.match(jobs, /if \(job\.status !== 'error'\) return false/)
  assert.match(jobs, /@click="replaceFailedItems\(job\)"/)
  assert.match(jobs, /Replace Failed Items/)
  assert.match(jobs, /Checking failed items/)
  assert.match(jobs, /Replacement queued/)
  assert.match(jobs, /Replacement blocked/)
  assert.match(jobs, /local\?\.state === 'checking' \|\| \(local\?\.state === 'blocked' && job\.status !== 'done'\)/)
  assert.match(jobs, /local\?\.state === 'checking'[\s\S]*job\.status !== 'done'[\s\S]*job\.status !== 'error'/)
  assert.match(jobs, /if \(!job\.params\?\.jobs_replace_failed_items\) return null[\s\S]*?if \(job\.status === 'done'\) return \{ state: 'complete'/)
  assert.match(jobs, /function canRetryManualFailedItemExactly/)
  assert.match(jobs, /CLOUD_SUBMISSION_UNCERTAIN/)
  assert.match(jobs, /\/replace-failed-items`[\s\S]*\{\}/)
  assert.equal((jobs.match(/@click="replaceFailedItems\(job\)"/g) || []).length, 1)
})

test('History presents one safe primary control and hides alternatives under More actions', () => {
  const start = jobs.indexOf('<!-- History (done / error / cancelled)')
  const end = jobs.indexOf('</template>', start)
  assert.ok(start > -1 && end > start, 'History template must remain discoverable')
  const history = jobs.slice(start, end)
  assert.match(history, /primaryJobControl\(job\)/)
  assert.match(history, /secondaryJobControls\(job\)/)
  assert.match(history, /class="job-more-actions"/)
  assert.doesNotMatch(history, /v-for="control in jobControls\(job\)"/)
})

test('Jobs keeps all toolbar actions available, disabled when their scoped count is zero', () => {
  assert.match(jobs, /<section class="jobs-control-toolbar" aria-label="Job actions">/)
  assert.match(jobs, /\{\{ actionScopeLabel \}\} · all job types and statuses/)
  // Owner 2026-10-03: two main buttons, everything else under More actions.
  assert.match(jobs, /:disabled="checkAction\.disabled"[\s\S]{0,120}@click="checkOnRunningJobs\(\)"/)
  assert.match(jobs, /:disabled="redoAction\.disabled"[\s\S]{0,160}@click="retryAllFailed\(\)"/)
  // Owner rule 2026-10-03: More actions stay visible, never folded (the 2026-10-07 fold was reverted).
  assert.match(jobs, /<div class="jobs-more-actions" role="group" aria-label="Other job actions">/)
  assert.doesNotMatch(jobs, /<details class="jobs-more-actions"/)
  for (const action of ['recoverAllEpisodes', 'repairAllFailed', 'resumePausedJobs', 'clearFinished', 'clearFailed']) {
    assert.match(jobs, new RegExp(`:disabled="[^"\\n]+"[\\s\\S]{0,240}@click="${action}`))
  }
  assert.match(jobs, /:disabled="changingQueueState \|\| resumingQueue \|\| queueStateUnknown \|\| \(!queuePaused && !hasQueueWork\)"[\s\S]{0,520}@click="queuePaused \? resumeQueue\(\) : pauseQueue\(\)"/)
  assert.match(jobs, /recoverableEpisodes\.length === 0/)
  assert.match(jobs, /repairableFailedJobs\.length === 0/)
  assert.match(jobs, /redo: retryAllTriage\.value\.retry\.length/)
  assert.match(jobs, /pausedJobCount === 0/)
  assert.match(jobs, /finishedCount === 0/)
  assert.match(jobs, /failedCount === 0/)
})

test('toolbar scope uses only the selected project; hiding affects cards but never bulk actions', () => {
  assert.match(jobs, /const projectScopedJobs = computed\(\(\) => \{[\s\S]{0,240}job\.project_slug === projectFilter\.value/)
  assert.match(jobs, /const presentationScopedJobs = computed\(\(\) => showHidden\.value[\s\S]{0,180}projectScopedJobs\.value\.filter\(job => !isJobHidden\(job\)\)/)
  assert.match(jobs, /const typeScopedJobs = computed\(\(\) => activeFilter\.value === 'all'[\s\S]{0,160}presentationScopedJobs\.value\.filter\(job => job\.type === activeFilter\.value\)/)
  for (const name of ['repairableFailedJobs', 'failedJobsForRetryAll', 'recoverableEpisodes', 'pausedJobCount', 'removableJobs']) {
    assert.match(jobs, new RegExp(`const ${name}[\\s\\S]{0,360}projectScopedJobs\\.value`), `${name} must ignore type and status filters`)
  }
})

test('history cleanup uses distinct finished and failed requests while preserving files and billing evidence', () => {
  assert.match(jobs, /function clearFinished\(\) \{ return clearHistory\('finished'\) \}/)
  assert.match(jobs, /function clearFailed\(\) \{ return clearHistory\('failed'\) \}/)
  assert.match(jobs, /await del<\{ cleared: number \}>\(`\$\{endpoint\}\?status=\$\{status\}`\)/)
  assert.match(jobs, /Files and billing records are unchanged/)
})

test('toolbar history cleanup refreshes the visible authoritative scope instead of guessing cleared ids from a count', () => {
  assert.match(jobs, /info\(bulkActionMessage\.value\)[\s\S]*?void refreshVisibleJobs\(\)/)
})

test('Jobs reports whole-batch completed, settling, cancelled, failed, and not-submitted counts', () => {
  // v1.4.82 — these still all have to be reported; where they are reported
  // moved. The headline four (total / in-flight / finished / remaining) plus
  // queued and settling are the stat row in the DEFAULT card view; the raw
  // per-field breakdown, including the customer-cancelled wording, folded into
  // the Technical details drawer rather than being dropped.
  assert.match(jobs, /item_progress\.settling/)
  assert.match(jobs, /item_progress\.cancelled/)
  assert.match(jobs, /item_progress\.not_submitted/)
  assert.match(jobs, /cancelled by customer/i)
  for (const field of ['total', 'inFlight', 'finished', 'remaining', 'queued', 'settling', 'failed']) {
    assert.match(jobs, new RegExp(`jobCounts\\(job\\)\\.${field}`))
  }
  assert.ok((jobs.match(/needs another try/g) || []).length >= 2, 'active and history cards show failures')
  assert.ok((jobs.match(/left in this run/g) || []).length >= 2, 'remaining is the scheduling remainder')
  assert.doesNotMatch(jobs, /<span class="job-stat-label">remaining<\/span>/)
  assert.match(jobs, /\.job-stat\.is-failed strong \{ color: var\(--error\); \}/)
  assert.match(jobs, /summariseJobItems\(job\.item_progress, job\.genstudio_jobs\)/)
})

test('Gateway batch ledger keeps customer cancellations neutral instead of failed', () => {
  const ledger = readFileSync(
    fileURLToPath(new URL('../components/GenStudioBatchLedger.vue', import.meta.url)),
    'utf8',
  )
  assert.match(ledger, /cancelledCount/)
  assert.match(ledger, /return 'cancelled'/)
  assert.match(ledger, /class="cancelled"/)
})

test('Jobs keeps a requested cancellation active and explains it in plain words', () => {
  assert.match(jobs, /control\.label/)
  assert.match(jobs, /Story Studio is confirming the cancellation with the Gateway/)
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

test('Jobs explains the Gateway 1.2 waits and retries from provider-published fields', () => {
  for (const field of [
    'retry_after_seconds', 'retry_at', 'last_provider_progress_at',
    'stall_recovery_at', 'status_detail', 'failure_detail',
  ]) assert.match(contracts, new RegExp(`${field}\\?`))
  assert.match(jobs, /genStudioStatusDetail\(job\)/)
  assert.match(jobs, /remote\.status_detail/)
  assert.match(jobs, /remote\.failure_detail/)
  assert.match(jobs, /remote\.retry_at/)
  assert.match(jobs, /Retry in.*retry_after_seconds/)
  assert.match(jobs, /remote\.stall_recovery_at/)
})

test('Jobs retries every non-episode job through the durable queue without reposting legacy params', () => {
  assert.match(
    jobs,
    /const response = await post<\{ job\?: Job \}>\(`\$\{jobQueuePath\(job\)\}\/retry`, \{\}\)/,
  )
  const retryStart = jobs.indexOf('async function retryJob(')
  const retry = jobs.slice(retryStart, jobs.indexOf('async function autoRepairScenePrompts', retryStart))
  assert.doesNotMatch(retry, /await del\(jobQueuePath\(job\)\)/)
  assert.doesNotMatch(retry, /endpointMap|pipeline\/run-batch|\/generate\//)
  assert.match(retry, /isConfirmedRetryReplacement\(job, next\)/)
  const replacement = jobs.slice(jobs.indexOf('function isConfirmedRetryReplacement('), retryStart)
  assert.match(replacement, /job\.type === 'images' \? 'thumb_images' : job\.type/)
})

test('Jobs renders exact Gateway account facts only for a verified live snapshot', () => {
  assert.match(jobs, /verifiedGenStudioAdmission/)
  assert.match(jobs, /paid_active_jobs }} active \/ {{ genStudioAdmission\.paid_concurrency_limit }} standard lanes/)
  assert.match(jobs, /genStudioAdmission\.burst_concurrency_ceiling &&\s*genStudioAdmission\.paid_active_jobs > genStudioAdmission\.paid_concurrency_limit/)
  assert.match(jobs, /Temporary boost/)
  assert.match(jobs, /genStudioAdmission\.service_tier\.current\.display_name/)
  assert.match(jobs, /genStudioAdmission\.service_tier\?\.next_tier &&\s*genStudioAdmission\.service_tier\.cents_to_next_tier !== null/)
  assert.match(jobs, /formatGenStudioCents\(genStudioAdmission\.service_tier\.cents_to_next_tier\)/)
  assert.match(jobs, /next_tier\.paid_concurrency_limit/)
  assert.match(jobs, /next_tier\.generation_submissions_per_minute/)
  assert.match(jobs, /Account capacity is unverified/)
  assert.match(jobs, /scheduling conservatively/i)
})

test('the conservative capacity message wraps safely on narrow Jobs layouts', () => {
  assert.match(
    jobs,
    /\.genstudio-capacity-summary \.capacity-unverified\s*\{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/,
  )
})

test('Jobs makes temporary capacity best effort and directs upgrades to the Gateway', () => {
  assert.match(jobs, /Temporary boost[\s\S]*?best effort, not guaranteed/i)
  assert.match(jobs, /Purchase more standard capacity in GenStudio/i)
  assert.match(jobs, /\.capacity-boost \{[\s\S]*?white-space: normal;[\s\S]*?overflow-wrap: anywhere;/)
})

test('Remote uses the same distilled server controls and bulk-manages only safe actions', () => {
  assert.match(remote, /control\.label/)
  assert.match(remote, /control\.reason/)
  assert.match(remote, /primaryJobControl\(job\)/)
  assert.match(remote, /secondaryJobControls\(job\)/)
  assert.match(remote, /<details[^>]*class="rm-more-actions"/)
  assert.match(remote, /bulkControlJobs/)
  assert.match(remote, /cancel-before-submit.*stop-local.*request-remote-cancel/s)
  assert.match(remote, /await post\(`\$\{jobQueuePath\(job\)\}\/cancel`, \{\}\)/)
  assert.match(remote, /Requested safe action for/)
  assert.match(remote, /left \$\{unchanged\} unchanged/)
  assert.doesNotMatch(remote, />Stop all</)
  assert.doesNotMatch(remote, />Stop</)
})

test('Review failures applies the failed and active-batch scope, then focuses History', () => {
  assert.match(jobs, /statusFilter\.value = 'error'/)
  assert.match(jobs, /failureBatchFilter\.value = batchSummary\.value\?\.batch_id/)
  assert.match(jobs, /ref="historyHeading"/)
  assert.match(jobs, /historyHeading\.value\?\.focus\(\)/)
})

test('normal Jobs surfaces use attention language while internal status keys stay unchanged', () => {
  assert.match(statusBadge, /error: 'Needs attention'/)
  assert.match(jobs, /label: 'Needs attention'/)
  assert.match(jobs, /job.*need.*attention/s)
  assert.match(jobs, /episode.*need.*attention/s)
  assert.match(jobs, /Show all episodes needing attention/)
  assert.match(jobs, />Review Jobs →<\/button>/)
  assert.match(jobs, /What happened:/)
  assert.match(jobs, /Show Details/)
  assert.match(jobs, /Repair All \(\$\{repairableFailedJobs\.length\}\)/)
  assert.match(jobs, /No jobs need another try/)
  assert.match(useJobsSource, /\$\{jobDisplayLabel\(job\)\} needs attention: \$\{job\.episode_id\}/)
  assert.match(batchSignals, /need.*attention/)

  for (const legacy of [
    /error: 'Error'/,
    /label: 'Failed'/,
    />Review failures/,
    />Repair all failed/,
    /<span class="error-label">Error:<\/span>/,
    /Show full error/,
    /Hide full error/,
    /Nothing failed that can be retried/,
    /Deletes this failed job/,
    /any that were refused say so on their card/,
  ]) {
    assert.doesNotMatch(`${statusBadge}\n${jobs}\n${useJobsSource}\n${batchSignals}`, legacy)
  }

  assert.match(jobs, /job\.status === 'error'/)
  assert.match(jobs, /statusFilter\.value = 'error'/)
  assert.match(jobs, /label="Technical details"/)
})

test('Job error disclosures are native buttons with expanded state and controlled regions', () => {
  assert.doesNotMatch(jobs, /<div\s+v-if="job\.error && hasMoreErrorLines\(job\.error\)"\s+class="error-toggle"/)
  assert.match(jobs, /<button[\s\S]*?class="error-toggle"[\s\S]*?:aria-expanded=/)
  assert.match(jobs, /:aria-controls="`job-error-/)
  assert.match(jobs, /:id="`job-error-/)
  assert.match(jobs, /\.error-toggle:focus-visible/)
})

test('Technical disclosure label omits counts and raw request identifiers', () => {
  assert.doesNotMatch(jobs, /:badge="expandSummary\(job\)/)
  assert.doesNotMatch(jobs, /Job id:<\/span> \{\{ job\.job_id \}\}/)
  assert.doesNotMatch(jobs, /Remote job:<\/span> \{\{ remote\.id \}\}/)
  const requestPreview = readFileSync(
    fileURLToPath(new URL('../components/GenStudioRequestPreview.vue', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(requestPreview, /Idempotency-Key/)
})

test('Generation confirmations do not interpolate internal job identifiers', () => {
  for (const path of [
    '../pages/projects/[slug]/scene-plan.vue',
    '../pages/projects/[slug]/images.vue',
    '../pages/projects/[slug]/image-prompts.vue',
    '../pages/projects/[slug]/broll.vue',
    '../pages/projects/[slug]/metadata.vue',
    '../components/RepairAssetsDialog.vue',
    '../components/ImageGeneratorPanel.vue',
    '../pages/projects/[slug]/scene-review.vue',
  ]) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, /(?:Story task|job|Job) \$\{job\??\.job_id\}/, path)
  }
})

test('recovery status and activity titles keep exact identifiers internal', () => {
  const images = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/images.vue', import.meta.url)),
    'utf8',
  )
  const notifications = readFileSync(
    fileURLToPath(new URL('../composables/useNotifications.ts', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(images, /Task:\s*\{\{ item\.task_id \}\}/)
  assert.doesNotMatch(images, />\{\{ lastRepairJob\.job_id \}\}<\/NuxtLink>/)
  assert.doesNotMatch(notifications, /title:\s*j\.title \|\| j\.episode_id \|\| j\.job_id/)
})

test('usage and prompt workflow summaries do not render stored job or batch ids', () => {
  const usage = readFileSync(fileURLToPath(new URL('../pages/usage.vue', import.meta.url)), 'utf8')
  const scenePlan = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)), 'utf8')
  assert.doesNotMatch(usage, /<code>\{\{ job\.id \}\}<\/code>/)
  assert.doesNotMatch(usage, /Internal id:/)
  assert.doesNotMatch(scenePlan, /Last Hub task:/)
  assert.doesNotMatch(scenePlan, /\{\{ plan\.motion_prompt_batch_id \|\| plan\.visual_prompt_batch_id \}\}/)
})

test('capacity facts require a fresh verified account snapshot', () => {
  const now = Date.parse('2026-08-30T10:00:00.000Z')
  assert.equal(isVerifiedLiveCapacity({ capacity_verified: true, limitSource: 'account-overview', refreshed_at: new Date(now - 5_000).toISOString() }, now), true)
  assert.equal(isVerifiedLiveCapacity({ capacity_verified: false, limitSource: 'account-overview', refreshed_at: new Date(now - 5_000).toISOString() }, now), false)
  assert.equal(isVerifiedLiveCapacity({ capacity_verified: false, limitSource: 'safe-fallback', refreshed_at: new Date(now - 5_000).toISOString() }, now), false)
  assert.equal(isVerifiedLiveCapacity({ capacity_verified: true, limitSource: 'account-overview', refreshed_at: new Date(now - 31_000).toISOString() }, now), false)
})

test('failure review keeps only failed jobs from the selected batch', () => {
  const recovered = {
    status: 'error', type: 'subtitles_transcribe', project_slug: 'story', params: {
      pipeline_batch_id: 'batch-2', episode_recovery_id: 'plan-1',
      episode_recovery: { id: 'plan-1', completed: ['subtitle_sections', 'subtitle_stitch'], first_unresolved: 'scene_plan_run' },
    },
  }
  const jobsForReview = [
    { status: 'error', type: 'audio', project_slug: 'story', params: { pipeline_batch_id: 'batch-2' } },
    { status: 'error', type: 'audio', project_slug: 'story', params: { pipeline_batch_id: 'batch-1' } },
    { status: 'done', type: 'audio', project_slug: 'story', params: { pipeline_batch_id: 'batch-2' } },
    recovered,
  ]
  assert.deepEqual(
    filterJobsForView(jobsForReview, { type: 'all', status: 'error', project: 'all', batch: 'batch-2' }),
    [jobsForReview[0]],
  )
  assert.deepEqual(
    filterJobsForView(jobsForReview, { type: 'all', status: 'recovered', project: 'all', batch: 'batch-2' }),
    [recovered],
  )
})

test('the safest control stays primary and exact targets survive presentation', () => {
  const controls = [
    { action: 'pause-submissions', enabled: true },
    { action: 'request-remote-cancel', enabled: true, targets: [{ operation: 'image.generation', provider_job_id: 'exact-target' }] },
    { action: 'force-abandon', enabled: true },
  ]
  assert.equal(primaryControl(controls)?.action, 'pause-submissions')
  assert.deepEqual(secondaryControls(controls)[0]?.targets, [{ operation: 'image.generation', provider_job_id: 'exact-target' }])
})

test('customer copy hides known request identities without mutating source evidence', () => {
  const evidence = { id: 'provider-job-1234567890' }
  assert.equal(customerSafeJobText(`Request ${evidence.id} failed`, [evidence.id]), 'Request [request hidden] failed')
  assert.equal(evidence.id, 'provider-job-1234567890')
})

test('customer copy preserves unrelated UUID-like and long customer content', () => {
  const customerText = 'Project 123e4567-e89b-12d3-a456-426614174000 uses render_12345678901234567890.png'
  assert.equal(customerSafeJobText(customerText), customerText)
})

test('customer copy still hides known UUID identities and explicitly labelled internal tokens', () => {
  const knownId = '123e4567-e89b-12d3-a456-426614174000'
  assert.equal(customerSafeJobText(`Request ${knownId} failed`, [knownId]), 'Request [request hidden] failed')
  assert.equal(customerSafeJobText('Provider job ID: provider_1234567890 failed'), 'Provider job ID: hidden failed')
  assert.equal(customerSafeJobText('Job job_123456789 failed'), 'Job [request hidden] failed')
})

test('Images repair and B-Roll errors hide their owning request identities without changing customer text', () => {
  const job = {
    job_id: 'job_internal_1234567890',
    genstudio_jobs: [{ id: 'provider_1234567890' }],
    remote_cancellations: { one: { provider_job_id: 'cancel_1234567890' } },
  }
  const customerText = 'Project 123e4567-e89b-12d3-a456-426614174000 failed on a customer-named scene.'

  for (const id of [job.job_id, job.genstudio_jobs[0].id, job.remote_cancellations.one.provider_job_id]) {
    assert.equal(customerSafeJobText(`Request ${id} failed`, jobRequestIds(job)), 'Request [request hidden] failed')
  }
  assert.equal(customerSafeJobText(customerText, jobRequestIds(job)), customerText)

  assert.match(images, /customerSafeJobText\(job\.error,\s*jobRequestIds\(job\)\)/)
  assert.match(brollLibrary, /customerJobError\(job\)/)
  assert.doesNotMatch(brollLibrary, /:title="job\.error"|job\.error\.slice/)
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

test('Paused status uses the same project and type scope for counts and visible rows', () => {
  const scopedJobs = [
    { status: 'paused', type: 'audio', project_slug: 'story' },
    { status: 'paused', type: 'images', project_slug: 'story' },
    { status: 'paused', type: 'audio', project_slug: 'other' },
    { status: 'running', type: 'audio', project_slug: 'story' },
  ]
  assert.deepEqual(
    filterJobsForView(scopedJobs, { type: 'audio', status: 'paused', project: 'story', batch: null }),
    [scopedJobs[0]],
  )
  assert.match(jobs, /const typeScopedJobs = computed\(\(\) =>/)
  assert.match(jobs, /\{ key: 'paused', label: 'Paused' \}/)
  assert.match(jobs, /count: s\.key === 'all'\s*\? typeScopedJobs\.value\.length\s*:\s*typeScopedJobs\.value\.filter\(j => jobDisplayStatus\(j\) === s\.key\)\.length/)
  assert.match(jobs, /filterJobsForView\(typeScopedJobs\.value, \{[\s\S]*?project: 'all'/)
})

test('Paused work rejoin sends only server-owned scope and gives immediate busy feedback', () => {
  assert.doesNotMatch(jobs, /v-if="showBulkResume"/)
  assert.match(jobs, /:disabled="bulkActionBusy \|\| pausedJobCount === 0"/)
  assert.match(jobs, /bulkResumeBusy \? `Resuming \$\{bulkResumeCount\}…` : `Resume Paused \(\$\{pausedJobCount\}\)`/)
  assert.match(jobs, /:disabled="controlBusy\.has\(job\.job_id\)"[\s\S]*?\{\{ controlBusy\.has\(job\.job_id\) \? 'Rejoining…' : 'Resume' \}\}/)
  assert.match(jobs, /if \(controlBusy\.value\.has\(job\.job_id\)\) return[\s\S]*?controlBusy\.value = new Set\(controlBusy\.value\)\.add\(job\.job_id\)/)
  assert.match(jobs, /if \(bulkResumeBusy\.value \|\| pausedJobCount\.value === 0\) return[\s\S]*?bulkResumeBusy\.value = true/)
  assert.match(jobs, /const payload: \{ project_slug\?: string; type\?: string \} = \{\}/)
  assert.doesNotMatch(jobs, /resumePausedJobs[\s\S]{0,900}payload\.type/)
  assert.match(jobs, /const endpoint = isUniversal\.value\s*\? '\/jobs\/all\/resume-paused'\s*:\s*`\/projects\/\$\{slug\.value\}\/jobs\/resume-paused`/)
  assert.match(jobs, /if \(isUniversal\.value && projectFilter\.value !== 'all'\) \{\s*payload\.project_slug = projectFilter\.value\s*\}/)
  assert.match(jobs, /await post<\{ resumed: number; skipped: number \}>\(endpoint, payload\)/)
  assert.match(jobs, /Resumed \$\{result\.resumed\}; \$\{result\.skipped\} unchanged\./)
  assert.doesNotMatch(jobs, /resume-paused[\s\S]{0,240}job_ids/)
})

test('Paused controls give filters and actions separate wrapping room on narrow Jobs layouts', () => {
  assert.match(jobs, /@media \(max-width: 760px\)[\s\S]*?\.status-filters \{ flex: 1 1 100%; min-width: 0; \}/)
  assert.match(jobs, /\.jobs-more-action \.btn \{ min-height: 36px; white-space: normal; \}/)
})

test('Jobs keeps every sort control reachable on narrow layouts', () => {
  assert.match(jobs, /@media \(max-width: 760px\)[\s\S]*?\.sort-bar \{ flex-wrap: wrap; min-width: 0; \}/)
  assert.match(jobs, /@media \(max-width: 760px\)[\s\S]*?\.sort-label \{ flex: 1 1 100%; margin-right: 0; \}/)
})

/**
 * DS-08 (Q-07, Q-10, Q-06) — the Jobs-only rules that are not pure enough to
 * unit-test directly. The behavioural halves live in
 * `jobPresentationLabels.test.ts`; these pin the page wiring.
 */
test('Q-07: retired scene-image filter tabs are not hard-coded', () => {
  // `scene_images` and `scene_images_batch` no longer exist in JOB_TYPES, and
  // the dynamic loop below the list already adds a tab when a historical row of
  // that type exists. Hard-coding them left two permanently-empty tabs.
  const tabs = jobs.slice(jobs.indexOf('const filterTabs = computed'), jobs.indexOf('const filterLabel'))
  assert.doesNotMatch(tabs, /type: 'scene_images'/)
  assert.doesNotMatch(tabs, /type: 'scene_images_batch'/)
})

test('Q-10: the subtitle Retry tooltip does not point at a Repair control', () => {
  // `subtitles_transcribe` is not in REPAIR_ENDPOINTS, so no Repair button is
  // rendered for it. The tooltip must describe what Retry actually does.
  const start = jobs.indexOf("if (jobType === 'subtitles_transcribe')")
  assert.ok(start >= 0, 'the subtitle tooltip branch must exist')
  const block = jobs.slice(start, jobs.indexOf('}', start))
  assert.doesNotMatch(block, /Repair first retrieves saved Gateway work/)
  assert.match(block, /Retry keeps completed SRT files/)
})

test('Q-06: per-row and bulk Retry apply the shared admission filter', () => {
  assert.match(jobs, /retryAdmissionAllowed\(job\)/, 'per-row Retry must refuse backend-rejected legacy rows')
  assert.match(jobs, /retryAdmissionAllowed\(j\)/, 'Retry all must apply the same admission filter')
})

test('Jobs names the published provider beside the model (§2 display-only)', () => {
  assert.match(jobs, /function jobModelProvider\(job: RJob\): string \{/)
  assert.match(jobs, /return genStudioModels\.providerName\(job\.params\?\.model\)/)
  const display = jobs.slice(jobs.indexOf('function jobModelDisplay'), jobs.indexOf('function jobModelTitle'))
  assert.match(display, /jobModelProvider\(job\)/, 'the model label must include the provider when one is published')
})

test('Jobs opens filtered by ?status= and names job types like the pages do (owner decision 2026-10-03)', () => {
  // The dashboard's "Repair N failed jobs" links to `/jobs?status=error`.
  assert.match(jobs, /watch\(\(\) => route\.query\.status, value => \{[\s\S]{0,120}statusFilter\.value = next/)
  assert.match(jobs, /STATUS_FILTERS\.some\(s => s\.key === key\)/)
  assert.match(jobs, /\{ type: 'metadata',\s+label: 'YouTube Finalizer' \}/)
  assert.match(jobs, /\{ type: 'audio_merge',\s+label: 'Audio Assembly' \}/)
  assert.doesNotMatch(jobs, /label: 'Metadata'|label: 'Audio Merge'/)
})
