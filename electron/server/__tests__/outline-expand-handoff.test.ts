/**
 * Script-only Pipeline handoff: the auto-approved `outline_only` → `expand_chapters` chain runs
 * the second link from inside the first one's `runJob`, while the parent is still `running` and
 * still in `activeRunJobIds`. The chapter-writer admission used to count that finished parent as a
 * concurrent writer, so every handoff failed with "expand_chapters generation already
 * queued/running" even though nothing else was writing (`joinDuplicateChainLink` then found no job
 * to join).
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  await jq.setQueuePaused(false)
})

const tail = [{ type: 'continuity_render', title: 'later step', params: { keep: 'me' } }]
const scriptOnlyChain = [
  { type: 'expand_chapters', title: 'Pipeline: Chapters', params: { auto_approve: true } },
  ...tail,
]

/** The parents whose Pipeline handoff is still owed a drain, and the channels this file made. */
const handoffParents: string[] = []
const projectSlugs: string[] = []

/** The concurrent writer that holds the episode, and the gate that releases it. */
let releaseConcurrentWriter: (() => void) | null = null
let concurrentWriterJobId = ''

after(async () => {
  // The job queue writes jobs.json in the background, so the temp data dir must not be removed
  // while a write is in flight: the atomic write's rename then finds its temp file gone and
  // fails with ENOENT. A failed settlement is reported, not swallowed, and the data root is kept
  // as the evidence of it.
  await jq?._waitForJobPersistenceForTesting()
  // Every worker this file started must be settled before the data dir goes away: a write that
  // lands afterwards resolves its store against the real HOME and is refused as an isolation
  // violation. The concurrent writer is released first so its worker can finish.
  releaseConcurrentWriter?.()
  releaseConcurrentWriter = null
  for (const jobId of handoffParents) {
    await waitFor(() => !jq!._isJobWorkerActiveForTesting(jobId), { label: `the worker of ${jobId} to settle` })
  }
  if (concurrentWriterJobId) {
    await waitFor(() => !jq!._isJobWorkerActiveForTesting(concurrentWriterJobId), { label: 'the concurrent writer to settle' })
  }
  // The drain needs the parent out of the active set, and it is what queues the child.
  for (const jobId of handoffParents) await jq?._drainPendingPipelineHandoffForTesting(jobId)
  // The drain may have queued a child, so settle every worker of every channel this file made.
  for (const slug of projectSlugs) {
    for (const job of await jq!.getJobs(slug)) {
      await waitFor(() => !jq!._isJobWorkerActiveForTesting(job.job_id), { label: `the worker of ${job.job_id} to settle` })
    }
  }
  await jq?._waitForJobPersistenceForTesting()
  await cleanup()
})

describe('outline_only -> expand_chapters handoff', () => {
  test('the auto-approved chain starts expand_chapters with its identity, order and tail intact', async () => {
    const proj = await pm.createProject({ name: 'Outline Expand Handoff' })
    projectSlugs.push(proj.slug)
    const ran: string[] = []
    jq.registerExecutor('outline_only', async () => { ran.push('outline_only') })
    jq.registerExecutor('expand_chapters', async () => { ran.push('expand_chapters') })
    jq.registerExecutor('continuity_render', async () => { ran.push('continuity_render') })

    const outline = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'outline_only', episode_id: 'PR0002', title: 'outline',
      params: { auto_approve: true, pipeline_batch_id: 'batch-1', pipeline_chain: structuredClone(scriptOnlyChain) },
    })
    handoffParents.push(outline.job_id)
    await waitFor(() => jq.getJob(outline.job_id)?.status === 'done')
    await waitFor(() => ran.includes('continuity_render'))

    assert.deepEqual(ran, ['outline_only', 'expand_chapters', 'continuity_render'])
    const all = await jq.getJobs(proj.slug)
    assert.equal(all.filter(j => j.params?.pipeline_handoff_failed).length, 0, 'no handoff failure record')
    const expand = all.find(j => j.type === 'expand_chapters')!
    assert.equal(expand.episode_id, 'PR0002')
    assert.equal(expand.title, 'Pipeline: Chapters')
    assert.equal(expand.params.pipeline_batch_id, 'batch-1')
    assert.equal(expand.params.auto_approve, true)
    assert.deepEqual(expand.params.pipeline_chain, tail)
  })

  test('a real concurrent writer still rejects the handoff and the failure is recorded', async () => {
    const proj = await pm.createProject({ name: 'Outline Expand Real Conflict' })
    projectSlugs.push(proj.slug)
    jq.registerExecutor('outline_only', async () => {})
    jq.registerExecutor('expand_chapters', async () => {})
    // The concurrent writer holds the episode until this test releases it, so it is still a real
    // writer when the handoff is attempted.
    let releaseWriter!: () => void
    const writerGate = new Promise<void>(r => { releaseWriter = r })
    jq.registerExecutor('chapter-only', async () => { await writerGate })
    releaseConcurrentWriter = releaseWriter
    // The durable handoff reaches the episode admission check through the same admission seam
    // the app uses, so a real writer can land on the episode exactly at that moment. The parent
    // is done and out of the active set by then, so the writer is admitted and still holds the
    // episode while the handoff is refused.
    let injected = false
    const restore = jq._setEpisodeAdmissionProbeForTesting(async (scope) => {
      if (injected || scope.type !== 'expand_chapters') return
      injected = true
      const writer = jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'chapter-only', episode_id: 'PR0003', title: 'other writer', params: {},
      })
      concurrentWriterJobId = writer.job_id
    })
    try {
      const outline = jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'outline_only', episode_id: 'PR0003', title: 'outline',
        params: { auto_approve: true, pipeline_chain: structuredClone(scriptOnlyChain) },
      })
      handoffParents.push(outline.job_id)
      await waitFor(() => jq.getJob(outline.job_id)?.status === 'done')
      // The handoff is a DURABLE step: it runs after the parent's row is on disk and only once
      // the parent has left the active set. The probe stays installed until the outcome is
      // recorded, so the injected writer is still a concurrent writer at that moment.
      await waitFor(() => !jq._isJobWorkerActiveForTesting(outline.job_id), { label: 'the outline parent worker to settle' })
      await jq._waitForJobPersistenceForTesting()
      await jq._drainPendingPipelineHandoffForTesting(outline.job_id)
      await waitFor(
        async () => (await jq.getJobs(proj.slug)).some(j => j.params?.pipeline_handoff_failed === true),
        { label: 'the recorded Pipeline handoff failure' },
      )
      assert.ok(injected, 'the concurrent writer was injected at the handoff admission check')
      assert.ok(
        jq.getJob(concurrentWriterJobId),
        'the injected concurrent writer is a real job row',
      )
    } finally {
      restore()
      releaseWriter()
    }

    const all = await jq.getJobs(proj.slug)
    assert.equal(all.filter(j => j.type === 'expand_chapters' && !j.params?.pipeline_handoff_failed).length, 0)
    assert.equal(all.filter(j => j.params?.pipeline_handoff_failed).length, 1)
  })

  test('the handing-off parent only stops counting for its own handoff', async () => {
    const proj = await pm.createProject({ name: 'Outline Expand Parent Window' })
    projectSlugs.push(proj.slug)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    jq.registerExecutor('outline_only', async () => { await gate })
    let releaseExpand!: () => void
    const expandGate = new Promise<void>(r => { releaseExpand = r })
    jq.registerExecutor('expand_chapters', async () => { await expandGate })
    const outline = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'outline_only', episode_id: 'PR0004', title: 'outline',
      params: { auto_approve: true, pipeline_chain: structuredClone(scriptOnlyChain) },
    })
    handoffParents.push(outline.job_id)
    try {
      await waitFor(() => jq.getJob(outline.job_id)?.status === 'running')
      // Still writing: a manual expand is a true concurrent writer.
      assert.throws(() => jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'expand_chapters', episode_id: 'PR0004', title: 'manual', params: {},
      }), jq.DuplicateJobError)
      release()
      await waitFor(() => jq.getJob(outline.job_id)?.status === 'done')
      // The expansion it hands off is queued by that durable handoff, so wait for it here.
      await waitFor(() => !jq._isJobWorkerActiveForTesting(outline.job_id), { label: 'the outline parent worker to settle' })
      await jq._waitForJobPersistenceForTesting()
      await jq._drainPendingPipelineHandoffForTesting(outline.job_id)
      await waitFor(
        async () => (await jq.getJobs(proj.slug)).some(j => j.type === 'expand_chapters'),
        { label: 'the handed-off expand_chapters job' },
      )
      // Handoff finished: the expansion it queued still blocks a duplicate.
      assert.throws(() => jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'expand_chapters', episode_id: 'PR0004', title: 'manual', params: {},
      }), jq.DuplicateJobError)
      releaseExpand()
      const expand = (await jq.getJobs(proj.slug)).find(j => j.type === 'expand_chapters')!
      await waitFor(() => jq.getJob(expand.job_id)?.status === 'done')
    } finally {
      release()
      releaseExpand()
    }
  })
})
