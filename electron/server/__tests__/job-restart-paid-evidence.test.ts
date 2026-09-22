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
      return Response.json({
        id: decodeURIComponent(match[1]!), state: 'succeeded', dispatch_state: 'dispatched',
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
      () => isTerminal(jq.getJob(jobId)?.status),
      { label: `${type} reached a terminal state`, timeoutMs: 12_000 },
    ).catch(() => {})
    await jq._waitForJobPersistenceForTesting()

    const settled = jq.getJob(jobId)!
    assert.ok(
      isTerminal(settled.status),
      `${type} was left status=${settled.status} after its provider task settled; `
      + `Retry is refused for a non-terminal row and no reconcile timer remains. `
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
  })
}

test('H-17 control: scene_plan_run has an auditor and does settle honestly', async () => {
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
    () => isTerminal(jq.getJob(jobId)?.status),
    { label: 'scene_plan_run reached a terminal state', timeoutMs: 12_000 },
  )

  const settled = jq.getJob(jobId)!
  assert.equal(settled.status, 'error', 'a settled paid task with no verifiable local output must fail loudly')
  assert.match(String(settled.error), /repair/i)
  assert.equal(calls.some(call => call.method !== 'GET'), false)
})

test('H-17 control: an interrupted job with no durable evidence keeps the plain restart error', async () => {
  const project = await pm.createProject({ name: 'Restart no evidence' })
  const jobId = 'restart-no-evidence'
  await seed(project.slug, interruptedJob('metadata', jobId, project.slug, []))
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
    () => isTerminal(jq.getJob(jobId)?.status),
    { label: 'retry-admission row settled', timeoutMs: 12_000 },
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
})
