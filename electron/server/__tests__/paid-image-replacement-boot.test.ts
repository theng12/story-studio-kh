import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import type { Job, PaidImageReplacementAttempt } from '../models/types.js'
import { readManifest, recordPaidImageReplacementStrict, recordTaskStrict } from '../services/task-manifest.js'
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

function committedJob(
  projectSlug: string,
  attempt: PaidImageReplacementAttempt,
  state: 'committed' | 'submitted' = 'committed',
): Job {
  attempt.state = state
  attempt.replacement_scope = `scope-${state}`
  attempt.quoted_credits = 3
  attempt.price_version = 'price-v1'
  attempt.replacement_committed_at = new Date(NOW).toISOString()
  if (state === 'submitted') attempt.replacement_task_id = 'replacement-task-1'
  return paidJob(projectSlug, attempt)
}

function addReplacementEvidence(job: Job, taskId = 'replacement-task-1'): void {
  job.genstudio_jobs = [{
    id: taskId,
    operation: 'image.generation',
    state: 'succeeded',
    updated_at: new Date(NOW).toISOString(),
  }]
}

async function writePersistedJob(job: Job): Promise<void> {
  await fs.writeFile(
    path.join(tempDir, 'projects', job.project_slug, 'jobs.json'),
    JSON.stringify({ jobs: [job] }),
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve }
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
      // The updater's idle gate reads this: before the boot scan the queue only looks empty.
      assert.equal(jq.areBootJobsLoaded(), false)
      await jq.resumeInterruptedJobsAtBoot()
      assert.equal(jq.areBootJobsLoaded(), true)
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

  test('each committed manifest remnant blocks a waiting timer and requeue', async () => {
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
    const remnants: Array<[string, Record<string, unknown>]> = [
      ['replacement_of_task_id', { replacement_of_task_id: 'replacement-of-original' }],
      ['replacement_scope', { replacement_scope: 'paid:scope' }],
      ['replacement_quoted_credits', { replacement_quoted_credits: 3 }],
      ['replacement_price_version', { replacement_price_version: 'price-v1' }],
      ['replacement_committed_at', { replacement_committed_at: new Date(NOW).toISOString() }],
    ]
    for (const [name, remnant] of remnants) {
      const project = await pm.createProject({ name: `manifest remnant ${name}` })
      const dir = path.join(tempDir, 'paid-manifests', project.slug)
      const attempt = paidAttempt(dir)
      const job = paidJob(project.slug, attempt)
      job.output_dir = dir
      await seedOriginalManifest(attempt)
      const entry = (await readManifest(dir)).tasks[attempt.manifest_key]!
      await recordPaidImageReplacementStrict(dir, attempt.manifest_key, { ...entry, ...remnant } as any)
      await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))
      const timers: unknown[] = []
      const restore = jq._setPaidImageWaitRuntimeForTesting({ nowMs: () => NOW, setTimer: timer => { timers.push(timer); return timers.length }, clearTimer: () => {} })
      try {
        jq.registerExecutor('continuity_render', async () => {})
        await jq.resumeInterruptedJobsAtBoot()
        assert.equal(timers.length, 0, name)
        assert.notEqual(jq.getJob(job.job_id)?.status, 'queued', name)
      } finally { restore() }
    }
  })

  test('jobs.json repairs only the approved committed and submitted manifest mirror', async () => {
    const settings = await import('../services/app-settings.js')
    for (const state of ['committed', 'submitted'] as const) {
      await settings.setPaidImageReplacementSetting({ enabled: state === 'committed', additional_credit_ceiling: 10 })
      const project = await pm.createProject({ name: `paid ${state} repair` })
      const { resolveContinuityRenderOutputDir } = await import('../generators/continuity-render.js')
      const dir = await resolveContinuityRenderOutputDir(project.slug, 'EP0001')
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
      let admissions = 0
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug === project.slug) admissions++
      })
      await jq.resumeInterruptedJobsAtBoot()
      await waitForScheduled(() => admissions === 1, { label: `${state} restart repair admission` })
      const entry = (await readManifest(dir)).tasks[attempt.manifest_key]!
      assert.equal(entry.replacement_of_task_id, attempt.original_task_id)
      assert.equal(entry.replacement_scope, attempt.replacement_scope)
      assert.equal(entry.replacement_quoted_credits, attempt.quoted_credits)
      assert.equal(entry.replacement_price_version, attempt.price_version)
      assert.equal(entry.replacement_committed_at, attempt.replacement_committed_at)
      assert.equal((entry as any).replacement_task_id, undefined, 'submitted task identity remains jobs.json-only')
    }
  })

  test('current machine Off holds a committed restart record without requeueing it', async () => {
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 10 })
    const project = await pm.createProject({ name: 'paid committed restart Off' })
    const { resolveContinuityRenderOutputDir } = await import('../generators/continuity-render.js')
    const dir = await resolveContinuityRenderOutputDir(project.slug, 'EP0001')
    const attempt = paidAttempt(dir, 'committed')
    const job = committedJob(project.slug, attempt)
    job.output_dir = dir
    await seedOriginalManifest(attempt)
    await writePersistedJob(job)
    let executions = 0
    let queuedPersists = 0
    const releaseExecutor = deferred()
    const restore = jq._setPaidImageWaitRuntimeForTesting({
      persistWait: async candidate => {
        if (candidate.job_id === job.job_id && candidate.status === 'queued') queuedPersists++
      },
    })
    jq.registerExecutor('continuity_render', async running => {
      if (running.project_slug === project.slug) {
        executions++
        await releaseExecutor.promise
      }
    })
    try {
      await jq.resumeInterruptedJobsAtBoot()
      await Promise.resolve()

      assert.equal(queuedPersists, 0, 'Off prevents even the durable restart requeue transition')
      assert.equal(executions, 0, 'restart recovery cannot re-admit committed paid work while current setting is Off')
      const held = jq.getJob(job.job_id)!
      assert.equal(held.status, 'running')
      assert.equal(held.finished_at, null)
      assert.equal(held.paid_image_replacement_attempts?.[0]?.state, 'committed')

      const settings = await import('../services/app-settings.js')
      await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
      await waitForScheduled(() => executions === 1, { label: 'Off-held committed restart re-admission after setting On' })
      assert.equal(queuedPersists, 1)
      assert.equal(jq.getJob(job.job_id)?.paid_image_replacement_attempts?.[0]?.state, 'committed')

      await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
      const flushSettingReconciliation = (jq as any)._awaitPaidImageSettingReconciliationForTesting
      assert.equal(typeof flushSettingReconciliation, 'function')
      await flushSettingReconciliation()
      releaseExecutor.resolve()
      await waitForScheduled(() => jq.getJob(job.job_id)?.status === 'done', { label: 're-enabled committed restart completion' })
      assert.equal(queuedPersists, 1, 'repeated On writes cannot durably requeue the same commitment twice')
      assert.equal(executions, 1, 'repeated On writes cannot execute the same commitment twice')
    } finally { restore() }
  })

  test('canonical repair rejects conflicting roots, manifest authority, and submitted task mismatches', async () => {
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
    const { resolveContinuityRenderOutputDir } = await import('../generators/continuity-render.js')
    const pools = await import('../services/broll-pool-manager.js')
    const cases: Array<{ name: string; setup: () => Promise<Job> }> = [
      {
        name: 'conflicting continuity output_dir',
        setup: async () => {
          const project = await pm.createProject({ name: 'repair conflicting continuity output' })
          const root = await resolveContinuityRenderOutputDir(project.slug, 'EP0001')
          const attempt = paidAttempt(root, 'committed')
          const job = committedJob(project.slug, attempt)
          job.output_dir = path.join(tempDir, 'wrong-continuity-output')
          addReplacementEvidence(job)
          await seedOriginalManifest(attempt)
          return job
        },
      },
      {
        name: 'wrong continuity canonical path',
        setup: async () => {
          const project = await pm.createProject({ name: 'repair wrong continuity root' })
          const canonical = await resolveContinuityRenderOutputDir(project.slug, 'EP0001')
          const attempt = paidAttempt(path.join(canonical, 'foreign'), 'committed')
          const job = committedJob(project.slug, attempt)
          job.output_dir = canonical
          addReplacementEvidence(job)
          await seedOriginalManifest(attempt)
          return job
        },
      },
      {
        name: 'wrong thumbnail root',
        setup: async () => {
          const project = await pm.createProject({ name: 'repair wrong thumbnail root' })
          const attempt = paidAttempt(path.join(tempDir, 'wrong-thumb-root'), 'committed')
          const job = committedJob(project.slug, attempt)
          job.type = 'thumb_images'
          addReplacementEvidence(job)
          await seedOriginalManifest(attempt)
          return job
        },
      },
      {
        name: 'wrong image-pool root',
        setup: async () => {
          const project = await pm.createProject({ name: 'repair wrong image pool root' })
          const root = path.join(tempDir, 'image-pool-root')
          await fs.mkdir(root, { recursive: true })
          const pool = await pools.createPool({ name: `repair-image-${fixtureId}`, folder_path: root, media: 'image' })
          const attempt = paidAttempt(path.join(tempDir, 'wrong-image-pool-root'), 'committed')
          const job = committedJob(project.slug, attempt)
          job.type = 'image_pool_generate'
          job.params = { ...job.params, pool_id: pool.id, run_id: 'stable-run' }
          addReplacementEvidence(job)
          await seedOriginalManifest(attempt)
          return job
        },
      },
      {
        name: 'non-image pool',
        setup: async () => {
          const project = await pm.createProject({ name: 'repair non image pool' })
          const root = path.join(tempDir, 'video-pool-root')
          await fs.mkdir(root, { recursive: true })
          const pool = await pools.createPool({ name: `repair-video-${fixtureId}`, folder_path: root, media: 'video' })
          const attempt = paidAttempt(root, 'committed')
          const job = committedJob(project.slug, attempt)
          job.type = 'image_pool_generate'
          job.params = { ...job.params, pool_id: pool.id, run_id: 'stable-run' }
          addReplacementEvidence(job)
          await seedOriginalManifest(attempt)
          return job
        },
      },
      {
        name: 'conflicting manifest commitment',
        setup: async () => {
          const project = await pm.createProject({ name: 'repair manifest conflict' })
          const root = await resolveContinuityRenderOutputDir(project.slug, 'EP0001')
          const attempt = paidAttempt(root, 'committed')
          const job = committedJob(project.slug, attempt)
          job.output_dir = root
          addReplacementEvidence(job)
          await seedOriginalManifest(attempt)
          const entry = (await readManifest(root)).tasks[attempt.manifest_key]!
          await recordPaidImageReplacementStrict(root, attempt.manifest_key, {
            ...entry,
            replacement_of_task_id: attempt.original_task_id,
            replacement_scope: 'conflicting-scope',
          })
          return job
        },
      },
      {
        name: 'manifest-only commitment',
        setup: async () => {
          const project = await pm.createProject({ name: 'repair manifest only authority' })
          const root = await resolveContinuityRenderOutputDir(project.slug, 'EP0001')
          const attempt = paidAttempt(root)
          const job = paidJob(project.slug, attempt)
          job.output_dir = root
          addReplacementEvidence(job)
          await seedOriginalManifest(attempt)
          const entry = (await readManifest(root)).tasks[attempt.manifest_key]!
          await recordPaidImageReplacementStrict(root, attempt.manifest_key, {
            ...entry,
            replacement_of_task_id: attempt.original_task_id,
            replacement_scope: 'manifest-only-scope',
          })
          return job
        },
      },
      {
        name: 'submitted task evidence mismatch',
        setup: async () => {
          const project = await pm.createProject({ name: 'repair submitted mismatch' })
          const root = await resolveContinuityRenderOutputDir(project.slug, 'EP0001')
          const attempt = paidAttempt(root, 'submitted')
          const job = committedJob(project.slug, attempt, 'submitted')
          job.output_dir = root
          addReplacementEvidence(job, 'different-replacement-task')
          await seedOriginalManifest(attempt)
          return job
        },
      },
    ]

    for (const scenario of cases) {
      const job = await scenario.setup()
      await writePersistedJob(job)
      let executions = 0
      jq.registerExecutor(job.type, async running => {
        if (running.project_slug === job.project_slug) executions++
      })
      await jq.resumeInterruptedJobsAtBoot()
      assert.equal(executions, 0, scenario.name)
      assert.equal(jq.getJob(job.job_id)?.status, 'error', scenario.name)
    }

    const matchingProject = await pm.createProject({ name: 'repair submitted match' })
    const matchingRoot = await resolveContinuityRenderOutputDir(matchingProject.slug, 'EP0001')
    const matchingAttempt = paidAttempt(matchingRoot, 'submitted')
    const matchingJob = committedJob(matchingProject.slug, matchingAttempt, 'submitted')
    matchingJob.output_dir = matchingRoot
    addReplacementEvidence(matchingJob, matchingAttempt.replacement_task_id!)
    await seedOriginalManifest(matchingAttempt)
    await writePersistedJob(matchingJob)
    let matchingExecutions = 0
    const matchingStarted = deferred()
    jq.registerExecutor('continuity_render', async running => {
      if (running.project_slug === matchingProject.slug) {
        matchingExecutions++
        matchingStarted.resolve()
      }
    })
    await jq.resumeInterruptedJobsAtBoot()
    await matchingStarted.promise
    assert.equal(matchingExecutions, 1, 'matching submitted jobs.json evidence repairs and resumes')
  })

  test('paid-result persistence, emission, and timer faults fail closed without retry or downstream work', async () => {
    const failures = ['persist', 'emit', 'timer'] as const
    for (const failure of failures) {
      const project = await pm.createProject({ name: `paid result ${failure} fault` })
      const root = path.join(tempDir, 'paid-result-faults', project.slug)
      const attempt = paidAttempt(root)
      await seedOriginalManifest(attempt)
      await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
      let executions = 0
      let scheduleObserved!: () => void
      const scheduleObservedPromise = new Promise<void>(resolve => { scheduleObserved = resolve })
      const failureObserved = deferred()
      let persistCalls = 0
      const restore = jq._setPaidImageWaitRuntimeForTesting({
        nowMs: () => NOW,
        persistWait: async () => {
          persistCalls++
          if (persistCalls === 2) failureObserved.resolve()
          if (failure === 'persist') throw new Error('injected paid-result persist fault')
        },
        emitWait: () => {
          if (failure === 'emit') throw new Error('injected paid-result subscriber fault')
        },
        setTimer: () => {
          scheduleObserved()
          if (failure === 'timer') throw new Error('injected paid-result timer fault')
          return 1
        },
        clearTimer: () => {},
      })
      try {
        jq.registerExecutor('continuity_render', async running => {
          if (running.project_slug !== project.slug) return
          executions++
          applyPaidWait(running, attempt)
          running.result = { complete: false }
          return { kind: 'paid-image-wait' }
        })
        const job = jq.enqueuePreparedForTest({
          project_slug: project.slug,
          type: 'continuity_render',
          episode_id: 'EP-FAULT',
          title: failure,
          params: { pipeline_chain: [{ type: 'script-only' }] },
        })
        if (failure === 'timer') await scheduleObservedPromise
        await failureObserved.promise
        const terminal = jq.getJob(job.job_id)!
        assert.equal(executions, 1, failure)
        assert.equal(terminal.status, 'error', failure)
        assert.equal(terminal.local_execution_complete, false, failure)
        assert.equal(terminal.auto_retry?.attempt, 1, failure)
        assert.match(terminal.error || '', /No automatic retry/, failure)
        assert.equal((await jq.getJobs(project.slug)).length, 1, `${failure}: no completion/finalizer/pipeline job`)
      } finally { restore() }
    }
  })

  test('a valid paid-result snapshot is persisted and emitted as exact running null false state', async () => {
    const project = await pm.createProject({ name: 'paid result exact snapshot' })
    const root = path.join(tempDir, 'paid-result-exact', project.slug)
    const attempt = paidAttempt(root)
    await seedOriginalManifest(attempt)
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
    const persisted: Job[] = []
    const emitted: Job[] = []
    let scheduled!: () => void
    const scheduledPromise = new Promise<void>(resolve => { scheduled = resolve })
    const restore = jq._setPaidImageWaitRuntimeForTesting({
      nowMs: () => NOW,
      persistWait: async (job: Job) => { persisted.push(structuredClone(job)) },
      emitWait: (job: Job) => { emitted.push(structuredClone(job)) },
      setTimer: () => { scheduled(); return 1 },
      clearTimer: () => {},
    })
    try {
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug !== project.slug) return
        applyPaidWait(running, attempt)
        return { kind: 'paid-image-wait' }
      })
      const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'continuity_render', episode_id: 'EP-EXACT', title: 'exact', params: {} })
      await scheduledPromise
      assert.deepEqual(
        persisted.map(job => [job.status, job.finished_at, job.local_execution_complete]),
        [['running', null, false]],
      )
      assert.deepEqual(
        emitted.map(job => [job.status, job.finished_at, job.local_execution_complete]),
        [['running', null, false]],
      )
      assert.equal(jq.isDuplicate(project.slug, job.episode_id, job.type), true)
    } finally { restore() }
  })

  test('boot and duplicate due delivery wait for one durable requeue and preserve recovery FIFO', async () => {
    jq.setImageEpisodeConcurrency(1)
    const blockerProject = await pm.createProject({ name: 'paid due race blocker' })
    const paidProject = await pm.createProject({ name: 'paid due race recovery' })
    const root = path.join(tempDir, 'paid-due-race', paidProject.slug)
    const attempt = paidAttempt(root)
    const paid = paidJob(paidProject.slug, attempt)
    await seedOriginalManifest(attempt)
    await writePersistedJob(paid)
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })

    const blockerRelease = deferred()
    const blockerStarted = deferred()
    const paidStarted = deferred()
    const freshStarted = deferred()
    const order: string[] = []
    jq.registerExecutor('continuity_render', async running => {
      if (running.project_slug === blockerProject.slug && running.episode_id === 'BLOCK') {
        order.push('blocker')
        blockerStarted.resolve()
        await blockerRelease.promise
      } else if (running.job_id === paid.job_id) {
        order.push('paid')
        assert.equal(running.started_at, paid.started_at)
        paidStarted.resolve()
      } else if (running.project_slug === blockerProject.slug && running.episode_id === 'FRESH') {
        order.push('fresh')
        freshStarted.resolve()
      }
    })
    jq.enqueuePreparedForTest({ project_slug: blockerProject.slug, type: 'continuity_render', episode_id: 'BLOCK', title: 'blocker', params: {} })
    await blockerStarted.promise
    jq.enqueuePreparedForTest({ project_slug: blockerProject.slug, type: 'continuity_render', episode_id: 'FRESH', title: 'fresh', params: {} })

    let now = NOW
    const timers: Array<() => void> = []
    const persistEntered = deferred()
    const persistRelease = deferred()
    const requeueInserted = deferred()
    let paidPersists = 0
    const restore = jq._setPaidImageWaitRuntimeForTesting({
      nowMs: () => now,
      setTimer: callback => { timers.push(callback); return timers.length },
      clearTimer: () => {},
      persistWait: async job => {
        if (job.job_id !== paid.job_id || job.status !== 'queued') return
        paidPersists++
        persistEntered.resolve()
        await persistRelease.promise
        await jq.checkpointJobState(job)
      },
      emitWait: job => { if (job.job_id === paid.job_id && job.status === 'queued') requeueInserted.resolve() },
    })
    try {
      await jq.resumeInterruptedJobsAtBoot()
      assert.equal(timers.length, 1)
      now = DUE
      timers[0]()
      timers[0]()
      const repeatedBoot = jq.resumeInterruptedJobsAtBoot()
      await persistEntered.promise
      assert.equal(order.includes('paid'), false, 'persistence must finish before enqueue')
      assert.equal(jq.getJob(paid.job_id)?.status, 'running')
      persistRelease.resolve()
      await repeatedBoot
      await requeueInserted.promise
      blockerRelease.resolve()
      await paidStarted.promise
      await freshStarted.promise
      assert.equal(paidPersists, 1)
      assert.deepEqual(order, ['blocker', 'paid', 'fresh'])
    } finally {
      blockerRelease.resolve()
      persistRelease.resolve()
      restore()
      jq.setImageEpisodeConcurrency(1)
    }
  })

  test('a due requeue persistence failure never inserts or executes the paid job', async () => {
    const project = await pm.createProject({ name: 'paid due persistence failure' })
    const root = path.join(tempDir, 'paid-due-persist-failure', project.slug)
    const attempt = paidAttempt(root)
    const job = paidJob(project.slug, attempt)
    await seedOriginalManifest(attempt)
    await writePersistedJob(job)
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
    let now = NOW
    const timers: Array<() => void> = []
    let executions = 0
    const persistAttempted = deferred()
    const restore = jq._setPaidImageWaitRuntimeForTesting({
      nowMs: () => now,
      setTimer: callback => { timers.push(callback); return timers.length },
      clearTimer: () => {},
      persistWait: async queued => {
        if (queued.job_id === job.job_id && queued.status === 'queued') {
          persistAttempted.resolve()
          throw new Error('injected due persistence failure')
        }
      },
      emitWait: () => {},
    })
    try {
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug === project.slug) executions++
      })
      await jq.resumeInterruptedJobsAtBoot()
      now = DUE
      timers[0]()
      await persistAttempted.promise
      await Promise.resolve()
      assert.equal(executions, 0)
      assert.equal(jq.getJob(job.job_id)?.status, 'running')
      const durable = JSON.parse(await fs.readFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), 'utf8')).jobs[0]
      assert.equal(durable.status, 'running')
      assert.deepEqual(durable.paid_image_replacement_attempts, [attempt])
    } finally { restore() }
  })

  test('loader precedence is pause, paid wait, ordinary recovery, reconciliation, then generic terminalization', async () => {
    await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
    const pausedProject = await pm.createProject({ name: 'paid loader pause precedence' })
    const pausedRoot = path.join(tempDir, 'paid-loader-pause', pausedProject.slug)
    const pausedAttempt = paidAttempt(pausedRoot)
    const paused = paidJob(pausedProject.slug, pausedAttempt)
    paused.pause_requested = true
    await seedOriginalManifest(pausedAttempt)
    await writePersistedJob(paused)

    const paidProject = await pm.createProject({ name: 'paid loader wait precedence' })
    const paidRoot = path.join(tempDir, 'paid-loader-wait', paidProject.slug)
    const paidAttemptFixture = paidAttempt(paidRoot)
    const paid = paidJob(paidProject.slug, paidAttemptFixture)
    await seedOriginalManifest(paidAttemptFixture)
    await writePersistedJob(paid)

    const recoveryProject = await pm.createProject({ name: 'paid loader recovery precedence' })
    const recoveryRoot = path.join(tempDir, 'paid-loader-recovery', recoveryProject.slug)
    const recoveryAttempt = paidAttempt(recoveryRoot, 'failed')
    const recovery = paidJob(recoveryProject.slug, recoveryAttempt)
    addReplacementEvidence(recovery)
    await seedOriginalManifest(recoveryAttempt)
    await writePersistedJob(recovery)

    const reconciliationProject = await pm.createProject({ name: 'paid loader reconciliation precedence' })
    const reconciliation: Job = {
      job_id: `reconciliation-${++fixtureId}`,
      project_slug: reconciliationProject.slug,
      type: 'audio',
      episode_id: 'EP0001',
      title: 'Reconcile accepted provider work',
      status: 'running',
      created_at: new Date(NOW - 1_000).toISOString(),
      started_at: new Date(NOW - 500).toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
      genstudio_jobs: [{
        id: 'provider-stage-1', operation: 'voice.tts', state: 'accepted', updated_at: new Date(NOW).toISOString(),
      }],
    }
    await writePersistedJob(reconciliation)

    const terminalProject = await pm.createProject({ name: 'paid loader generic terminalization precedence' })
    const terminal: Job = {
      job_id: `terminal-${++fixtureId}`,
      project_slug: terminalProject.slug,
      // Writing steps are picked up again at boot since R2; paid thumbnails are not.
      type: 'thumb_images',
      episode_id: 'EP0001',
      title: 'Interrupted local work',
      status: 'running',
      created_at: new Date(NOW - 1_000).toISOString(),
      started_at: new Date(NOW - 500).toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
    }
    await writePersistedJob(terminal)

    const timers: string[] = []
    const recoveryStarted = deferred()
    const recoveryRelease = deferred()
    const traces = new Map<string, string[]>()
    const restore = jq._setPaidImageWaitRuntimeForTesting({
      nowMs: () => NOW,
      setTimer: (_callback, _delay) => { timers.push('timer'); return timers.length },
      clearTimer: () => {},
    })
    const restoreTrace = jq._observePersistedRunningJobLoadStagesForTesting((jobId, stage) => {
      const stages = traces.get(jobId) || []
      stages.push(stage)
      traces.set(jobId, stages)
    })
    try {
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug !== recoveryProject.slug) return
        recoveryStarted.resolve()
        await recoveryRelease.promise
      })
      jq.registerExecutor('audio', async () => {})
      jq.registerExecutor('chapter-only', async () => {})
      await jq.resumeInterruptedJobsAtBoot()
      await recoveryStarted.promise

      assert.equal(jq.getJob(paused.job_id)?.status, 'paused')
      assert.equal(jq.getJob(paid.job_id)?.status, 'running')
      assert.equal(jq.getJob(recovery.job_id)?.status, 'running')
      assert.equal(jq.getJob(recovery.job_id)?.finished_at, null)
      assert.equal(jq.getJob(reconciliation.job_id)?.status, 'running')
      assert.equal(jq.getJob(reconciliation.job_id)?.local_execution_complete, true)
      assert.equal(jq.getJob(terminal.job_id)?.status, 'error')
      assert.equal(jq.getJob(terminal.job_id)?.error, 'Interrupted by app restart')
      assert.equal(timers.length, 1, 'only the valid unpaused paid wait schedules')

      assert.deepEqual(traces.get(paused.job_id), ['pause-requested'])
      assert.deepEqual(traces.get(paid.job_id), ['pause-requested', 'paid-image-wait'])
      assert.deepEqual(traces.get(recovery.job_id), ['pause-requested', 'paid-image-wait', 'ordinary-recovery'])
      assert.deepEqual(traces.get(reconciliation.job_id), [
        'pause-requested', 'paid-image-wait', 'ordinary-recovery', 'cancellation-reconciliation',
      ])
      assert.deepEqual(traces.get(terminal.job_id), [
        'pause-requested', 'paid-image-wait', 'ordinary-recovery', 'cancellation-reconciliation', 'interrupted-terminalization',
      ])
    } finally {
      recoveryRelease.resolve()
      await jq.forceAbandonJob(reconciliation.project_slug, reconciliation.job_id).catch(() => {})
      restoreTrace()
      restore()
    }
  })

  test('independent Off, pause, terminal clear, commitment, requeue, and invalidation paths remove due work safely', async (suite) => {
    const bootWait = async (name: string) => {
      const project = await pm.createProject({ name })
      const root = path.join(tempDir, 'paid-cleanup-matrix', project.slug)
      const attempt = paidAttempt(root)
      const job = paidJob(project.slug, attempt)
      await seedOriginalManifest(attempt)
      await writePersistedJob(job)
      await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 10 })
      let now = NOW
      const timers: Array<() => void> = []
      let cleared = 0
      const timerCleared = deferred()
      let executions = 0
      const executed = deferred()
      const restore = jq._setPaidImageWaitRuntimeForTesting({
        nowMs: () => now,
        setTimer: callback => { timers.push(callback); return timers.length },
        clearTimer: () => { cleared++; timerCleared.resolve() },
      })
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug === project.slug) {
          executions++
          executed.resolve()
        }
      })
      await jq.resumeInterruptedJobsAtBoot()
      assert.equal(timers.length, 1)
      return {
        project, root, attempt, job, timers,
        due: () => { now = DUE },
        executions: () => executions,
        cleared: () => cleared,
        timerCleared,
        executed,
        restore,
      }
    }

    await suite.test('Off', async () => {
      const fixture = await bootWait('cleanup Off')
      try {
        await (await import('../services/app-settings.js')).setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 10 })
        await fixture.timerCleared.promise
        fixture.due()
        fixture.timers[0]()
        await Promise.resolve()
        assert.equal(fixture.executions(), 0)
        const durable = JSON.parse(await fs.readFile(path.join(tempDir, 'projects', fixture.project.slug, 'jobs.json'), 'utf8')).jobs[0]
        assert.deepEqual(durable.paid_image_replacement_attempts, [fixture.attempt])
        assert.ok((await readManifest(fixture.root)).tasks[fixture.attempt.manifest_key])
      } finally { fixture.restore() }
    })

    await suite.test('pause', async () => {
      const fixture = await bootWait('cleanup pause')
      try {
        await jq.pauseJob(fixture.job.job_id, 'manual')
        assert.equal(fixture.cleared(), 1)
        fixture.due()
        fixture.timers[0]()
        await Promise.resolve()
        assert.equal(fixture.executions(), 0)
        assert.deepEqual(jq.getJob(fixture.job.job_id)?.paid_image_replacement_attempts, [fixture.attempt])
        assert.ok((await readManifest(fixture.root)).tasks[fixture.attempt.manifest_key])
      } finally { fixture.restore() }
    })

    await suite.test('cancel', async () => {
      jq.setImageEpisodeConcurrency(1)
      const project = await pm.createProject({ name: 'cleanup cancel' })
      const blockerRelease = deferred()
      const blockerStarted = deferred()
      jq.registerExecutor('continuity_render', async running => {
        if (running.episode_id === 'CANCEL-BLOCKER') {
          blockerStarted.resolve()
          await blockerRelease.promise
        }
      })
      jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'continuity_render', episode_id: 'CANCEL-BLOCKER', title: 'blocker', params: {} })
      await blockerStarted.promise
      const queued = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'continuity_render', episode_id: 'CANCEL-ME', title: 'cancel me', params: {} })
      let cleared = 0
      const restoreRuntime = jq._setPaidImageWaitRuntimeForTesting({ clearTimer: () => { cleared++ } })
      const restoreTimer = jq._seedPaidImageWaitTimerForTesting(queued.job_id, 'cancel-timer')
      try {
        const cancelled = await jq.requestJobCancellation(project.slug, queued.job_id)
        assert.equal(cancelled.status, 'cancelled')
        assert.equal(cleared, 1)
      } finally {
        blockerRelease.resolve()
        restoreTimer()
        restoreRuntime()
      }
    })

    await suite.test('ordinary terminalization', async () => {
      const project = await pm.createProject({ name: 'cleanup terminalization' })
      const executorStarted = deferred()
      const executorRelease = deferred()
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug !== project.slug) return
        executorStarted.resolve()
        await executorRelease.promise
        throw new Error('injected terminalization')
      })
      const terminalPromise = new Promise<Job>(resolve => {
        const onUpdate = (updated: Job) => {
          if (updated.project_slug !== project.slug || updated.status !== 'error') return
          jq.jobEvents.off('update', onUpdate)
          resolve(updated)
        }
        jq.jobEvents.on('update', onUpdate)
      })
      const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'continuity_render', episode_id: 'TERMINALIZE', title: 'terminalize', params: {} })
      await executorStarted.promise
      let cleared = 0
      const restoreRuntime = jq._setPaidImageWaitRuntimeForTesting({ clearTimer: () => { cleared++ } })
      const restoreTimer = jq._seedPaidImageWaitTimerForTesting(job.job_id, 'terminal-timer')
      try {
        executorRelease.resolve()
        await terminalPromise
        assert.equal(cleared, 1)
      } finally {
        executorRelease.resolve()
        restoreTimer()
        restoreRuntime()
      }
    })

    await suite.test('clear', async () => {
      const project = await pm.createProject({ name: 'cleanup clear' })
      const executorStarted = deferred()
      const executorRelease = deferred()
      jq.registerExecutor('continuity_render', async running => {
        if (running.project_slug !== project.slug) return
        executorStarted.resolve()
        await executorRelease.promise
      })
      const job = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'continuity_render', episode_id: 'CLEAR', title: 'clear', params: {} })
      await executorStarted.promise
      const done = waitForUpdate(job.job_id, 'done')
      executorRelease.resolve()
      await done
      let cleared = 0
      const restoreRuntime = jq._setPaidImageWaitRuntimeForTesting({ clearTimer: () => { cleared++ } })
      const restoreTimer = jq._seedPaidImageWaitTimerForTesting(job.job_id, 'clear-timer')
      try {
        assert.equal(jq.removeTerminalJob(project.slug, job.job_id), true)
        assert.equal(cleared, 1)
      } finally {
        restoreTimer()
        restoreRuntime()
      }
    })

    await suite.test('terminalization and clear', async () => {
      const fixture = await bootWait('cleanup terminal clear')
      try {
        const terminal = await jq.forceAbandonJob(fixture.project.slug, fixture.job.job_id)
        assert.equal(terminal.status, 'cancelled')
        assert.equal(fixture.cleared(), 1)
        assert.equal(jq.removeTerminalJob(fixture.project.slug, fixture.job.job_id), true)
        fixture.due()
        fixture.timers[0]()
        await Promise.resolve()
        assert.equal(fixture.executions(), 0)
        assert.ok((await readManifest(fixture.root)).tasks[fixture.attempt.manifest_key], 'timer cleanup never deletes artifacts/evidence')
      } finally { fixture.restore() }
    })

    await suite.test('commitment invalidates the delivered timer', async () => {
      const fixture = await bootWait('cleanup commitment')
      try {
        const durable = JSON.parse(await fs.readFile(path.join(tempDir, 'projects', fixture.project.slug, 'jobs.json'), 'utf8'))
        const attempt = durable.jobs[0].paid_image_replacement_attempts[0]
        attempt.state = 'committed'
        attempt.replacement_scope = 'scope-committed-elsewhere'
        attempt.quoted_credits = 3
        attempt.price_version = 'price-v1'
        attempt.replacement_committed_at = new Date(NOW).toISOString()
        await fs.writeFile(path.join(tempDir, 'projects', fixture.project.slug, 'jobs.json'), JSON.stringify(durable))
        fixture.due()
        fixture.timers[0]()
        fixture.timers[0]()
        await Promise.resolve()
        await Promise.resolve()
        assert.equal(fixture.executions(), 0)
        assert.equal(jq.getJob(fixture.job.job_id)?.status, 'running')
      } finally { fixture.restore() }
    })

    await suite.test('due requeue consumes one timer delivery', async () => {
      const fixture = await bootWait('cleanup due requeue')
      try {
        fixture.due()
        fixture.timers[0]()
        fixture.timers[0]()
        await fixture.executed.promise
        assert.equal(fixture.executions(), 1)
      } finally { fixture.restore() }
    })

    await suite.test('invalid predicate prevents delivered due work', async () => {
      const fixture = await bootWait('cleanup invalid predicate')
      try {
        const durable = JSON.parse(await fs.readFile(path.join(tempDir, 'projects', fixture.project.slug, 'jobs.json'), 'utf8'))
        durable.jobs[0].paid_image_replacement.enabled = false
        await fs.writeFile(path.join(tempDir, 'projects', fixture.project.slug, 'jobs.json'), JSON.stringify(durable))
        fixture.due()
        fixture.timers[0]()
        fixture.timers[0]()
        await Promise.resolve()
        await Promise.resolve()
        assert.equal(fixture.executions(), 0)
        assert.equal(jq.getJob(fixture.job.job_id)?.status, 'running')
      } finally { fixture.restore() }
    })
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
