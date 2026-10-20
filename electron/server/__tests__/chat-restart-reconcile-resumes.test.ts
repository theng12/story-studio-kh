/**
 * Production, 2026-10-20 (Story Sprout SS0121 / SS0119, Night Atlas History EP0015).
 *
 * A Scene Plan writing job was running with one Gateway chat request in flight when
 * the app restarted. The boot scan correctly reconciled that request first instead
 * of sending it again (`requiresCancellationReconciliation`). The Gateway then
 * answered `succeeded` for every child, but the packs the job had not yet saved
 * were still missing, so the settlement audit failed and the job was left `error`
 * ("Retry rewrites only those scenes") — its pipeline chain held — even though
 * resuming it is exactly what a restart with nothing in flight does
 * (`bootRecoveryKind` → 'chat'): saved answers kept, earlier requests collected by
 * their saved key, only the missing work asked for.
 *
 * Pinned: once the reconciliation settles every child, an interrupted writing job
 * whose output is still incomplete is picked up again; and until it settles, the
 * prompt updater waits for it (`runningJobsThatWouldNotResume`).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
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
  await setGenStudioUrl('https://chat-restart-reconcile.test')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'chat-restart-reconcile-key')
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

const CHAT_ID = '5b0c1f7e-6d0a-4b8e-9a53-2f4f0c7d9e11'
const CHAT_KEY = 'story-chat-5a1f0c7d9e11b2c3d4e5f60718293a4b5c6d7e8f90a1b2'

function interruptedScenePlan(slug: string): Job {
  const at = '2026-10-20T04:04:38.816Z'
  return {
    job_id: 'scene-plan-interrupted',
    project_slug: slug,
    type: 'scene_plan_run',
    episode_id: 'SS0121',
    title: 'Pipeline: Scene Plan — SS0121',
    status: 'running',
    created_at: at,
    started_at: at,
    finished_at: null,
    error: null,
    output_lines: ['Checkpointed visual-0002: 50/50 prompts verified on disk.'],
    params: { episode_id: 'SS0121', pipeline_step: 'scene_plan', pipeline_requires: [], pipeline_batch_id: 'batch-sp' },
    remote_cancellations: {},
    genstudio_jobs: [{
      id: CHAT_ID,
      operation: 'chat.response',
      state: 'running',
      queue_state: 'running',
      model_id: 'pool::writing-haiku-gemini-luna-ordered',
      request: { method: 'POST', path: '/v1/chat/responses', idempotency_key: CHAT_KEY, captured_at: at },
      updated_at: at,
    }],
  } as unknown as Job
}

test('an interrupted writing job whose Gateway request settled is picked up again, not left in error', async () => {
  const { registerJobCancellationAuditor } = await import('../services/job-cancellation-auditors.js')
  const project = await pm.createProject({ name: 'Restart reconcile resumes' })
  const row = interruptedScenePlan(project.slug)
  await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [row] }))

  let runs = 0
  const restoreExecutor = jq._setExecutorForTesting('scene_plan_run', async () => { runs++ })
  // Output stays incomplete (the later packs were never saved) until the executor has run again.
  registerJobCancellationAuditor('scene_plan_run', async () => (runs === 0
    ? { verdict: 'repair-required', detail: 'Scene plan visual prompts incomplete: 100/276 required item(s) verified.' }
    : 'complete'))

  let gatewayUp = false
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal((init?.method || 'GET').toUpperCase(), 'GET', 'reconciling must never send provider work')
    if (!gatewayUp) throw new TypeError('fetch failed')
    if (new URL(String(input)).pathname === `/v1/chat/responses/${CHAT_ID}`) {
      return Response.json({ id: CHAT_ID, state: 'succeeded', cancellable: false, cancelled: false })
    }
    return Response.json({ code: 'JOB_NOT_FOUND', detail: 'No such job.' }, { status: 404 })
  }
  try {
    await jq.getJobs(project.slug)
    await waitFor(() => jq.getJob(row.job_id)?.output_lines.some(line => /reconciling the existing Gateway request/.test(line)) === true,
      { label: 'the boot scan to reconcile instead of resuming' })

    // While the request is unsettled a restart would not resume this job, so the updater waits for it.
    assert.deepEqual((await jq.runningJobsThatWouldNotResume()).map(job => job.job_id), [row.job_id])
    assert.equal(runs, 0, 'nothing is run again while the earlier request may still be working')

    gatewayUp = true
    await waitFor(() => jq.getJob(row.job_id)?.status === 'done', { label: 'the settled job to be picked up again and finish', timeoutMs: 8_000 })
    await jq._waitForJobPersistenceForTesting()

    const finished = jq.getJob(row.job_id)!
    assert.equal(runs, 1, 'the executor ran once, to collect saved work and ask only for what is missing')
    assert.equal(finished.error, null)
    assert.ok(finished.genstudio_jobs!.every(entry => entry.state === 'succeeded'), 'the settled evidence is kept')
  } finally {
    globalThis.fetch = original
    restoreExecutor()
  }
})
