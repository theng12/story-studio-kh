/**
 * v1.4.30 — a Scene Plan batch image refused for want of a free machine waits
 * and asks again instead of being dropped.
 *
 * WHY THIS GENERATOR. Every image in the app is fleet-placed — 7,419 attempts
 * in thirty days, the highest-volume operation there is — and this batch is one
 * of the paths producing them, in runs of hundreds of scenes at a time. It has
 * simply not met a saturated fleet yet. The two operations that did both lost
 * work without saying so: transcription lost 122 of 353 items in one burst, and
 * TTS lost 5 over three days that nobody noticed for nine, because the only
 * symptom is a missing asset a later manual retry quietly fills in. A large
 * batch meeting the same wall would lose scenes exactly that silently, and the
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
import { sceneImagesBatchFleetBusyRetryPlan } from '../generators/scene-images-batch.js'
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
  // manual re-run and, worse, a silently short episode he may not notice: the
  // batch's own completion audit only tells him which ids to try again.
  for (const failure_code of ['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE']) {
    const plan = sceneImagesBatchFleetBusyRetryPlan(imageFailure({ failure_code }), 1)
    assert.ok(plan, `${failure_code} must earn another attempt`)
    assert.match(plan.reason, /every machine was busy/i)
  }
})

test('(b) the same code with credits SETTLED is never resubmitted', () => {
  // Settled credits mean a provider was paid and may already have rendered the
  // image. Resubmitting over that charges the owner twice for one asset — the
  // single worst outcome this change can have — so a guarantee that can no
  // longer be verified stops the retry, whatever the failure code claims.
  assert.equal(
    sceneImagesBatchFleetBusyRetryPlan(imageFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 9, released_credits: 0,
    }), 1),
    null,
  )
  assert.equal(
    sceneImagesBatchFleetBusyRetryPlan(imageFailure({
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
      sceneImagesBatchFleetBusyRetryPlan(imageFailure({ failure_code }), 1),
      null,
      `${String(failure_code)} is not a capacity problem`,
    )
  }
  // Not even a declined ROUTE, which `generators/images.ts` does retry on its
  // own seconds-long schedule. This batch has never had that retry, and reusing
  // that generator's `imageRetryPlan` to save a few lines would have smuggled a
  // second behaviour change into a fix about a busy fleet.
  assert.equal(
    sceneImagesBatchFleetBusyRetryPlan(imageFailure({ failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE }), 1),
    null,
  )
  // Nor anything that is not a settled GenStudio failure at all — a socket
  // hang-up says nothing about whether a worker took the job.
  assert.equal(sceneImagesBatchFleetBusyRetryPlan(new Error('socket hang up'), 1), null)
  assert.equal(sceneImagesBatchFleetBusyRetryPlan(null, 1), null)
  assert.equal(sceneImagesBatchFleetBusyRetryPlan(undefined, 1), null)
})

test('(d) a cancelled job is never resubmitted', () => {
  // Cancellation is the owner's instruction. However GenStudio settled the job,
  // asking for the image again would be the app overruling him.
  assert.equal(
    sceneImagesBatchFleetBusyRetryPlan(imageFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', cancelled: true }), 1),
    null,
  )
})

test('a busy queue in another modality is not licence to resubmit an image', () => {
  // A saturated TTS queue says nothing about whether THIS image's credits came
  // back, which is why the modality is passed to the shared guard rather than
  // left to match anything.
  assert.equal(
    sceneImagesBatchFleetBusyRetryPlan(new GenStudioTtsTerminalFailureError(
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
    const plan = sceneImagesBatchFleetBusyRetryPlan(busy, attemptNum)
    assert.ok(plan)
    assert.equal(plan.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[attemptNum - 1])
    assert.ok(plan.waitMs >= 30_000, 'a fleet wait is never a couple of seconds')
    assert.equal(plan.maxAttempts, FLEET_BUSY_RETRY_DELAYS_MS.length + 1)
  }
  // Bounded by the shared schedule's own length: after the last delay the scene
  // fails exactly as it does today. An unbounded wait would hold a batch open
  // against a wall forever and is a worse failure than the one being fixed.
  assert.equal(sceneImagesBatchFleetBusyRetryPlan(busy, FLEET_BUSY_RETRY_DELAYS_MS.length + 1), null)
  assert.equal(sceneImagesBatchFleetBusyRetryPlan(busy, 99), null)
})

test('the batch waits under the owner\'s control and resubmits under a DERIVED identity', () => {
  const source = readFileSync(new URL('../generators/scene-images-batch.ts', import.meta.url), 'utf8')

  // The rule is the shared one, not a local copy that can drift away from the
  // other generators that must agree about what is free to retry.
  assert.match(source, /from '\.\.\/lib\/genstudio-fleet-busy\.js'/)
  assert.match(source, /isFleetBusyFailure\(e, 'image'\)/)

  // Cancel and Pause are read at all three moments that matter: the top of
  // every attempt, before committing to a wait, and again after minutes have
  // passed. The wait itself polls in short slices, so a stop pressed four
  // minutes into a five-minute wait is honoured in seconds rather than at the
  // end of it.
  assert.match(source, /Cancel is re-read at the top of EVERY attempt/)
  assert.match(source, /if \(retryPlan && failedTaskId && !jq\.isCancelled\(job\.job_id\) && !jq\.isPauseRequested\(job\.job_id\)\) \{/)
  assert.match(source, /await waitForFleetCapacity\(retryPlan\.waitMs\)/)
  assert.match(source, /Math\.min\(2_000, deadline - Date\.now\(\)\)/)
  assert.match(source, /if \(!jq\.isCancelled\(job\.job_id\) && !jq\.isPauseRequested\(job\.job_id\)\) \{/)

  // IDENTITY. A settled-failed GenStudio job can never be reopened — replaying
  // its idempotency key returns the same failure forever — so every attempt
  // needs a new one. It is DERIVED, not minted: the failed manifest entry is
  // written to disk first and mirrored into the in-memory manifest EXACTLY as
  // written, then promoted through the same deterministic
  // `resolveImageRetryScope` a manual Retry uses. A crash between the wait and
  // the resubmission therefore replays the identical request and re-attaches to
  // the job GenStudio already has, instead of buying a second render.
  assert.match(source, /const failedEntry = await recordState\(scene, attempt, 'failed', failedTaskId, acceptedKey\)/)
  assert.match(source, /taskManifest\.tasks\[`\$\{scene\.id\}\.png`\] = failedEntry/)
  assert.match(source, /const attempt = resolveAttempt\(scene\)/)
  assert.match(source, /resolveImageRetryScope\(entry, 'batch'\)/)
  assert.doesNotMatch(source, /randomUUID/)
  assert.doesNotMatch(source, /Math\.random/)

  // Said in words the owner can read in the job output, and it says the part he
  // would otherwise have to take on faith: this cost him nothing.
  assert.match(source, /nothing was charged/)

  // A scene sitting out a wait has not settled. Counting it done here would
  // report more finished scenes than there are images on disk — the same kind
  // of quiet miscount this whole change exists to stop.
  assert.match(source, /if \(!retryScene\) \{\n\s+done\+\+/)
})

test('no stall watchdog can cancel this generator\'s own retry', () => {
  // continuity-render.ts had to suppress a 10-minute stall pause while waiting,
  // because a busy fleet is exactly the condition that trips it. This generator
  // has no such timer — it owns no interval and nothing external watches it —
  // so there is nothing to suppress. This test fails the day one is added
  // without teaching it about the wait.
  const source = readFileSync(new URL('../generators/scene-images-batch.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /pauseJobForStall|setInterval/)
})
