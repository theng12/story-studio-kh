import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import type { Job, PaidImageReplacementAttempt } from '../models/types.js'
import { readManifest, recordTaskStrict } from '../services/task-manifest.js'
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

function waitForUpdate(jobId: string, status: Job['status']): Promise<Job> {
  return new Promise(resolve => {
    const onUpdate = (job: Job) => {
      if (job.job_id !== jobId || job.status !== status) return
      jq.jobEvents.off('update', onUpdate)
      resolve(job)
    }
    jq.jobEvents.on('update', onUpdate)
  })
}

function applyPaidWait(job: Job, attempt: PaidImageReplacementAttempt): void {
  const template = paidJob(job.project_slug, attempt)
  job.params = template.params
  job.paid_image_replacement = template.paid_image_replacement
  job.paid_image_replacement_attempts = template.paid_image_replacement_attempts
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
  test('pure predicate rejects every jobs.json clause and preserves the waiting source order', () => {
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
      ['not running', job => { job.status = 'queued' }],
      ['completed', job => { job.finished_at = new Date(NOW).toISOString() }],
      ['policy disabled', job => { job.paid_image_replacement!.enabled = false }],
      ['wrong wait duration', job => { (job.paid_image_replacement! as any).wait_minutes = 29 }],
      ['bad attempt identity', job => { job.paid_image_replacement_attempts![0].original_task_id = '' }],
      ['bad selector', job => { job.paid_image_replacement_attempts![0].output_selector.width = 0 }],
      ['unbalanced settlement', job => { job.paid_image_replacement_attempts![0].released_credits = 3 }],
      ['wrong due time', job => { job.paid_image_replacement_attempts![0].eligible_at = new Date(DUE + 1).toISOString() }],
      ['checkpoint mismatch', job => { (job.params as any).genstudio_recovery.assets['scene-001.png'].job_id = 'other-task' }],
      ['two waiting attempts', job => { job.paid_image_replacement_attempts!.push(structuredClone(job.paid_image_replacement_attempts![0])) }],
    ]
    for (const [label, mutate] of cases) {
      const malformed = structuredClone(valid)
      mutate(malformed)
      assert.equal(jq.getValidPaidImageWait(malformed), null, label)
    }
    const ordered = structuredClone(valid)
    const later = structuredClone(ordered.paid_image_replacement_attempts![0])
    later.asset_key = 'scene-002.png'
    later.state = 'failed'
    ordered.paid_image_replacement_attempts!.push(later)
    assert.equal(jq.getValidPaidImageWait(ordered)?.attempt.asset_key, 'scene-001.png')
  })

  test('paid-wait executor result stays running, schedules once, releases its lane, and does not chain', async () => {
    const project = await pm.createProject({ name: 'paid result boundary' })
    const dir = path.join(tempDir, 'paid-manifests', project.slug)
    const attempt = paidAttempt(dir)
    await seedOriginalManifest(attempt)
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
    const timers: Array<{ callback: () => void; delay: number }> = []
    let scheduled!: () => void
    const restore = jq._setPaidImageWaitRuntimeForTesting({
      nowMs: () => NOW,
      setTimer: (callback, delay) => { timers.push({ callback, delay }); scheduled(); return timers.length },
      clearTimer: () => {},
    })
    try {
      let calls = 0
      const scheduledPromise = new Promise<void>(resolve => { scheduled = resolve })
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug !== project.slug) return
        if (running.episode_id === 'EP-FOLLOWER') return
        calls++
        applyPaidWait(running, attempt)
        return { kind: 'paid-image-wait' }
      })
      const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'continuity_render', episode_id: 'EP-RESULT', title: 'result boundary', params: { pipeline_chain: [{ type: 'script-only' }] } })
      await scheduledPromise
      assert.equal(calls, 1)
      assert.equal(jq.getJob(job.job_id)?.status, 'running')
      assert.equal(timers.length, 1)
      assert.equal((await jq.getJobs(project.slug)).length, 1, 'no pipeline handoff may run')
      const follower = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'continuity_render', episode_id: 'EP-FOLLOWER', title: 'lane released', params: {} })
      const done = waitForUpdate(follower.job_id, 'done')
      await done
    } finally { restore() }
  })

  test('a revoked paid-wait result is terminal fail-closed with no retry or timer', async () => {
    const project = await pm.createProject({ name: 'revoked paid result' })
    const attempt = paidAttempt(path.join(tempDir, 'revoked-manifest'))
    attempt.failure_code = 'AUTH_FAILED'
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
    const timers: unknown[] = []
    const restore = jq._setPaidImageWaitRuntimeForTesting({ nowMs: () => NOW, setTimer: timer => { timers.push(timer); return timers.length }, clearTimer: () => {} })
    try {
      let calls = 0
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug !== project.slug) return
        calls++
        applyPaidWait(running, attempt)
        return { kind: 'paid-image-wait' }
      })
      const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'continuity_render', episode_id: 'EP-REVOKED', title: 'revoked', params: {} })
      const terminal = await waitForUpdate(job.job_id, 'error')
      assert.equal(calls, 1)
      assert.equal(terminal.auto_retry?.attempt, 1)
      assert.equal(timers.length, 0)
      assert.match(terminal.error || '', /No automatic retry/)
    } finally { restore() }
  })

  test('Off, pause, and duplicate delivery clear or reject a durable wait without a provider call', async () => {
    const project = await pm.createProject({ name: 'paid wait cleanup' })
    const dir = path.join(tempDir, 'paid-manifests', project.slug)
    const attempt = paidAttempt(dir)
    const job = paidJob(project.slug, attempt)
    await seedOriginalManifest(attempt)
    await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))
    const timers: Array<{ callback: () => void }> = []
    let cleared = 0
    let now = NOW
    const restore = jq._setPaidImageWaitRuntimeForTesting({
      nowMs: () => now,
      setTimer: callback => { timers.push({ callback }); return timers.length },
      clearTimer: () => { cleared++ },
    })
    try {
      let calls = 0
      jq.registerExecutor('continuity_render', async () => { calls++ })
      await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
      await jq.resumeInterruptedJobsAtBoot()
      assert.equal(timers.length, 1)
      await jq.pauseJob(job.job_id, 'manual')
      assert.equal(cleared, 1)
      now = DUE
      timers[0].callback()
      timers[0].callback()
      await Promise.resolve()
      assert.equal(calls, 0)
      await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 10 })
      await Promise.resolve()
      assert.equal(calls, 0)
    } finally { restore() }
  })

  test('jobs.json repairs only the approved committed and submitted manifest mirror', async () => {
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
    for (const state of ['committed', 'submitted'] as const) {
      const project = await pm.createProject({ name: `paid ${state} repair` })
      const dir = path.join(tempDir, 'paid-manifests', project.slug)
      const attempt = paidAttempt(dir, state)
      attempt.replacement_scope = `scope-${state}`
      attempt.quoted_credits = 3
      attempt.price_version = 'price-v1'
      attempt.replacement_committed_at = new Date(NOW).toISOString()
      if (state === 'submitted') attempt.replacement_task_id = 'replacement-task-owned-by-jobs'
      const job = paidJob(project.slug, attempt)
      job.output_dir = dir
      await seedOriginalManifest(attempt)
      await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))
      let admitted!: () => void
      const admittedPromise = new Promise<void>(resolve => { admitted = resolve })
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug === project.slug) admitted()
      })
      await jq.resumeInterruptedJobsAtBoot()
      await admittedPromise
      const entry = (await readManifest(dir)).tasks[attempt.manifest_key]!
      assert.equal(entry.replacement_of_task_id, attempt.original_task_id)
      assert.equal(entry.replacement_scope, attempt.replacement_scope)
      assert.equal(entry.replacement_quoted_credits, attempt.quoted_credits)
      assert.equal(entry.replacement_price_version, attempt.price_version)
      assert.equal(entry.replacement_committed_at, attempt.replacement_committed_at)
      assert.equal((entry as any).replacement_task_id, undefined, 'submitted task identity remains jobs.json-only')
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
