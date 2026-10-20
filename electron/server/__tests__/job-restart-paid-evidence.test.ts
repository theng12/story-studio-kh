/**
 * H-17 (DS-02) — a restart that leaves durable, already-paid provider work.
 *
 * THE SOURCE LEAD. On load, a `running` job with unsettled GenStudio evidence is
 * routed to `reconcileCancellationJob` rather than being failed as "Interrupted
 * by app restart". That is correct: the provider task has a durable identity and
 * must settle. What the boot path cannot know is what happens next. When the
 * provider answers `succeeded`, `finalizeSettledProviderJob` needs a registered
 * output auditor before it can move the row to a terminal state. `metadata`,
 * `image_prompts` and `research_run` had none when this packet ran; NEW-02
 * registered all three, and their own both-directions proof now lives in
 * `text-job-completion-auditors.test.ts`. What this file pins is unchanged: the
 * row must reach an honest terminal state either way (see
 * `boot/executors.ts:registerCancellationAuditors`), so their row is left
 * `running` — with the reconcile timer no longer rescheduled, no error, and no
 * Retry, because `retryTerminalJob` only accepts `error`/`cancelled`.
 *
 * WHAT IS INTENTIONAL AND MUST SURVIVE. Reconciliation is read-only here: it
 * must never issue a generation POST, and it must keep the duplicate lock until
 * the provider's answer is authoritative. Only an already-settled, already-paid
 * task is involved; the test spends nothing and submits nothing.
 *
 * 1.4.337 CHANGED WHICH STATE IS "HONEST" FOR A WRITING JOB. A restart-interrupted writing job whose
 * children all settled but whose output is still incomplete is no longer ended as `error` (Sprout
 * SS0121/SS0119, History EP0015): `finalizeSettledProviderJob` requeues it, collect-first
 * (`chat-restart-reconcile-resumes.test.ts`). These fixtures carry `params: {}`, so the resumed
 * executor stops on its own missing input and the job sits in its auto-retry wait. That is honest too
 * — a live worker with a retry timer, not a row nothing drives — so the invariant pinned here is
 * "terminal, or visibly driven", never "running with nothing behind it".
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import type { Job, JobType } from '../models/types.js'
import { waitFor } from './_timing.js'

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let originalFetch: typeof globalThis.fetch
const calls: Array<{ method: string; path: string }> = []

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  await setGenStudioUrl('https://restart-paid.test')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'restart-paid-test-key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  // Register the SAME auditors production registers, so "no auditor" here means
  // production genuinely has none for that type rather than the test forgeting.
  const { registerAllExecutors } = await import('../boot/executors.js')
  registerAllExecutors({ loadSettings: false })

  originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = (init?.method || 'GET').toUpperCase()
    calls.push({ method, path: url.pathname })
    // Read-only status for one already-accepted chat task.
    const match = /^\/v1\/chat\/responses\/(.+)$/.exec(url.pathname)
    if (method === 'GET' && match) {
      const id = decodeURIComponent(match[1]!)
      // A row the Gateway still holds answers with the HOLD, not with a result: asked about its own
      // id, a submission-uncertain row is re-read rather than re-used from stored evidence, and this
      // is what the Gateway publishes for the one `chat-uncertain-1` is (`services/job-cancellation-
      // reconciler.ts` reads it back; `__tests__/chat-held-outcome-readback.test.ts` is the same
      // envelope with the pair present on the stored row).
      if (id === 'chat-uncertain-1') {
        return Response.json({
          id, state: 'failed', failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN', dispatch_state: 'dispatched',
          cancellable: false, cancelled: false, recovery_required: true, recovery_state: 'unknown_outcome',
        })
      }
      return Response.json({
        id, state: 'succeeded', dispatch_state: 'dispatched',
        cancellable: false, cancelled: false, settled_credits: 3,
      })
    }
    return Response.json({ detail: `unexpected ${method} ${url.pathname}` }, { status: 500 })
  }
})

after(async () => {
  globalThis.fetch = originalFetch
  await jq?._waitForJobPersistenceForTesting().catch(() => {})
  await cleanup()
})

function interruptedJob(
  type: JobType,
  jobId: string,
  projectSlug: string,
  evidence: Job['genstudio_jobs'],
): Job {
  return {
    job_id: jobId,
    project_slug: projectSlug,
    type,
    episode_id: 'EP0001',
    title: `interrupted ${type}`,
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
    genstudio_jobs: evidence,
    remote_cancellations: {},
  }
}

async function seed(projectSlug: string, job: Job): Promise<void> {
  const file = path.join(tempDir, 'projects', projectSlug, 'jobs.json')
  await fs.writeFile(file, JSON.stringify({ jobs: [job] }))
}

function isTerminal(status: Job['status'] | undefined): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}

/** Terminal, or queued, or running with its worker alive in the auto-retry wait (a live timer). */
function isDriven(jobId: string): boolean {
  const job = jq.getJob(jobId)
  if (!job) return false
  if (isTerminal(job.status) || job.status === 'queued') return true
  return job.status === 'running' && jq._isJobWorkerActiveForTesting(jobId)
    && Date.parse(job.auto_retry?.next_retry_at ?? '') > Date.now()
}

/** A resumed job keeps retrying for minutes; stop it so no worker outlives the temp data dir. */
async function release(projectSlug: string, jobId: string): Promise<void> {
  if (!isTerminal(jq.getJob(jobId)?.status)) await jq.forceAbandonJob(projectSlug, jobId).catch(() => {})
}

/**
 * Every generation flow must prove its output complete before success, and must
 * fail loudly when it cannot. A row that neither settles nor fails is neither.
 */
for (const type of ['metadata', 'image_prompts', 'research_run'] as const) {
  test(`H-17: interrupted ${type} with a settled paid task reaches an honest terminal state`, async () => {
    const project = await pm.createProject({ name: `Restart ${type}` })
    const jobId = `restart-${type}`
    await seed(project.slug, interruptedJob(type, jobId, project.slug, [{
      id: `chat-${type}-1`,
      operation: 'chat.response',
      state: 'accepted',
      updated_at: new Date().toISOString(),
    }]))
    calls.length = 0

    await jq.getJobs(project.slug)
    // Reconciliation is asynchronous. Give it ample room to read the one
    // provider task and classify the outcome.
    await waitFor(
      () => isDriven(jobId),
      { label: `${type} reached a terminal state or a live retry wait`, timeoutMs: 12_000 },
    ).catch(() => {})
    await jq._waitForJobPersistenceForTesting()

    const settled = jq.getJob(jobId)!
    assert.ok(
      isDriven(jobId),
      `${type} was left status=${settled.status} after its provider task settled; `
      + `Retry is refused for a non-terminal row and nothing is driving it. `
      + `error=${JSON.stringify(settled.error)} lines=${settled.output_lines.join(' | ')}`,
    )
    // The read-only reconciliation must never submit generation work.
    assert.equal(
      calls.some(call => call.method !== 'GET'),
      false,
      `reconciliation issued a non-GET request: ${JSON.stringify(calls)}`,
    )
    // Provider evidence is preserved, not discarded, so the paid task identity
    // and its settled state stay auditable after the failure.
    assert.equal(settled.genstudio_jobs?.[0]?.id, `chat-${type}-1`)
    assert.equal(settled.genstudio_jobs?.[0]?.state, 'succeeded')
    await release(project.slug, jobId)
  })
}

test('H-17 control: scene_plan_run has an auditor and does not strand the row', async () => {
  const project = await pm.createProject({ name: 'Restart scene_plan_run' })
  const jobId = 'restart-scene-plan'
  await seed(project.slug, interruptedJob('scene_plan_run', jobId, project.slug, [{
    id: 'chat-scene-plan-1',
    operation: 'chat.response',
    state: 'accepted',
    updated_at: new Date().toISOString(),
  }]))
  calls.length = 0

  await jq.getJobs(project.slug)
  await waitFor(
    () => isDriven(jobId),
    { label: 'scene_plan_run reached a terminal state or a live retry wait', timeoutMs: 12_000 },
  )

  // Its audit finds the output incomplete, so the restart-interrupted job is resumed rather than
  // failed (1.4.337); with these empty params the resumed run stops on its own input and retries.
  const settled = jq.getJob(jobId)!
  assert.ok(
    settled.output_lines.some(line => /picking this step up where it stopped/.test(line)),
    'a settled paid task with incomplete local output is picked up again: ' + settled.output_lines.join(' | '),
  )
  assert.equal(calls.some(call => call.method !== 'GET'), false)
  await release(project.slug, jobId)
})

test('H-17 control: an interrupted job with no durable evidence keeps the plain restart error', async () => {
  const project = await pm.createProject({ name: 'Restart no evidence' })
  const jobId = 'restart-no-evidence'
  // Writing steps without provider evidence are picked up again since R2 (2026-10-07); paid
  // thumbnails are not resumable, so they still show the plain restart error.
  await seed(project.slug, interruptedJob('thumb_images', jobId, project.slug, []))
  calls.length = 0

  await jq.getJobs(project.slug)
  const settled = jq.getJob(jobId)!
  assert.equal(settled.status, 'error')
  assert.equal(settled.error, 'Interrupted by app restart')
  // No durable identity means there is nothing to read and nothing to reclaim.
  assert.equal(calls.length, 0)
  // Retry admission is not silently blocked for this honest terminal row.
  let retried: Job | undefined
  assert.doesNotThrow(() => { retried = jq.retryTerminalJob(project.slug, jobId) })
  if (retried) await jq.forceAbandonJob(project.slug, retried.job_id).catch(() => {})
})

test('H-17: a stuck running row cannot be retried, only abandoned', async () => {
  // This is the downstream consequence, asserted directly so the severity is
  // explicit: while the row is `running`, the user has no Retry.
  const project = await pm.createProject({ name: 'Retry admission' })
  const jobId = 'restart-retry-admission'
  await seed(project.slug, interruptedJob('metadata', jobId, project.slug, [{
    id: 'chat-metadata-retry',
    operation: 'chat.response',
    state: 'accepted',
    updated_at: new Date().toISOString(),
  }]))

  await jq.getJobs(project.slug)
  // `waitFor` (not a fixed sleep) is the only bounded wait: it returns as soon
  // as the row settles, and the guard below tolerates both a settled row and
  // the pre-fix stuck `running` one this test exists to describe.
  await waitFor(
    () => isDriven(jobId),
    { label: 'retry-admission row settled or retrying', timeoutMs: 12_000 },
  ).catch(() => {})

  const row = jq.getJob(jobId)!
  if (row.status === 'running') {
    assert.throws(
      () => jq.retryTerminalJob(project.slug, jobId),
      /Only failed or cancelled jobs can be retried/,
      'a stuck running row is expected to refuse Retry while it holds the lock',
    )
  } else {
    assert.ok(isTerminal(row.status))
  }
  await release(project.slug, jobId)
})

/**
 * DM0009, 2026-10-16 — the sibling of the H-17 control above, and the message
 * that control does not cover.
 *
 * The job's evidence held one `succeeded` pack, one `failed` pack whose code was
 * `PROVIDER_SUBMISSION_UNCERTAIN` — the Gateway's own way of saying it could not
 * prove whether the request was taken — and one in-flight re-send. The restart
 * reconciled, the re-send settled as succeeded, and the finalizer then reported
 * "A Gateway provider task failed after cancellation reconciliation. Provider
 * evidence is retained." Neither clause was true: the recorded outcome was
 * unknown rather than failed, and no cancellation was ever requested
 * (`remote_cancellations` was empty). The owner was told about an action he never
 * took, on work the Gateway had not finished answering about.
 *
 * The terminal state itself is right and is what H-17 pins: an error the owner can
 * Retry, with the provider evidence kept and nothing new submitted. Only the claim
 * was wrong — the same defect this codebase already fixed once for the paused
 * branch, where a job that "was never cancelled by anybody" stopped being told it
 * was reconciling a cancellation.
 */
test('H-17: an unknown-outcome failure is not reported as a settled provider failure', async () => {
  const project = await pm.createProject({ name: 'Restart scene plan unknown outcome' })
  const jobId = 'restart-scene-plan-uncertain'
  const job = interruptedJob('scene_plan_run', jobId, project.slug, [
    {
      id: 'chat-settled-1', operation: 'chat.response', state: 'succeeded',
      request_key: 'story-chat-settled-1', updated_at: new Date().toISOString(),
    },
    {
      id: 'chat-uncertain-1', operation: 'chat.response', state: 'failed',
      failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN',
      request_key: 'story-chat-uncertain-1', updated_at: new Date().toISOString(),
    },
    {
      // Forces the restart down the reconcile-first path (H-17) rather than the
      // chat resume, exactly as DM0009's in-flight re-send did.
      id: 'chat-inflight-1', operation: 'chat.response', state: 'accepted',
      request_key: 'story-chat-inflight-1', updated_at: new Date().toISOString(),
    },
  ])
  // DM0009's own list, verbatim: an earlier pass DID send a fresh request, and that
  // re-send is why one of its rows is `succeeded`. The terminal line lands in this
  // same list, so it must not contradict the line above it.
  job.output_lines = [
    'The writing service lost track of a writing request after it was sent; Story sends it once more as a fresh request. The safety check "Lost writing request" is set to Off for this channel, so this carries on.',
  ]
  await seed(project.slug, job)
  calls.length = 0

  await jq.getJobs(project.slug)
  await waitFor(
    () => isTerminal(jq.getJob(jobId)?.status),
    { label: 'scene_plan_run with an uncertain sibling reached a terminal state', timeoutMs: 12_000 },
  ).catch(() => {})
  await jq._waitForJobPersistenceForTesting()

  const settled = jq.getJob(jobId)!
  assert.equal(settled.status, 'error', settled.output_lines.join(' | '))
  assert.doesNotMatch(
    String(settled.error), /cancellation/i,
    'no cancellation was requested on this job, so none may be named',
  )
  assert.doesNotMatch(
    String(settled.error), /task failed/i,
    'the recorded outcome is unknown, not a proven provider failure',
  )
  // Positively: it must say what is actually true, not merely avoid the wrong words.
  assert.match(
    String(settled.error), /could not prove whether an earlier request was accepted/i,
    'the unknown outcome must be named as unknown',
  )
  assert.match(
    String(settled.error), /this reconciliation sent no new generation request/i,
    'the "sent nothing" claim must be scoped to this reconciliation',
  )
  // And it must NOT make the unscoped claim: DM0009's own log records an earlier pass re-sending a
  // lost writing request as a fresh one, so an unqualified "did not submit fresh paid work" would
  // contradict the job's own output list a few lines above it.
  assert.doesNotMatch(
    String(settled.error), /did not submit fresh paid work/i,
    'an unqualified claim about Story Studio at large is false on a job that re-sent earlier',
  )
  // The owner reads ONE list. The earlier re-send line and this terminal line must coexist in it.
  const list = settled.output_lines.join('\n')
  assert.match(list, /once more as a fresh request/i, 'the earlier re-send must still be recorded')
  assert.doesNotMatch(list, /did not submit fresh paid work/i, 'nothing in the list may deny that re-send')
  // Unknown outcome means Story Studio must submit nothing new: the request may
  // already have been accepted and charged.
  assert.equal(calls.some(call => call.method !== 'GET'), false, JSON.stringify(calls))
  // The evidence is preserved, including the unknown-outcome row itself.
  assert.ok(settled.genstudio_jobs?.some(entry => entry.id === 'chat-uncertain-1'))
  assert.equal(settled.genstudio_jobs?.find(entry => entry.id === 'chat-uncertain-1')?.state, 'failed')
})

/**
 * The other half of the same message: a genuinely failed provider task on a job
 * with no cancellation context must still fail loudly, and still must not claim a
 * cancellation that never happened.
 */
test('H-17: a proven provider failure with no cancellation context names no cancellation', async () => {
  const project = await pm.createProject({ name: 'Restart scene plan real failure' })
  const jobId = 'restart-scene-plan-failed'
  await seed(project.slug, interruptedJob('scene_plan_run', jobId, project.slug, [
    {
      id: 'chat-settled-2', operation: 'chat.response', state: 'succeeded',
      request_key: 'story-chat-settled-2', updated_at: new Date().toISOString(),
    },
    {
      id: 'chat-failed-2', operation: 'chat.response', state: 'failed',
      failure_code: 'LANGUAGE_PROVIDER_FAILED',
      request_key: 'story-chat-failed-2', updated_at: new Date().toISOString(),
    },
    {
      id: 'chat-inflight-2', operation: 'chat.response', state: 'accepted',
      request_key: 'story-chat-inflight-2', updated_at: new Date().toISOString(),
    },
  ]))
  calls.length = 0

  await jq.getJobs(project.slug)
  await waitFor(
    () => isTerminal(jq.getJob(jobId)?.status),
    { label: 'scene_plan_run with a failed sibling reached a terminal state', timeoutMs: 12_000 },
  ).catch(() => {})
  await jq._waitForJobPersistenceForTesting()

  const settled = jq.getJob(jobId)!
  assert.equal(settled.status, 'error', settled.output_lines.join(' | '))
  assert.doesNotMatch(String(settled.error), /cancellation/i)
  assert.equal(calls.some(call => call.method !== 'GET'), false)
  assert.ok(settled.genstudio_jobs?.some(entry => entry.id === 'chat-failed-2'))
})
