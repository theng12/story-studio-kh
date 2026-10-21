import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FinalRenderRemoteWaitReceiptV1, Job } from '../models/types.js'
import {
  hasFinalRenderRemoteWaitMarker,
  parseFinalRenderRemoteWaitReceipt,
  publicFinalRenderWait,
  sameFinalRenderRemoteWaitIdentity,
} from '../lib/final-render-remote-wait.js'
import { classifyJobControls } from '../services/job-control.js'
import { resolveJobAutoRetryPolicy } from '../services/job-retry-policy.js'
import { retainJobsForPersistence } from '../services/job-queue.js'

const HASH = 'a'.repeat(64)
const receipt = (overrides: Partial<FinalRenderRemoteWaitReceiptV1> = {}): FinalRenderRemoteWaitReceiptV1 => ({
  version: 1,
  phase: 'remote_wait',
  revision: 1,
  job_id: 'video-job-1',
  intent_id: 'intent-1',
  story_attempt: 1,
  gateway_attempt_key: 'attempt-1',
  request_body_sha256: HASH,
  request_body_bytes: 123,
  packet_sha256: HASH,
  render_fingerprint: HASH,
  submission_scope_sha256: HASH,
  destination_fence_sha256: HASH,
  source_generation_fence_sha256: HASH,
  gateway_job_id: null,
  committed_at: '2026-10-15T00:00:00.000Z',
  cancel_requested_at: null,
  ...overrides,
})

function job(marker: unknown = receipt()): Job {
  return {
    job_id: 'video-job-1', project_slug: 'remote-wait-state', type: 'video_assembly', episode_id: 'EP1',
    title: 'Video', status: 'running', created_at: '2026-10-15T00:00:00.000Z',
    started_at: '2026-10-15T00:00:00.000Z', finished_at: null, error: null,
    output_lines: [], params: { voice: 'Sophea', preset: 'cinematic' },
    final_render_remote_wait: marker as FinalRenderRemoteWaitReceiptV1,
  }
}

describe('video assembly remote-wait state', () => {
  test('uses own-property presence and accepts only the exact closed receipt', () => {
    assert.equal(hasFinalRenderRemoteWaitMarker(job(null)), true)
    assert.equal(hasFinalRenderRemoteWaitMarker({}), false)
    assert.deepEqual(parseFinalRenderRemoteWaitReceipt(receipt(), 'video-job-1'), { ok: true, receipt: receipt() })

    const invalid = [
      receipt({ version: 2 as 1 }),
      receipt({ revision: 3 }),
      receipt({ job_id: 'other-job' }),
      receipt({ request_body_sha256: HASH.toUpperCase() }),
      receipt({ request_body_bytes: 0 }),
      receipt({ committed_at: '2026-10-15T00:00:00Z' }),
      { ...receipt(), extra: true },
      null,
    ]
    for (const value of invalid) assert.equal(parseFinalRenderRemoteWaitReceipt(value, 'video-job-1').ok, false)

    const cancelled = receipt({ revision: 2, cancel_requested_at: '2026-10-15T00:00:01.000Z' })
    assert.equal(parseFinalRenderRemoteWaitReceipt(cancelled, 'video-job-1').ok, true)
    assert.equal(sameFinalRenderRemoteWaitIdentity(receipt(), cancelled), true)
    assert.equal(sameFinalRenderRemoteWaitIdentity(receipt(), receipt({ gateway_attempt_key: 'other' })), false)
  })

  test('projects only bounded public state and fences controls, retries, and retention', () => {
    assert.deepEqual(publicFinalRenderWait(job()), {
      state: 'remote_wait', cancellation_requested: false, gateway_id_known: false,
      committed_at: '2026-10-15T00:00:00.000Z',
    })
    assert.deepEqual(publicFinalRenderWait(job(), true), {
      state: 'recovery_hold', cancellation_requested: false, gateway_id_known: false,
      committed_at: '2026-10-15T00:00:00.000Z',
    })
    assert.deepEqual(publicFinalRenderWait(job(null)), {
      state: 'recovery_hold', cancellation_requested: false, gateway_id_known: false, committed_at: null,
    })
    const controls = classifyJobControls(job(), { remoteCancellationAudited: false })
    assert.deepEqual(controls.map(control => control.action), ['request-remote-cancel'])
    assert.equal(resolveJobAutoRetryPolicy(job()).eligible, false)

    const oldMarked = { ...job(null), status: 'done' as const, finished_at: '2000-01-01T00:00:00.000Z' }
    const unmarked = job()
    delete unmarked.final_render_remote_wait
    const newer = Array.from({ length: 751 }, (_, index) => ({
      ...unmarked, job_id: `terminal-${index}`,
      status: 'done' as const, finished_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }))
    const retained = retainJobsForPersistence([oldMarked, ...newer])
    assert.equal(retained.some(value => value.job_id === oldMarked.job_id), true)
    assert.equal(retained.length, 751)
  })
})
