/**
 * Contextual Cues waits for a busy fleet (v1.4.33).
 *
 * THE DEFECT. GenStudio places every job on a machine in the Mac-mini fleet,
 * and with none free it settles the job FAILED with `SITE_PLACEMENT_EXHAUSTED`
 * after a fifteen-minute placement window. Before this, `contextual-cues.ts`
 * recognised exactly one capacity failure — `LANGUAGE_PROVIDER_BACKPRESSURE` —
 * and a busy fleet fell straight through to `throw error`, which does not lose
 * one cue: it throws out of the batch loop and ends the episode's whole
 * proposal pass. The same code has already cost the owner 122 of 353
 * transcription items in one burst, and 5 TTS sections over three days that
 * nobody noticed for nine.
 *
 * WHAT THIS FILE PROTECTS. Two things that are easy to get wrong and silent
 * when wrong:
 *
 *   1. That the retry stays pinned to the ONE code where GenStudio has proved
 *      the money came back whole. Anything wider resubmits over work a provider
 *      may already have done and billed — the double-charge that got "Repair &
 *      Retry all" removed in v1.0.114.
 *   2. That the two ladders stay separate. Provider backpressure is a provider
 *      shedding load for a moment (15s, twice); a busy fleet is a saturated
 *      fleet GenStudio has ALREADY waited fifteen minutes on (30s/2m/5m). A
 *      fifteen-second retry rejoins the same jam and burns the attempt.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  CONTEXTUAL_CUE_GENSTUDIO_MODALITY,
  contextualCueFleetBusyRetryPlan,
} from '../generators/contextual-cues.js'
import { isReleasedContextualCueBackpressure } from '../services/contextual-cues.js'
import { FLEET_BUSY_RETRY_DELAYS_MS } from '../lib/genstudio-fleet-busy.js'
import {
  GenStudioChatTerminalFailureError,
  GenStudioTtsTerminalFailureError,
} from '../lib/genstudio-client.js'

const GENERATOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'generators', 'contextual-cues.ts')

/** A failed GenStudio job; any legacy settlement fields it carries do not decide. */
const settled = (over: Record<string, unknown> = {}) => ({
  id: 'job-dead-1', state: 'failed', cancelled: false,
  reserved_credits: 23, settled_credits: 0, released_credits: 23, ...over,
}) as any

const chatFailure = (over: Record<string, unknown> = {}) =>
  new GenStudioChatTerminalFailureError(settled(over))

/**
 * Assert on the generator's own text without printing 20KB of it on failure.
 *
 * The wiring below — which counter governs which ladder, where the retry
 * identity comes from, that both stop signals are re-read after the wait — has
 * no return value to check: it is only observable by driving a real episode of
 * paid batches against a saturated fleet, which is exactly the thing nobody
 * will do before shipping. So it is pinned here instead.
 */
async function sourceProbe(): Promise<(needle: string, why: string) => void> {
  const source = await readFile(GENERATOR, 'utf8')
  return (needle, why) => assert.ok(source.includes(needle), `${why}\n  missing: ${needle}`)
}

describe('Contextual Cues: a busy fleet is worth asking again', () => {
  test('the modality comes from a live error instance, not a hopeful string', () => {
    // Asserted against a REAL error rather than the literal 'chat', so an
    // upstream rename fails here instead of quietly turning the retry off:
    // `isFleetBusyFailure` would then match nothing and every batch would go
    // back to being dropped, with no test and no symptom to notice it by.
    assert.equal(
      chatFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }).modality,
      CONTEXTUAL_CUE_GENSTUDIO_MODALITY,
      'callAi failures arrive as GenStudioChatTerminalFailureError; its modality is what the guard must be pinned to')
  })

  test('(a) a busy fleet with the credits returned whole is retried, on the fleet ladder', () => {
    const plan = contextualCueFleetBusyRetryPlan(
      chatFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }), 0)
    assert.ok(plan, 'the one failure this generator resubmits')
    assert.equal(plan.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[0])
    assert.equal(plan.reason, 'High demand right now')
    // The whole ladder, in order, and then it stops. Bounded matters: an item
    // must never be silently unreported for longer than the schedule allows.
    for (const [used, expected] of FLEET_BUSY_RETRY_DELAYS_MS.entries()) {
      assert.equal(
        contextualCueFleetBusyRetryPlan(chatFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }), used)?.waitMs,
        expected)
    }
    assert.equal(
      contextualCueFleetBusyRetryPlan(
        chatFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }), FLEET_BUSY_RETRY_DELAYS_MS.length),
      null,
      'the ladder ends; it does not loop forever')
    // A fleet wait is minutes, not the backpressure ladder's seconds. Flattening
    // one into the other would rejoin the same jam and burn the attempt.
    assert.ok(plan.waitMs >= 30_000)
  })

  test('(b) legacy or missing settlement does not decide; the code and the job state do', () => {
    // Story no longer tracks credits — the error's credit fields are null — so
    // a legacy payload's settled/released numbers can neither grant nor deny
    // the plan. Only the failure code, cancellation, modality and the
    // unknown-outcome hold decide.
    const charged = chatFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 23, released_credits: 0,
    })
    assert.equal(charged.settledCredits, null, 'the error publishes no settlement to decide on')
    assert.ok(contextualCueFleetBusyRetryPlan(charged, 0), 'a legacy settled payload does not decide')
    assert.ok(contextualCueFleetBusyRetryPlan(chatFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED',
      reserved_credits: undefined, settled_credits: undefined, released_credits: undefined,
    }), 0), 'missing settlement does not decide either')
  })

  test('(c) an unrelated failure is never retried', () => {
    for (const code of [
      'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
      'CLOUD_PROVIDER_EXHAUSTED',
      'CONTENT_POLICY',
      '',
    ]) {
      assert.equal(contextualCueFleetBusyRetryPlan(chatFailure({ failure_code: code }), 0), null,
        `${code || '(no code)'} may describe work a provider already did and billed`)
    }
    assert.equal(contextualCueFleetBusyRetryPlan(new Error('socket hang up'), 0), null)
  })

  test('(d) a cancelled job is the owner speaking; retrying it would overrule him', () => {
    assert.equal(contextualCueFleetBusyRetryPlan(chatFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', cancelled: true,
    }), 0), null)
  })

  test('(d2) an unknown-outcome hold is never retried', () => {
    // The gateway may still be holding a result that has not landed; a busy
    // code on such a job must not buy a second one.
    assert.equal(contextualCueFleetBusyRetryPlan(chatFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', recovery_state: 'unknown_outcome',
    }), 0), null)
    assert.equal(contextualCueFleetBusyRetryPlan(chatFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', recovery_required: true,
    }), 0), null)
  })

  test('(e) a busy fleet in another modality is not licence for a cue batch', () => {
    // A saturated TTS queue says nothing about whether THIS batch's credits
    // came back, and the chat and TTS ladders are not the same queue.
    const tts = new GenStudioTtsTerminalFailureError(settled({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }))
    assert.notEqual(tts.modality, CONTEXTUAL_CUE_GENSTUDIO_MODALITY)
    assert.equal(contextualCueFleetBusyRetryPlan(tts, 0), null)
  })
})

describe('Contextual Cues: the backpressure ladder is untouched', () => {
  const backpressure = chatFailure({ failure_code: 'LANGUAGE_PROVIDER_BACKPRESSURE' })

  test('(f) provider backpressure still routes to its own ladder, not the fleet one', () => {
    assert.equal(isReleasedContextualCueBackpressure(backpressure), true,
      'still recognised exactly as before')
    assert.equal(contextualCueFleetBusyRetryPlan(backpressure, 0), null,
      'the new guard must not swallow it and hand it a five-minute wait')
    // The classifier answers from the failure code and the job's own state,
    // never from credit settlement: a legacy payload carrying no settlement at
    // all still recognises, and Cancel or an unknown-outcome hold never does.
    assert.equal(isReleasedContextualCueBackpressure(chatFailure({
      failure_code: 'LANGUAGE_PROVIDER_BACKPRESSURE',
      reserved_credits: undefined, settled_credits: undefined, released_credits: undefined,
    })), true, 'missing settlement does not decide backpressure either')
    assert.equal(isReleasedContextualCueBackpressure(chatFailure({
      failure_code: 'LANGUAGE_PROVIDER_BACKPRESSURE', cancelled: true,
    })), false, "the owner's instruction stands")
    assert.equal(isReleasedContextualCueBackpressure(chatFailure({
      failure_code: 'LANGUAGE_PROVIDER_BACKPRESSURE', recovery_state: 'unknown_outcome',
    })), false, 'an unknown-outcome hold is not a released refusal')
  })

  test('the two guards are disjoint, so neither can shadow the other', () => {
    for (const code of ['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE']) {
      const error = chatFailure({ failure_code: code })
      assert.equal(isReleasedContextualCueBackpressure(error), false)
      assert.ok(contextualCueFleetBusyRetryPlan(error, 0))
    }
  })

  test('the backpressure ladder keeps its own budget and its own cooldown', async () => {
    const has = await sourceProbe()
    // Separate counters. One shared counter would let a fleet wait silently eat
    // a backpressure retry — a change to a path that had to stay as it was.
    has('backpressureRetries >= CONTEXTUAL_CUE_BACKPRESSURE_RETRIES',
      'the backpressure ladder must still count only its own retries')
    has('waitWhileActive(job.job_id, CONTEXTUAL_CUE_BACKPRESSURE_COOLDOWN_MS)',
      'and still wait its own fifteen seconds, not a fleet-sized wait')
    has('fleetBusyRetryPlan(error, CONTEXTUAL_CUE_GENSTUDIO_MODALITY, retriesUsed)',
      'while the fleet ladder reads the shared escalating schedule')
  })
})

describe('Contextual Cues: the wait itself', () => {
  test('a fleet retry needs a dead job id, because the next identity is derived from it', async () => {
    // Without one the scope cannot be promoted, and the retry replays a
    // settled-failed idempotency key — which returns the same failure forever.
    const has = await sourceProbe()
    has('fleetBusyPlan && deadJobId && !isCancelled(job.job_id) && !isPauseRequested(job.job_id)',
      'no dead job id means no promotable scope, so no retry')
    has('[String(index)]: deadJobId',
      'the next identity is derived from the job that just died — no clock, no random')
    has("scope-${progress.retry_scopes?.[String(index)] || 'initial'}",
      'and the next submission must actually read that promoted scope')
    // Written to disk from the SAME in-memory object the next attempt reads,
    // so an in-process retry and a crash-replay derive ONE identity, never two.
    has('await writeContextualCueProgress(planPath, progress)\n          fleetBusyRetries++',
      'the promoted scope reaches disk before the retry is counted')
  })

  test('Cancel and Pause are honoured before, during and after the wait', async () => {
    const has = await sourceProbe()
    // During: the wait sleeps in slices and returns on either signal.
    has('if (isCancelled(jobId) || isPauseRequested(jobId)) return',
      'a five-minute wait must notice Cancel or Pause within seconds')
    // After: re-read, because minutes passed and his last word wins.
    const source = await readFile(GENERATOR, 'utf8')
    const afterWait = source.split('await waitForFleetCapacity(job.job_id, fleetBusyPlan.waitMs)')[1] || ''
    assert.ok(
      afterWait.slice(0, 500).includes('if (!isCancelled(job.job_id) && !isPauseRequested(job.job_id))'),
      'the signals must be re-read after the wait, before another job is bought')
  })

  test('nothing external can cancel this generator\'s own wait', async () => {
    // The job queue's stall circuit breaker — which a fleet wait is exactly the
    // thing to trip — has one caller in the app, continuity-render.ts, which
    // had to suppress its own. This generator owns no such timer, and must not
    // grow one without also suppressing it around the wait.
    const source = await readFile(GENERATOR, 'utf8')
    assert.ok(!/pauseJobForStall|setInterval/.test(source),
      'a stall watchdog here would cancel the very wait this fix depends on')
  })
})
