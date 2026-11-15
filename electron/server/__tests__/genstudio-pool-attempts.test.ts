/**
 * Gateway pool attempts as data (1.4.402, job286aa756).
 *
 * The real shape: the free primary ran out of output (`INCOMPLETE_OUTPUT`, finish_reason length),
 * one member was offline, and a paid member had a bad key (HTTP 401). Story used to keep only the
 * last member's sentence, which read as a pure auth failure. These tests pin the mixed summary,
 * the sanitizer, tolerant/legacy parsing, both error classes and the durable record's round trip.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  genStudioFailureRecord,
  parsePoolAttempts,
  sanitizeAttemptDetail,
  summarizePoolFailure,
} from '../contracts/genstudio-pool-attempts.js'
import { GenStudioApiError, GenStudioTerminalFailureError } from '../lib/genstudio-client.js'

const MIXED = [
  { member: 'magpie::group/story-llm-free', outcome: 'failed', code: 'INCOMPLETE_OUTPUT', finish_reason: 'length', retryable: true },
  { member: 'gpt6luna', outcome: 'unavailable', detail: 'offline' },
  { member: 'haiku', outcome: 'failed', status: 401, code: 'PROVIDER_AUTH_FAILED', detail: 'invalid x-api-key: sk-live-SECRET123456' },
]

test('a mixed three-member walk stays mixed, and the key never survives', () => {
  const attempts = parsePoolAttempts(MIXED)
  assert.equal(attempts.length, 3)
  assert.equal(attempts[0]!.finish_reason, 'length')
  assert.equal(attempts[0]!.retryable, true)
  assert.equal(attempts[2]!.status, 401)
  assert.ok(!attempts[2]!.detail!.includes('SECRET'), 'credential-shaped text is removed')
  const summary = summarizePoolFailure('story-studio-llm', attempts)
  assert.match(summary, /1 stopped at its output limit/)
  assert.match(summary, /1 could not authenticate/)
  assert.match(summary, /1 was unavailable/)
  assert.doesNotMatch(summary, /^.*all.*auth/i)
})

test('a pure auth failure says so plainly', () => {
  const attempts = parsePoolAttempts([{ member: 'haiku', status: 401, code: 'PROVIDER_AUTH_FAILED', detail: 'invalid x-api-key' }])
  assert.equal(summarizePoolFailure('story-studio-llm', attempts), '1 model in pool "story-studio-llm": 1 could not authenticate.')
})

test('missing, legacy and malformed attempts are empty, never invented', () => {
  assert.deepEqual(parsePoolAttempts(undefined), [])
  assert.deepEqual(parsePoolAttempts(null), [])
  assert.deepEqual(parsePoolAttempts('Pool had no member'), [])
  assert.deepEqual(parsePoolAttempts([{}, null, 3]), [])
  // A legacy Gateway publishes only the sentence: no attempts, no summary, no crash.
  assert.equal(summarizePoolFailure(null, []), '')
})

test('camelCase and snake_case member facts are both read', () => {
  const attempts = parsePoolAttempts([{ model_id: 'm1', state: 'failed', failure_code: 'X', status_code: 500, native_finish_reason: 'length' }])
  assert.deepEqual(attempts[0], {
    member: 'm1', outcome: 'failed', code: 'X', status: 500, detail: null, finish_reason: 'length', retryable: null,
  })
})

test('the durable record round-trips through JSON unchanged', () => {
  const record = genStudioFailureRecord({
    pool: 'story-studio-llm', jobId: 'job286aa756', model: 'story-studio-llm', attempts: parsePoolAttempts(MIXED),
    at: '2026-11-15T00:00:00Z',
  })
  const reloaded = JSON.parse(JSON.stringify(record))
  assert.deepEqual(reloaded, record)
  assert.equal(reloaded.job_id, 'job286aa756')
  assert.equal(reloaded.attempts.length, 3)
  assert.match(reloaded.summary, /1 stopped at its output limit/)
})

test('an HTTP pool failure carries the attempts and shows the mixed summary', () => {
  const error = new GenStudioApiError(502, "Pool 'story-studio-llm' had no member that could answer", 'INCOMPLETE_OUTPUT', undefined, {
    name: 'story-studio-llm', jobId: 'job286aa756', attempts: MIXED,
  })
  assert.equal(error.poolAttempts.length, 3)
  assert.equal(error.poolName, 'story-studio-llm')
  assert.equal(error.gatewayJobId, 'job286aa756')
  assert.match(error.message, /1 stopped at its output limit/)
  assert.match(error.message, /1 could not authenticate/)
})

test('a settled terminal failure records the walk with its job and model ids', () => {
  const error = new GenStudioTerminalFailureError('chat', {
    id: 'job286aa756', state: 'failed', model_id: 'story-studio-llm',
    failure_code: 'INCOMPLETE_OUTPUT',
    failure_reason: "Pool 'story-studio-llm' had no member that could answer",
    pool: 'story-studio-llm',
    pool_attempts: MIXED,
  }, 'Writing failed')
  assert.equal(error.poolAttempts.length, 3)
  assert.equal(error.failureRecord?.job_id, 'job286aa756')
  assert.equal(error.failureRecord?.model, 'story-studio-llm')
  assert.match(error.message, /1 stopped at its output limit/)
  assert.match(error.message, /1 was unavailable/)
})

test('the sanitizer keeps a real reason and drops every key shape', () => {
  assert.equal(sanitizeAttemptDetail('Bearer abcdefghijklmnop'), '[key removed]')
  assert.equal(sanitizeAttemptDetail('x-api-key: sk-abc123456789'), '[key removed]')
  assert.equal(sanitizeAttemptDetail('invalid x-api-key (401)'), 'invalid x-api-key (401)')
  assert.equal(sanitizeAttemptDetail('   '), null)
})
