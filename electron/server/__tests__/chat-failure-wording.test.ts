/**
 * What the owner reads when a writing request fails, built from the envelopes the live gateway
 * actually sent on 2026-10-02 (pool::gemini-free-all, the `gateway.catalog.resolve` bug): code
 * PROVIDER_FAILED (the gateway's dialect, no LANGUAGE_ prefix), held as unknown_outcome, settled
 * 0/0/0, failure_reason ending in the gateway's "reconcile" suffix. That used to read
 * "GenStudio KH language generation failed (PROVIDER_FAILED). This job cannot be reopened; …
 * No fallback route was attempted. GenStudio reports 0 credits released. Provider reason: … The
 * result is being checked; nothing was run twice." — every clause jargon, the last one false.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { GenStudioChatTerminalFailureError, describeGenStudioLanguageFailure } from '../lib/genstudio-client.js'

const JARGON = /GenStudio KH|PROVIDER_|LANGUAGE_|reconcile|upstream|fallback route|durable|reservation|being checked|Provider reason|0 credits/i

const gatewayFailure = (fields: Record<string, unknown>) => new GenStudioChatTerminalFailureError({
  id: 'job_1', state: 'failed', reserved_credits: 0, settled_credits: 0, released_credits: 0, ...fields,
})

test('the pool-bug failure reads as a lost request with a next step, keeping the detail', () => {
  const error = gatewayFailure({
    failure_code: 'PROVIDER_FAILED', recovery_state: 'unknown_outcome',
    failure_reason: "AttributeError: module 'gateway.catalog' has no attribute 'resolve' Upstream outcome is unknown; "
      + 'reconcile the provider request before retrying; the gateway will not resubmit it automatically.',
  })
  assert.match(error.message, /^The writing service lost track of this request/)
  assert.match(error.message, /Generate this step again/)
  assert.match(error.message, /Details: AttributeError/)
  assert.doesNotMatch(error.message, JARGON)
  assert.equal(error.unknownOutcome, true, 'wording changed, the no-auto-resubmit flag did not')
})

test('a settled provider failure says retry or pick another model, in either code dialect', () => {
  for (const code of ['PROVIDER_FAILED', 'LANGUAGE_PROVIDER_FAILED']) {
    const message = gatewayFailure({ failure_code: code }).message
    assert.equal(message, 'The writing model could not answer this request. Retry this step; if it keeps failing, pick a different writing model.')
  }
})

test('quota exhaustion (whole pool used up) says when to come back', () => {
  const message = gatewayFailure({ failure_code: 'PROVIDER_QUOTA_EXHAUSTED' }).message
  assert.match(message, /used up its free allowance/)
  assert.match(message, /Retry later/)
  assert.doesNotMatch(message, JARGON)
})

test('no free Mac / provider unavailable is not reported as a broken model', () => {
  for (const code of ['PROVIDER_UNAVAILABLE', 'LOCATION_NOT_READY', 'LANGUAGE_PROVIDER_BACKPRESSURE']) {
    assert.match(describeGenStudioLanguageFailure(code)!, /No writing model was free/)
  }
})

test('credits are mentioned only when some moved, in the sentence Abandon still parses', () => {
  assert.doesNotMatch(gatewayFailure({ failure_code: 'PROVIDER_FAILED' }).message, /credit/i)
  const paid = gatewayFailure({ failure_code: 'PROVIDER_FAILED', reserved_credits: 42, released_credits: 42 }).message
  assert.match(paid, /GenStudio reports 42 credits released\./)
})

test('an unknown code still gives a plain next step, never the raw code', () => {
  const message = gatewayFailure({ failure_code: 'SOMETHING_NEW' }).message
  assert.match(message, /^Writing failed\. Retry this step/)
  assert.doesNotMatch(message, /SOMETHING_NEW/)
})
