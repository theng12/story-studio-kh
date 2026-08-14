/**
 * Three GenStudio boundary contracts that were previously wrong or missing:
 *
 *   1. transcription is priced per SECOND (`credits_per_second`), not per
 *      minute — the old field name never appeared in a response, so every
 *      model parsed as free;
 *   2. published video variants and modes are carried through whole, validated
 *      by SHAPE rather than by membership of a list hardcoded in this app;
 *   3. HTTP 429 capacity reason codes get distinct, actionable messages, and
 *      `request_in_progress` can neither read as a failure nor cause a second
 *      submission.
 *
 * ZERO paid calls: every response here is a hand-written fixture served from a
 * stubbed `globalThis.fetch`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  cheapestGenStudioVideoVariant,
  describeGenStudioCapacityReason,
  describeGenStudioVideoVariant,
  findGenStudioVideoVariant,
  generateImageWithGenStudio,
  GENSTUDIO_CAPACITY_REASONS,
  GenStudioApiError,
  isGenStudioRequestInProgress,
  listTranscriptionModels,
  listVideoModels,
  readGenStudioCapacityReason,
  readGenStudioPollHintMs,
  supportsGenStudioVideoMode,
  type GenStudioVideoVariant,
} from '../lib/genstudio-client.js'
import { selectSceneClipGenStudioVariant } from '../generators/scene-clip.js'

// ── 1. Transcription is priced per second ───────────────────────────────

test('transcription reads the published per-SECOND rate and its minimum', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/transcription\/models$/)
      return Response.json([
        {
          id: 'gs-transcribe-priced-v1',
          display_name: 'Priced',
          provider: 'GenStudio KH',
          language: 'multilingual',
          available: true,
          available_workers: 2,
          qualification_only: false,
          credits_per_second: 0.25,
          minimum_credits: 3,
          price_version: 'transcribe-price-v1',
        },
        {
          // The field Story Studio used to read. It is NOT what GenStudio
          // publishes, so it must not become a price.
          id: 'gs-transcribe-legacy-field-v1',
          display_name: 'Legacy field',
          provider: 'GenStudio KH',
          language: 'multilingual',
          available: true,
          available_workers: 1,
          qualification_only: false,
          credits_per_minute: 15,
          minimum_credits: 3,
          price_version: 'transcribe-price-v1',
        },
      ])
    }
    const models = await listTranscriptionModels('transcription-per-second-key')
    assert.equal(models[0]?.credits_per_second, 0.25)
    assert.equal(models[0]?.minimum_credits, 3)
    assert.equal(models[0]?.price_version, 'transcribe-price-v1')
    // An unpublished rate stays 0 = "not published"; it is never invented from
    // a field GenStudio does not send.
    assert.equal(models[1]?.credits_per_second, 0)
    assert.equal((models[1] as unknown as Record<string, unknown>).credits_per_minute, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 2. Video variants and modes are published data, not a local ladder ──

test('a 4k and an 8-second variant published today reach the catalogue intact', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/videos\/models$/)
      return Response.json([{
        id: 'gs-video-wide-v1',
        display_name: 'Wide Ladder',
        available: true,
        // GenStudio's published operations. Story Studio submits only
        // image-to-video, but every operation must survive transport.
        modes: ['image-to-video', 'text-to-video', 'start-end-frame', 'video-to-video'],
        aspect_ratios: ['16:9', '9:16'],
        variants: [
          { operation: 'image-to-video', duration_seconds: 3, resolution: '480p', credits_per_video: 8, minimum_credits: 8, price_version: 'v1' },
          { operation: 'text-to-video', duration_seconds: 8, resolution: '1080p', credits_per_video: 40, minimum_credits: 40, price_version: 'v1' },
          { operation: 'start-end-frame', duration_seconds: 15, resolution: '4k', credits_per_video: 200, minimum_credits: 200, price_version: 'v1' },
          // Malformed rows are still dropped — SHAPE is validated.
          { operation: 'image-to-video', duration_seconds: 0, resolution: '1080p', credits_per_video: 5, minimum_credits: 5, price_version: 'v1' },
          { operation: 'image-to-video', duration_seconds: 10, resolution: '   ', credits_per_video: 5, minimum_credits: 5, price_version: 'v1' },
          { operation: 'image-to-video', duration_seconds: 10, resolution: '720p', credits_per_video: 'free', minimum_credits: 5, price_version: 'v1' },
          { operation: 'image-to-video', duration_seconds: 10, resolution: '720p', credits_per_video: 5, minimum_credits: 5 },
          { duration_seconds: 10, resolution: '720p', credits_per_video: 5, minimum_credits: 5, price_version: 'v1' },
        ],
      }])
    }
    const [model] = await listVideoModels('video-wide-ladder-key')
    assert.ok(model)
    assert.deepEqual(
      model.variants.map(describeGenStudioVideoVariant),
      ['3s at 480p', '8s at 1080p', '15s at 4k'],
    )
    assert.deepEqual(model.variants.map(variant => variant.operation), [
      'image-to-video', 'text-to-video', 'start-end-frame',
    ])
    assert.deepEqual(model.modes, [
      'image-to-video', 'text-to-video', 'start-end-frame', 'video-to-video',
    ])
    assert.equal(supportsGenStudioVideoMode(model), true)
    assert.equal(supportsGenStudioVideoMode(model, 'text-to-video'), true)
    assert.equal(supportsGenStudioVideoMode(model, 'audio-to-video'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('variant selection takes the cheapest published option and rejects unpublished combinations', () => {
  const variants: GenStudioVideoVariant[] = [
    { operation: 'image-to-video', duration_seconds: 15, resolution: '4k', credits_per_video: 200, minimum_credits: 200, price_version: 'v1' },
    { operation: 'image-to-video', duration_seconds: 8, resolution: '1080p', credits_per_video: 40, minimum_credits: 40, price_version: 'v1' },
    { operation: 'image-to-video', duration_seconds: 3, resolution: '480p', credits_per_video: 8, minimum_credits: 8, price_version: 'v1' },
  ]
  assert.equal(describeGenStudioVideoVariant(cheapestGenStudioVideoVariant(variants)!), '3s at 480p')
  assert.equal(cheapestGenStudioVideoVariant([]), null)
  assert.equal(cheapestGenStudioVideoVariant(undefined), null)

  assert.equal(describeGenStudioVideoVariant(findGenStudioVideoVariant(variants, 8, '1080p')!), '8s at 1080p')
  assert.equal(describeGenStudioVideoVariant(findGenStudioVideoVariant(variants, 15, '4K')!), '15s at 4k')
  // The old code would have silently substituted 5s/720p for each of these.
  assert.equal(findGenStudioVideoVariant(variants, 5, '720p'), null)
  assert.equal(findGenStudioVideoVariant(variants, 8, '4k'), null)
})

test('scene clips keep an exact published variant, reject a removed one, and use cheapest only for legacy jobs', () => {
  const variants: GenStudioVideoVariant[] = [
    { operation: 'image-to-video', duration_seconds: 3, resolution: '480p', credits_per_video: 8, minimum_credits: 8, price_version: 'v1' },
    { operation: 'image-to-video', duration_seconds: 8, resolution: '1080p', credits_per_video: 40, minimum_credits: 40, price_version: 'v1' },
  ]

  assert.deepEqual(
    selectSceneClipGenStudioVariant(variants, { duration_seconds: 8, resolution: '1080p' }),
    variants[1],
    'a queued selection keeps the exact published duration and resolution',
  )
  assert.deepEqual(
    selectSceneClipGenStudioVariant(variants),
    variants[0],
    'only jobs created before variant fields existed receive the current cheapest published option',
  )
  assert.throws(
    () => selectSceneClipGenStudioVariant(variants, { duration_seconds: 8, resolution: '4k' }),
    /does not publish a 8s at 4k option/,
    'a stale queued combination stops before any provider submission',
  )
})

test('neither the catalogue nor the selectors infer anything from a model name', () => {
  const source = readSource('../lib/genstudio-client.ts')
  const videoParse = source.slice(source.indexOf('/v1/videos/models'), source.indexOf('videoSourceMediaType'))
  assert.doesNotMatch(videoParse, /sora|runway|veo|kling|hailuo/i)
  // And no duration/resolution ladder survives in the parse.
  assert.doesNotMatch(videoParse, /=== 5 \|\| |'720p' \|\| /)

  const catalog = readSource('../models/video-catalog.ts')
  // The retirement is enforced by contract now; no name pattern remains.
  assert.doesNotMatch(catalog, /RETIRED_MODEL_PATTERN/)
  assert.match(catalog, /model\.available !== true/)
})

// ── 3. Capacity reason codes ────────────────────────────────────────────

test('every published capacity code gets its own actionable, provider-agnostic message', () => {
  const messages = new Map<string, string>()
  for (const code of Object.values(GENSTUDIO_CAPACITY_REASONS)) {
    const message = describeGenStudioCapacityReason(code)
    assert.ok(message, `${code} must have its own message`)
    messages.set(code, message!)
  }
  // Distinct: the incident this fixes was five situations rendered as one.
  assert.equal(new Set(messages.values()).size, messages.size)

  for (const [code, message] of messages) {
    // Never name, or let a user infer, an upstream vendor.
    assert.doesNotMatch(
      message,
      /openai|anthropic|google|runway|kling|elevenlabs|fal\.ai|kie\.ai|deepgram|replicate/i,
      `${code} must stay provider-agnostic`,
    )
  }

  // An account-side code says it is THEIR limit and what to do about it.
  for (const code of [
    GENSTUDIO_CAPACITY_REASONS.ACCOUNT_CONCURRENCY,
    GENSTUDIO_CAPACITY_REASONS.ACCOUNT_RATE_LIMIT,
    GENSTUDIO_CAPACITY_REASONS.ACCOUNT_QUEUE_LIMIT,
  ]) {
    assert.match(messages.get(code)!, /your genstudio kh account/i)
  }
  // A provider/queue code says it is transient and already being retried, and
  // asks nothing of the user's account.
  const backpressure = messages.get(GENSTUDIO_CAPACITY_REASONS.PROVIDER_BACKPRESSURE)!
  assert.match(backpressure, /temporary/i)
  assert.match(backpressure, /retrying automatically/i)
  assert.doesNotMatch(backpressure, /your genstudio kh account'?s? (?:plan|queue|limit)/i)
})

test('request_in_progress reads as work in flight, never as busy or failed', () => {
  const message = describeGenStudioCapacityReason(GENSTUDIO_CAPACITY_REASONS.REQUEST_IN_PROGRESS)!
  assert.match(message, /already running this exact request/i)
  assert.match(message, /did NOT send it again/)
  assert.match(message, /reconnect/i)
  // The generic wording this code must never collapse back into.
  assert.doesNotMatch(message, /busy or rate-limited/i)
  assert.doesNotMatch(message, /\bfailed\b/i)
})

test('an unknown or absent capacity code degrades to the generic message instead of throwing', () => {
  assert.equal(describeGenStudioCapacityReason(undefined), null)
  assert.equal(describeGenStudioCapacityReason(null), null)
  assert.equal(describeGenStudioCapacityReason(''), null)
  assert.equal(describeGenStudioCapacityReason('a_code_shipped_after_this_build'), null)

  const unknown = new GenStudioApiError(429, 'busy', undefined, {
    reason: 'a_code_shipped_after_this_build',
  })
  assert.match(unknown.message, /busy or rate-limited/i)
  // The unrecognised code is still preserved, so it can be logged.
  assert.equal(unknown.capacityReason, 'a_code_shipped_after_this_build')
  assert.equal(isGenStudioRequestInProgress(unknown), false)

  // No capacity signal at all keeps today's message exactly.
  assert.match(new GenStudioApiError(429, 'busy').message, /busy or rate-limited/i)
  assert.equal(new GenStudioApiError(429, 'busy').capacityReason, null)
})

test('the capacity reason is read from the body first and the header as a fallback', () => {
  const headers = new Headers({ 'X-GenStudio-Capacity-Reason': 'provider_backpressure' })
  assert.equal(
    readGenStudioCapacityReason({ capacity_reason: 'account_concurrency' }, headers),
    'account_concurrency',
  )
  assert.equal(readGenStudioCapacityReason({}, headers), 'provider_backpressure')
  assert.equal(readGenStudioCapacityReason(null, headers), 'provider_backpressure')
  assert.equal(readGenStudioCapacityReason({}, null), null)
  assert.equal(readGenStudioCapacityReason(undefined, undefined), null)
  // Case and padding come from a wire format, not from this app's assumptions.
  assert.equal(
    readGenStudioCapacityReason({ capacity_reason: '  Request_In_Progress  ' }, null),
    'request_in_progress',
  )
})

test('retry_after_seconds rides the same server-hint reader as every other hint', () => {
  // One mechanism, so a hint cannot be honoured in the poll loop and ignored
  // in the retry loop.
  assert.equal(readGenStudioPollHintMs({ retry_after_seconds: 12 }), 12_000)
  assert.equal(readGenStudioPollHintMs({ retry_after_seconds: 2.5 }), 2_500)
  // It wins over the local schedule's other shapes.
  assert.equal(readGenStudioPollHintMs({ retry_after_seconds: 30, poll_after_seconds: 1 }), 30_000)
  // Malformed or negative hints cannot become a busy-loop.
  assert.equal(readGenStudioPollHintMs({ retry_after_seconds: -1 }), null)
  assert.equal(readGenStudioPollHintMs({ retry_after_seconds: 'soon' }), null)

  const error = new GenStudioApiError(429, 'queued', undefined, {
    reason: GENSTUDIO_CAPACITY_REASONS.ACCOUNT_CONCURRENCY,
    retryAfterSeconds: 45,
  })
  assert.equal(error.retryAfterSeconds, 45)
})

test('GenStudio 1.2 retry_at is honored when no relative retry delay is published', () => {
  const now = Date.parse('2026-08-13T03:00:00Z')
  assert.equal(readGenStudioPollHintMs({ retry_at: '2026-08-13T03:00:12Z' }, now), 12_000)
  assert.equal(readGenStudioPollHintMs({ retry_at: 'not-a-date' }, now), null)
})

test('a request_in_progress 429 is never resubmitted and never reported as a failure', async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  const queueStates: string[] = []
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/account/overview')) {
        return Response.json({
          subscription_plan_name: 'Mekong Studio',
          paid_concurrency_limit: 2,
          paid_active_jobs: 0,
          paid_queued_jobs: 0,
          max_queued_jobs: 25,
          generation_submissions_per_minute: 30,
        })
      }
      if (url.endsWith('/v1/images/generations')) {
        posts++
        return Response.json(
          {
            detail: 'this request is already running',
            capacity_reason: 'request_in_progress',
            retry_after_seconds: 20,
          },
          { status: 429, headers: { 'Retry-After': '20' } },
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    }

    const error = await generateImageWithGenStudio('request-in-progress-key', {
      prompt: 'A request GenStudio already has.',
      modelId: 'genstudio-image-fast-v1',
      aspectRatio: '16:9',
      requestIdentity: 'project:EP0001:scene:0001',
      onQueueState: (state: string) => { queueStates.push(state) },
    }).then(() => null, (caught: unknown) => caught)

    assert.ok(error instanceof GenStudioApiError, 'expected a typed GenStudio error')
    assert.equal(isGenStudioRequestInProgress(error), true)
    // THE POINT: exactly one POST. 429 is a retryable status, so without an
    // explicit guard the retry loop would have re-sent this request — which is
    // what abandons the run GenStudio already has.
    assert.equal(posts, 1, 'a request already in progress must never be resubmitted')
    // And it is never rendered as a failed job.
    assert.ok(!queueStates.includes('failed'), `queue states must not include failed: ${queueStates.join()}`)
    assert.ok(queueStates.includes('waiting_account_capacity'))
    assert.match(error.message, /already running this exact request/i)
    assert.doesNotMatch(error.message, /busy or rate-limited/i)
    assert.equal(error.retryAfterSeconds, 20)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}
