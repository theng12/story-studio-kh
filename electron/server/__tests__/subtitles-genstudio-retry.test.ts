import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTerminalGenStudioTranscriptionProviderError,
  isTerminalGenStudioTranscriptionTaskFailure,
} from '../generators/subtitles.js'
import {
  GenStudioApiError,
  GenStudioTranscriptionArtifactUnavailableError,
  GenStudioTranscriptionQuoteExpiredError,
  GenStudioTranscriptionTerminalFailureError,
  GenStudioTtsTerminalFailureError,
} from '../lib/genstudio-client.js'

test('terminal transcription states and typed provider outcomes are classified without matching prose', () => {
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ task_id: 'stt-failed', last_state: 'failed' }), true)
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ idempotency_key: 'story-stt-expired', last_state: 'expired' }), true)
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ task_id: 'stt-expired', last_state: 'expired' }), true)
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ task_id: 'stt-active', last_state: 'running' }), false)
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ task_id: '', last_state: 'failed' }), false)
  // Settled outcomes are classified by TYPE, never by matching words like
  // "failed" or "expired" inside a provider message.
  assert.equal(
    isTerminalGenStudioTranscriptionProviderError(new GenStudioTranscriptionQuoteExpiredError(410, 'quote has expired')),
    true,
  )
  assert.equal(
    isTerminalGenStudioTranscriptionProviderError(
      new GenStudioTranscriptionTerminalFailureError({ id: 'stt-1', state: 'failed', failure_code: 'PROVIDER_ERROR' }),
    ),
    true,
  )
  assert.equal(
    isTerminalGenStudioTranscriptionProviderError(new GenStudioTranscriptionArtifactUnavailableError('stt-2', 404)),
    true,
  )
  // A transient/auth failure is NOT terminal, however it is worded...
  assert.equal(isTerminalGenStudioTranscriptionProviderError(new GenStudioApiError(401, 'key rejected')), false)
  assert.equal(isTerminalGenStudioTranscriptionProviderError(new Error('Gateway request failed: transcription quote has expired')), false)
  // ...and another modality's terminal failure never retires a transcription key.
  assert.equal(
    isTerminalGenStudioTranscriptionProviderError(new GenStudioTtsTerminalFailureError({ id: 'tts-1', state: 'failed' })),
    false,
  )

})

/**
 * v1.4.24 — a chapter refused for want of a free machine waits and asks again.
 *
 * THE EVENT. The owner started thirty episodes of transcription at once. Of 353
 * transcriptions, 122 came back `SITE_PLACEMENT_EXHAUSTED` and were dropped
 * with "re-run to fill it in", leaving him to chase each one by hand.
 *
 * WHY RETRYING THIS IS SAFE, and it is the only reason it is automatic.
 * GenStudio raises the code from one place, and says there exactly what
 * happened to the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so a retry is a fresh
 * charge for work that never happened — not a second charge for the same work,
 * which is the hazard every other retry path in this file exists to avoid.
 *
 * The guard therefore checks the code and the job's own state — cancellation
 * and the gateway's unknown-outcome hold stop it — never credit settlement:
 * Story no longer tracks credits, so a legacy payload's numbers cannot decide.
 */

function settledJob(over: Record<string, unknown>) {
  return {
    id: 'stt-job', state: 'failed', cancelled: false,
    reserved_credits: 17, settled_credits: 0, released_credits: 17,
    ...over,
  } as any
}

test('a busy fleet is retryable — the credits came back and no worker ran', async () => {
  const { isFleetBusyTranscriptionFailure } = await import('../generators/subtitles.js')
  for (const code of ['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE']) {
    assert.equal(
      isFleetBusyTranscriptionFailure(
        new GenStudioTranscriptionTerminalFailureError(settledJob({ failure_code: code })),
      ),
      true,
      `${code} means no machine was free, not that the work is impossible`,
    )
  }
})

test('legacy or missing settlement does not decide — the code and the job state do', async () => {
  const { isFleetBusyTranscriptionFailure } = await import('../generators/subtitles.js')
  // Story no longer tracks credits: the error's credit fields are null, so a
  // legacy payload's settled/released numbers can neither grant nor deny the
  // retry. Only the code and the job's own state decide.
  const charged = new GenStudioTranscriptionTerminalFailureError(
    settledJob({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 17, released_credits: 0 }),
  )
  assert.equal(charged.settledCredits, null, 'the error publishes no settlement to decide on')
  assert.equal(isFleetBusyTranscriptionFailure(charged), true, 'a legacy settled payload does not decide')
  assert.equal(
    isFleetBusyTranscriptionFailure(new GenStudioTranscriptionTerminalFailureError(
      settledJob({
        failure_code: 'SITE_PLACEMENT_EXHAUSTED',
        reserved_credits: undefined, settled_credits: undefined, released_credits: undefined,
      }),
    )),
    true,
    'missing settlement does not decide either',
  )
})

test('an ordinary failure is never retried as if the fleet were merely busy', async () => {
  const { isFleetBusyTranscriptionFailure } = await import('../generators/subtitles.js')
  // A real fault repeats, and retrying it three times with waits would turn a
  // clear error into a ten-minute silence before the same clear error.
  for (const code of ['PROVIDER_REJECTED', 'AUDIO_UNREADABLE', null, '']) {
    assert.equal(
      isFleetBusyTranscriptionFailure(
        new GenStudioTranscriptionTerminalFailureError(settledJob({ failure_code: code })),
      ),
      false,
      `${String(code)} is not a capacity problem`,
    )
  }
})

test('a cancelled job is never resubmitted', async () => {
  const { isFleetBusyTranscriptionFailure } = await import('../generators/subtitles.js')
  // Cancellation is the owner's instruction. Retrying it would be the app
  // overruling him.
  assert.equal(
    isFleetBusyTranscriptionFailure(new GenStudioTranscriptionTerminalFailureError(
      settledJob({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', cancelled: true }),
    )),
    false,
  )
})

test('an unknown-outcome hold is never resubmitted', async () => {
  const { isFleetBusyTranscriptionFailure } = await import('../generators/subtitles.js')
  // The gateway may still be holding a result that has not landed; a busy code
  // on such a job must not buy a second transcription.
  for (const over of [{ recovery_state: 'unknown_outcome' }, { recovery_required: true }]) {
    assert.equal(
      isFleetBusyTranscriptionFailure(new GenStudioTranscriptionTerminalFailureError(
        settledJob({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', ...over }),
      )),
      false,
      JSON.stringify(over),
    )
  }
})

test('a TTS failure is not treated as a transcription retry', async () => {
  const { isFleetBusyTranscriptionFailure } = await import('../generators/subtitles.js')
  assert.equal(
    isFleetBusyTranscriptionFailure(new GenStudioTtsTerminalFailureError(
      settledJob({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }),
    )),
    false,
  )
  assert.equal(isFleetBusyTranscriptionFailure(new Error('boom')), false)
  assert.equal(isFleetBusyTranscriptionFailure(null), false)
})

test('the waits are minutes, because the Gateway already waited fifteen', async () => {
  // SITE_PLACEMENT_EXHAUSTED is only raised after a fifteen-minute placement
  // window, so a chapter that reaches here has been queued a long time and the
  // fleet is genuinely saturated. A two-second retry would rejoin the same jam
  // and burn an attempt for nothing.
  //
  // Imported rather than scraped from source: 1.4.25 moved the schedule into
  // `lib/genstudio-fleet-busy.ts` so every generator can share it, and a test
  // that reads a file path silently stops testing anything when the code moves.
  const { FLEET_BUSY_RETRY_DELAYS_MS } = await import('../lib/genstudio-fleet-busy.js')
  const delays = [...FLEET_BUSY_RETRY_DELAYS_MS]
  assert.equal(delays.length, 3, 'three attempts, then give up and report it')
  assert.ok(delays.every(d => d >= 30_000), 'every wait must be tens of seconds at least')
  assert.ok(delays.every((d, i) => i === 0 || d > delays[i - 1]!), 'waits must grow')
  assert.ok(delays.reduce((a, b) => a + b, 0) <= 600_000,
    'a chapter must not sit unreported for more than about ten minutes')
})
