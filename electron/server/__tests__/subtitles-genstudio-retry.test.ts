import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('terminal GenStudio transcription tasks receive a fresh manual-retry identity', () => {
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
  assert.equal(isTerminalGenStudioTranscriptionProviderError(new Error('GenStudio KH request failed: transcription quote has expired')), false)
  // ...and another modality's terminal failure never retires a transcription key.
  assert.equal(
    isTerminalGenStudioTranscriptionProviderError(new GenStudioTtsTerminalFailureError({ id: 'tts-1', state: 'failed' })),
    false,
  )

  const source = readFileSync(new URL('../generators/subtitles.ts', import.meta.url), 'utf8')
  assert.match(source, /const recoveryTask = terminalFailure \? null : reusableTask/)
  assert.match(source, /manual-retry:\$\{job\.job_id\}/)
  assert.match(source, /previous GenStudio transcription task failed terminally; submitting one fresh recovery task/i)
  assert.match(source, /saved GenStudio transcription request had expired; submitting one fresh replacement now/i)
  assert.match(source, /if \(!recoveryTask\)/)
})
