import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  isTerminalGenStudioTranscriptionProviderError,
  isTerminalGenStudioTranscriptionTaskFailure,
} from '../generators/subtitles.js'

test('terminal GenStudio transcription tasks receive a fresh manual-retry identity', () => {
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ task_id: 'stt-failed', last_state: 'failed' }), true)
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ idempotency_key: 'story-stt-expired', last_state: 'expired' }), true)
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ task_id: 'stt-expired', last_state: 'expired' }), true)
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ task_id: 'stt-active', last_state: 'running' }), false)
  assert.equal(isTerminalGenStudioTranscriptionTaskFailure({ task_id: '', last_state: 'failed' }), false)
  assert.equal(isTerminalGenStudioTranscriptionProviderError(new Error('GenStudio KH request failed: transcription quote has expired')), true)
  assert.equal(isTerminalGenStudioTranscriptionProviderError(new Error('GenStudio KH rejected the scoped API key')), false)

  const source = readFileSync(new URL('../generators/subtitles.ts', import.meta.url), 'utf8')
  assert.match(source, /const recoveryTask = terminalFailure \? null : reusableTask/)
  assert.match(source, /manual-retry:\$\{job\.job_id\}/)
  assert.match(source, /previous GenStudio transcription task failed terminally; submitting one fresh recovery task/i)
  assert.match(source, /next manual Retry will submit one fresh replacement/i)
})
