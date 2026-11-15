/**
 * Standalone image repair adopts the failed step's saved continuation exactly once (EP0018).
 *
 * The real rows: repair 2476fd2e chain=[] / done / 231 images; parent 0cb6378e status=error /
 * local_execution_complete / chain=[video_assembly] / no handoff marker. The repair child takes the
 * chain; the parent stays historical. A single-scene repair, an existing assembly, or a chain
 * already adopted from the same parent adopts nothing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { assemblyAlreadyExists, repairContinuationFrom } from '../services/pipeline-repair-continuation.js'

const job = (over: Record<string, unknown>): any => ({
  job_id: 'job', project_slug: 'cello', type: 'continuity_render', episode_id: 'EP0018',
  status: 'error', created_at: '2026-11-15T00:00:00Z', output_lines: [], params: {}, ...over,
})

const PARENT = job({
  job_id: '0cb6378e', status: 'error', local_execution_complete: true,
  params: { pipeline_chain: [{ type: 'video_assembly', title: 'Final Video', params: { episode_id: 'EP0018' } }], pipeline_batch_id: 'batch-1' },
})
const REPAIR = job({ job_id: '2476fd2e', status: 'done', local_execution_complete: true, params: {} })

test('the bulk repair adopts the failed parent\'s Final Video chain and batch, once', () => {
  const adopted = repairContinuationFrom([PARENT, REPAIR], 'EP0018', { assemblyExists: false })
  assert.ok(adopted)
  assert.equal(adopted!.fromJobId, '0cb6378e')
  assert.equal(adopted!.batchId, 'batch-1')
  assert.equal((adopted!.chain[0] as any).type, 'video_assembly')
  assert.equal(PARENT.params.pipeline_chain.length, 1, 'the historical parent is not edited')
})

test('nothing is adopted when an assembly already exists, the chain is empty, or it was adopted before', () => {
  assert.equal(repairContinuationFrom([PARENT], 'EP0018', { assemblyExists: true }), null)
  assert.equal(repairContinuationFrom([job({ job_id: 'nochain' })], 'EP0018', { assemblyExists: false }), null)
  const already = job({ job_id: 'child', params: { pipeline_chain_adopted_from: '0cb6378e' } })
  assert.equal(repairContinuationFrom([PARENT, already], 'EP0018', { assemblyExists: false }), null)
})

test('a chain that does not start at Final Video is not adopted', () => {
  const other = job({
    job_id: 'other', status: 'error', local_execution_complete: true,
    params: { pipeline_chain: [{ type: 'thumb_images', params: {} }] },
  })
  assert.equal(repairContinuationFrom([other], 'EP0018', { assemblyExists: false }), null)
})

test('only a completed-failure row qualifies; a still-running parent does not', () => {
  const running = job({ job_id: 'running', status: 'running', local_execution_complete: false, params: PARENT.params })
  assert.equal(repairContinuationFrom([running], 'EP0018', { assemblyExists: false }), null)
})

test('a finished or live assembly counts as already existing; an errored one does not', () => {
  for (const status of ['queued', 'running', 'done']) {
    assert.equal(assemblyAlreadyExists([job({ type: 'video_assembly', status })], 'EP0018'), true, status)
  }
  assert.equal(assemblyAlreadyExists([job({ type: 'video_assembly', status: 'error' })], 'EP0018'), false)
  assert.equal(assemblyAlreadyExists([job({ type: 'video_assembly', status: 'done', episode_id: 'EP0019' })], 'EP0018'), false)
})
