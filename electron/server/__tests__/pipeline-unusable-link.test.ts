/**
 * A captured Pipeline link whose step was left out is skipped at every boundary
 * that meets it, not only in run-batch.
 *
 * Night Atlas Mythology EP0014, 2026-10-20 (runtime 1.4.335). 1.4.335 stopped
 * run-batch from enqueuing a step preflight left out, but a batch admitted
 * earlier still carried a Motion link with no model (no usable Motion preset).
 * Episode recovery re-enqueued it as `recovery-<plan>-continuation`, the
 * generator died on "episode_id and model are required", and Final Video stayed
 * held behind it with no provider work done.
 *
 * Rule pinned here: a Pipeline link for a step that needs a model its captured
 * params do not carry is skipped (`⊘ Skipped:`), never run, and the steps that
 * needed it proceed — whether the link arrives by chain dispatch, as an already
 * admitted job, or as an episode-recovery continuation.
 */
import { after, afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import type { Job, JobType } from '../models/types.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let pipeline: typeof import('../routes/pipeline.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  pipeline = await import('../routes/pipeline.js')
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

const restores: Array<() => void> = []
afterEach(() => { while (restores.length) restores.pop()!() })

function useExecutor(type: JobType, executor: (job: Job) => Promise<void>): void {
  restores.push(jq._setExecutorForTesting(type, executor))
}

/** The Motion + Final Video chain as 1.4.334 captured it: the Motion link has no `model`. */
function capturedChain(motionModel?: string) {
  const chain: Array<{ type: string; title: string; params: Record<string, any> }> = [
    { type: 'scene_clips_batch', title: 'Motion Clips', params: { auto_approve_clip: true, ...(motionModel ? { model: motionModel } : {}) } },
    { type: 'video_assembly', title: 'Final Video', params: {} },
  ]
  pipeline.stampPipelineStepFacts(chain, 'scene_plan')
  assert.deepEqual(chain[1]!.params.pipeline_requires.includes('motion_review'), true,
    'Final Video must really require the Motion step, or this test proves nothing')
  return chain
}

function record(ran: string[]): void {
  useExecutor('scene_clips_batch', async () => { ran.push('scene_clips_batch') })
  useExecutor('video_assembly', async () => { ran.push('video_assembly') })
  useExecutor('continuity_render', async () => { ran.push('continuity_render') })
}

const newChannel = async (name: string) => (await pm.createProject({ name })).slug

describe('a captured link with no usable model is skipped, not run', () => {
  test('chain dispatch never enqueues it and the parent records the skip', async () => {
    const slug = await newChannel('Link Dispatch')
    const ran: string[] = []
    record(ran)
    const parent = await jq.enqueue({
      project_slug: slug, type: 'continuity_render', episode_id: 'EP0014', title: 'Scene Review',
      params: { pipeline_step: 'scene_review', pipeline_requires: [], pipeline_chain: capturedChain(), pipeline_batch_id: 'b-dispatch' },
    })
    await waitFor(() => ran.includes('video_assembly'), { label: 'Final Video proceeds' })
    await jq._waitForJobPersistenceForTesting()

    assert.deepEqual(ran, ['continuity_render', 'video_assembly'])
    assert.equal((await jq.getJobs(slug)).find(job => job.type === 'scene_clips_batch'), undefined)
    assert.ok(jq.getJob(parent.job_id)!.output_lines.some(line => line.startsWith('⊘ Skipped:')))
  })

  test('an already admitted job settles skipped, with no executor entry, and hands the chain on', async () => {
    const slug = await newChannel('Link Admitted')
    const ran: string[] = []
    record(ran)
    const [motion, ...rest] = capturedChain()
    const admitted = await jq.enqueue({
      project_slug: slug, type: 'scene_clips_batch', episode_id: 'EP0014', title: motion!.title,
      params: { ...motion!.params, pipeline_chain: rest, pipeline_batch_id: 'b-admitted' },
    })
    await waitFor(() => ran.includes('video_assembly'), { label: 'Final Video proceeds' })
    await jq._waitForJobPersistenceForTesting()

    const settled = jq.getJob(admitted.job_id)!
    assert.equal(settled.status, 'done')
    assert.ok(settled.skipped)
    assert.deepEqual(ran, ['video_assembly'], 'Motion never reached its executor')
  })

  test('an episode-recovery continuation head is skipped and its dependents proceed', async () => {
    const { dispatchEpisodeRecoveryStep, EPISODE_RECOVERY_ORDER } = await import('../services/episode-recovery.js')
    const slug = await newChannel('Link Recovery')
    const ran: string[] = []
    record(ran)
    const [motion, ...rest] = capturedChain()
    const plan = {
      version: 1 as const, id: 'plan-motion', project_slug: slug, episode_id: 'EP0014',
      target: 'audio_merge' as const, steps: {}, completed: [], first_unresolved: null, message: '',
      continuation: [motion!, ...rest] as any, pipeline_batch_id: 'b-recovery',
    }
    const verified = Object.fromEntries(EPISODE_RECOVERY_ORDER.map(step => [step, true])) as any
    await dispatchEpisodeRecoveryStep(plan, { verified, message: 'Ready.' }, [], [])

    await waitFor(() => ran.includes('video_assembly'), { label: 'Final Video proceeds' })
    await jq._waitForJobPersistenceForTesting()
    assert.deepEqual(ran, ['video_assembly'], 'Motion never reached its executor')
    const continuation = jq.getJob('recovery-plan-motion-continuation')!
    assert.equal(continuation.status, 'done')
    assert.match(continuation.skipped!.reason, /Motion Clips/)
  })

  test('a link that carries its model, and a manual job with no pipeline step, still run', async () => {
    const slug = await newChannel('Link Usable')
    const ran: string[] = []
    record(ran)
    const [motion, ...rest] = capturedChain('some-video-model')
    await jq.enqueue({
      project_slug: slug, type: 'scene_clips_batch', episode_id: 'EP0016', title: motion!.title,
      params: { ...motion!.params, pipeline_chain: rest, pipeline_batch_id: 'b-usable' },
    })
    await waitFor(() => ran.includes('video_assembly'), { label: 'the full chain runs' })
    assert.deepEqual(ran, ['scene_clips_batch', 'video_assembly'])

    ran.length = 0
    const manual = await jq.enqueue({ project_slug: slug, type: 'scene_clips_batch', episode_id: 'EP0017', title: 'Motion', params: {} })
    await waitFor(() => jq.getJob(manual.job_id)?.status === 'done', { label: 'manual job runs its own executor' })
    assert.deepEqual(ran, ['scene_clips_batch'], 'manual work is not a Pipeline link and is never skipped')
    assert.equal(jq.getJob(manual.job_id)!.skipped, undefined)
  })
})
