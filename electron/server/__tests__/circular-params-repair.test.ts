// 1.4.266 (mini, 2026-10-09): "Pipeline: Scene Plan — EP0045/EP0039" failed 3/3 with "pacing must be
// an object". The job redactor saved every SECOND reference to a shared object as '[CIRCULAR]'; the
// Pipeline shares one `pacing` object between a job's params and each pipeline_chain link, so the
// saved chain carried the marker, and jobs resumed across the 1.4.264 update handed it down the
// chain. Pinned here: shared references persist intact, and saved damage is repaired on load and
// on Retry from the job's own run.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { redactSensitiveValue } from '../lib/redact-secrets.js'
import { CIRCULAR_MARKER, repairCircularParams } from '../lib/circular-params-repair.js'
import { parseScenePacing } from '../contracts/pacing.js'
import { nonRetryable } from '../services/job-retry-policy.js'
import { createEpisodeRecoveryPlan, repairEpisodeRecoveryPlanParams } from '../services/episode-recovery.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
const planned: Array<{ job_id: string; pacing: unknown }> = []

const PACING = {
  mode: 'variable', min_sec: 5, max_sec: 10,
  periods: [{ start_sec: 0, end_sec: 180, min_sec: 5, max_sec: 10 }, { start_sec: 180, end_sec: null, min_sec: 8, max_sec: 14 }],
}

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  jq.registerExecutor('scene_plan_run', async job => {
    try { parseScenePacing(job.params.pacing) } catch (error) { throw nonRetryable(error as Error) }
    planned.push({ job_id: job.job_id, pacing: job.params.pacing })
  })
  jq.registerExecutor('metadata', async () => {})
})
after(async () => { await cleanup() })

const jobsFile = (slug: string) => path.join(tempDir, 'projects', slug, 'jobs.json')

test('a shared (non-cyclic) object is copied at every reference; only a real cycle is marked', () => {
  const pacing = { mode: 'uniform', min_sec: 5, max_sec: 10 }
  const params = { pacing, pipeline_chain: [{ params: { pacing } }, { params: { pacing } }] }
  const out = redactSensitiveValue(params)
  assert.deepEqual(out.pipeline_chain.map(link => link.params.pacing), [pacing, pacing])
  assert.notEqual(out.pipeline_chain[0]!.params.pacing, pacing, 'still a deep copy')

  const cyclic: Record<string, unknown> = { name: 'loop' }
  cyclic.self = cyclic
  assert.equal((redactSensitiveValue(cyclic) as Record<string, unknown>).self, CIRCULAR_MARKER)
})

test('a Pipeline job whose params share objects is saved to jobs.json without "[CIRCULAR]"', async () => {
  const project = await pm.createProject({ name: 'Circular Persist' })
  const pacing = structuredClone(PACING)
  const job = await jq.enqueue({
    project_slug: project.slug, type: 'metadata', episode_id: 'EP001', title: 'shared refs',
    params: { pacing, motion: { pacing }, list: [pacing, pacing] },
  })
  await waitFor(() => jq.getJob(job.job_id)?.status === 'done', { label: 'job finishes' })
  await jq._waitForJobPersistenceForTesting()
  const raw = await fs.readFile(jobsFile(project.slug), 'utf8')
  assert.ok(!raw.includes(CIRCULAR_MARKER), 'no marker on disk')
  const saved = JSON.parse(raw).jobs.find((row: { job_id: string }) => row.job_id === job.job_id)
  assert.deepEqual(saved.params.list, [PACING, PACING])
})

function row(slug: string, id: string, type: string, episode: string, status: string, params: Record<string, unknown>) {
  const now = new Date().toISOString()
  return {
    job_id: id, project_slug: slug, type, episode_id: episode, title: `${type} ${episode}`, status,
    created_at: now, started_at: now, finished_at: now, error: status === 'error' ? 'pacing must be an object' : null,
    output_lines: [], params: { episode_id: episode, ...params },
  }
}

test('episode recovery restores legacy shared settings from its saved Pipeline run before snapshotting a child', () => {
  const slug = 'legacy-recovery'
  const batch = { pipeline_batch_id: 'batch-recovery' }
  const motionScope = { mode: 'all', scene_ids: ['scene-1'] }
  const damaged = { pacing: CIRCULAR_MARKER, motion_scope: CIRCULAR_MARKER, motion_level: 2 }
  const parent = row(slug, 'parent-audio', 'audio', 'EP0110', 'done', {
    ...batch,
    pacing: structuredClone(PACING),
    motion_scope: structuredClone(motionScope),
    pipeline_chain: [{ type: 'scene_plan_run', title: 'Scene Plan', params: { ...damaged } }],
  })
  parent.created_at = '2026-10-13T15:20:00.000Z'
  const failedChild = row(slug, 'recovery-old-scene-plan', 'scene_plan_run', 'EP0110', 'error', {
    ...batch,
    ...damaged,
    episode_recovery_id: 'legacy-plan',
  })
  failedChild.created_at = '2026-10-13T15:25:00.000Z'

  const plan = createEpisodeRecoveryPlan([parent, failedChild] as any, [failedChild.job_id])

  assert.deepEqual(plan.steps.scene_plan_run?.params.pacing, PACING)
  assert.deepEqual(plan.steps.scene_plan_run?.params.motion_scope, motionScope)
})

test('a newer Pipeline batch repairs its child only from that batch', () => {
  const slug = 'two-batch-recovery'
  const pipeline = (id: string, createdAt: string, pacing: Record<string, unknown>) => {
    const parent = row(slug, `parent-${id}`, 'audio', 'EP0110', 'done', {
      pipeline_batch_id: id,
      pacing,
      pipeline_chain: [
        { type: 'scene_plan_run', title: 'Scene Plan', params: { pacing: CIRCULAR_MARKER } },
        { type: 'video_assembly', title: 'Final Video', params: {} },
      ],
    })
    parent.created_at = createdAt
    return parent
  }
  const batchA = pipeline('batch-a', '2026-10-13T15:00:00.000Z', { mode: 'uniform', min_sec: 2, max_sec: 4 })
  const batchBPacing: Record<string, unknown> = { mode: 'uniform', min_sec: 9, max_sec: 13 }
  const batchB = pipeline('batch-b', '2026-10-13T16:00:00.000Z', batchBPacing)

  const plan = createEpisodeRecoveryPlan([batchA, batchB] as any)

  assert.equal(plan.pipeline_batch_id, 'batch-b')
  assert.deepEqual(plan.steps.scene_plan_run?.params.pacing, batchBPacing)
})

test('persisted recovery fails closed when its Pipeline batch has no intact legacy setting', async () => {
  const project = await pm.createProject({ name: 'Circular Missing Donor' })
  const slug = project.slug
  const batchA = row(slug, 'parent-a', 'audio', 'EP0110', 'done', {
    pipeline_batch_id: 'batch-a',
    pacing: { mode: 'uniform', min_sec: 2, max_sec: 4 },
  })
  batchA.created_at = '2026-10-13T15:00:00.000Z'
  const batchB = row(slug, 'parent-b', 'audio', 'EP0110', 'done', {
    pipeline_batch_id: 'batch-b',
    pipeline_chain: [
      { type: 'scene_plan_run', title: 'Scene Plan', params: { pacing: CIRCULAR_MARKER } },
      { type: 'video_assembly', title: 'Final Video', params: {} },
    ],
  })
  batchB.created_at = '2026-10-13T16:00:00.000Z'
  await fs.writeFile(jobsFile(slug), JSON.stringify({ jobs: [batchA, batchB] }))

  const hydrated = await jq.getJobs(slug)

  assert.throws(
    () => createEpisodeRecoveryPlan(hydrated as any),
    /could not be restored from its original Pipeline run/,
  )
})

test('a persisted recovery snapshot restores legacy shared settings only from its saved run', () => {
  const slug = 'persisted-recovery'
  const batch = { pipeline_batch_id: 'batch-persisted' }
  const motionScope = { mode: 'all', scene_ids: ['scene-7'] }
  const parent = row(slug, 'parent-audio', 'audio', 'EP0110', 'done', {
    ...batch,
    pacing: structuredClone(PACING),
    motion_scope: structuredClone(motionScope),
  })
  const plan = createEpisodeRecoveryPlan([parent] as any)
  plan.pipeline_batch_id = batch.pipeline_batch_id
  plan.target = 'scene_plan_run'
  plan.steps.scene_plan_run = {
    job_id: `recovery-${plan.id}-scene_plan_run`,
    type: 'scene_plan_run',
    title: 'Scene Plan',
    params: { pacing: CIRCULAR_MARKER, motion_scope: CIRCULAR_MARKER, motion_level: 2 },
  }

  assert.equal(repairEpisodeRecoveryPlanParams(plan, [parent] as any), true)
  assert.deepEqual(plan.steps.scene_plan_run.params.pacing, PACING)
  assert.deepEqual(plan.steps.scene_plan_run.params.motion_scope, motionScope)

  plan.steps.scene_plan_run.params.pacing = CIRCULAR_MARKER
  assert.throws(() => repairEpisodeRecoveryPlanParams(plan, []), /could not be restored from its original Pipeline run/)
  assert.equal(plan.steps.scene_plan_run.params.pacing, CIRCULAR_MARKER, 'an unresolved repair never guesses the current preset')
})

test('saved "[CIRCULAR]" settings are repaired on load from the parent job, and a plain Retry then plans', async () => {
  const project = await pm.createProject({ name: 'Circular Load' })
  const slug = project.slug
  const batch = { pipeline_batch_id: 'batch-1' }
  const damaged = { pacing: CIRCULAR_MARKER, motion_scope: CIRCULAR_MARKER, motion_level: 2 }
  const rows = [
    // The narration job: its own copy was written first and survived; its chain links did not.
    row(slug, 'na-audio', 'audio', 'EP0045', 'done', {
      ...batch, pacing: PACING, motion_scope: { mode: 'off' },
      pipeline_chain: [{ type: 'scene_plan_run', title: 'Scene Plan', params: { ...damaged, pipeline_step: 'scene_plan' } }],
    }),
    // The step it handed the marker to (EP0045's 4336da4a on the mini).
    row(slug, 'na-plan', 'scene_plan_run', 'EP0045', 'error', {
      ...batch, ...damaged,
      pipeline_chain: [{ type: 'metadata', title: 'Next', params: { ...damaged } }],
    }),
    // No same-episode donor: falls back to the batch.
    row(slug, 'na-plan-2', 'scene_plan_run', 'EP0046', 'error', { ...batch, ...damaged }),
    // No run to restore from: the marker stays explicit so Retry cannot guess the current setting.
    row(slug, 'na-orphan', 'scene_plan_run', 'EP0047', 'error', { ...damaged }),
  ]
  await fs.writeFile(jobsFile(slug), JSON.stringify({ jobs: rows }))

  await jq.getJobs(slug)
  const plan = jq.getJob('na-plan')!
  assert.deepEqual(plan.params.pacing, PACING)
  assert.deepEqual(plan.params.motion_scope, { mode: 'off' })
  assert.deepEqual(plan.params.pipeline_chain[0].params.pacing, PACING)
  assert.deepEqual(jq.getJob('na-audio')!.params.pipeline_chain[0].params.pacing, PACING)
  assert.deepEqual(jq.getJob('na-plan-2')!.params.pacing, PACING)
  assert.equal(jq.getJob('na-orphan')!.params.pacing, CIRCULAR_MARKER)
  await jq._waitForJobPersistenceForTesting()
  const savedRows = JSON.parse(await fs.readFile(jobsFile(slug), 'utf8')).jobs
  assert.ok(!JSON.stringify(savedRows.find((job: { job_id: string }) => job.job_id === 'na-plan')).includes(CIRCULAR_MARKER), 'matched repair is saved')
  assert.equal(savedRows.find((job: { job_id: string }) => job.job_id === 'na-orphan').params.pacing, CIRCULAR_MARKER,
    'unmatched corruption stays visible and cannot silently fall back to current defaults')

  const retried = jq.retryTerminalJob(slug, 'na-plan')
  await waitFor(() => jq.getJob(retried.job_id)?.status === 'done', { label: 'retried Scene Plan finishes' })
  assert.deepEqual(planned.find(entry => entry.job_id === retried.job_id)?.pacing, PACING)
})

test('Retry repairs a job that is still damaged in memory', async () => {
  const project = await pm.createProject({ name: 'Circular Retry' })
  const slug = project.slug
  const donor = await jq.enqueue({
    project_slug: slug, type: 'metadata', episode_id: 'EP0039', title: 'parent',
    params: { pipeline_batch_id: 'batch-2', pacing: structuredClone(PACING) },
  })
  await waitFor(() => jq.getJob(donor.job_id)?.status === 'done', { label: 'parent finishes' })
  const broken = await jq.enqueue({
    project_slug: slug, type: 'scene_plan_run', episode_id: 'EP0039', title: 'Pipeline: Scene Plan — EP0039',
    params: { pipeline_batch_id: 'batch-2', pacing: CIRCULAR_MARKER },
  })
  await waitFor(() => jq.getJob(broken.job_id)?.status === 'error', { label: 'damaged plan fails' })
  assert.match(jq.getJob(broken.job_id)!.error || '', /pacing must be an object/)
  // The row reports `error` before its worker settles; Retry is refused until then (1.4.319).
  await waitFor(() => !jq._isJobWorkerActiveForTesting(broken.job_id), { label: 'damaged plan worker settles' })

  const retried = jq.retryTerminalJob(slug, broken.job_id)
  await waitFor(() => jq.getJob(retried.job_id)?.status === 'done', { label: 'retry plans' })
  assert.deepEqual(jq.getJob(retried.job_id)!.params.pacing, PACING)
})

test('repair order: own params, then the same episode, then the batch; one log line per job', () => {
  const lines: string[] = []
  const target = { job_id: 't', project_slug: 'p', episode_id: 'E1', params: { pipeline_batch_id: 'b', pacing: CIRCULAR_MARKER } }
  const sameEpisode = { job_id: 'parent', project_slug: 'p', episode_id: 'E1', params: { pipeline_batch_id: 'b', pacing: { min_sec: 1, max_sec: 2 } } }
  const otherEpisode = { job_id: 'sib', project_slug: 'p', episode_id: 'E2', params: { pipeline_batch_id: 'b', pacing: { min_sec: 3, max_sec: 4 } } }
  const otherProject = { job_id: 'x', project_slug: 'q', episode_id: 'E1', params: { pipeline_batch_id: 'b', pacing: { min_sec: 9, max_sec: 9 } } }
  const repaired = repairCircularParams([target], [otherProject, otherEpisode, sameEpisode, target], line => lines.push(line))
  assert.deepEqual([...repaired], ['t'])
  assert.deepEqual(target.params.pacing, { min_sec: 1, max_sec: 2 })
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /pacing ← parent job parent/)
})
