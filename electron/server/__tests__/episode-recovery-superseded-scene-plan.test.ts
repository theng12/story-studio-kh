/**
 * SS0082, 2026-11-08: a boot audit re-queued a saved Scene Plan edge (b296c28a) even though the
 * owner had deliberately run Audio Assembly alone at 05:58-06:14 (force, empty pipeline_chain) and
 * reused the episode's existing images. A saved Scene Plan older than that run is superseded;
 * legacy plans without their own admission evidence fail closed instead of guessing. Owner Retry
 * and a Scene Plan with its own newer source stay valid. Every admission records when and why.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

const ready = { audio_merge: true, subtitle_sections: true, subtitle_stitch: true, scene_plan_run: true, contextual_cues: true, continuity_render: true }
const notReady = { ...ready, scene_plan_run: false, continuity_render: false }

function row(projectSlug: string, type: Job['type'], status: Job['status'], jobId: string, params: Job['params'] = {}, createdAt = '2026-11-07T22:00:00Z'): Job {
  return {
    job_id: jobId, project_slug: projectSlug, episode_id: 'EP0001', type, params, status, title: type,
    created_at: createdAt, started_at: null, finished_at: null, error: status === 'error' ? 'failed' : null, output_lines: [],
  }
}

/** The saved plan shape SS0082 had: a missing Scene Plan source and a normal 8-hex node. */
async function oldPlan(projectSlug: string) {
  const { createEpisodeRecoveryPlan } = await import('../services/episode-recovery.js')
  const plan = createEpisodeRecoveryPlan([row(projectSlug, 'scene_plan_run', 'error', 'c6e7232f')])
  plan.target = 'continuity_render'
  plan.completed = ['audio_merge', 'subtitle_sections', 'subtitle_stitch']
  plan.first_unresolved = 'scene_plan_run'
  const scene = plan.steps.scene_plan_run!
  scene.job_id = 'b296c28a'
  delete scene.source_job_id // its earlier source row was cleared; legacy plans carried no admission time
  scene.dispatched = true
  plan.steps.subtitle_sections = { job_id: `recovery-${plan.id}-subtitle_sections`, type: 'subtitles_transcribe',
    title: 'subtitle sections', params: {}, source_job_id: 'c6e7232f' }
  plan.steps.continuity_render = { job_id: `recovery-${plan.id}-continuity_render`, type: 'continuity_render',
    title: 'Scene Review', params: {} }
  return plan
}

/** The owner's 05:58 audio-only reuse: forced, and its saved chain deliberately names no later step. */
function audioOnlyReuse(projectSlug: string): Job {
  const job = row(projectSlug, 'audio_merge', 'done', '0f704dbf',
    { force: true, pipeline_chain: [], pipeline_batch_id: '27911d1c-4580-4161-8a53-ec8fe60569fb' },
    '2026-11-08T05:58:27.549Z')
  job.started_at = '2026-11-08T06:09:47.218Z'
  job.finished_at = '2026-11-08T06:14:46.433Z'
  return job
}

test('an automatic boot audit does not re-queue a Scene Plan superseded by a newer audio-only run', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Superseded scene plan' })
    await jq.setQueuePaused(true)
    const { dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const plan = await oldPlan(project.slug)
    // A recent automatic adoption receipt is not new authority: the saved edge stays older.
    plan.admission_events = [{ step: 'scene_plan_run', action: 'adopt', at: '2026-11-08T08:18:10.027Z', source: 'boot', job_id: 'b296c28a' }]

    const reuse = audioOnlyReuse(project.slug)
    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Scene Plan is stale' }, [reuse], [], 'boot')
    // Audits project the plan id onto completed rows; that stamp must not turn unrelated audio into an owned edge.
    reuse.params.episode_recovery_id = plan.id
    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Scene Plan is stale' }, [reuse], [], 'timer')

    assert.deepEqual((await jq.getJobs(project.slug)).map(job => job.type), [], 'no Scene Plan and no later Scene Review')
    assert.equal(plan.first_unresolved, 'scene_plan_run')
    assert.match(plan.message, /Audio Assembly 0f704dbf finished later/)
    assert.match(plan.message, /use Retry on Scene Plan/)
    assert.equal(plan.steps.scene_plan_run!.job_id, 'b296c28a', 'the saved node is preserved')
    assert.equal(plan.steps.scene_plan_run!.dispatched, true, 'the saved edge is preserved')
    assert.equal(plan.steps.scene_plan_run!.source_job_id, undefined)
    assert.deepEqual(plan.completed, ['audio_merge', 'subtitle_sections', 'subtitle_stitch'])
    assert.equal(plan.admission_events!.length, 1, 'the blocked edge adds no receipt and the audit receipt is not authority')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('owner Retry and a Scene Plan with its own newer source still dispatch after the audio-only run', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Valid scene plan after audio reuse' })
    await jq.setQueuePaused(true)
    const { dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const reuse = audioOnlyReuse(project.slug)

    const retried = await oldPlan(project.slug)
    retried.owner_requested_at = '2026-11-08T08:30:00.000Z'
    await dispatchEpisodeRecoveryStep(retried, { verified: notReady, message: 'Scene Plan is stale' }, [reuse], [], 'owner')
    assert.deepEqual((await jq.getJobs(project.slug)).map(job => job.type), ['scene_plan_run'], 'owner Retry still runs it')

    const newerProject = await pm.createProject({ name: 'Newer scene plan source' })
    const newer = await oldPlan(newerProject.slug)
    newer.steps.scene_plan_run!.job_id = `recovery-${newer.id}-scene_plan_run`
    newer.steps.scene_plan_run!.source_job_id = 'newer-scene-plan'
    newer.steps.scene_plan_run!.dispatched = false
    const newerSource = row(newerProject.slug, 'scene_plan_run', 'error', 'newer-scene-plan', {}, '2026-11-08T07:00:00.000Z')
    await dispatchEpisodeRecoveryStep(newer, { verified: notReady, message: 'Scene Plan is stale' },
      [audioOnlyReuse(newerProject.slug), newerSource], [], 'boot')
    assert.deepEqual((await jq.getJobs(newerProject.slug)).map(job => job.type), ['scene_plan_run'], 'a newer source is not superseded')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a completed audio-only run owned by the same recovery plan does not supersede its own Scene Plan', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Own audio run before scene plan' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const plan = createEpisodeRecoveryPlan([row(project.slug, 'scene_plan_run', 'error', 'failed-scene-plan')])
    const own = audioOnlyReuse(project.slug)
    own.job_id = 'own-merge'
    own.params = { ...own.params, episode_recovery_id: plan.id }
    plan.steps.audio_merge = { job_id: 'own-merge', type: 'audio_merge', title: 'Audio Assembly',
      params: { force: true, pipeline_chain: [] }, source_job_id: 'own-merge' }

    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Scene Plan is stale' }, [own], [], 'boot')

    assert.deepEqual((await jq.getJobs(project.slug)).map(job => job.type), ['scene_plan_run'], 'its own audio edge cannot block its next step')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('every admission records its raw time and source, and the pure-read plan exposes it', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Recovery admission evidence' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep, readEpisodeRecoveryPlans } = await import('../services/episode-recovery.js')
    const plan = createEpisodeRecoveryPlan([row(project.slug, 'scene_plan_run', 'error', 'failed-scene-plan')])
    plan.steps.scene_plan_run!.dispatched = true // the row was pruned: this is a re-queue, not a new edge

    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Scene Plan is stale' }, [], [], 'boot', ['observed-done-job'])
    const first = plan.admission_events![0]!
    assert.equal(first.step, 'scene_plan_run')
    assert.equal(first.action, 'enqueue')
    assert.equal(first.source, 'boot')
    assert.equal(first.job_id, plan.steps.scene_plan_run!.job_id)
    assert.ok(Number.isFinite(Date.parse(first.at)), 'raw ISO admission time')
    assert.ok(first.source_job_ids?.includes('observed-done-job'), 'observed completion jobs are evidence')
    assert.ok(first.source_job_ids?.includes('failed-scene-plan'), 'the saved source job is evidence')
    assert.equal(plan.steps.scene_plan_run!.redispatched, true, 'this was the requeued edge')

    const queued = (await jq.getJobs(project.slug))[0]!
    await jq.mutateAuthoritativeJob(project.slug, queued.job_id, job => ({ ...job, status: 'paused' }))
    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Scene Plan is stale' },
      await jq.getJobs(project.slug), [], 'completion')
    const adopted = plan.admission_events![1]!
    assert.equal(adopted.step, 'scene_plan_run')
    assert.equal(adopted.action, 'adopt')
    assert.equal(adopted.source, 'completion')
    assert.equal(adopted.job_id, queued.job_id)
    assert.ok(Date.parse(adopted.at) >= Date.parse(first.at))

    const file = path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json')
    await fs.writeFile(file, JSON.stringify({ version: 1, plans: { EP0001: plan } }))
    const read = (await readEpisodeRecoveryPlans(project.slug, 'EP0001'))!
    assert.equal(read.plans[0]!.admission_events.length, 2, 'append-only history survives the pure-read projection')
    assert.equal(read.plans[0]!.admission_events[1]!.action, 'adopt')
    assert.equal(read.plans[0]!.admission_events[1]!.job_id, queued.job_id)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})
