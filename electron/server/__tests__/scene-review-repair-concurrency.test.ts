/**
 * One adoption per failed continuation, even with two repairs racing (1.4.402, EP0018).
 *
 * The adoption scan and the enqueue are one reservation under the episode's continuity lock. A
 * second bulk repair arriving at the same moment either loses the queue's own dedupe (a clean
 * DuplicateJobError) or finds the first child's persisted marker; it can never adopt the same
 * parent twice. An episode that already has an assembly adopts nothing.
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let enqueueContinuityRender: typeof import('../routes/scene-review.js').enqueueContinuityRender
let slug = ''

before(async () => {
  await useTempDataDir()
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  ;({ enqueueContinuityRender } = await import('../routes/scene-review.js'))
  const project = await pm.createProject({ name: 'Repair adoption race' })
  slug = project.slug
})

async function failedParent(episodeId: string): Promise<string> {
  const parent = jq.enqueuePreparedForTest({
    project_slug: slug, type: 'continuity_render', episode_id: episodeId, title: 'failed parent',
    params: {
      pipeline_chain: [{ type: 'video_assembly', title: 'Final Video', params: { episode_id: episodeId } }],
      pipeline_batch_id: 'batch-1',
    },
  })
  jq._setJobRecordForTesting(parent.job_id, { status: 'error', local_execution_complete: true })
  await jq.checkpointJobState(jq.getJob(parent.job_id)!)
  return parent.job_id
}

test('two racing bulk repairs produce exactly one adoption and one child', async () => {
  const parentId = await failedParent('EP0018')
  const body = { model: 'mock-image-model', scene_ids: ['sc-1'] }
  const results = await Promise.allSettled([
    enqueueContinuityRender(slug, 'EP0018', body),
    enqueueContinuityRender(slug, 'EP0018', body),
  ])
  const fulfilled = results.filter(row => row.status === 'fulfilled')
  assert.equal(fulfilled.length, 1, 'the queue admits one bulk owner')
  const rejected = results.filter(row => row.status === 'rejected')
  assert.equal(rejected.length, 1)
  assert.match(String((rejected[0] as PromiseRejectedResult).reason?.message || (rejected[0] as PromiseRejectedResult).reason),
    /duplicate|already/i)

  const jobs = await jq.findJobs(slug, job => job.episode_id === 'EP0018')
  const adopted = jobs.filter(job => job.params?.pipeline_chain_adopted_from === parentId)
  assert.equal(adopted.length, 1, 'exactly one child adopted the parent chain')
  assert.equal((adopted[0]!.params.pipeline_chain as any[])[0].type, 'video_assembly')
  assert.ok(adopted[0]!.output_lines.some(line => line.startsWith(`Adopted the remaining Final Video step from failed job ${parentId}`)))
  assert.equal((await jq.findJobs(slug, job => job.job_id === parentId))[0]!.params.pipeline_chain.length, 1,
    'the historical parent keeps its chain untouched')
})

test('an existing assembly means no adoption, and the repair still queues', async () => {
  const parentId = await failedParent('EP0020')
  const assembly = jq.enqueuePreparedForTest({
    project_slug: slug, type: 'video_assembly', episode_id: 'EP0020', title: 'assembly', params: {},
  })
  jq._setJobRecordForTesting(assembly.job_id, { status: 'done', local_execution_complete: true })
  await jq.checkpointJobState(jq.getJob(assembly.job_id)!)

  const job = await enqueueContinuityRender(slug, 'EP0020', { model: 'mock-image-model', scene_ids: ['sc-2'] })
  assert.equal(job.params.pipeline_chain, undefined, 'nothing is adopted when an assembly already exists')
  assert.equal(job.params.pipeline_chain_adopted_from, undefined)
  assert.equal((await jq.findJobs(slug, row => row.job_id === parentId))[0]!.params.pipeline_chain.length, 1)
})
