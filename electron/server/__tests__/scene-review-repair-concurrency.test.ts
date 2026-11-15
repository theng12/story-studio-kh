/**
 * One adoption per failed continuation, even with two repairs racing (1.4.402, EP0018).
 * The historical parent keeps its chain; only one repair may adopt it.
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let enqueueContinuityRender: typeof import('../routes/scene-review.js').enqueueContinuityRender
let slug = ''

before(async () => {
  await useTempDataDir()
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  ;({ enqueueContinuityRender } = await import('../routes/scene-review.js'))
  slug = (await pm.createProject({ name: 'Repair adoption race' })).slug
})

async function failedParent(episodeId: string): Promise<string> {
  // A terminal record alone does not release an active worker's admission slot.
  const restore = jq._setExecutorForTesting('continuity_render', async () => { throw new Error('fixture parent failed') })
  try {
    const parent = jq.enqueuePreparedForTest({
      project_slug: slug, type: 'continuity_render', episode_id: episodeId, title: 'failed parent',
      params: {
        pipeline_chain: [{ type: 'video_assembly', title: 'Final Video', params: { episode_id: episodeId } }],
        pipeline_batch_id: 'batch-1',
      },
    })
    await waitFor(() => jq.getJob(parent.job_id)?.status === 'error' && !jq._isJobWorkerActiveForTesting(parent.job_id),
      { label: 'failed parent and its worker to finish' })
    return parent.job_id
  } finally { restore() }
}

async function workersFinished(episodeId: string): Promise<void> {
  await waitFor(async () => (await jq.findJobs(slug, row => row.episode_id === episodeId))
    .every(row => !jq._isJobWorkerActiveForTesting(row.job_id)), { label: `${episodeId} workers to finish` })
}

test('two racing bulk repairs produce exactly one adoption and one child', async () => {
  const parentId = await failedParent('EP0018')
  const body = { model: 'mock-image-model', scene_ids: ['sc-1'] }
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const restoreImage = jq._setExecutorForTesting('continuity_render', async () => { await held })
  const restoreVideo = jq._setExecutorForTesting('video_assembly', async () => {})
  try {
    const results = await Promise.allSettled([
      enqueueContinuityRender(slug, 'EP0018', body),
      enqueueContinuityRender(slug, 'EP0018', body),
    ])
    const fulfilled = results.filter(row => row.status === 'fulfilled')
    assert.equal(fulfilled.length, 1, 'the queue admits one bulk owner')
    const rejected = results.filter(row => row.status === 'rejected')
    assert.equal(rejected.length, 1)
    const error = (rejected[0] as PromiseRejectedResult).reason
    assert.equal(error.status, 409)
    assert.match(String(error.message || error), /duplicate|already|finishing/i)

    const jobs = await jq.findJobs(slug, job => job.episode_id === 'EP0018')
    const adopted = jobs.filter(job => job.params?.pipeline_chain_adopted_from === parentId)
    assert.equal(adopted.length, 1, 'exactly one child adopted the parent chain')
    assert.equal((adopted[0]!.params.pipeline_chain as any[])[0].type, 'video_assembly')
    assert.ok(adopted[0]!.output_lines.some(line => line.startsWith(`Adopted the remaining Final Video step from failed job ${parentId}`)))
    assert.equal((await jq.findJobs(slug, job => job.job_id === parentId))[0]!.params.pipeline_chain.length, 1,
      'the historical parent keeps its chain untouched')
  } finally {
    release()
    try { await workersFinished('EP0018') } finally { restoreImage(); restoreVideo() }
  }
})

test('an existing assembly means no adoption, and the repair still queues', async () => {
  const parentId = await failedParent('EP0020')
  const restoreVideo = jq._setExecutorForTesting('video_assembly', async () => {})
  const restoreImage = jq._setExecutorForTesting('continuity_render', async () => {})
  try {
    const assembly = jq.enqueuePreparedForTest({
      project_slug: slug, type: 'video_assembly', episode_id: 'EP0020', title: 'assembly', params: {},
    })
    await waitFor(() => jq.getJob(assembly.job_id)?.status === 'done' && !jq._isJobWorkerActiveForTesting(assembly.job_id),
      { label: 'existing assembly to finish' })
    const job = await enqueueContinuityRender(slug, 'EP0020', { model: 'mock-image-model', scene_ids: ['sc-2'] })
    assert.equal(job.params.pipeline_chain, undefined, 'nothing is adopted when an assembly already exists')
    assert.equal(job.params.pipeline_chain_adopted_from, undefined)
    assert.equal((await jq.findJobs(slug, row => row.job_id === parentId))[0]!.params.pipeline_chain.length, 1)
  } finally {
    try { await workersFinished('EP0020') } finally { restoreImage(); restoreVideo() }
  }
})

test('a completed bulk repair drains exactly one Final Video child', async () => {
  const parentId = await failedParent('EP0030')
  const restoreImage = jq._setExecutorForTesting('continuity_render', async job => { job.result = { ...(job.result || {}), complete: true } })
  const restoreVideo = jq._setExecutorForTesting('video_assembly', async job => { job.result = { ...(job.result || {}), complete: true } })
  try {
    const job = await enqueueContinuityRender(slug, 'EP0030', { model: 'mock-image-model', scene_ids: ['sc-30'] })
    await waitFor(() => jq.getJob(job.job_id)?.status === 'done', { label: 'the repaired image batch to finish' })
    await waitFor(async () => (await jq.findJobs(slug, row => row.type === 'video_assembly' && row.episode_id === 'EP0030')).length === 1,
      { label: 'exactly one Final Video child' })
    const assemblies = await jq.findJobs(slug, row => row.type === 'video_assembly' && row.episode_id === 'EP0030')
    assert.equal(assemblies.length, 1)
    assert.equal(assemblies[0]!.params.pipeline_batch_id, 'batch-1')
    assert.equal((await jq.findJobs(slug, row => row.job_id === parentId))[0]!.params.pipeline_chain.length, 1,
      'the failed parent remains historical')
  } finally {
    try { await workersFinished('EP0030') } finally { restoreImage(); restoreVideo() }
  }
})

test('a failed bulk repair queues no assembly', async () => {
  await failedParent('EP0031')
  const restoreImage = jq._setExecutorForTesting('continuity_render', async () => { throw new Error('image render failed') })
  try {
    const job = await enqueueContinuityRender(slug, 'EP0031', { model: 'mock-image-model', scene_ids: ['sc-31'] })
    await waitFor(() => jq.getJob(job.job_id)?.status === 'error' && !jq._isJobWorkerActiveForTesting(job.job_id),
      { label: 'the failed image batch' })
    assert.equal((await jq.findJobs(slug, row => row.type === 'video_assembly' && row.episode_id === 'EP0031')).length, 0)
  } finally { restoreImage() }
})
