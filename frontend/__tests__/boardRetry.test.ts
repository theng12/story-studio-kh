import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardRetryPlan, readRepairRecords, REPAIR_STATE_KEY, type BoardRetryJob } from '../utils/board-retry.js'

const FLEET = [{ model_id: 'studio-hub::tts' }]
const PAID = [{ model_id: 'genstudio::tts-pro' }]
const job = (job_id: string, type: string, episode_id: string, status = 'error', extra: Partial<BoardRetryJob> = {}): BoardRetryJob =>
  ({ job_id, type, episode_id, status, created_at: '2026-10-01T00:00:00Z', ...extra })

test('retries only the ✕ cells of the selection, using the latest job of each step', () => {
  const jobs = [
    job('old', 'metadata', 'EP1', 'error', { created_at: '2026-09-01T00:00:00Z' }),
    job('new', 'metadata', 'EP1'),
    job('other-ep', 'metadata', 'EP2'),
    job('fixed', 'outline_only', 'EP1', 'error', { created_at: '2026-09-01T00:00:00Z' }),
    job('fixed-later', 'expand_chapters', 'EP1', 'done'),
  ]
  const plan = boardRetryPlan(jobs, new Set(['EP1:metadata', 'EP1:script']), () => undefined)
  assert.deepEqual(plan.retry.map(j => j.job_id), ['new'])
  assert.equal(plan.held, 0)
})

test('holds repairable work that was never repaired, and anything Retry is refused for', () => {
  const jobs = [
    job('audio', 'audio', 'EP1'),
    job('thumbs-repaired', 'thumb_images', 'EP2'),
    job('auto-repair', 'metadata', 'EP3', 'error', { params: { auto_repair_missing_prompts: true } }),
    job('scene-prompts', 'image_prompts', 'EP4', 'error', { params: { mode: 'scenes' } }),
    job('recovered', 'metadata', 'EP5', 'error', { resolved: { reason: 'files exist' } }),
  ]
  const cells = new Set(['EP1:audio', 'EP2:thumbnails', 'EP3:metadata', 'EP5:metadata'])
  const plan = boardRetryPlan(jobs, cells, id => id === 'thumbs-repaired'
    ? { outcome: 'measured', result: { recovered: 1, stillMissing: 2, totalExpected: 3 } }
    : undefined)
  assert.deepEqual(plan.retry.map(j => j.job_id), ['thumbs-repaired'])
  assert.equal(plan.held, 3)
})

test('says when a retry may use credits, and not for free fleet or local work', () => {
  const cells = new Set(['EP1:metadata', 'EP2:video_assembly'])
  assert.equal(boardRetryPlan([job('a', 'metadata', 'EP1', 'error', { genstudio_jobs: FLEET }), job('b', 'video_assembly', 'EP2')], cells, () => undefined).mayUseCredits, false)
  assert.equal(boardRetryPlan([job('a', 'metadata', 'EP1', 'error', { genstudio_jobs: PAID })], cells, () => undefined).mayUseCredits, true)
  // No request recorded yet: a resubmit can still be charged.
  assert.equal(boardRetryPlan([job('a', 'metadata', 'EP1')], cells, () => undefined).mayUseCredits, true)
})

test('reads the Jobs page repair records and survives junk', () => {
  const store = (value: string | null) => ({ getItem: (key: string) => key === REPAIR_STATE_KEY ? value : null })
  assert.deepEqual(readRepairRecords(store('{"j1":{"outcome":"failed"}}')), { j1: { outcome: 'failed' } })
  assert.deepEqual(readRepairRecords(store('not json')), {})
  assert.deepEqual(readRepairRecords(store('[1]')), {})
  assert.deepEqual(readRepairRecords(undefined), {})
})
