/**
 * A failed Pipeline step holds back only the later steps that need it.
 *
 * Before 1.4.248 an episode chain was a straight line: one failed thumbnail
 * stopped that episode's audio, subtitles, scenes and final video for the
 * whole overnight run.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { splitChainAfterFailure } from '../lib/pipeline-continuation.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let pipeline: typeof import('../routes/pipeline.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  pipeline = await import('../routes/pipeline.js')
})
after(async () => { await cleanup() })

function link(type: string, step: string, requires: string[]) {
  return { type, title: type, params: { pipeline_step: step, pipeline_requires: requires } }
}

test('split holds dependents (directly and through a held link) and keeps the rest', () => {
  const split = splitChainAfterFailure('introduction-only', [
    link('image_prompts', 'image_prompts', ['script-only']),
    link('thumb_images', 'thumb_images', ['image_prompts']),
    link('audio', 'audio', ['script-only', 'introduction-only']),
    link('audio_merge', 'audio_merge', ['audio']),
  ])!
  assert.deepEqual(split.survivors.map(l => l.type), ['image_prompts', 'thumb_images'])
  assert.deepEqual(split.waiting.map(l => l.type), ['audio', 'audio_merge'])
  // Two links of one step (outline → chapters): a failed first half holds the second.
  const script = splitChainAfterFailure('script-only', [link('expand_chapters', 'script-only', [])])!
  assert.deepEqual(script.waiting.map(l => l.type), ['expand_chapters'])
  // A chain written before step facts existed keeps the old stop.
  assert.equal(splitChainAfterFailure('thumb_images', [{ type: 'audio', params: {} }]), null)
})

test('narration waits for the opening and the final video waits for requested motion clips', () => {
  const run = new Set(['script-only', 'introduction-only', 'audio', 'scene_review', 'motion_review', 'video_assembly'] as const)
  assert.ok(pipeline.pipelineLinkRequirements('audio', run as any, 'scene_plan').includes('introduction-only'))
  assert.ok(pipeline.pipelineLinkRequirements('video_assembly', run as any, 'scene_plan').includes('motion_review'))
  assert.ok(!pipeline.pipelineLinkRequirements('video_assembly', new Set(['video_assembly']) as any, 'scene_plan').includes('motion_review'))
  const chain: Array<{ type: string; params: Record<string, any> }> = [{ type: 'outline_only', params: {} }, { type: 'expand_chapters', params: {} }, { type: 'continuity_render', params: {} }]
  pipeline.stampPipelineStepFacts(chain, 'scene_plan')
  assert.deepEqual(chain.map(l => l.params.pipeline_step), ['script-only', 'script-only', 'scene_review'])
  assert.deepEqual(chain[2].params.pipeline_requires, ['scene_plan'])
})

test('a failed opening no longer stops thumbnails; Retry continues only what waited', async () => {
  const proj = await pm.createProject({ name: 'Pipeline failure continuation' })
  const runs: string[] = []
  let failIntro = true
  jq.registerExecutor('introduction-only', async () => {
    runs.push('introduction-only')
    if (failIntro) throw new Error('The writing pool was busy')
  })
  for (const type of ['image_prompts', 'thumb_images', 'audio', 'audio_merge'] as const) {
    jq.registerExecutor(type, async () => { runs.push(type) })
  }
  const head = jq.enqueuePreparedForTest({
    project_slug: proj.slug,
    type: 'introduction-only',
    episode_id: 'EP001',
    title: 'intro',
    params: {
      pipeline_batch_id: 'batch-continue',
      pipeline_step: 'introduction-only',
      pipeline_requires: ['script-only'],
      pipeline_chain: [
        link('image_prompts', 'image_prompts', ['script-only']),
        link('thumb_images', 'thumb_images', ['image_prompts']),
        link('audio', 'audio', ['script-only', 'introduction-only']),
        link('audio_merge', 'audio_merge', ['audio']),
      ],
    },
  })

  await waitFor(() => runs.includes('thumb_images') && jq.getJob(head.job_id)?.status === 'error')
  await jq._waitForJobPersistenceForTesting()
  const failed = jq.getJob(head.job_id)!
  assert.deepEqual(runs, ['introduction-only', 'image_prompts', 'thumb_images'])
  assert.deepEqual(failed.params.pipeline_chain.map((l: any) => l.type), ['audio', 'audio_merge'])
  assert.ok(failed.output_lines.some(line => /Waiting for this step: Audio, Audio Assembly/.test(line)))
  assert.ok(failed.output_lines.some(line => /kept going .*Thumbnail Prompts, Thumbnails/.test(line)))
  const batch = (await jq.getJobs(proj.slug)).filter(job => job.params?.pipeline_batch_id === 'batch-continue')
  assert.ok(batch.length >= 3, 'continued links stay in the same batch')

  failIntro = false
  const retried = jq.retryTerminalJob(proj.slug, head.job_id)
  await waitFor(() => runs.includes('audio_merge') && jq.getJob(retried.job_id)?.status === 'done')
  assert.deepEqual(runs.slice(3), ['introduction-only', 'audio', 'audio_merge'], 'Retry never repeats the steps that already continued')
})
