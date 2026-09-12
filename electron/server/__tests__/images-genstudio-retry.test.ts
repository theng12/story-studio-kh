/**
 * v1.4.26 — an image refused for want of a free machine waits and asks again.
 *
 * WHY THIS GENERATOR, AND WHY NOW. Images are 100% fleet-placed and the
 * highest-volume operation in the whole app — 7,419 attempts in thirty days.
 * They have not met a saturated fleet yet; the two generators that did both
 * lost work. Transcription lost 122 of 353 in a single burst, and the owner
 * only caught it because he happened to run thirty episodes at once. TTS lost
 * five over three days and nobody ever noticed, because the only symptom is a
 * missing asset that a later manual retry quietly fills in. A 333-scene batch
 * meeting the same wall would drop scenes the same silent way.
 *
 * WHY RETRYING THIS IS SAFE, and why it is the ONLY failure retried here.
 * GenStudio raises the code from one place, after already holding the job in a
 * fifteen-minute placement window, and says there what happened to the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so resubmitting is a fresh
 * charge for work that never happened — not a second charge for the same work.
 * That argument does not extend one inch further: a provider that WAS engaged
 * may have done the work, and resubmitting over it double-charges the owner.
 * A "Repair & Retry all" button was removed in v1.0.114 for exactly that, which
 * is why the negative cases below matter more than the positive one.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { imageRetryPlan } from '../generators/images.js'
import { FLEET_BUSY_RETRY_DELAYS_MS } from '../lib/genstudio-fleet-busy.js'
import {
  GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
  GenStudioImageTerminalFailureError,
  GenStudioTtsTerminalFailureError,
} from '../lib/genstudio-client.js'
import { IMAGE_ROUTE_RETRY_MAX_ATTEMPTS } from '../services/image-route-retry.js'

/** A settled GenStudio job with the reservation released whole — the free case. */
function settledJob(over: Record<string, unknown>) {
  return {
    id: 'img-job', state: 'failed', cancelled: false,
    reserved_credits: 12, settled_credits: 0, released_credits: 12,
    ...over,
  } as any
}

const imageFailure = (over: Record<string, unknown>) =>
  new GenStudioImageTerminalFailureError(settledJob(over))

test('a busy fleet with the money returned is waited out, not dropped', () => {
  // Both codes mean the same thing: no machine was free. Neither means the
  // render is impossible, so the item deserves another ask rather than a line
  // in the output telling the owner to re-run it by hand.
  for (const failure_code of ['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE']) {
    const plan = imageRetryPlan(imageFailure({ failure_code }), 1)
    assert.ok(plan, `${failure_code} must earn another attempt`)
    assert.match(plan.reason, /high demand right now/i)
  }
})

test('a capacity code that took money is NOT retried', () => {
  // Settled credits mean a provider was paid and may already have rendered the
  // image. Resubmitting over that charges the owner twice for one asset — the
  // single worst outcome this file exists to prevent — so an assumption that
  // can no longer be verified stops the retry, whatever the code claims.
  assert.equal(
    imageRetryPlan(imageFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 12, released_credits: 0,
    }), 1),
    null,
  )
  assert.equal(
    imageRetryPlan(imageFailure({
      failure_code: 'SITE_CAPACITY_UNAVAILABLE', settled_credits: 3, released_credits: 9,
    }), 1),
    null,
  )
})

test('an ordinary image failure is never retried as if the fleet were merely busy', () => {
  // A real fault repeats. Three backoffs would turn a clear, immediate error
  // into ten minutes of silence followed by the same clear error — worse for
  // the owner than failing at once, and it teaches him to distrust the log.
  for (const failure_code of ['CLOUD_PROVIDER_FAILED', 'CONTENT_BLOCKED', 'CLOUD_SUBMISSION_UNCERTAIN', null, '']) {
    assert.equal(
      imageRetryPlan(imageFailure({ failure_code }), 1),
      null,
      `${String(failure_code)} is not a capacity problem`,
    )
  }
  // Nor is anything that is not a settled GenStudio failure at all.
  assert.equal(imageRetryPlan(new Error('socket hang up'), 1), null)
  assert.equal(imageRetryPlan(null, 1), null)
  assert.equal(imageRetryPlan(undefined, 1), null)
})

test('a cancelled job is never resubmitted', () => {
  // Cancellation is the owner's instruction. However GenStudio settled the
  // job, retrying it would be the app overruling him.
  assert.equal(
    imageRetryPlan(imageFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', cancelled: true }), 1),
    null,
  )
})

test('another modality queuing up is not licence to resubmit an image', () => {
  // A busy TTS queue says nothing about whether this image's credits came
  // back. Only an image failure can authorise an image resubmission.
  assert.equal(
    imageRetryPlan(new GenStudioTtsTerminalFailureError(
      settledJob({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' })), 1),
    null,
  )
})

test('the fleet waits are the shared minutes-long schedule, and they run out', () => {
  // GenStudio declares a busy fleet only AFTER a fifteen-minute placement
  // window, so an item reaching here has already queued a long time and the
  // fleet is genuinely saturated. The image route backoff — seconds, tuned for
  // a provider declining right now — would rejoin the same jam and burn the
  // attempt, which is why this path uses the shared schedule instead.
  const busy = imageFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' })
  for (let attemptNum = 1; attemptNum <= FLEET_BUSY_RETRY_DELAYS_MS.length; attemptNum++) {
    const plan = imageRetryPlan(busy, attemptNum)
    assert.ok(plan)
    assert.equal(plan.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[attemptNum - 1])
    assert.ok(plan.waitMs >= 30_000, 'a fleet wait is never a couple of seconds')
    assert.equal(plan.maxAttempts, FLEET_BUSY_RETRY_DELAYS_MS.length + 1)
  }
  // Bounded: after the last delay the item fails exactly as it does today. An
  // unbounded wait would hold a scene open against a wall forever.
  assert.equal(imageRetryPlan(busy, FLEET_BUSY_RETRY_DELAYS_MS.length + 1), null)
  assert.equal(imageRetryPlan(busy, 99), null)
})

test('the declined-route retry that already existed is untouched', () => {
  // This change widens what is retried; it must not quietly re-time or
  // re-bound the CLOUD_PROVIDER_EXHAUSTED path that shipped before it. That
  // one is a per-second condition with its own jittered, independently
  // tunable schedule, and it keeps it.
  const plan = imageRetryPlan(imageFailure({ failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE }), 1)
  assert.ok(plan)
  assert.match(plan.reason, /no image route/i)
  assert.equal(plan.maxAttempts, IMAGE_ROUTE_RETRY_MAX_ATTEMPTS)
  assert.ok(plan.waitMs < 30_000, 'a declined route is not a saturated fleet')
  assert.equal(imageRetryPlan(imageFailure({ failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE }), IMAGE_ROUTE_RETRY_MAX_ATTEMPTS), null)
})

test('the generator waits under the owner\'s control and resubmits under a derived identity', () => {
  const source = readFileSync(new URL('../generators/images.ts', import.meta.url), 'utf8')

  // Scenes AND thumbnails. Thumbnails are the same fleet-placed submission and
  // were the half of this file most likely to be fixed and forgotten.
  assert.equal(source.match(/imageRetryPlan\(e, attemptNum\)/g)?.length, 2)

  // Cancel and pause are the file's own mechanisms, checked before and after
  // both waits. Scenes keep their fleet-only guard; paid thumbnails extend the
  // same stoppable guard to the one released zero-settlement retry.
  assert.match(source, /!jq\.isCancelled\(job\.job_id\)\s*\n\s*&& !\(fleetBusy && jq\.isPauseRequested\(job\.job_id\)\)/)
  assert.match(source, /const stoppableRetry = fleetBusy \|\| releasedZeroSettlementRetry/)
  assert.match(source, /!jq\.isCancelled\(job\.job_id\)\s*\n\s*&& !\(stoppableRetry && jq\.isPauseRequested\(job\.job_id\)\)/)
  assert.equal(source.match(/if \(fleetBusy && jq\.isPauseRequested\(job\.job_id\)\) \{/g)?.length, 1)
  assert.equal(source.match(/if \(stoppableRetry && jq\.isPauseRequested\(job\.job_id\)\) \{/g)?.length, 1)
  assert.equal(source.match(/await waitUnlessStopped\(/g)?.length, 2)
  assert.equal(source.match(/await delayUnlessAborted\(waitMs, cancelController\.signal\)/g)?.length, 2)

  // IDENTITY. A settled-failed job can never be reopened, so each attempt needs
  // a new one — but minting it fresh would mean a crash between the wait and
  // the resubmission buys a second render. Images already own a deterministic
  // chain (`resolveImageRetryScope`, via `deriveRouteRetryAttempt`) derived
  // from the failed job id, so a replayed retry re-attaches instead of paying.
  assert.equal(
    source.match(/attempt = deriveRouteRetryAttempt\(attempt, e\.jobId \|\| acceptedTaskId, finalPrompt\)/g)?.length,
    2,
  )
  assert.doesNotMatch(source, /randomUUID/)
  assert.doesNotMatch(source, /nextImageRouteRetryIdentity/)

  // The rule itself is the shared one, not a local copy that can drift.
  assert.match(source, /from '\.\.\/lib\/genstudio-fleet-busy\.js'/)

  // Said in words the owner can read in the job output, and it says the thing
  // he would otherwise have to take on faith: this cost him nothing.
  assert.match(source, /nothing was charged/)
})
