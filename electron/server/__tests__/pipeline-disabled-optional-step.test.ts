/**
 * A Pipeline step the channel's own settings switch off is SKIPPED, never failed.
 *
 * AGENTS.md §8: "Optional steps are skipped only through explicit project
 * configuration. A skipped optional step is not missing."
 *
 * Production, 2026-10-19. The owner switched Contextual Cues off on all 19
 * channels. Batches admitted while it was on still carried captured links for it
 * (History EP0011–EP0014, plus running chains on the other Night Atlas
 * channels). Those links were enqueued anyway, their generator refused
 * ("Contextual Cues are disabled for this project. Enable them first."), each
 * job auto-retried three times and stayed failed, and Scene Review, Motion Clips
 * and Final Video sat behind them waiting for a step that can never run.
 *
 * The rules pinned here:
 *   - a captured link for a step the channel has switched off is never enqueued;
 *   - a job already admitted for such a step settles `skipped`, with no executor
 *     entry, no provider call and no auto-retry;
 *   - the steps that needed it proceed;
 *   - switching the step back on restores the ordinary path;
 *   - a REQUIRED step is never skipped, and neither is a step that is merely
 *     missing output;
 *   - unrelated running work is untouched.
 */
import { after, afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import type { Job, JobType } from '../models/types.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let pipeline: typeof import('../routes/pipeline.js')
let optional: typeof import('../lib/optional-steps.js')

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  pipeline = await import('../routes/pipeline.js')
  optional = await import('../lib/optional-steps.js')
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

const restores: Array<() => void> = []
afterEach(() => { while (restores.length) restores.pop()!() })

/** Swap in a stand-in executor; restored after each test. */
function useExecutor(type: JobType, executor: (job: Job) => Promise<void>): void {
  restores.push(jq._setExecutorForTesting(type, executor))
}

/**
 * The chain a batch admitted while Contextual Cues was on captured: Scene
 * Review requires Contextual Cues because the run was going to generate them.
 * Built through the real stamper, so the requirements under test are the
 * production ones.
 */
function capturedChain(): Array<{ type: string; title: string; params: Record<string, any> }> {
  const chain: Array<{ type: string; title: string; params: Record<string, any> }> = [
    { type: 'contextual_cues', title: 'Contextual Cues', params: {} },
    { type: 'continuity_render', title: 'Scene Review', params: {} },
    { type: 'video_assembly', title: 'Final Video', params: {} },
  ]
  pipeline.stampPipelineStepFacts(chain, 'scene_plan')
  assert.deepEqual(chain[1]!.params.pipeline_requires, ['scene_plan', 'contextual_cues'],
    'the captured link must really require the optional step, or this test proves nothing')
  return chain
}

async function newChannel(name: string, cuesEnabled: boolean): Promise<string> {
  const project = await pm.createProject({ name })
  await pm.updateConfig(project.slug, { contextual_cues: { enabled: cuesEnabled } } as any)
  optional._clearOptionalStepConfigCacheForTesting()
  return project.slug
}

/** Register the three steps of the captured chain and record which ones actually ran. */
function recordChainRuns(ran: string[]): void {
  useExecutor('contextual_cues', async () => { ran.push('contextual_cues') })
  useExecutor('continuity_render', async () => { ran.push('continuity_render') })
  useExecutor('video_assembly', async () => { ran.push('video_assembly') })
}

async function jobOfType(slug: string, type: string): Promise<Job | undefined> {
  return (await jq.getJobs(slug)).find(job => job.type === type)
}

describe('an optional step the channel switches off is skipped, not failed', () => {
  test('only an optional step with its channel setting off is skipped', () => {
    assert.equal(optional.optionalStepSkipReason('contextual_cues', { contextual_cues: { enabled: true } }), null,
      'switched on: nothing to skip')
    assert.match(optional.optionalStepSkipReason('contextual_cues', { contextual_cues: { enabled: false } })!,
      /Contextual Cues is switched off in this channel's settings/)
    assert.match(optional.optionalStepSkipReason('contextual_cues', {})!,
      /switched off/, 'an absent setting means off, the same default the rest of the app reads')
    // §8: "Optional steps are skipped only through explicit project configuration."
    // Required work must never take this path, whatever the config says.
    for (const required of ['scene_review', 'motion_review', 'video_assembly', 'scene_plan', 'subtitles', 'audio', 'audio_merge', 'metadata', 'thumb_images']) {
      assert.equal(optional.optionalStepSkipReason(required, {}), null, `${required} is required work and is never skipped`)
    }
  })

  test('a job already admitted for a now-disabled step settles skipped, without a retry or a provider call', async () => {
    const slug = await newChannel('Cues Off Settle', false)
    const ran: string[] = []
    recordChainRuns(ran)
    const chain = capturedChain()
    const [first, ...rest] = chain
    const admitted = await jq.enqueue({
      project_slug: slug, type: 'contextual_cues', episode_id: 'EP0012', title: first!.title,
      params: { ...first!.params, pipeline_chain: rest, pipeline_batch_id: 'batch-settle' },
    })

    await waitFor(() => jq.getJob(admitted.job_id)?.status === 'done', { label: 'the disabled step settles' })
    await jq._waitForJobPersistenceForTesting()

    const settled = jq.getJob(admitted.job_id)!
    assert.equal(settled.status, 'done', 'nothing failed: a skipped step is not an error')
    assert.equal(settled.error, null)
    assert.ok(settled.skipped, 'the row carries the skip marker')
    assert.match(settled.skipped!.reason, /switched off in this channel's settings/)
    assert.ok(settled.output_lines.some(line => line.startsWith('⊘ Skipped:')),
      'the log says it was skipped')
    assert.equal(settled.auto_retry?.exhausted, undefined,
      'no auto-retry was ever entered — the disabled step is not a retryable failure')
    assert.ok(!ran.includes('contextual_cues'), 'the disabled step never reached its executor')

    // The Jobs list reads it as skipped, not as something needing attention.
    const row = jq.getPublicJob(admitted.job_id)!
    assert.equal(jq.isSkippedJob(settled), true)
    assert.equal((row as any).skipped?.reason, settled.skipped!.reason)
    assert.equal(jq.getQueueStats(slug).error, 0, 'a skipped step is not counted as needing attention')
  })

  test('Scene Review and the later steps proceed past the skipped step', async () => {
    const slug = await newChannel('Cues Off Proceed', false)
    const ran: string[] = []
    recordChainRuns(ran)
    const chain = capturedChain()
    const [first, ...rest] = chain
    const admitted = await jq.enqueue({
      project_slug: slug, type: 'contextual_cues', episode_id: 'EP0013', title: first!.title,
      params: { ...first!.params, pipeline_chain: rest, pipeline_batch_id: 'batch-proceed' },
    })

    await waitFor(() => ran.includes('video_assembly'), { label: 'the run reaches Final Video' })
    await jq._waitForJobPersistenceForTesting()

    assert.deepEqual(ran, ['continuity_render', 'video_assembly'],
      'Scene Review ran and handed Final Video on; the skipped step ran nothing')
    const finalVideo = await jobOfType(slug, 'video_assembly')
    assert.equal(finalVideo?.status, 'done')
    assert.equal(jq.getJob(admitted.job_id)!.status, 'done')
  })

  test('a captured link for a now-disabled step is never enqueued at chain dispatch', async () => {
    const slug = await newChannel('Cues Off Dispatch', false)
    const ran: string[] = []
    recordChainRuns(ran)
    useExecutor('scene_plan_run', async () => { ran.push('scene_plan_run') })
    const chain = capturedChain()
    const parent = await jq.enqueue({
      project_slug: slug, type: 'scene_plan_run', episode_id: 'EP0014', title: 'Scene Plan',
      params: { pipeline_step: 'scene_plan', pipeline_requires: ['subtitles'], pipeline_chain: chain, pipeline_batch_id: 'batch-dispatch' },
    })

    await waitFor(() => ran.includes('video_assembly'), { label: 'the chain continues past the disabled link' })
    await jq._waitForJobPersistenceForTesting()

    assert.equal(await jobOfType(slug, 'contextual_cues'), undefined,
      'no job was ever created for the disabled step')
    assert.deepEqual(ran, ['scene_plan_run', 'continuity_render', 'video_assembly'])
    const settledParent = jq.getJob(parent.job_id)!
    assert.ok(settledParent.output_lines.some(line => line.startsWith('⊘ Skipped:')),
      'the parent run records the skip')
  })

  test('switching the step back on restores the ordinary path', async () => {
    const slug = await newChannel('Cues On Again', true)
    const ran: string[] = []
    recordChainRuns(ran)
    useExecutor('scene_plan_run', async () => { ran.push('scene_plan_run') })
    const chain = capturedChain()
    await jq.enqueue({
      project_slug: slug, type: 'scene_plan_run', episode_id: 'EP0015', title: 'Scene Plan',
      params: { pipeline_step: 'scene_plan', pipeline_requires: ['subtitles'], pipeline_chain: chain, pipeline_batch_id: 'batch-on' },
    })

    await waitFor(() => ran.includes('video_assembly'), { label: 'the full chain runs' })
    await jq._waitForJobPersistenceForTesting()

    assert.deepEqual(ran, ['scene_plan_run', 'contextual_cues', 'continuity_render', 'video_assembly'],
      'with the feature on, every step runs as it always did')
    const cues = await jobOfType(slug, 'contextual_cues')
    assert.equal(cues?.status, 'done')
    assert.equal(cues?.skipped, undefined, 'a step that ran is never marked skipped')
  })

  test('an already-failed row for a now-disabled step reads skipped, and re-enabling puts it back', async () => {
    const slug = await newChannel('Cues Off History', false)
    // The row exactly as 1.4.324 left it: the generator refused, the job retried
    // out and stayed failed. Nothing on disk is rewritten by this rule.
    const now = new Date().toISOString()
    const row = {
      job_id: 'cues-failed-0012', project_slug: slug, type: 'contextual_cues', episode_id: 'EP0012',
      title: 'Pipeline: Contextual Cues — EP0012', status: 'error', created_at: now, started_at: now,
      finished_at: now, error: 'Contextual Cues are disabled for this project. Enable them first.',
      output_lines: ['Error: Contextual Cues are disabled for this project. Enable them first.'],
      params: { episode_id: 'EP0012', pipeline_step: 'contextual_cues', pipeline_requires: ['scene_plan'] },
    }
    await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'jobs.json'), JSON.stringify({ jobs: [row] }))
    await jq.getJobs(slug)

    const failed = (await jq.getJobs(slug)).find(job => job.job_id === row.job_id)!
    assert.ok(failed.skipped, 'the read-time classification stamps the row')
    assert.match(failed.skipped!.reason, /switched off in this channel's settings/)
    assert.equal(failed.status, 'error', 'the historical row keeps its own recorded outcome')
    assert.equal(failed.error, row.error, 'and its recorded error text, verbatim')
    assert.equal(jq.getQueueStats(slug).error, 0, 'and is not counted as needing attention')

    // The classification is read-time, not a rewrite: switching the feature back
    // on returns the row to reading as its own failure.
    await pm.updateConfig(slug, { contextual_cues: { enabled: true } } as any)
    optional._clearOptionalStepConfigCacheForTesting()
    const back = (await jq.getJobs(slug)).find(job => job.job_id === row.job_id)!
    assert.equal(back.skipped, undefined, 'an enabled step is never skipped')
    assert.equal(jq.getQueueStats(slug).error, 1, 'and the failure is visible again')
  })

  test('an episode recovery plan does not wait for a step the channel switched off', async () => {
    const { dispatchEpisodeRecoveryStep, EPISODE_RECOVERY_ORDER } = await import('../services/episode-recovery.js')
    // The plan a Retry of the failed EP0012 row built: everything up to Contextual
    // Cues is behind it, and the cue step is the next edge.
    const planFor = (slug: string) => ({
      version: 1 as const, id: 'plan-cues', project_slug: slug, episode_id: 'EP0012',
      target: 'contextual_cues' as const,
      steps: {
        contextual_cues: { job_id: 'recovery-plan-cues-contextual_cues', type: 'contextual_cues' as JobType, title: 'Contextual Cues', params: {} },
      },
      completed: [], first_unresolved: 'audio_merge' as const, message: 'Checking episode prerequisites.',
    })
    const verified = () => ({
      verified: Object.fromEntries(EPISODE_RECOVERY_ORDER.map(step => [step, step !== 'contextual_cues' && step !== 'continuity_render'])) as any,
      message: 'Ready.',
    })

    const off = await newChannel('Cues Off Recovery', false)
    const offPlan = planFor(off)
    await dispatchEpisodeRecoveryStep(offPlan, verified(), [], [])
    assert.equal(offPlan.steps.contextual_cues, undefined,
      'the skipped step is dropped from the plan, not waited for')
    assert.equal(offPlan.first_unresolved, null, 'the plan is no longer held by the switched-off step')
    assert.equal(offPlan.message, 'Episode recovery complete.')

    // With the feature on, the step is a real edge again.
    const on = await newChannel('Cues On Recovery', true)
    useExecutor('contextual_cues', async () => {})
    const onPlan = planFor(on)
    await dispatchEpisodeRecoveryStep(onPlan, verified(), [], [])
    assert.ok(onPlan.steps.contextual_cues, 'an enabled step stays in the plan')
    assert.equal(onPlan.first_unresolved, 'contextual_cues', 'and is still the edge the plan waits on')
  })

  test('unrelated running work is untouched', async () => {
    const slug = await newChannel('Cues Off Unrelated', false)
    const ran: string[] = []
    recordChainRuns(ran)
    let releaseAudio!: () => void
    const audioGate = new Promise<void>(resolve => { releaseAudio = resolve })
    let audioEntries = 0
    useExecutor('audio', async () => { audioEntries++; await audioGate })

    const unrelated = await jq.enqueue({ project_slug: slug, type: 'audio', episode_id: 'EP0099', title: 'Audio' })
    await waitFor(() => jq.getJob(unrelated.job_id)?.status === 'running', { label: 'the unrelated job starts' })

    const chain = capturedChain()
    const [first, ...rest] = chain
    const admitted = await jq.enqueue({
      project_slug: slug, type: 'contextual_cues', episode_id: 'EP0098', title: first!.title,
      params: { ...first!.params, pipeline_chain: rest, pipeline_batch_id: 'batch-unrelated' },
    })
    await waitFor(() => jq.getJob(admitted.job_id)?.status === 'done', { label: 'the disabled step settles' })

    assert.equal(jq.getJob(unrelated.job_id)!.status, 'running',
      'the unrelated running job was neither cancelled nor restarted')
    assert.equal(audioEntries, 1, 'and its executor was not entered a second time')

    releaseAudio()
    await waitFor(() => jq.getJob(unrelated.job_id)?.status === 'done', { label: 'the unrelated job finishes normally' })
  })
})
