import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GenStudioImageTerminalFailureError,
  GenStudioTtsTerminalFailureError,
  GenStudioMusicTerminalFailureError,
  genStudioFailureGuidance,
  settledFailureClass,
  type GenStudioSettledJobShape,
} from '../lib/genstudio-client.js'

/**
 * The owner retried a blocked thumbnail three times at 20 credits a go, because
 * `IMAGE_PROVIDER_SUBMISSION_FAILED` was the whole of what Story Studio could
 * show him. GenStudio now publishes the provider's own account of the refusal
 * and a structured class for it; these tests pin what the app does with both.
 *
 * The single most important test in this file is the LAST one: with neither
 * field present — which is every currently deployed GenStudio — the message
 * must be byte-for-byte what it was before any of this existed.
 */

/** The real case: OpenAI moderation, phrased as GenStudio publishes it. */
const MODERATION_REASON =
  'direct provider rejected the image request (HTTP 400): Your request was '
  + 'rejected by the safety system. If you believe this is an error, contact us '
  + 'at help.openai.com and include the request ID req_8f2c1a9d4e7b3006.'

function failedImageJob(extra: Partial<GenStudioSettledJobShape> = {}): GenStudioSettledJobShape {
  return {
    id: 'job_abc123',
    state: 'failed',
    failure_code: 'IMAGE_CONTENT_REFUSED',
    reserved_credits: 20,
    settled_credits: 0,
    released_credits: 20,
    ...extra,
  }
}

// --------------------------------------------------------------------------
// What the owner would have seen
// --------------------------------------------------------------------------

test('a content refusal shows the provider reason and tells the user to reword', () => {
  const error = new GenStudioImageTerminalFailureError(
    failedImageJob({ failure_reason: MODERATION_REASON, failure_class: 'content_refused' }),
  )

  // The reason, in the provider's own words.
  assert.match(error.message, /rejected by the safety system/)
  // The actionable half: what to do, and where.
  assert.match(error.message, /Edit the prompt \(open the Prompts page\)/)
  assert.match(error.message, /retrying unchanged will fail again/)
  // The support handle survives, because the sentence tells him to use it.
  assert.match(error.message, /req_8f2c1a9d4e7b3006/)
  // And the original settlement wording is still there, not replaced.
  assert.match(error.message, /GenStudio KH image generation failed/)
  assert.equal(error.failureClass, 'content_refused')
  assert.equal(error.failureReason, MODERATION_REASON)
})

test('the section and job-card lines carry the reason without touching their code', () => {
  // `Thumbnail N: FAILED — ${e.message}` in generators/images.ts and
  // `${sectionLabel}: ${e.message}` in generators/audio.ts both interpolate
  // `.message`, which is why appending in the error constructor reaches every
  // surface at once. This asserts the composed line, the way a user sees it.
  const error = new GenStudioImageTerminalFailureError(
    failedImageJob({ failure_reason: MODERATION_REASON, failure_class: 'content_refused' }),
  )

  const sectionLine = `Thumbnail 3/8: FAILED — ${error.message}`

  assert.match(sectionLine, /^Thumbnail 3\/8: FAILED — /)
  assert.match(sectionLine, /rejected by the safety system/)
  assert.match(sectionLine, /Edit the prompt/)
})

test('a transient provider problem says retry, not reword', () => {
  const error = new GenStudioImageTerminalFailureError(
    failedImageJob({
      failure_code: 'IMAGE_PROVIDER_FAILED',
      failure_reason: 'direct provider is temporarily unavailable',
      failure_class: 'provider_transient',
    }),
  )

  assert.match(error.message, /Temporary provider issue — Retry usually succeeds\./)
  assert.doesNotMatch(error.message, /Edit the prompt/)
})

// --------------------------------------------------------------------------
// Where the app deliberately says nothing
// --------------------------------------------------------------------------

test('an unexplained failure shows the reason verbatim and invents no advice', () => {
  // `provider_error` is GenStudio saying precisely that it will not claim to
  // know why. Telling the user to edit a prompt here is how they end up
  // rewriting something that was never the problem.
  const error = new GenStudioImageTerminalFailureError(
    failedImageJob({
      failure_code: 'IMAGE_PROVIDER_SUBMISSION_FAILED',
      failure_reason: 'direct provider rejected the image request (HTTP 402): billing hard limit reached',
      failure_class: 'provider_error',
    }),
  )

  assert.match(error.message, /billing hard limit reached/)
  assert.doesNotMatch(error.message, /Edit the prompt/)
  assert.doesNotMatch(error.message, /Retry usually succeeds/)
})

test('a class Story Studio does not recognise is treated as unknown, not guessed', () => {
  // A newer GenStudio that grows a fourth value must not make this app invent
  // advice for a category it has never heard of.
  const error = new GenStudioImageTerminalFailureError(
    failedImageJob({ failure_reason: MODERATION_REASON, failure_class: 'quota_exhausted' }),
  )

  assert.equal(error.failureClass, 'unknown')
  assert.match(error.message, /rejected by the safety system/)
  assert.doesNotMatch(error.message, /Edit the prompt/)
})

test('the hint is chosen by class alone and never by the wording of the reason', () => {
  // The rule Story Studio asked GenStudio for and must itself obey: text that
  // reads exactly like a moderation refusal earns no hint unless the CLASS
  // says so, because provider wording changes without notice.
  const error = new GenStudioImageTerminalFailureError(
    failedImageJob({
      failure_reason: 'rejected by the safety system for content policy reasons',
      failure_class: 'provider_error',
    }),
  )

  assert.doesNotMatch(error.message, /Edit the prompt/)
})

// --------------------------------------------------------------------------
// Graceful degradation — the mandatory one
// --------------------------------------------------------------------------

test('with no reason and no class the message is exactly what it was before', () => {
  // Every currently deployed GenStudio publishes neither field. This app must
  // behave as though this change had not happened.
  const bare = failedImageJob()
  const error = new GenStudioImageTerminalFailureError(bare)

  assert.equal(
    error.message,
    'GenStudio KH image generation failed (IMAGE_CONTENT_REFUSED). '
    + 'GenStudio reports 20 credits released. '
    + 'This job cannot be reopened; Retry submits a new job.',
  )
  assert.equal(error.failureReason, null)
  assert.equal(error.failureClass, 'unknown')
  // No stray separator, no dangling punctuation from a joined empty part.
  assert.doesNotMatch(error.message, /Provider reason:/)
  assert.doesNotMatch(error.message, / {2}/)
})

test('null and blank are the same as absent', () => {
  for (const value of [null, '', '   '] as const) {
    const error = new GenStudioImageTerminalFailureError(
      failedImageJob({ failure_reason: value, failure_class: value }),
    )

    assert.equal(error.failureReason, null, `reason for ${JSON.stringify(value)}`)
    assert.equal(error.failureClass, 'unknown', `class for ${JSON.stringify(value)}`)
    assert.doesNotMatch(error.message, /Provider reason:/)
  }
})

test('every modality gets the field, and names its own reprompt surface', () => {
  const tts = new GenStudioTtsTerminalFailureError(
    failedImageJob({ failure_reason: 'refused', failure_class: 'content_refused' }),
  )
  const music = new GenStudioMusicTerminalFailureError(
    failedImageJob({ failure_reason: 'refused', failure_class: 'content_refused' }),
  )

  assert.match(tts.message, /open the script\)/)
  assert.match(music.message, /open the music prompt\)/)
  assert.equal(tts.failureClass, 'content_refused')
  assert.equal(music.failureClass, 'content_refused')
})

// --------------------------------------------------------------------------
// The helpers, directly
// --------------------------------------------------------------------------

test('settledFailureClass accepts only the published vocabulary', () => {
  assert.equal(settledFailureClass({ id: 'j', failure_class: 'content_refused' }), 'content_refused')
  assert.equal(
    settledFailureClass({ id: 'j', failure_class: 'provider_transient' }),
    'provider_transient',
  )
  assert.equal(settledFailureClass({ id: 'j', failure_class: 'provider_error' }), 'provider_error')
  assert.equal(settledFailureClass({ id: 'j' }), 'unknown')
  assert.equal(settledFailureClass({ id: 'j', failure_class: 'CONTENT_REFUSED' }), 'unknown')
  // A non-string that slipped past the cast must not throw.
  assert.equal(settledFailureClass({ id: 'j', failure_class: 7 as never }), 'unknown')
})

test('guidance is null for everything the app cannot act on', () => {
  assert.equal(genStudioFailureGuidance('provider_error', 'image'), null)
  assert.equal(genStudioFailureGuidance('unknown', 'image'), null)
  assert.notEqual(genStudioFailureGuidance('content_refused', 'image'), null)
  assert.notEqual(genStudioFailureGuidance('provider_transient', 'image'), null)
})
