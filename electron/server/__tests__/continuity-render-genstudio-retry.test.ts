/**
 * v1.4.27 — a Scene Review image refused for want of a free machine waits and
 * asks again instead of being dropped.
 *
 * WHY THIS GENERATOR. Every image in the app is fleet-placed, and Scene Review
 * is the batch that produces most of them — 7,419 image attempts in thirty
 * days across the app, in runs of hundreds of scenes at a time. It has simply
 * not met a saturated fleet yet. The two operations that did both lost work
 * without saying so: transcription lost 122 of 353 items in one burst, and TTS
 * lost 5 over three days that nobody noticed for nine, because the only symptom
 * is a missing asset that a later manual retry quietly fills in. A 333-scene
 * render meeting the same wall would lose scenes exactly that silently, and the
 * owner would be told to re-run them by hand.
 *
 * WHY RESUBMITTING IS SAFE, AND WHY NOTHING ELSE IS. GenStudio raises this code
 * from one place, having already held the job in a fifteen-minute placement
 * window, and states there what became of the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so another attempt is a
 * fresh charge for work that never happened — not a second charge for the same
 * work. The argument does not extend one inch further: a provider that WAS
 * engaged may already have rendered the image, and resubmitting over it charges
 * the owner twice for one asset. A "Repair & Retry all" button was removed in
 * v1.0.114 for exactly that, which is why the refusals below matter more than
 * the one case that is allowed.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  continuityFleetBusyRetryPlan,
  shouldPauseContinuityForStall,
} from '../generators/continuity-render.js'
import { FLEET_BUSY_RETRY_DELAYS_MS } from '../lib/genstudio-fleet-busy.js'
import {
  GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
  GenStudioImageTerminalFailureError,
  GenStudioTtsTerminalFailureError,
} from '../lib/genstudio-client.js'

/** A settled GenStudio job with the reservation released whole — the free case. */
function settledJob(over: Record<string, unknown>) {
  return {
    id: 'img-job', state: 'failed', cancelled: false,
    reserved_credits: 9, settled_credits: 0, released_credits: 9,
    ...over,
  } as any
}

const imageFailure = (over: Record<string, unknown>) =>
  new GenStudioImageTerminalFailureError(settledJob(over))

test('(a) a busy fleet with the money returned earns another attempt', () => {
  // Both codes mean the same thing — no machine was free — and neither means
  // the render is impossible. Dropping the scene here is what costs the owner a
  // manual re-run and, worse, a silently short episode he may not notice.
  for (const failure_code of ['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE']) {
    const plan = continuityFleetBusyRetryPlan(imageFailure({ failure_code }), 1)
    assert.ok(plan, `${failure_code} must earn another attempt`)
    assert.match(plan.reason, /high demand right now/i)
  }
})

test('(b) the same code with credits SETTLED is never resubmitted', () => {
  // Settled credits mean a provider was paid and may already have rendered the
  // image. Resubmitting over that charges the owner twice for one asset — the
  // single worst outcome this change can have — so a guarantee that can no
  // longer be verified stops the retry, whatever the failure code claims.
  assert.equal(
    continuityFleetBusyRetryPlan(imageFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 9, released_credits: 0,
    }), 1),
    null,
  )
  assert.equal(
    continuityFleetBusyRetryPlan(imageFailure({
      failure_code: 'SITE_CAPACITY_UNAVAILABLE', settled_credits: 2, released_credits: 7,
    }), 1),
    null,
  )
})

test('(c) an unrelated failure is never retried as if the fleet were merely busy', () => {
  // A real fault repeats. Three backoffs would turn a clear, immediate error
  // into ten minutes of silence followed by the same clear error — worse for
  // the owner than failing at once, and it teaches him to distrust the log.
  for (const failure_code of ['CLOUD_PROVIDER_FAILED', 'CONTENT_BLOCKED', 'CLOUD_SUBMISSION_UNCERTAIN', null, '']) {
    assert.equal(
      continuityFleetBusyRetryPlan(imageFailure({ failure_code }), 1),
      null,
      `${String(failure_code)} is not a capacity problem`,
    )
  }
  // Not even a declined ROUTE, which images.ts does retry on its own seconds-long
  // schedule. Scene Review has never had that retry; this change is about a busy
  // fleet, and quietly bundling a second behaviour change into it would be a
  // different decision made without being asked for.
  assert.equal(
    continuityFleetBusyRetryPlan(imageFailure({ failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE }), 1),
    null,
  )
  // Nor anything that is not a settled GenStudio failure at all.
  assert.equal(continuityFleetBusyRetryPlan(new Error('socket hang up'), 1), null)
  assert.equal(continuityFleetBusyRetryPlan(null, 1), null)
  assert.equal(continuityFleetBusyRetryPlan(undefined, 1), null)
})

test('(d) a cancelled job is never resubmitted', () => {
  // Cancellation is the owner's instruction. However GenStudio settled the job,
  // asking for the image again would be the app overruling him — and this
  // generator separately counts a cancelled scene as not-a-failure, so a retry
  // here would also corrupt that accounting.
  assert.equal(
    continuityFleetBusyRetryPlan(imageFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', cancelled: true }), 1),
    null,
  )
})

test('a busy queue in another modality is not licence to resubmit an image', () => {
  // A saturated TTS queue says nothing about whether THIS image's credits came
  // back, which is why the modality is passed to the shared guard rather than
  // left to match anything.
  assert.equal(
    continuityFleetBusyRetryPlan(new GenStudioTtsTerminalFailureError(
      settledJob({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' })), 1),
    null,
  )
})

test('the waits are the shared minutes-long schedule, and they run out', () => {
  // GenStudio declares a busy fleet only AFTER a fifteen-minute placement
  // window, so a scene reaching here has already queued a long time and the
  // fleet is genuinely saturated. A two-second retry would rejoin the same jam
  // and burn the attempt for nothing.
  const busy = imageFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' })
  for (let attemptNum = 1; attemptNum <= FLEET_BUSY_RETRY_DELAYS_MS.length; attemptNum++) {
    const plan = continuityFleetBusyRetryPlan(busy, attemptNum)
    assert.ok(plan)
    assert.equal(plan.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[attemptNum - 1])
    assert.ok(plan.waitMs >= 30_000, 'a fleet wait is never a couple of seconds')
    assert.equal(plan.maxAttempts, FLEET_BUSY_RETRY_DELAYS_MS.length + 1)
  }
  // Bounded by the shared schedule's own length: after the last delay the scene
  // fails exactly as it does today. An unbounded wait would hold a render open
  // against a wall forever and is a worse failure than the one being fixed.
  assert.equal(continuityFleetBusyRetryPlan(busy, FLEET_BUSY_RETRY_DELAYS_MS.length + 1), null)
  assert.equal(continuityFleetBusyRetryPlan(busy, 99), null)
})

test('the batch waits under the owner\'s control and resubmits under a DERIVED identity', () => {
  const source = readFileSync(new URL('../generators/continuity-render.ts', import.meta.url), 'utf8')

  // The rule is the shared one, not a local copy that can drift away from the
  // seven other generators that must agree about what is free to retry.
  assert.match(source, /from '\.\.\/lib\/genstudio-fleet-busy\.js'/)
  assert.match(source, /isFleetBusyFailure\(e, 'image'\)/)

  // Cancel and Pause are this file's own mechanisms and are read at all three
  // moments that matter: the top of every attempt, before committing to a wait,
  // and again after minutes have passed. The wait itself polls in short slices,
  // so a stop pressed four minutes into a five-minute wait is honoured in
  // seconds rather than at the end of it.
  assert.match(source, /for \(;;\) \{\n\s+\/\/ Cancel and Pause are re-read at the top of EVERY attempt/)
  assert.match(source, /if \(plan && failedTaskId && !jq\.isCancelled\(job\.job_id\) && !jq\.isPauseRequested\(job\.job_id\)\) \{/)
  assert.match(source, /await waitForFleetCapacity\(plan\.waitMs\)/)
  assert.match(
    source,
    /\/\/ Pause pressed during them is the owner's last word\.\n\s+if \(jq\.isCancelled\(job\.job_id\) \|\| jq\.isPauseRequested\(job\.job_id\)\) return/,
  )

  // IDENTITY. A settled-failed GenStudio job can never be reopened — replaying
  // its idempotency key returns the same failure forever — so every attempt
  // needs a new one. It is DERIVED, not minted: the failed manifest entry is
  // written to disk first and handed to the next attempt, which promotes it
  // through the same deterministic `resolveImageRetryScope` a manual Retry
  // uses. A crash between the wait and the resubmission therefore replays the
  // identical request and re-attaches to the job GenStudio already has, instead
  // of buying a second render.
  assert.match(source, /await recordTaskStrict\(outDir, filename, failedEntry\)/)
  assert.match(source, /savedEntry = failedEntry/)
  assert.match(source, /const manifestEntry = savedEntry/)
  assert.match(source, /const retryScope = resolveImageRetryScope\(retryEntry, baseScope\)/)
  assert.doesNotMatch(source, /randomUUID/)
  assert.doesNotMatch(source, /Math\.random/)

  // Said in words the owner can read in the job output, and it says the part he
  // would otherwise have to take on faith: this cost him nothing.
  assert.match(source, /nothing was charged/)

  // The stall watchdog must not fight deliberate capacity waits, regardless
  // of whether the wait is local fleet retry or remote admission.
  const stalled = {
    stallPauseRequested: false,
    inFlightCount: 1,
    pauseRequested: false,
    elapsedMs: 11 * 60_000,
  }
  assert.equal(shouldPauseContinuityForStall({ ...stalled, fleetWaitingCount: 1, capacityWaitingCount: 0 }), false)
  assert.equal(shouldPauseContinuityForStall({ ...stalled, fleetWaitingCount: 0, capacityWaitingCount: 1 }), false)
  assert.equal(shouldPauseContinuityForStall({ ...stalled, fleetWaitingCount: 0, capacityWaitingCount: 0 }), true)
})
