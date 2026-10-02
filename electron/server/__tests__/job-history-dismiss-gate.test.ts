/**
 * v1.2.6 — a finished job's history must be dismissable once GenStudio says
 * its provider work is done, and Story Studio must never claim otherwise from
 * a snapshot it has not refreshed.
 *
 * The owner: "in jobs i can't clear this error while i already went in and
 * repaired it. i got the audio file already." His EP0058 audio job recorded
 * ten voice.tts calls; nine were snapshotted as succeeded and the tenth was
 * still in flight when the job finished. `genstudio_jobs` is only that
 * snapshot, and nothing ever re-read it, so the gate asserted "durable
 * provider work is still settling" about work GenStudio had settled in full,
 * with zero credits held — a false statement behind a disabled button labelled
 * "Checking provider status" that was checking nothing.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { reconcilePendingJobCancellation } from '../services/job-cancellation-reconciler.js'
import { classifyJobControl } from '../services/job-control.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await setGenStudioUrl('https://history-gate.test')
})
after(async () => { await cleanup() })

type GateJob = Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations' | 'history_evidence_check'>

function finishedAudioJob(overrides: Partial<GateJob> = {}): GateJob {
  return {
    status: 'done',
    type: 'audio',
    params: {},
    genstudio_jobs: [
      { id: 'tts-9', operation: 'voice.tts', state: 'succeeded', updated_at: '2026-08-16T02:38:00.000Z' },
      { id: 'tts-10', operation: 'voice.tts', state: 'accepted', updated_at: '2026-08-16T02:38:00.000Z' },
    ],
    ...overrides,
  }
}

const capabilities = { remoteCancellationAudited: true }

describe('finished-job dismiss gate', () => {
  test('before an answer, the control says it is asking — and it really is', () => {
    const control = classifyJobControl(finishedAudioJob(), capabilities)
    assert.equal(control.action, 'return-later')
    assert.equal(control.enabled, false)
    assert.equal(control.label, 'Checking provider status')
    assert.match(control.reason, /Story Studio is asking Gateway whether the narration request finished/)
    assert.match(control.reason, /can be removed as soon as the Gateway confirms it has/)
    assert.doesNotMatch(control.reason, /voice\.tts|tts-10/)
    // It must not assert anything about the provider it has not yet asked.
    assert.doesNotMatch(control.reason, /still settling/)
  })

  test('terminal on Gateway means dismissable, with no further clicks', () => {
    const settled = finishedAudioJob({
      genstudio_jobs: [
        { id: 'tts-9', operation: 'voice.tts', state: 'succeeded', updated_at: '2026-08-16T02:38:00.000Z' },
        { id: 'tts-10', operation: 'voice.tts', state: 'succeeded', updated_at: '2026-08-17T09:00:00.000Z' },
      ],
    })
    const control = classifyJobControl(settled, capabilities)
    assert.equal(control.action, 'clear-history')
    assert.equal(control.enabled, true)
    assert.equal(control.label, 'Remove from history')
    assert.equal(control.code, 'READY')
  })

  test('an unreachable the Gateway is a statement about Story Studio, not about the provider', () => {
    const control = classifyJobControl(finishedAudioJob({
      history_evidence_check: {
        state: 'unreachable',
        at: '2026-08-17T09:00:00.000Z',
        detail: 'Gateway status check is waiting (HTTP 503: service unavailable)',
      },
    }), capabilities)
    assert.equal(control.code, 'PROVIDER_STATUS_UNREACHABLE')
    assert.match(control.reason, /could not reach the Gateway to confirm whether the narration request finished/)
    assert.match(control.reason, /cannot say whether that work is still running/)
    assert.match(control.reason, /HTTP 503/)
    assert.doesNotMatch(control.reason, /voice\.tts|tts-10/)
    // The two states are never conflated.
    assert.doesNotMatch(control.reason, /still settling/)
    assert.doesNotMatch(control.reason, /GenStudio reports/)
    // And it offers the action rather than describing one it is not doing.
    assert.equal(control.enabled, true)
    assert.equal(control.action, 'recheck-provider-status')
    assert.equal(control.label, 'Check the Gateway again')
  })

  test('genuinely unfinished work still blocks dismissal, now on the Gateway\'s own word', () => {
    const control = classifyJobControl(finishedAudioJob({
      history_evidence_check: { state: 'unsettled', at: '2026-08-17T09:00:00.000Z' },
    }), capabilities)
    assert.equal(control.code, 'PROVIDER_WORK_ALREADY_STARTED')
    assert.match(control.reason, /GenStudio reports that the narration request has not finished yet/)
    assert.match(control.reason, /keeping this history until that work settles/)
    assert.doesNotMatch(control.reason, /voice\.tts|tts-10/)
    // The protection is intact: this is not a clear-history.
    assert.notEqual(control.action, 'clear-history')
    // But the customer is never stranded — the re-check is offered.
    assert.equal(control.enabled, true)
    assert.equal(control.action, 'recheck-provider-status')
  })

  test('a settled job ignores a stale check record instead of staying blocked by it', () => {
    const control = classifyJobControl(finishedAudioJob({
      genstudio_jobs: [{ id: 'tts-10', operation: 'voice.tts', state: 'succeeded', updated_at: '2026-08-17T09:00:00.000Z' }],
      history_evidence_check: { state: 'unsettled', at: '2026-08-16T02:38:00.000Z' },
    }), capabilities)
    assert.equal(control.action, 'clear-history')
  })

  test('no control ever offers a disabled button that names an activity it is not performing', () => {
    for (const state of ['unreachable', 'unsettled'] as const) {
      const control = classifyJobControl(finishedAudioJob({
        history_evidence_check: { state, at: '2026-08-17T09:00:00.000Z' },
      }), capabilities)
      if (!control.enabled) assert.doesNotMatch(control.label, /Checking/)
    }
  })

  test('several outstanding tasks are summarised rather than listed without end', () => {
    const control = classifyJobControl(finishedAudioJob({
      genstudio_jobs: Array.from({ length: 6 }, (_, index) => ({
        id: `tts-${index}`, operation: 'voice.tts' as const, state: 'accepted', updated_at: '2026-08-16T02:38:00.000Z',
      })),
    }), capabilities)
    assert.match(control.reason, /whether 6 narration requests finished/)
    assert.doesNotMatch(control.reason, /voice\.tts|tts-[0-5]/)
  })

  test('the summary agrees with itself about singular and plural', () => {
    const one = classifyJobControl(finishedAudioJob({
      history_evidence_check: { state: 'unsettled', at: '2026-08-17T09:00:00.000Z' },
    }), capabilities)
    assert.match(one.reason, /the narration request has not finished yet/)

    const many = classifyJobControl(finishedAudioJob({
      genstudio_jobs: [
        { id: 'tts-9', operation: 'voice.tts', state: 'accepted', updated_at: '2026-08-16T02:38:00.000Z' },
        { id: 'tts-10', operation: 'voice.tts', state: 'accepted', updated_at: '2026-08-16T02:38:00.000Z' },
      ],
      history_evidence_check: { state: 'unsettled', at: '2026-08-17T09:00:00.000Z' },
    }), capabilities)
    assert.match(many.reason, /2 narration requests have not finished yet/)
    assert.doesNotMatch(many.reason, /requests has not/)
  })
})

describe('read-only reconciliation for a finished job', () => {
  test('refreshes the stored evidence without issuing any provider control request', async () => {
    const original = globalThis.fetch
    const requests: Array<{ method: string; path: string }> = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      requests.push({ method: (init?.method || 'GET').toUpperCase(), path: url.pathname })
      if (url.pathname === '/v1/jobs/tts-10') {
        return Response.json({ id: 'tts-10', state: 'succeeded', dispatch_state: 'pre_dispatch', cancellable: true, cancelled: false, released_credits: 0 })
      }
      return Response.json({ detail: 'unexpected request' }, { status: 500 })
    }
    try {
      const job = {
        job_id: 'story-ep0058', project_slug: 'project', type: 'audio', episode_id: 'EP0058', title: 'Audio',
        status: 'done', created_at: '2026-08-16T02:00:00.000Z', started_at: '2026-08-16T02:00:00.000Z',
        finished_at: '2026-08-16T02:38:00.000Z', error: null, output_lines: [], params: {},
        genstudio_jobs: [{ id: 'tts-10', operation: 'voice.tts' as const, state: 'accepted', updated_at: '2026-08-16T02:38:00.000Z' }],
        // A stranded crash-recovery marker on a job that already finished must
        // not be mistaken for a live request to cancel something.
        remote_cancellations: {
          'voice.tts:tts-10': {
            status: 'submitting' as const, operation: 'voice.tts' as const, provider_job_id: 'tts-10',
            requested_at: '2026-08-16T02:38:00.000Z', updated_at: '2026-08-16T02:38:00.000Z',
          },
        },
      } as unknown as Job

      const outcome = await reconcilePendingJobCancellation(job, 'test-key', { readOnly: true })
      assert.equal(outcome.kind, 'succeeded')
      assert.equal(requests.some(request => request.method === 'POST'), false, 'a finished job must send no cancellation POST')
      assert.equal(outcome.providerJobs[0]?.job.state, 'succeeded')
    } finally {
      globalThis.fetch = original
    }
  })
})
