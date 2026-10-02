import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Job, JobControl, JobType } from '../models/types.js'
import { classifyJobControl, classifyJobControls, isProvenLocalStopCapableJob } from '../services/job-control.js'
import {
  getJobCancellationAuditor,
  hasJobCancellationAuditor,
  registerJobCancellationAuditor,
} from '../services/job-cancellation-auditors.js'

type Evidence = NonNullable<Job['genstudio_jobs']>[number]

function job(overrides: Partial<Job> = {}): Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations'> {
  return {
    status: 'running',
    type: 'thumb_images',
    params: {},
    ...overrides,
  }
}

function evidence(operation: Evidence['operation'], state: string, extra: Partial<Evidence> = {}): Evidence {
  return {
    id: `${operation}-task`,
    operation,
    state,
    updated_at: '2026-08-11T00:00:00.000Z',
    ...extra,
  }
}

describe('server-owned job controls', () => {
  test('classifies every supported state without inferring provider safety', () => {
    const cases: Array<{
      name: string
      input: Partial<Job>
      audited?: boolean
      action: JobControl['action']
      code: JobControl['code']
      reason: string
    }> = [
      { name: 'queued', input: { status: 'queued' }, action: 'cancel-before-submit', code: 'READY', reason: 'Nothing has been sent to the Gateway yet, so cancelling costs nothing.' },
      { name: 'paused', input: { status: 'paused' }, action: 'cancel-before-submit', code: 'READY', reason: 'Nothing has been sent to the Gateway yet, so cancelling costs nothing.' },
      { name: 'local video assembly', input: { type: 'video_assembly' }, action: 'stop-local', code: 'READY', reason: 'Stops this job on this Mac now. Nothing was sent to the Gateway, so nothing is charged.' },
      { name: 'local audio merge', input: { type: 'audio_merge' }, action: 'stop-local', code: 'READY', reason: 'Stops this job on this Mac now. Nothing was sent to the Gateway, so nothing is charged.' },
      { name: 'pre-dispatch tts', input: { genstudio_jobs: [evidence('voice.tts', 'accepted', { dispatch_state: 'pre_dispatch', cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Asks the Gateway to stop the request it can still stop. Work that never runs is not charged.' },
      { name: 'pre-dispatch image', input: { genstudio_jobs: [evidence('image.generation', 'reserved', { dispatch_state: 'pre_dispatch', cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Asks the Gateway to stop the request it can still stop. Work that never runs is not charged.' },
      { name: 'pre-dispatch transcription', input: { genstudio_jobs: [evidence('audio.transcription', 'accepted', { dispatch_state: 'pre_dispatch', cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Asks the Gateway to stop the request it can still stop. Work that never runs is not charged.' },
      { name: 'dispatched video the gateway cannot stop', input: { genstudio_jobs: [evidence('video.generation', 'running', { dispatch_state: 'dispatched', cancellable: false })] }, audited: true, action: 'pause-submissions', code: 'PROVIDER_WORK_ALREADY_STARTED', reason: 'The video request already started and will finish — it can\'t be cancelled now. Pause stops anything new from being sent.' },
      { name: 'pre-dispatch chat', input: { genstudio_jobs: [evidence('chat.response', 'accepted', { dispatch_state: 'pre_dispatch', cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Asks the Gateway to stop the request it can still stop. Work that never runs is not charged.' },
      { name: 'pre-dispatch music', input: { genstudio_jobs: [evidence('music.generation', 'accepted', { dispatch_state: 'pre_dispatch', cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Asks the Gateway to stop the request it can still stop. Work that never runs is not charged.' },
      { name: 'dispatched narration the gateway can stop', input: { genstudio_jobs: [evidence('voice.tts', 'running', { dispatch_state: 'dispatched', cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Asks the Gateway to stop the request it can still stop. Work that never runs is not charged.' },
      { name: 'started image', input: { genstudio_jobs: [evidence('image.generation', 'running', { dispatch_state: 'dispatched', cancellable: false })] }, audited: true, action: 'pause-submissions', code: 'PROVIDER_WORK_ALREADY_STARTED', reason: 'The image request already started and will finish — it can\'t be cancelled now. Pause stops anything new from being sent.' },
      { name: 'submitting image', input: { genstudio_jobs: [evidence('image.generation', 'submitting')] }, audited: true, action: 'return-later', code: 'CANCELLATION_STATUS_UNKNOWN', reason: 'Story Studio cannot yet prove whether every provider request was accepted. It will reconcile before any new submission.' },
      {
        name: 'cancellation already requested',
        input: {
          remote_cancellations: {
            'image.generation:image-task': {
              status: 'requested', operation: 'image.generation', provider_job_id: 'image-task',
              requested_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
            },
          },
        },
        audited: true,
        action: 'return-later',
        code: 'CANCELLATION_STATUS_UNKNOWN',
        reason: 'Story Studio is waiting for the Gateway to confirm the cancellation result. The provider work may still settle.',
      },
      { name: 'done', input: { status: 'done' }, action: 'clear-history', code: 'READY', reason: 'This finished job can be removed from the job list. Its files and provider evidence stay intact.' },
      { name: 'error', input: { status: 'error' }, action: 'clear-history', code: 'READY', reason: 'This finished job can be removed from the job list. Its files and provider evidence stay intact.' },
      { name: 'cancelled', input: { status: 'cancelled' }, action: 'clear-history', code: 'READY', reason: 'This finished job can be removed from the job list. Its files and provider evidence stay intact.' },
    ]

    for (const item of cases) {
      const control = classifyJobControl(job(item.input), { remoteCancellationAudited: item.audited ?? false })
      assert.equal(control.action, item.action, item.name)
      assert.equal(control.code, item.code, item.name)
      assert.equal(control.reason, item.reason, item.name)
    }
  })

  test('returns only cancellable provider targets and names work that will finish', () => {
    const control = classifyJobControl(job({
      genstudio_jobs: [
        evidence('image.generation', 'accepted', { dispatch_state: 'pre_dispatch', cancellable: true, id: 'can-cancel' }),
        evidence('image.generation', 'running', { dispatch_state: 'dispatched', cancellable: false, id: 'already-started' }),
      ],
    }), { remoteCancellationAudited: true })

    assert.equal(control.action, 'request-remote-cancel')
    assert.deepEqual(control.targets, [{ operation: 'image.generation', provider_job_id: 'can-cancel' }])
    assert.doesNotMatch(control.reason, /already-started|can-cancel/)
    assert.match(control.reason, /image request/i)
    assert.match(control.reason, /already started and will finish/i)
  })

  test('never calls a checkpointed provider job unsubmitted merely because Story restored it queued or paused', () => {
    for (const status of ['queued', 'paused'] as const) {
      const control = classifyJobControl(job({
        status,
        genstudio_jobs: [evidence('voice.tts', 'accepted', { cancellable: true })],
      }), { remoteCancellationAudited: true })

      assert.notEqual(control.action, 'cancel-before-submit', status)
      assert.notEqual(control.financial_effect, 'no-provider-request', status)
    }
  })

  test('does not expose history removal for a terminal-looking job with unsettled provider evidence', () => {
    const control = classifyJobControl(job({
      status: 'error',
      genstudio_jobs: [evidence('voice.tts', 'running')],
    }), { remoteCancellationAudited: true })

    assert.equal(control.action, 'return-later')
    assert.equal(control.enabled, false)
  })

  test('exposes truthful Pause independently from pre-dispatch cancellation for scene image batches', () => {
    const controls = classifyJobControls(job({
      type: 'continuity_render',
      genstudio_jobs: [
        evidence('image.generation', 'accepted', { id: 'not-dispatched', dispatch_state: 'pre_dispatch', cancellable: true }),
        evidence('image.generation', 'running', { id: 'already-started', dispatch_state: 'dispatched', cancellable: false }),
      ],
    }), { remoteCancellationAudited: true })

    // v1.2.8 appends the always-available owner override as a third control.
    // The first two are unchanged and still say exactly what they said before.
    assert.deepEqual(controls.map(control => control.action), ['pause-submissions', 'request-remote-cancel', 'force-abandon'])
    assert.equal(controls[0]?.enabled, true)
    assert.deepEqual(controls[1]?.targets, [{ operation: 'image.generation', provider_job_id: 'not-dispatched' }])
    assert.match(controls[0]?.reason || '', /already accepted work will finish/i)
  })

  test('keeps pause disabled for image jobs without a proven cooperative item boundary', () => {
    const control = classifyJobControl(job({
      type: 'thumb_images',
      genstudio_jobs: [evidence('image.generation', 'running', { dispatch_state: 'dispatched', cancellable: false })],
    }), { remoteCancellationAudited: true })

    assert.equal(control.action, 'pause-submissions')
    assert.equal(control.enabled, false)
    assert.match(control.reason, /already started and will finish/i)
  })

  test('keeps Pause submissions enabled only for an executor with a proven cooperative boundary', () => {
    const control = classifyJobControl(job({
      type: 'audio',
      genstudio_jobs: [evidence('voice.tts', 'running', { dispatch_state: 'dispatched', cancellable: false })],
    }), { remoteCancellationAudited: true })

    assert.equal(control.action, 'pause-submissions')
    assert.equal(control.enabled, true)
  })

  test('offers Pause only for the explicit Scene Plan paid-repair path with per-request safe points', () => {
    const ordinary = classifyJobControls(job({
      type: 'scene_plan_run',
      params: { stage: 'visual' },
      genstudio_jobs: [evidence('chat.response', 'running', { dispatch_state: 'dispatched', cancellable: false })],
    }), { remoteCancellationAudited: true })
    assert.equal(ordinary.some(control => control.action === 'pause-submissions' && control.enabled), false)

    const paidRepair = classifyJobControls(job({
      type: 'scene_plan_run',
      params: { stage: 'visual', auto_repair_missing_prompts: true },
      genstudio_jobs: [evidence('chat.response', 'running', { dispatch_state: 'dispatched', cancellable: false })],
    }), { remoteCancellationAudited: true })
    assert.equal(paidRepair.some(control => control.action === 'pause-submissions' && control.enabled), true)
  })

  test('cancels every sibling the gateway says is cancellable and never promises a refund', () => {
    const control = classifyJobControl(job({
      genstudio_jobs: [
        evidence('chat.response', 'accepted', { dispatch_state: 'pre_dispatch', cancellable: true, id: 'chat-can-cancel' }),
        evidence('music.generation', 'running', { dispatch_state: 'dispatched', cancellable: true, id: 'music-can-cancel' }),
        evidence('image.generation', 'running', { dispatch_state: 'dispatched', cancellable: false, id: 'image-keeps-running' }),
      ],
    }), { remoteCancellationAudited: true })

    assert.equal(control.action, 'request-remote-cancel')
    assert.deepEqual(control.targets, [
      { operation: 'chat.response', provider_job_id: 'chat-can-cancel' },
      { operation: 'music.generation', provider_job_id: 'music-can-cancel' },
    ])
    assert.match(control.reason, /image request already started and will continue settling/i)
    assert.doesNotMatch(control.reason, /image-keeps-running|chat-can-cancel|music-can-cancel/)
    assert.doesNotMatch(control.reason, /refund/i)
  })

  test('a running narration or music job is cancellable exactly when the gateway says so', () => {
    for (const operation of ['voice.tts', 'music.generation'] as const) {
      const offered = classifyJobControl(job({
        genstudio_jobs: [evidence(operation, 'running', { dispatch_state: 'dispatched', cancellable: true })],
      }), { remoteCancellationAudited: true })
      assert.equal(offered.action, 'request-remote-cancel', operation)
      assert.equal(offered.targets?.[0]?.operation, operation)
      // The gateway withholds it for work it cannot stop (images, subtitles, chat): Story follows.
      for (const cancellable of [false, undefined]) {
        const withheld = classifyJobControl(job({
          genstudio_jobs: [evidence(operation, 'running', { dispatch_state: 'dispatched', cancellable })],
        }), { remoteCancellationAudited: true })
        assert.equal(withheld.action, 'pause-submissions', `${operation} ${cancellable}`)
        assert.equal(withheld.code, 'PROVIDER_WORK_ALREADY_STARTED', `${operation} ${cancellable}`)
      }
    }
  })

  test('fails closed for every operation unless Gateway explicitly says pre-dispatch and cancellable', () => {
    const operations: Evidence['operation'][] = [
      'voice.tts', 'audio.transcription', 'image.generation',
      'video.generation', 'chat.response', 'music.generation',
    ]
    for (const operation of operations) {
      for (const extra of [
        { cancellable: true },
        { dispatch_state: 'pre_dispatch' as const, cancellable: false },
        { dispatch_state: 'unknown' as never, cancellable: true },
      ]) {
        const control = classifyJobControl(job({
          genstudio_jobs: [evidence(operation, 'accepted', extra)],
        }), { remoteCancellationAudited: true })
        assert.notEqual(control.action, 'request-remote-cancel', `${operation} ${JSON.stringify(extra)}`)
        assert.equal(control.targets, undefined, `${operation} ${JSON.stringify(extra)}`)
      }
    }
  })

  test('fails closed when remote cancellation is not audited or provider state is ambiguous', () => {
    const accepted = job({
      genstudio_jobs: [evidence('voice.tts', 'accepted', { dispatch_state: 'pre_dispatch', cancellable: true })],
    })
    assert.equal(
      classifyJobControl(accepted, { remoteCancellationAudited: false }).action,
      'return-later',
    )

    const mixed = classifyJobControl(job({
      genstudio_jobs: [
        evidence('image.generation', 'accepted', { dispatch_state: 'pre_dispatch', cancellable: true, id: 'known' }),
        evidence('image.generation', 'submitting', { id: 'unknown' }),
      ],
    }), { remoteCancellationAudited: true })
    assert.equal(mixed.action, 'return-later')
    assert.equal(mixed.code, 'CANCELLATION_STATUS_UNKNOWN')
  })

  test('keeps reconciliation identifiers in evidence but removes them from public reason copy', () => {
    const rawId = 'provider-job-12345678901234567890'
    const input = job({ reconciliation_error: `Status lookup failed for ${rawId}` })
    const control = classifyJobControl(input, { remoteCancellationAudited: true })

    assert.equal((input as Partial<Job>).reconciliation_error, `Status lookup failed for ${rawId}`)
    assert.doesNotMatch(control.reason, new RegExp(rawId))
    assert.match(control.reason, /request hidden/i)
  })

  test('does not mistake local model identifiers or no evidence for a stoppable local job', () => {
    assert.equal(isProvenLocalStopCapableJob({ type: 'thumb_images', params: { model: 'imagestudio:local' } }), false)
    assert.equal(isProvenLocalStopCapableJob({ type: 'audio', params: { model: 'macos-say' } }), false)
    assert.equal(classifyJobControl(job({ params: { model: 'unknown-cloud-model' } }), { remoteCancellationAudited: true }).action, 'pause-submissions')
    assert.equal(classifyJobControl(job({ params: { model: 'imagestudio:local' } }), { remoteCancellationAudited: true }).action, 'pause-submissions')

    const stoppable: JobType[] = ['video_assembly', 'audio_merge', 'broll_normalize', 'broll_assemble']
    for (const type of stoppable) assert.equal(isProvenLocalStopCapableJob({ type, params: {} }), true, type)
  })

  test('keeps cancellation output auditing opt-in by job type', async () => {
    assert.equal(hasJobCancellationAuditor('audio_merge'), false)
    const auditor = async () => 'complete' as const
    registerJobCancellationAuditor('audio_merge', auditor)
    assert.equal(hasJobCancellationAuditor('audio_merge'), true)
    assert.equal(await getJobCancellationAuditor('audio_merge')?.({} as Job), 'complete')
  })
})
