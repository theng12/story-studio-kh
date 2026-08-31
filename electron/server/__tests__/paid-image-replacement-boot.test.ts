import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import type { Job, PaidImageReplacementAttempt } from '../models/types.js'
import { recordTaskStrict } from '../services/task-manifest.js'
import { waitFor as waitForScheduled } from './_timing.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let fixtureId = 0

const NOW = Date.parse('2026-08-31T12:00:00.000Z')
const DUE = NOW + 30 * 60 * 1_000

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

function paidAttempt(dir: string, state: PaidImageReplacementAttempt['state'] = 'waiting'): PaidImageReplacementAttempt {
  return {
    asset_key: 'scene-001.png',
    manifest_dir: dir,
    manifest_key: 'scene-001.png',
    output_path: path.join(dir, 'scene-001.png'),
    state,
    original_task_id: 'original-task-1',
    original_idempotency_key: 'story-original-1',
    input_hash: 'a'.repeat(64),
    output_selector: { resolution: '1024x1024', aspect_ratio: '1:1', width: 1024, height: 1024, reference_mode: 'normal' },
    reference_inputs: [],
    reference_identity_hash: 'b'.repeat(64),
    failure_code: 'SITE_PLACEMENT_EXHAUSTED',
    reserved_credits: 4,
    settled_credits: 4,
    released_credits: 0,
    terminal_observed_at: new Date(NOW).toISOString(),
    eligible_at: new Date(DUE).toISOString(),
  }
}

function paidJob(projectSlug: string, attempt: PaidImageReplacementAttempt): Job {
  return {
    job_id: `paid-wait-${++fixtureId}`,
    project_slug: projectSlug,
    type: 'continuity_render',
    episode_id: 'EP0001',
    title: 'Paid image wait',
    status: 'running',
    created_at: new Date(NOW - 1_000).toISOString(),
    started_at: new Date(NOW - 500).toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {
      genstudio_recovery: {
        version: 1,
        route: 'genstudio',
        assets: {
          'scene-001.png': {
            operation: 'image',
            idempotency_key: attempt.original_idempotency_key,
            job_id: attempt.original_task_id,
            output_path: attempt.output_path,
            state: 'failed',
          },
        },
      },
    },
    paid_image_replacement: {
      enabled: true,
      wait_minutes: 30,
      max_replacements_per_asset: 1,
      additional_credit_ceiling: 10,
      snapshotted_at: new Date(NOW - 2_000).toISOString(),
    },
    paid_image_replacement_attempts: [attempt],
  }
}

async function seedOriginalManifest(attempt: PaidImageReplacementAttempt): Promise<void> {
  await recordTaskStrict(attempt.manifest_dir, attempt.manifest_key, {
    provider: 'genstudio', task_id: attempt.original_task_id, submitted_at: new Date(NOW - 2_000).toISOString(),
    idempotency_key: attempt.original_idempotency_key, operation: 'image', last_state: 'failed',
    input_hash: attempt.input_hash, original_output_selector: attempt.output_selector,
    original_reference_inputs: attempt.reference_inputs,
    original_reference_identity_hash: attempt.reference_identity_hash,
    original_output_path: attempt.output_path,
  })
}

describe('durable paid image waits across boot', () => {
  test('pure predicate rejects malformed snapshot, terminal, and replacement evidence', () => {
    jq.registerExecutor('continuity_render', async () => {})
    const attempt = paidAttempt(path.join(tempDir, 'predicate'))
    const valid = paidJob('predicate-project', attempt)
    assert.ok(jq.getValidPaidImageWait(valid))
    const cases: Array<[string, (job: Job) => void]> = [
      ['invalid snapshot timestamp', job => { job.paid_image_replacement!.snapshotted_at = 'not-an-iso-time' }],
      ['unrecognized terminal failure', job => { job.paid_image_replacement_attempts![0].failure_code = 'AUTH_FAILED' }],
      ['zero settled wait', job => { job.paid_image_replacement_attempts![0].settled_credits = 0; job.paid_image_replacement_attempts![0].released_credits = 4 }],
      ['quoted commitment remnant', job => { job.paid_image_replacement_attempts![0].quoted_credits = 1 }],
      ['actual settlement remnant', job => { job.paid_image_replacement_attempts![0].actual_settled_credits = 1 }],
    ]
    for (const [label, mutate] of cases) {
      const malformed = structuredClone(valid)
      mutate(malformed)
      assert.equal(jq.getValidPaidImageWait(malformed), null, label)
    }
  })

  test('keeps a valid before-due wait running without consuming an image lane', async () => {
    const project = await pm.createProject({ name: 'paid wait before due' })
    const dir = path.join(tempDir, 'paid-manifests', project.slug)
    const attempt = paidAttempt(dir)
    const job = paidJob(project.slug, attempt)
    await seedOriginalManifest(attempt)
    await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })

    const timers: Array<{ delay: number; callback: () => void }> = []
    const restore = jq._setPaidImageWaitRuntimeForTesting({
      nowMs: () => NOW + 1,
      setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
      clearTimer: () => {},
    })
    try {
      let executions = 0
      jq.registerExecutor('continuity_render', async () => { executions++ })
      await jq.resumeInterruptedJobsAtBoot()
      const restored = jq.getJob(job.job_id)!
      assert.equal(restored.status, 'running')
      assert.equal(restored.finished_at, null)
      assert.equal(restored.started_at, job.started_at)
      assert.deepEqual(restored.paid_image_replacement_attempts, [attempt])
      assert.equal(executions, 0)
      assert.equal(timers.length, 1)
      assert.equal(timers[0].delay, DUE - (NOW + 1))
    } finally { restore() }
  })

  test('moves the same valid due wait into recovery FIFO once without a boot provider call', async () => {
    const project = await pm.createProject({ name: 'paid wait due' })
    const dir = path.join(tempDir, 'paid-manifests', project.slug)
    const attempt = paidAttempt(dir)
    const job = paidJob(project.slug, attempt)
    await seedOriginalManifest(attempt)
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })

    const restore = jq._setPaidImageWaitRuntimeForTesting({ nowMs: () => DUE, setTimer: () => { throw new Error('due wait must not schedule a timer') }, clearTimer: () => {} })
    try {
      let executions = 0
      let started!: () => void
      const startedPromise = new Promise<void>(resolve => { started = resolve })
      jq.registerExecutor('continuity_render', async () => { executions++; started() })
      await jq.resumeInterruptedJobsAtBoot()
      await startedPromise
      const queued = jq.getJob(job.job_id)!
      assert.equal(queued.status, 'running', 'normal pump may admit the same queued recovery record')
      assert.equal(queued.started_at, job.started_at)
      assert.equal(executions, 1)
      await waitForScheduled(() => jq.getJob(job.job_id)?.status === 'done', { label: 'due paid-wait executor completion' })
    } finally { restore() }
  })

})
