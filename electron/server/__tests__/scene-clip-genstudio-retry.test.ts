/**
 * v1.4.31 — a Motion Review clip refused for want of a free machine waits and
 * asks again instead of being dropped.
 *
 * WHY THIS GENERATOR. GenStudio places every job on a fleet machine, and with
 * none free it settles the job FAILED with `SITE_PLACEMENT_EXHAUSTED` after a
 * fifteen-minute placement window. Two operations have already lost work to it
 * silently: transcription dropped 122 of 353 items in one burst, and TTS dropped
 * 5 over three days that nobody noticed for nine, because the only symptom is a
 * missing asset a later manual retry quietly fills in. Motion Review is worse
 * than either, on two counts. `generateSceneClipsBatchJob` runs every non-still
 * scene through `generateSceneClipJob` inside ONE queue job with no per-scene
 * catch, so a single refusal does not drop one clip — it ends the whole
 * episode's run. And video is the most expensive thing the app buys, so the
 * work being thrown away is the most valuable work there is.
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
 * work. The argument does not extend one inch further. A provider that WAS
 * engaged may already have rendered the clip, and resubmitting over it charges
 * the owner twice for the priciest asset in the app — the single worst outcome
 * this change can have. A "Repair & Retry all" button was removed in v1.0.114
 * for exactly that, which is why the refusals below matter more than the one
 * case that is allowed.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { sceneClipFleetBusyRetryPlan } from '../generators/scene-clip.js'
import { FLEET_BUSY_RETRY_DELAYS_MS } from '../lib/genstudio-fleet-busy.js'
import {
  GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
  GenStudioImageTerminalFailureError,
  GenStudioTtsTerminalFailureError,
  GenStudioVideoTerminalFailureError,
} from '../lib/genstudio-client.js'

/** A settled GenStudio job with the reservation released whole — the free case. */
function settledJob(over: Record<string, unknown>) {
  return {
    id: 'vid-job', state: 'failed', cancelled: false,
    reserved_credits: 240, settled_credits: 0, released_credits: 240,
    ...over,
  } as any
}

const videoFailure = (over: Record<string, unknown>) =>
  new GenStudioVideoTerminalFailureError(settledJob(over))

test('the modality this generator guards on is the one the video error carries', () => {
  // Read, not assumed. `GenStudioVideoTerminalFailureError` builds its base with
  // `super('video', job, …)`, and Motion Review produces VIDEO — not the
  // `'image'` its still-image neighbours pass. Getting this wrong in the
  // permissive direction would let a busy IMAGE queue licence a resubmission of
  // the most expensive asset in the app.
  assert.equal(videoFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }).modality, 'video')
})

test('(a) a busy fleet with the money returned earns another attempt', () => {
  // Both codes mean the same thing — no machine was free — and neither means
  // the clip is impossible. Dropping it here costs the owner a manual re-run of
  // an entire episode's motion pass, because the batch has no per-scene catch.
  for (const failure_code of ['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE']) {
    const plan = sceneClipFleetBusyRetryPlan(videoFailure({ failure_code }), 1)
    assert.ok(plan, `${failure_code} must earn another attempt`)
    assert.match(plan.reason, /every machine was busy/i)
  }
})

test('(b) the same code with credits SETTLED is never resubmitted', () => {
  // Settled credits mean a provider was paid and may already have rendered the
  // clip. Resubmitting over that charges the owner twice for one video — the
  // worst outcome available to this change — so a guarantee that can no longer
  // be verified stops the retry, whatever the failure code claims.
  assert.equal(
    sceneClipFleetBusyRetryPlan(videoFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 240, released_credits: 0,
    }), 1),
    null,
  )
  assert.equal(
    sceneClipFleetBusyRetryPlan(videoFailure({
      failure_code: 'SITE_CAPACITY_UNAVAILABLE', settled_credits: 12, released_credits: 228,
    }), 1),
    null,
  )
})

test('(c) an unrelated failure is never retried as if the fleet were merely busy', () => {
  // A real fault repeats. Three backoffs would turn a clear, immediate error
  // into ten minutes of silence followed by the same clear error — worse for the
  // owner than failing at once, and it teaches him to distrust the log.
  for (const failure_code of ['CLOUD_PROVIDER_FAILED', 'CONTENT_BLOCKED', 'CLOUD_SUBMISSION_UNCERTAIN', null, '']) {
    assert.equal(
      sceneClipFleetBusyRetryPlan(videoFailure({ failure_code }), 1),
      null,
      `${String(failure_code)} is not a capacity problem`,
    )
  }
  // Not even a declined ROUTE, which `generators/images.ts` does retry on its
  // own seconds-long schedule. Motion Review has never had that retry, and
  // reusing that generator's `imageRetryPlan` to save a few lines would have
  // smuggled a second behaviour change — on the priciest modality — into a fix
  // about a busy fleet.
  assert.equal(
    sceneClipFleetBusyRetryPlan(videoFailure({ failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE }), 1),
    null,
  )
  // Nor anything that is not a settled GenStudio failure at all — a socket
  // hang-up says nothing about whether a worker took the job.
  assert.equal(sceneClipFleetBusyRetryPlan(new Error('socket hang up'), 1), null)
  assert.equal(sceneClipFleetBusyRetryPlan(null, 1), null)
  assert.equal(sceneClipFleetBusyRetryPlan(undefined, 1), null)
})

test('(d) a cancelled job is never resubmitted', () => {
  // Cancellation is the owner's instruction. A cancelled video job settles
  // through the same `cancelled` boolean as every other modality
  // (`waitForVideoJob` throws on `state === 'failed' || cancelled === true`), so
  // the shared guard sees it; asking for the clip again would be the app
  // overruling him.
  assert.equal(
    sceneClipFleetBusyRetryPlan(videoFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', cancelled: true }), 1),
    null,
  )
  assert.equal(
    sceneClipFleetBusyRetryPlan(videoFailure({ failure_code: 'SITE_CAPACITY_UNAVAILABLE', cancelled: true }), 1),
    null,
  )
})

test('(e) a busy queue in another modality is not licence to resubmit a clip', () => {
  // A saturated TTS or image queue says nothing about whether THIS clip's
  // credits came back, which is why the modality is passed to the shared guard
  // rather than left to match anything. The image case is the one that would
  // actually happen here: this generator sits beside two image generators that
  // pass `'image'`, and an episode renders stills and clips in the same run.
  const busy = { failure_code: 'SITE_PLACEMENT_EXHAUSTED' }
  assert.equal(
    sceneClipFleetBusyRetryPlan(new GenStudioTtsTerminalFailureError(settledJob(busy)), 1),
    null,
  )
  assert.equal(
    sceneClipFleetBusyRetryPlan(new GenStudioImageTerminalFailureError(settledJob(busy)), 1),
    null,
  )
})

test('the waits are the shared minutes-long schedule, and they run out', () => {
  // GenStudio declares a busy fleet only AFTER a fifteen-minute placement
  // window, so a clip reaching here has already queued a long time and the fleet
  // is genuinely saturated. A two-second retry would rejoin the same jam and
  // burn the attempt for nothing.
  const busy = videoFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' })
  for (let attemptNum = 1; attemptNum <= FLEET_BUSY_RETRY_DELAYS_MS.length; attemptNum++) {
    const plan = sceneClipFleetBusyRetryPlan(busy, attemptNum)
    assert.ok(plan)
    assert.equal(plan.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[attemptNum - 1])
    assert.ok(plan.waitMs >= 30_000, 'a fleet wait is never a couple of seconds')
    assert.equal(plan.maxAttempts, FLEET_BUSY_RETRY_DELAYS_MS.length + 1)
  }
  // Bounded by the shared schedule's own length: after the last delay the clip
  // fails exactly as it does today. An unbounded wait would hold an episode's
  // motion pass open against a wall forever and is a worse failure than the one
  // being fixed.
  assert.equal(sceneClipFleetBusyRetryPlan(busy, FLEET_BUSY_RETRY_DELAYS_MS.length + 1), null)
  assert.equal(sceneClipFleetBusyRetryPlan(busy, 99), null)
})

test('the clip waits under the owner\'s control and resubmits under a DERIVED identity', () => {
  const source = readFileSync(new URL('../generators/scene-clip.ts', import.meta.url), 'utf8')

  // The rule is the shared one, not a local copy that can drift away from the
  // other generators that must agree about what is free to retry.
  assert.match(source, /from '\.\.\/lib\/genstudio-fleet-busy\.js'/)
  assert.match(source, /isFleetBusyFailure\(e, 'video'\)/)

  // Cancel and Pause are read at all three moments that matter: the top of every
  // attempt, before committing to a wait, and again after minutes have passed.
  // The wait itself polls in short slices, so a stop pressed four minutes into a
  // five-minute wait is honoured in seconds rather than at the end of it.
  assert.match(source, /Cancel is re-read at the top of EVERY attempt/)
  assert.match(source, /if \(jq\.isCancelled\(job\.job_id\)\) throw new Error\('Cancelled by user'\)/)
  assert.match(source, /if \(retryPlan && failedTaskId && !jq\.isCancelled\(job\.job_id\) && !jq\.isPauseRequested\(job\.job_id\)\) \{/)
  assert.match(source, /await waitForFleetCapacity\(retryPlan\.waitMs\)/)
  assert.match(source, /Math\.min\(2_000, deadline - Date\.now\(\)\)/)
  assert.match(source, /if \(!jq\.isCancelled\(job\.job_id\) && !jq\.isPauseRequested\(job\.job_id\)\) \{/)

  // IDENTITY. A settled-failed GenStudio job can never be reopened — replaying
  // its idempotency key returns the same failure forever — so every attempt
  // needs a new one. It is DERIVED, not minted: this file already persisted the
  // failed job id before the wait, and the same entry is mirrored into the
  // in-memory `savedEntry` EXACTLY as written, then promoted through the same
  // deterministic `resolveGenStudioRetryScope` a manual Retry uses. A crash
  // between the wait and the resubmission therefore replays the identical
  // request instead of buying a second clip.
  assert.match(source, /const failedEntry = clipManifestEntry\(\{/)
  assert.match(source, /await recordTask\(outDir, manifestKey, failedEntry\)/)
  assert.match(source, /savedEntry = failedEntry/)
  assert.match(source, /const retry = resolveGenStudioRetryScope\(savedEntry, 'missing', isTerminalGenStudioClipTaskFailure\)/)
  assert.doesNotMatch(source, /randomUUID/)
  assert.doesNotMatch(source, /Math\.random/)

  // The new identity is on disk BEFORE the paid POST of the retry — the whole
  // reason a lost submit response replays instead of buying a second clip.
  assert.match(source, /Persist the request identity BEFORE the POST/)
  assert.match(source, /await recordTaskStrict\(outDir, manifestKey, clipManifestEntry\(\{\n\s+task_id: recoveryEntry\?\.task_id \|\| '',\n\s+last_state: preparedState,/)

  // Said in words the owner can read in the job output, and it says the part he
  // would otherwise have to take on faith: this cost him nothing.
  assert.match(source, /nothing was charged and the credits were returned/)
})

test('no stall watchdog can cancel this generator\'s own retry', () => {
  // continuity-render.ts had to suppress a 10-minute stall pause while waiting,
  // because a busy fleet is exactly the condition that trips it. Motion Review
  // has no such timer — it owns no interval, and `jq.pauseJobForStall` has
  // exactly one caller in the app, which is continuity-render — so there is
  // nothing to suppress. This test fails the day one is added here without
  // teaching it about the wait.
  const source = readFileSync(new URL('../generators/scene-clip.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /pauseJobForStall|setInterval/)
})
