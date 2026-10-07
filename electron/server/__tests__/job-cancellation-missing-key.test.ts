/**
 * H-16 (DS-01) — the missing-credential cancellation lifecycle.
 *
 * THE SOURCE LEAD. `reconcileCancellationJob` reads the GenStudio key first and,
 * when there is none, appends a waiting line, persists, and returns. Its
 * `finally` then reschedules the same pass in five seconds while the job is
 * still `running` or `paused` and still requires reconciliation. So the wait is
 * bounded by nothing except the key arriving: every five seconds it re-states
 * the same fact to `output_lines` and rewrites `jobs.json`.
 *
 * WHAT IS INTENTIONAL AND MUST SURVIVE. The polling itself is the mechanism by
 * which a later key save is noticed. This file does not assert that polling
 * stops, does not turn the wait into a failure, and does not remove the
 * duplicate lock. It pins the actual defect: the missing-key pass reports the
 * same unchanged state once per tick, and spends provider/claim work it does
 * not have credentials for.
 *
 * Kept out of `job-cancellation-reconciliation.test.ts` on purpose: that file
 * sets a key in several tests against one shared temp data dir, so a missing-key
 * case there would be order-dependent. This file owns a keyless data dir.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import type { Job } from '../models/types.js'
import { sleep, waitFor } from './_timing.js'

/** The production cadence being observed: the `finally` reschedules after 5s. */
const RECONCILE_INTERVAL_MS = 5_000
/** The packet requires at least three whole retry intervals. */
const OBSERVED_INTERVALS = 3
const WAITING_LINE = /Cancellation is waiting for the Gateway API Key/

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  await setGenStudioUrl('https://missing-key.test')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
})

after(async () => {
  await jq?._waitForJobPersistenceForTesting().catch(() => {})
  await cleanup()
})

function job(status: 'queued' | 'submitting'): Job {
  return {
    job_id: 'story-missing-key', project_slug: 'project', type: 'audio', episode_id: 'EP0001', title: 'Audio',
    status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null,
    error: null, output_lines: [], params: {},
    genstudio_jobs: [{ id: 'provider-1', operation: 'voice.tts', state: 'accepted', updated_at: new Date().toISOString() }],
    remote_cancellations: {
      'voice.tts:provider-1': {
        status, operation: 'voice.tts', provider_job_id: 'provider-1',
        requested_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    },
  }
}

async function seed(projectSlug: string, entry: Job): Promise<string> {
  entry.project_slug = projectSlug
  const jobsFile = path.join(tempDir, 'projects', projectSlug, 'jobs.json')
  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [entry] }))
  return jobsFile
}

test('missing key: one bounded waiting statement, no provider or claim spend, and the same identity resumes when the key returns', async () => {
  const { clearApiKey } = await import('../services/app-secrets-store.js')
  await clearApiKey('genstudio')
  const project = await pm.createProject({ name: 'Missing key cancellation' })
  const persisted = job('queued')
  persisted.job_id = 'missing-key-cancel'
  await seed(project.slug, persisted)

  const calls: Array<{ method: string; path: string }> = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ method: (init?.method || 'GET').toUpperCase(), path: url.pathname })
    if (url.pathname === '/v1/jobs/provider-1' && (init?.method || 'GET') === 'GET') {
      return Response.json({ id: 'provider-1', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true, cancelled: false })
    }
    if (url.pathname === '/v1/jobs/provider-1/cancel' && init?.method === 'POST') {
      return Response.json({ id: 'provider-1', state: 'accepted', cancellable: false, cancelled: true, released_credits: 4 })
    }
    return Response.json({ detail: 'unexpected request' }, { status: 500 })
  }
  try {
    await jq.getJobs(project.slug)
    await waitFor(
      () => (jq.getJob('missing-key-cancel')?.output_lines || []).some(line => WAITING_LINE.test(line)),
      { label: 'the missing-key waiting statement' },
    )

    // The first pass has finished; the 5s cadence is now the only thing running.
    //
    // WHY REAL TIMERS. The reschedule is a raw `setTimeout` inside
    // `reconcileCancellationJob` with no injectable clock, and each pass does
    // real async fs persistence before the next timer is registered. Faking
    // Node timers would fire the callback without awaiting that work and would
    // not exercise the cadence the defect lives in. Three whole production
    // intervals (15s) is the explicitly justified bounded equivalent.
    await jq._waitForJobPersistenceForTesting()
    const beforeWindow = Date.now()
    jq._resetJobPersistenceCountersForTesting()

    // Observe three whole retry intervals, not an arbitrary short timeout.
    await sleep(RECONCILE_INTERVAL_MS * OBSERVED_INTERVALS + 1_000)
    const observedMs = Date.now() - beforeWindow
    assert.ok(
      observedMs >= RECONCILE_INTERVAL_MS * OBSERVED_INTERVALS,
      `observation window ${observedMs}ms did not cover ${OBSERVED_INTERVALS} full ${RECONCILE_INTERVAL_MS}ms intervals`,
    )

    const waiting = jq.getJob('missing-key-cancel')!
    const waitingLines = waiting.output_lines.filter(line => WAITING_LINE.test(line))
    const writes = jq._getJobPersistenceCountersForTesting().atomic_writes

    // ---- no-key behaviour: visibly waiting, nothing spent, still locked ----
    assert.equal(waiting.status, 'running')
    assert.equal(waiting.finished_at, null)
    assert.notEqual(waiting.status, 'done')
    assert.equal(jq.isDuplicate(project.slug, 'EP0001', 'audio'), true)
    assert.equal(waiting.remote_cancellations?.['voice.tts:provider-1']?.status, 'queued')
    assert.deepEqual(calls, [], 'a keyless pass must not touch the provider')

    // ---- the bounded statements of an unchanged state ----
    // Pre-fix this measured 4: one append and one jobs.json rewrite per tick.
    assert.equal(waitingLines.length, 1, `the same waiting fact was restated ${waitingLines.length} times`)
    assert.ok(
      writes <= 1,
      `an unchanged missing-key state rewrote jobs.json ${writes} times in ${OBSERVED_INTERVALS} intervals`,
    )

    // ---- credentials restored through the real supported trigger ----
    // The bound is deliberately one interval plus slack. It is the control that
    // forbids a "never reschedule" implementation: the key is only ever noticed
    // by a later pass, so a queue that stopped polling would fail here rather
    // than passing the bounded no-key assertions above.
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const restoreStarted = Date.now()
    await setApiKey('genstudio', 'missing-key-test-key')

    await waitFor(
      () => jq.getJob('missing-key-cancel')?.remote_cancellations?.['voice.tts:provider-1']?.status === 'confirmed',
      { label: 'same-identity cancellation after the key returned', timeoutMs: RECONCILE_INTERVAL_MS + 3_000 },
    )
    const settled = jq.getJob('missing-key-cancel')!
    assert.ok(
      Date.now() - restoreStarted <= RECONCILE_INTERVAL_MS + 3_000,
      'the waiting cadence must notice a restored key within one interval',
    )
    assert.equal(settled.remote_cancellations?.['voice.tts:provider-1']?.provider_job_id, 'provider-1')
    assert.equal(settled.remote_cancellations?.['voice.tts:provider-1']?.released_credits, 4)
    assert.deepEqual(calls, [
      { method: 'GET', path: '/v1/jobs/provider-1' },
      { method: 'POST', path: '/v1/jobs/provider-1/cancel' },
    ])

    // A settled job reaches its terminal state and leaves no live timer work:
    // an unchanged tail plus no further writes over a full interval.
    await waitFor(() => jq.getJob('missing-key-cancel')?.status === 'cancelled', { label: 'terminal cancellation' })
    await jq._waitForJobPersistenceForTesting()
    jq._resetJobPersistenceCountersForTesting()
    const linesAtSettle = jq.getJob('missing-key-cancel')!.output_lines.length
    await sleep(RECONCILE_INTERVAL_MS + 1_000)
    assert.equal(jq.getJob('missing-key-cancel')!.output_lines.length, linesAtSettle, 'a settled job must not keep writing reconciliation lines')
    assert.equal(jq._getJobPersistenceCountersForTesting().atomic_writes, 0, 'a settled job must not keep rewriting jobs.json')
    assert.equal(jq.removeTerminalJob(project.slug, 'missing-key-cancel'), true)
  } finally {
    globalThis.fetch = original
    const { clearApiKey } = await import('../services/app-secrets-store.js')
    await clearApiKey('genstudio').catch(() => {})
    await jq.forceAbandonJob(project.slug, 'missing-key-cancel').catch(() => {})
    await jq._waitForJobPersistenceForTesting().catch(() => {})
  }
})

test('missing key never replays an already-claimed cancellation, and a dispatched task is not re-POSTed when the key returns', async () => {
  // This file shares one temp data dir across tests, so remove the key the
  // previous case saved rather than depending on test order.
  const { clearApiKey } = await import('../services/app-secrets-store.js')
  await clearApiKey('genstudio')
  const project = await pm.createProject({ name: 'Missing key no-replay' })
  const persisted = job('submitting')
  persisted.job_id = 'missing-key-no-replay'
  await seed(project.slug, persisted)

  const calls: Array<{ method: string; path: string }> = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ method: (init?.method || 'GET').toUpperCase(), path: url.pathname })
    if (url.pathname === '/v1/jobs/provider-1') {
      return Response.json({ id: 'provider-1', state: 'accepted', dispatch_state: 'dispatched', cancellable: true, cancelled: false })
    }
    return Response.json({ detail: 'no control POST may be replayed' }, { status: 500 })
  }
  try {
    await jq.getJobs(project.slug)
    await waitFor(
      () => (jq.getJob('missing-key-no-replay')?.output_lines || []).some(line => WAITING_LINE.test(line)),
      { label: 'the missing-key waiting statement' },
    )
    // The crash-recovery claim is preserved across the keyless wait.
    assert.equal(jq.getJob('missing-key-no-replay')?.remote_cancellations?.['voice.tts:provider-1']?.status, 'submitting')
    assert.deepEqual(calls, [])

    const { setApiKey } = await import('../services/app-secrets-store.js')
    await setApiKey('genstudio', 'missing-key-test-key')

    await waitFor(
      () => jq.getJob('missing-key-no-replay')?.remote_cancellations?.['voice.tts:provider-1']?.status === 'reconciling',
      { label: 'read-only reconciliation of the claimed task', timeoutMs: 15_000 },
    )
    // Only the status read: the task is already dispatched, so repeating the
    // idempotent control request is not authorized by this evidence.
    assert.deepEqual(calls, [{ method: 'GET', path: '/v1/jobs/provider-1' }])
    assert.equal(jq.getJob('missing-key-no-replay')?.status, 'running')
  } finally {
    globalThis.fetch = original
    await jq.forceAbandonJob(project.slug, 'missing-key-no-replay').catch(() => {})
    await jq._waitForJobPersistenceForTesting().catch(() => {})
  }
})

/**
 * NEW-01 — the primary control must NAME the missing key.
 *
 * DS-01 bounded the waiting and kept the actionable sentence in `output_lines`,
 * but the control the customer actually presses is derived from
 * `reconciliation_error`, which the missing-key pass never set. So the button
 * read "Checking cancellation" and gave no reason, while the sentence that
 * explains it sat in the log beside it.
 */
test('missing key: the primary cancellation control names the key, not just "Checking cancellation"', async () => {
  const { clearApiKey } = await import('../services/app-secrets-store.js')
  const { classifyJobControl } = await import('../services/job-control.js')
  await clearApiKey('genstudio')
  const project = await pm.createProject({ name: 'Missing key control copy' })
  const persisted = job('queued')
  persisted.job_id = 'missing-key-control-copy'
  await seed(project.slug, persisted)

  await jq.getJobs(project.slug)
  await waitFor(
    () => (jq.getJob('missing-key-control-copy')?.output_lines || []).some(line => WAITING_LINE.test(line)),
    { label: 'the missing-key waiting statement' },
  )

  const loaded = jq.getJob('missing-key-control-copy')!
  const control = classifyJobControl(loaded, { remoteCancellationAudited: true })
  const copy = `${control.label} ${control.reason}`

  assert.match(copy, /Gateway API Key/,
    'the control the customer presses must say the key is missing, not only that something is being checked')
  assert.match(copy, /Settings/,
    'it must say where to fix it — the whole point of naming the cause')
  assert.match(copy, /cannot be confirmed yet|cannot confirm/i,
    'and it must not claim the cancellation is progressing while no request can be made')
})
