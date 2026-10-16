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

after(async () => { await cleanup() })

const tail = [{ type: 'continuity_render', title: 'later step', params: { keep: 'me' } }]
const scriptOnlyChain = [
  { type: 'expand_chapters', title: 'Pipeline: Chapters', params: { auto_approve: true } },
  ...tail,
]

describe('outline_only -> expand_chapters handoff', () => {
  test('the auto-approved chain starts expand_chapters with its identity, order and tail intact', async () => {
    const proj = await pm.createProject({ name: 'Outline Expand Handoff' })
    const ran: string[] = []
    jq.registerExecutor('outline_only', async () => { ran.push('outline_only') })
    jq.registerExecutor('expand_chapters', async () => { ran.push('expand_chapters') })
    jq.registerExecutor('continuity_render', async () => { ran.push('continuity_render') })

    const outline = jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'outline_only', episode_id: 'PR0002', title: 'outline',
      params: { auto_approve: true, pipeline_batch_id: 'batch-1', pipeline_chain: structuredClone(scriptOnlyChain) },
    })
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
    jq.registerExecutor('outline_only', async () => {})
    jq.registerExecutor('expand_chapters', async () => {})
    jq.registerExecutor('chapter-only', async () => { await new Promise(() => {}) }) // never settles
    // A genuine second writer lands while the handoff is preparing its enqueue.
    let injected = false
    const restore = jq._setEpisodeAdmissionProbeForTesting(async (scope) => {
      if (injected || scope.type !== 'expand_chapters') return
      injected = true
      jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'chapter-only', episode_id: 'PR0003', title: 'other writer', params: {},
      })
    })
    try {
      const outline = jq.enqueuePreparedForTest({
        project_slug: proj.slug, type: 'outline_only', episode_id: 'PR0003', title: 'outline',
        params: { auto_approve: true, pipeline_chain: structuredClone(scriptOnlyChain) },
      })
      await waitFor(() => jq.getJob(outline.job_id)?.status === 'done')
    } finally { restore() }

    const all = await jq.getJobs(proj.slug)
    assert.equal(all.filter(j => j.type === 'expand_chapters' && !j.params?.pipeline_handoff_failed).length, 0)
    assert.equal(all.filter(j => j.params?.pipeline_handoff_failed).length, 1)
  })

  test('the handing-off parent only stops counting for its own handoff', async () => {
    const proj = await pm.createProject({ name: 'Outline Expand Parent Window' })
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
    await waitFor(() => jq.getJob(outline.job_id)?.status === 'running')
    // Still writing: a manual expand is a true concurrent writer.
    assert.throws(() => jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'expand_chapters', episode_id: 'PR0004', title: 'manual', params: {},
    }), jq.DuplicateJobError)
    release()
    await waitFor(() => jq.getJob(outline.job_id)?.status === 'done')
    // Handoff finished: the expansion it queued still blocks a duplicate.
    assert.throws(() => jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'expand_chapters', episode_id: 'PR0004', title: 'manual', params: {},
    }), jq.DuplicateJobError)
    releaseExpand()
    const expand = (await jq.getJobs(proj.slug)).find(j => j.type === 'expand_chapters')!
    await waitFor(() => jq.getJob(expand.job_id)?.status === 'done')
  })
})
