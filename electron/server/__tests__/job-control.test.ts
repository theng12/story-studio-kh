import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Job, JobControl, JobType } from '../models/types.js'
import { classifyJobControl, isProvenLocalStopCapableJob } from '../services/job-control.js'
import {
  getJobCancellationAuditor,
  hasJobCancellationAuditor,
  registerJobCancellationAuditor,
} from '../services/job-cancellation-auditors.js'

type Evidence = NonNullable<Job['genstudio_jobs']>[number]

function job(overrides: Partial<Job> = {}): Pick<Job, 'status' | 'type' | 'params' | 'genstudio_jobs' | 'remote_cancellations'> {
  return {
    status: 'running',
    type: 'images',
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
      { name: 'queued', input: { status: 'queued' }, action: 'cancel-before-submit', code: 'READY', reason: 'This job has not submitted provider work.' },
      { name: 'paused', input: { status: 'paused' }, action: 'cancel-before-submit', code: 'READY', reason: 'This job has not submitted provider work.' },
      { name: 'local video assembly', input: { type: 'video_assembly' }, action: 'stop-local', code: 'READY', reason: 'This local job has a proven cooperative or child-process stop path.' },
      { name: 'local audio merge', input: { type: 'audio_merge' }, action: 'stop-local', code: 'READY', reason: 'This local job has a proven cooperative or child-process stop path.' },
      { name: 'accepted tts', input: { genstudio_jobs: [evidence('voice.tts', 'accepted', { cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Story Studio will ask GenStudio to cancel the eligible provider task; GenStudio determines whether credits are released.' },
      { name: 'reserved image', input: { genstudio_jobs: [evidence('image.generation', 'reserved', { cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Story Studio will ask GenStudio to cancel the eligible provider task; GenStudio determines whether credits are released.' },
      { name: 'accepted transcription', input: { genstudio_jobs: [evidence('audio.transcription', 'accepted', { cancellable: true })] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Story Studio will ask GenStudio to cancel the eligible provider task; GenStudio determines whether credits are released.' },
      { name: 'running video', input: { genstudio_jobs: [evidence('video.generation', 'running')] }, audited: true, action: 'request-remote-cancel', code: 'READY', reason: 'Story Studio will ask GenStudio to cancel the eligible provider task; GenStudio determines whether credits are released.' },
      { name: 'running chat', input: { genstudio_jobs: [evidence('chat.response', 'running')] }, audited: true, action: 'return-later', code: 'REMOTE_CANCELLATION_NOT_SUPPORTED', reason: 'chat.response chat.response-task does not publish a cancellation endpoint. Provider work may still settle.' },
      { name: 'started image', input: { genstudio_jobs: [evidence('image.generation', 'running', { cancellable: false })] }, audited: true, action: 'pause-submissions', code: 'PROVIDER_WORK_ALREADY_STARTED', reason: 'image.generation image.generation-task already started and will continue settling. New provider submissions can be paused, but this request cannot be cancelled.' },
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
        reason: 'Story Studio is waiting for GenStudio to confirm the cancellation result. The provider work may still settle.',
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

  test('returns only cancellable provider targets and names work that will continue settling', () => {
    const control = classifyJobControl(job({
      genstudio_jobs: [
        evidence('image.generation', 'accepted', { cancellable: true, id: 'can-cancel' }),
        evidence('image.generation', 'running', { cancellable: false, id: 'already-started' }),
      ],
    }), { remoteCancellationAudited: true })

    assert.equal(control.action, 'request-remote-cancel')
    assert.deepEqual(control.targets, [{ operation: 'image.generation', provider_job_id: 'can-cancel' }])
    assert.match(control.reason, /already-started/)
    assert.match(control.reason, /continue settling/i)
  })

  test('keeps known unsupported provider work settling while requesting eligible video cancellation', () => {
    const control = classifyJobControl(job({
      genstudio_jobs: [
        evidence('video.generation', 'running', { id: 'video-can-cancel' }),
        evidence('chat.response', 'running', { id: 'chat-keeps-running' }),
      ],
    }), { remoteCancellationAudited: true })

    assert.equal(control.action, 'request-remote-cancel')
    assert.deepEqual(control.targets, [{ operation: 'video.generation', provider_job_id: 'video-can-cancel' }])
    assert.match(control.reason, /chat.response chat-keeps-running already started and will continue settling/i)
  })

  test('never exposes post-dispatch TTS or image cancellation even when stale evidence claims cancellable', () => {
    for (const entry of [
      evidence('voice.tts', 'running', { cancellable: true }),
      evidence('image.generation', 'dispatched', { cancellable: true }),
    ]) {
      const control = classifyJobControl(job({ genstudio_jobs: [entry] }), { remoteCancellationAudited: true })
      assert.equal(control.action, 'pause-submissions', entry.operation)
      assert.equal(control.code, 'PROVIDER_WORK_ALREADY_STARTED', entry.operation)
    }
  })

  test('fails closed when remote cancellation is not audited or provider state is ambiguous', () => {
    const accepted = job({
      genstudio_jobs: [evidence('voice.tts', 'accepted', { cancellable: true })],
    })
    assert.equal(
      classifyJobControl(accepted, { remoteCancellationAudited: false }).action,
      'return-later',
    )

    const mixed = classifyJobControl(job({
      genstudio_jobs: [
        evidence('image.generation', 'accepted', { cancellable: true, id: 'known' }),
        evidence('image.generation', 'submitting', { id: 'unknown' }),
      ],
    }), { remoteCancellationAudited: true })
    assert.equal(mixed.action, 'return-later')
    assert.equal(mixed.code, 'CANCELLATION_STATUS_UNKNOWN')
  })

  test('does not mistake local model identifiers or no evidence for a stoppable local job', () => {
    assert.equal(isProvenLocalStopCapableJob({ type: 'images', params: { model: 'imagestudio:local' } }), false)
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
