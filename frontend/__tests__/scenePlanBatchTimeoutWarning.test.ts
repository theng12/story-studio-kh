/**
 * v1.4.78 — the Scene Plan panel says when a batch may outlast the request.
 *
 * THE RULING (2026-08-29): *"raise the timeout default to 30 minutes but also
 * make it a setting i can dial"*, corrected the same day to *"our floor is 25
 * tps, we prefer 50 tps+"*. The warning is the last part of it: dials that can
 * be set to contradict each other need a sentence that says so before the
 * click, and the sum has to be done against the FLOOR, not the preference.
 *
 * WHY IT MATTERS. Token maths decides what a model can RETURN, and the Scene
 * Plan card has advertised that derivation since the 50-scene cap was removed.
 * It answers a different question from "will the answer arrive in time", and
 * the gap between those two is exactly EP0067 — nine packs generated, settled,
 * charged, and unreachable because the socket closed first.
 *
 * WHAT IS PINNED:
 *   - It fires when the arithmetic says so and STAYS QUIET otherwise, and
 *     the arithmetic uses the HARD FLOOR. The shipped default (50 scenes,
 *     300 tokens each, 30 minutes) is quiet (10 min <= 30 min), while an
 *     oversized batch (250 scenes) DOES warn at the 25 tok/s hard floor and
 *     would not at the preferred 50 — so the sentence has to name both
 *     speeds rather than just sounding an alarm.
 *   - The boundary is exact, and equal-to-the-budget is NOT a warning.
 *   - Unanswerable inputs are silent, not alarming.
 *   - It is a sentence, never a refusal: nothing here returns a boolean the
 *     page could disable a button with.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { batchTimeoutWarning } from '../utils/model-token-budget.js'

/** The shipped defaults, all five of them. */
const DEFAULTS = {
  packSize: 50,
  tokensPerScene: 300,
  timeoutMinutes: 30,
  floorTokensPerSecond: 25,
  preferredTokensPerSecond: 50,
}

const OVERSIZED_BATCH = {
  ...DEFAULTS,
  packSize: 250,
}

describe('the batch-versus-timeout warning', () => {
  test('the shipped default of 50 scenes fits at floor speed and stays quiet', () => {
    assert.equal(batchTimeoutWarning(DEFAULTS), '')
  })

  test('an oversized batch (250 scenes) DOES warn, computed against the hard floor', () => {
    // 250 x 300 = 75,000 tokens. At the 25 tok/s floor that is 50 minutes
    // against a 30-minute timeout, so the warning fires — a provider running
    // at the floor is eligible, so a batch that cannot finish at floor speed
    // is a batch that can genuinely be lost.
    const warning = batchTimeoutWarning(OVERSIZED_BATCH)
    assert.notEqual(warning, '')
    assert.match(warning, /slowest acceptable provider speed \(25 tok\/s\)/)
    assert.match(warning, /50 minutes/)
  })

  test('it names the preferred speed so the worst case reads as a worst case', () => {
    // The same batch at his preferred 50 tok/s finishes in 25 minutes, inside
    // the timeout. Saying only the bad half would make the warning read as a
    // prediction of failure, which it is not.
    const warning = batchTimeoutWarning(OVERSIZED_BATCH)
    assert.match(warning, /Faster providers \(50\+ preferred\) will typically complete it/)
    assert.match(warning, /about 25 minutes/)
    assert.match(warning, /Reduce the batch or raise the timeout if you see timeouts\./)
  })

  test('a small enough batch is silent', () => {
    // 30 minutes at 25 tok/s = 45,000 tokens = exactly 150 scenes at 300 each.
    assert.equal(batchTimeoutWarning({ ...DEFAULTS, packSize: 149 }), '')
    assert.equal(
      batchTimeoutWarning({ ...DEFAULTS, packSize: 150 }), '',
      'a batch that fits EXACTLY must not warn — equal is not over',
    )
    assert.notEqual(batchTimeoutWarning({ ...DEFAULTS, packSize: 151 }), '')
  })

  test('the floor is what the sum uses; the preference never moves the boundary', () => {
    const quiet = { ...DEFAULTS, packSize: 150 }
    assert.equal(batchTimeoutWarning(quiet), '')
    // A wildly optimistic preference cannot silence a batch that fails the
    // floor test, and a pessimistic one cannot trip a batch that passes it.
    assert.equal(batchTimeoutWarning({ ...quiet, preferredTokensPerSecond: 5 }), '')
    assert.notEqual(batchTimeoutWarning({ ...OVERSIZED_BATCH, preferredTokensPerSecond: 10_000 }), '')
    // Raising the FLOOR does silence it, because the worst case got faster.
    assert.equal(batchTimeoutWarning({ ...OVERSIZED_BATCH, floorTokensPerSecond: 50 }), '')
  })

  test('each of the other inputs moves the boundary on its own', () => {
    const over = { ...DEFAULTS, packSize: 200 }
    assert.notEqual(batchTimeoutWarning(over), '', 'a bigger batch trips it')
    // Raising the timeout is half the advice the warning itself gives.
    assert.equal(batchTimeoutWarning({ ...over, timeoutMinutes: 45 }), '')
    // A cheaper per-scene reservation means fewer tokens to write.
    assert.equal(batchTimeoutWarning({ ...over, tokensPerScene: 100 }), '')
    // ...and reducing the batch is the other half.
    assert.equal(batchTimeoutWarning({ ...over, packSize: 100 }), '')
  })

  test('a preference that is not faster than the floor is simply not mentioned', () => {
    // He may set them equal, or set the preference lower by mistake. Neither
    // is worth a refusal, but "faster providers (25+ preferred)" alongside a
    // 25 tok/s floor would be a sentence that says nothing.
    for (const preferred of [25, 10, undefined, NaN]) {
      const warning = batchTimeoutWarning({ ...OVERSIZED_BATCH, preferredTokensPerSecond: preferred as number })
      assert.notEqual(warning, '', 'the batch still does not fit at the floor')
      assert.doesNotMatch(warning, /Faster providers/)
      assert.match(warning, /Reduce the batch or raise the timeout/)
    }
  })

  test('it says the numbers it used, so the advice is checkable', () => {
    const warning = batchTimeoutWarning({ ...DEFAULTS, packSize: 1000 })
    assert.match(warning, /1000 scenes/)
    assert.match(warning, /300,000 tokens/)     // 1000 x 300
    assert.match(warning, /200 minutes/)         // 300,000 / 25 / 60
    assert.match(warning, /30-minute timeout/)
  })

  test('it is a warning, never a refusal', () => {
    const warning = batchTimeoutWarning({ ...DEFAULTS, packSize: 5000 })
    assert.equal(typeof warning, 'string')
    assert.match(warning, /may not finish/)
    assert.doesNotMatch(warning, /cannot|not allowed|too large to send/i)
  })

  test('an unanswerable question is silent, not alarming', () => {
    // Every one of these would otherwise divide by zero, or warn forever on a
    // page whose settings fetch failed.
    for (const broken of [
      { floorTokensPerSecond: 0 },
      { floorTokensPerSecond: NaN },
      { floorTokensPerSecond: -25 },
      { timeoutMinutes: 0 },
      { timeoutMinutes: NaN },
      { packSize: 0 },
      { tokensPerScene: 0 },
    ]) {
      assert.equal(
        batchTimeoutWarning({ ...DEFAULTS, ...broken }), '',
        `${JSON.stringify(broken)} must be silent`,
      )
    }
  })
})

describe('the Scene Plan page wires it up', () => {
  const scenePlan = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
    'utf8',
  )

  test('the panel renders the warning and reads both numbers from the backend', () => {
    assert.match(scenePlan, /promptBatchTimeoutWarning/)
    assert.match(scenePlan, /v-if="promptBatchTimeoutWarning"/)
    assert.match(scenePlan, /genstudio_language_timeout_minutes/)
    assert.match(scenePlan, /language_floor_tokens_per_second/)
    assert.match(scenePlan, /language_preferred_tokens_per_second/)
    // Derived, not duplicated: the arithmetic is the shared helper's.
    assert.match(scenePlan, /batchTimeoutWarning\(\{/)
  })

  test('no copy on the page states a fixed request timeout any more', () => {
    // The help text under Advanced batch controls said "a request has 20
    // minutes to come back" — true when it was written, a lie the moment the
    // number became a dial. It interpolates the live value now.
    assert.doesNotMatch(scenePlan, /20 minutes to come back/)
    assert.match(scenePlan, /\{\{ languageTimeoutMinutes \}\} minutes to come back/)
  })
})
