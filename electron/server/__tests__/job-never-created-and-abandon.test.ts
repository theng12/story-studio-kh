/**
 * v1.2.8 — quitting the app mid-batch must not manufacture a permanent wedge,
 * and a wedged job must always have an exit.
 *
 * THE INCIDENT. The owner quit Story Studio during a Scene Review image batch,
 * updated, and reopened. GenStudio held exactly 50 succeeded image jobs and had
 * charged for 50. Story Studio was waiting on a 51st whose submission was in
 * flight when the app closed, so it was never created and never charged.
 * GenStudio answered every status lookup for it with HTTP 404. Story Studio
 * read that 404 as "not yet", polled it for twenty-two minutes, and would have
 * polled it forever — with 48 further items of the same batch stuck behind it.
 * Two more of his jobs reached the identical state at the same time, and no
 * button or API call in the product could clear any of them.
 *
 * Three things are asserted here, and the middle one is the one that costs real
 * money if it is ever got backwards:
 *
 *   1. A provider 404 is TERMINAL. The job reaches a definite state on its own.
 *   2. An UNREACHABLE provider is not. The hold is kept and nothing resubmits.
 *   3. Whatever else is true, the owner can always abandon the job and re-run.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  await setGenStudioUrl('https://never-created.test')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'never-created-test-key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  // Deliberately no executors: this file is about the queue's own bookkeeping
  // — reconciliation, terminal classification, controls — and registering the
  // real generators would have a retried scene render actually start rendering
  // and outlive the test's temp directory.
})

after(async () => { await cleanup() })

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`Timed out waiting for: ${what}`)
}

/**
 * His batch, in miniature: two provider tasks GenStudio really has, and one
 * whose POST never landed — recorded only by its idempotency key, because that
 * is all Story Studio had when the process died.
 */
function interruptedBatch(jobId: string, projectSlug: string): Job {
  return {
    job_id: jobId,
    project_slug: projectSlug,
    type: 'continuity_render',
    episode_id: 'EP0053',
    title: 'Scene Review images',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
    genstudio_jobs: [
      { id: 'image-settled-1', operation: 'image.generation', state: 'accepted', updated_at: new Date().toISOString() },
      { id: 'image-settled-2', operation: 'image.generation', state: 'accepted', updated_at: new Date().toISOString() },
      {
        id: '' as unknown as string,
        operation: 'image.generation',
        state: 'submitting',
        queue_state: 'submitting',
        updated_at: new Date().toISOString(),
        request: {
          method: 'POST', path: '/v1/images', captured_at: '2026-08-15T00:00:00.000Z',
          idempotency_key: 'story-image-inflight',
        },
      },
    ],
    remote_cancellations: {},
  }
}

async function persist(projectName: string, job: Job): Promise<string> {
  const project = await pm.createProject({ name: projectName })
  job.project_slug = project.slug
  await fs.writeFile(
    path.join(tempDir, 'projects', project.slug, 'jobs.json'),
    JSON.stringify({ jobs: [job] }),
  )
  return project.slug
}

test('restarting after a mid-batch quit settles every item — a provider 404 is "never created", not "not yet"', async () => {
  const job = interruptedBatch('restart-404', 'placeholder')
  const slug = await persist('Restart 404 is terminal', job)

  const original = globalThis.fetch
  const requests: Array<{ method: string; path: string }> = []
  globalThis.fetch = async (input, init) => {
    const method = (init?.method || 'GET').toUpperCase()
    const url = new URL(String(input))
    requests.push({ method, path: url.pathname })
    if (method !== 'GET') {
      return Response.json({ detail: 'no POST may be sent during restart reconciliation' }, { status: 500 })
    }
    if (url.pathname === '/v1/images/image-settled-1' || url.pathname === '/v1/images/image-settled-2') {
      return Response.json({ id: url.pathname.split('/').pop(), state: 'succeeded', dispatch_state: 'dispatched', cancellable: false })
    }
    // The in-flight submission. GenStudio looked, and has nothing.
    return Response.json({ detail: 'image generation not found' }, { status: 404 })
  }
  try {
    await jq.getJobs(slug)
    await waitFor(() => {
      const current = jq.getJob('restart-404')
      return !!current && current.status !== 'running'
    }, 'the restarted job to reach a definite state without human intervention')

    const settled = jq.getJob('restart-404')!
    const publicSettled = jq.getPublicJob('restart-404')!

    // 1. Definite. Not "running" forever.
    assert.equal(settled.status, 'error')
    // 2. Nothing left claiming Story Studio is still waiting for an answer.
    assert.equal(settled.reconciliation_error, undefined)
    // 3. The never-created task is recorded as such — not as a provider failure.
    const inflight = settled.genstudio_jobs!.find(entry => entry.request?.idempotency_key === 'story-image-inflight')
      ?? settled.genstudio_jobs!.find(entry => entry.state === 'not_created')
    assert.equal(inflight?.state, 'not_created')
    assert.equal(inflight?.queue_state, 'not_created')
    // 4. The log answers the only question the user actually has: was I charged?
    const log = settled.output_lines.join('\n')
    assert.match(log, /GenStudio has no record of image\.generation/)
    assert.match(log, /never created, so nothing was generated and nothing was charged/)
    assert.match(log, /will not resend it on its own/)
    // 5. Exactly one lookup per recorded task, and never a POST.
    assert.deepEqual(requests.filter(r => r.method !== 'GET'), [])
    assert.equal(requests.length, 3)
    // 6. The way forward is on the row: history can be cleared, and Retry works.
    assert.equal(publicSettled.control?.action, 'clear-history')
    assert.equal(publicSettled.control?.enabled, true)
  } finally {
    globalThis.fetch = original
  }
})

test('a finished image job coalesces a pruned pending receipt into its exact succeeded task', async () => {
  const job = interruptedBatch('history-exact-coalesce', 'placeholder')
  job.status = 'error'
  job.local_execution_complete = true
  job.finished_at = new Date().toISOString()
  job.params.genstudio_recovery = {
    version: 1,
    route: 'genstudio',
    assets: {
      'ep0058-scene-0132.png': {
        operation: 'image',
        idempotency_key: 'story-history-exact-key',
        job_id: 'history-real-task',
        state: 'succeeded',
        updated_at: '2026-09-06T12:00:00.000Z',
      },
    },
  }
  job.genstudio_jobs = [
    {
      id: 'pending:story-history-exact-key', operation: 'image.generation', state: 'submitting',
      updated_at: '2026-09-06T11:59:59.000Z',
    },
    {
      id: 'history-real-task', operation: 'image.generation', state: 'succeeded',
      settled_credits: 9, updated_at: '2026-09-06T12:00:01.000Z',
    },
  ]
  const slug = await persist('Finished exact evidence coalesces', job)
  const jobsFile = path.join(tempDir, 'projects', slug, 'jobs.json')

  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    assert.equal((init?.method || 'GET').toUpperCase(), 'GET', 'history reconciliation is read-only')
    requests.push(String(input))
    return Response.json({
      id: 'history-real-task', state: 'succeeded', dispatch_state: 'dispatched',
      cancellable: false, settled_credits: 9,
    })
  }
  try {
    await jq.getJobs(slug)
    await waitFor(
      () => jq.getPublicJob(job.job_id)?.control?.action === 'clear-history',
      'the loaded finished row to coalesce exact evidence and become clearable',
    )
    const refreshed = await jq.recheckJobProviderStatus(slug, job.job_id)
    assert.ok(requests.length >= 1)
    assert.equal(refreshed.control?.action, 'clear-history')
    assert.equal(refreshed.control?.enabled, true)
    const live = jq.getJob(job.job_id)
    assert.equal(live?.genstudio_jobs?.filter(entry => entry.id === 'history-real-task').length, 1)
    assert.equal(live?.genstudio_jobs?.some(entry => entry.id === 'pending:story-history-exact-key'), false)
    const durable = (JSON.parse(await fs.readFile(jobsFile, 'utf8')) as { jobs: Job[] }).jobs[0]
    assert.equal(durable?.genstudio_jobs?.filter(entry => entry.id === 'history-real-task').length, 1)
    assert.equal(durable?.genstudio_jobs?.some(entry => entry.id === 'pending:story-history-exact-key'), false)
  } finally {
    globalThis.fetch = original
  }
})

test('an unreachable GenStudio keeps the hold — a network outage is never read as "never created"', async () => {
  const job = interruptedBatch('restart-unreachable', 'placeholder')
  const slug = await persist('Restart unreachable holds', job)

  const original = globalThis.fetch
  const posts: string[] = []
  globalThis.fetch = async (input, init) => {
    if ((init?.method || 'GET').toUpperCase() !== 'GET') posts.push(String(input))
    throw new TypeError('fetch failed')
  }
  try {
    await jq.getJobs(slug)
    await waitFor(
      () => !!jq.getJob('restart-unreachable')?.reconciliation_error,
      'the job to record that Story Studio could not reach GenStudio',
    )

    const held = jq.getJob('restart-unreachable')!
    // Still held, because nothing has been established about the provider.
    assert.equal(held.status, 'running')
    assert.ok(held.genstudio_jobs!.every(entry => entry.state !== 'not_created'))
    // The message is about Story Studio's reach, not about a provider verdict.
    assert.match(held.reconciliation_error!, /GenStudio status check is waiting/)
    assert.doesNotMatch(held.output_lines.join('\n'), /never created/)
    // And above all: no resubmission. This is the double-charge direction.
    assert.deepEqual(posts, [])
  } finally {
    globalThis.fetch = original
  }
})

test('a job with no other way out can always be abandoned, and re-run from the same row', async () => {
  const job = interruptedBatch('abandon-me', 'placeholder')
  const slug = await persist('Abandon always available', job)

  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  try {
    await jq.getJobs(slug)
    await waitFor(
      () => !!jq.getJob('abandon-me')?.reconciliation_error,
      'the job to become genuinely wedged',
    )

    // The dead end, reproduced: every ordinary exit refuses.
    const wedged = jq.getJob('abandon-me')!
    await assert.rejects(() => jq.requestJobCancellation(slug, 'abandon-me'))
    assert.equal(jq.removeTerminalJob(slug, 'abandon-me'), false)
    assert.throws(() => jq.retryTerminalJob(slug, 'abandon-me'))

    // …and the override is nevertheless offered, enabled, and honest.
    const escape = jq.getPublicJob('abandon-me')?.controls?.find(control => control.action === 'force-abandon')
    assert.ok(escape, 'a wedged job must offer force-abandon')
    assert.equal(escape.enabled, true)
    assert.equal(escape.label, 'Abandon this job')
    assert.match(escape.reason, /does not cancel provider work GenStudio has already accepted/)
    assert.match(escape.reason, /does not refund credits already spent/)
    assert.match(escape.reason, /Output may still arrive, and it stays recoverable/)

    const abandoned = await jq.forceAbandonJob(slug, 'abandon-me')
    assert.equal(abandoned.status, 'cancelled')
    assert.ok(abandoned.force_abandoned)
    assert.equal(abandoned.reconciliation_error, undefined)
    // Provider evidence is untouched — abandoning taught Story Studio nothing
    // about GenStudio, so it invents nothing about GenStudio.
    assert.equal(abandoned.genstudio_jobs!.length, 3)
    assert.ok(abandoned.genstudio_jobs!.every(entry => entry.state !== 'not_created'))
    assert.equal(abandoned.force_abandoned!.unsettled.length, 3)
    assert.match(abandoned.output_lines.join('\n'), /No cancellation was sent to GenStudio/)

    // Abandoning twice is a no-op, not a second cancellation.
    const again = await jq.forceAbandonJob(slug, 'abandon-me')
    assert.equal(again.force_abandoned!.at, abandoned.force_abandoned!.at)

    // The row is now usable: history can be cleared, and "generate a new one in
    // its replacement" is the Retry that sits beside it — the same Retry the
    // unsettled-evidence gate refused a moment ago.
    assert.equal(abandoned.control?.action, 'clear-history')
    assert.equal(abandoned.control?.enabled, true)
    const replacement = jq.retryTerminalJob(slug, 'abandon-me')
    assert.notEqual(replacement.job_id, 'abandon-me')
    assert.equal(replacement.episode_id, 'EP0053')
    assert.equal(replacement.type, 'continuity_render')
    // Retry replaces the row, as it always has: the abandoned job is gone and
    // its successor is queued in its place.
    assert.equal(jq.getJob('abandon-me'), null)

    // Stop the successor before this test's temp directory goes away, so a
    // half-started render cannot outlive the fixture and write outside it.
    await jq.forceAbandonJob(slug, replacement.job_id)
    await waitFor(() => {
      const current = jq.getJob(replacement.job_id)
      return !current || (current.status !== 'queued' && current.status !== 'running')
    }, 'the retried job to stop')
  } finally {
    globalThis.fetch = original
  }
})

/**
 * ABANDONING MUST NOT CLAIM "nothing was refunded".
 *
 * THE INCIDENT (2026-08-28). A scene-prompt job failed at GenStudio's
 * provider-identity gate. GenStudio released the whole reservation server-side
 * and Story Studio wrote that release into the job's own log — "GenStudio
 * reports 611 credits released." Forty-three minutes later the owner abandoned
 * the row, and the abandon message told him flatly that nothing was refunded,
 * three lines under his own evidence that everything had been.
 *
 * Story Studio holds no balance and refunds nothing itself; that is true and is
 * still said. What it may never do is assert the provider refunded nothing.
 */
function settledJobWithLog(jobId: string, lines: string[]): Job {
  return {
    job_id: jobId,
    project_slug: 'placeholder',
    type: 'continuity_render',
    episode_id: 'EP0088',
    title: 'Scene prompts',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: lines,
    params: {},
    // Nothing outstanding: this test is about the CREDIT sentence alone.
    genstudio_jobs: [],
    remote_cancellations: {},
  }
}

test('abandoning quotes the credit releases the job already recorded, instead of denying them', async () => {
  const slug = await persist('Abandon credits already released', settledJobWithLog('abandon-released', [
    'GenStudio KH language generation failed (LANGUAGE_PROVIDER_MODEL_MISMATCH). GenStudio reports 611 credits released.',
    'GenStudio KH language generation failed (LANGUAGE_PROVIDER_MODEL_MISMATCH). GenStudio reports 42 credits released.',
  ]))

  const abandoned = await jq.forceAbandonJob(slug, 'abandon-released')
  const log = abandoned.output_lines.join('\n')

  // The blanket claim is gone, everywhere in the log.
  assert.doesNotMatch(log, /nothing was refunded/i)
  // The evidence is quoted, and summed, and attributed to GenStudio.
  assert.match(log, /already records GenStudio releasing 653 credit\(s\) across 2 settled requests/)
  // Story Studio's own limit is still stated honestly, and the user is pointed
  // at the only place that holds the real balance.
  assert.match(log, /Story Studio holds no balance and refunds nothing itself/)
  assert.match(log, /GenStudio KH account has the final figure/)
})

test('with no recorded release, abandoning says what Story Studio cannot do — and asserts nothing about GenStudio', async () => {
  const slug = await persist('Abandon no release recorded', settledJobWithLog('abandon-unknown', [
    'Processing 3 adaptive pack(s) through GenStudio KH.',
  ]))

  const abandoned = await jq.forceAbandonJob(slug, 'abandon-unknown')
  const log = abandoned.output_lines.join('\n')

  assert.doesNotMatch(log, /nothing was refunded/i)
  assert.match(log, /Story Studio holds no balance and refunds nothing itself/)
  assert.match(log, /recorded in your GenStudio KH account/)
  // No number is invented when the log carries no release evidence.
  assert.doesNotMatch(log, /credit\(s\) across/)
})

test('the release reader counts only published release lines', () => {
  assert.deepEqual(jq.readRecordedCreditReleases([]), { count: 0, total: 0 })
  assert.deepEqual(
    jq.readRecordedCreditReleases(['GenStudio reports 0 credits released.']),
    { count: 1, total: 0 },
    'an explicit zero release is still evidence GenStudio published a settlement',
  )
  assert.deepEqual(
    jq.readRecordedCreditReleases(['Credit settlement is not yet published; check its GenStudio status.']),
    { count: 0, total: 0 },
    'an unpublished settlement is not a release',
  )
  assert.deepEqual(
    jq.readRecordedCreditReleases(['GenStudio reports 12.5 credits released. GenStudio reports 2.5 credits released.']),
    { count: 2, total: 15 },
    'two releases on one line are both counted',
  )
})
