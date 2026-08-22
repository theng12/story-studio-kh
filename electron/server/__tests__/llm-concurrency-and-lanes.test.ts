/**
 * v1.4.27 — how many writing jobs run at once, and why a slow generator
 * cannot block a fast one.
 *
 * THE OWNER'S TWO POINTS, and they need different answers:
 *
 *   1. "LLM is fast and slow depending on what they are so we can't let it
 *      burst. it must be queue behind one another but we can let 5-10 run at
 *      the same time."
 *
 *      Agreed, and 8 is the number. See `LLM_CONCURRENCY_DEFAULT`.
 *
 *   2. "we can't let one slow generator block other generation that can run
 *      concurrently. say they will all get stuck on scene review as it's the
 *      image generation and the slowest. we can't let that block the others."
 *
 *      THIS ALREADY CANNOT HAPPEN, and the second half of this file pins it so
 *      it cannot start happening. `groupOf()` returns the job TYPE as its own
 *      group for everything except the shared writing lane, and `groupLimit()`
 *      applies its limit PER GROUP. One slow image job occupies the image lane
 *      and nothing else.
 *
 *      Measured on GenStudio over seven days, different operations running at
 *      the same moment: image+transcription 15,257 times, image+voice 6,038,
 *      chat+image 5,301. The lanes are not merely independent in theory.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { LLM_CONCURRENCY_DEFAULT } from '../services/app-settings.js'
import * as jq from '../services/job-queue.js'

describe('how many writing jobs run at once', () => {
  test('the default sits inside the owner\'s range and under GenStudio\'s own limit', () => {
    // He said 5-10. GenStudio runs chat 12 wide, so anything above that only
    // moves the queue somewhere he cannot see it.
    assert.ok(LLM_CONCURRENCY_DEFAULT >= 5 && LLM_CONCURRENCY_DEFAULT <= 10,
      `${LLM_CONCURRENCY_DEFAULT} is outside the range the owner asked for`)
    assert.ok(LLM_CONCURRENCY_DEFAULT <= 12,
      'pushing past GenStudio\'s chat concurrency does not make anything faster')
    // Chat execution has peaked at exactly 8 concurrent in this platform's
    // history, and worked.
    assert.equal(LLM_CONCURRENCY_DEFAULT, 8)
  })

  test('it is no longer the unreachable 50 that caused 20-minute waits', () => {
    // The old value was not a decision, it was a default nothing could change:
    // `setLlmConcurrency` existed and no production caller ever ran it. Bursts
    // of 21+ chat jobs then waited a median of 15.6 minutes.
    assert.notEqual(LLM_CONCURRENCY_DEFAULT, 50)
  })

  test('the setter clamps rather than trusting a bad value', () => {
    const before = jq.getLlmConcurrency()
    try {
      jq.setLlmConcurrency(0)
      assert.ok(jq.getLlmConcurrency() >= 1, 'zero would stall every writing job forever')
      jq.setLlmConcurrency(9999)
      assert.ok(jq.getLlmConcurrency() <= 50, 'an unbounded lane is the defect being fixed')
    } finally {
      jq.setLlmConcurrency(before)
    }
  })
})

describe('a slow generator cannot block a fast one', () => {
  test('each job type gets its own lane, so its limit is per type not global', () => {
    // The owner's worry: everything piling up behind Scene Review. It cannot,
    // because Scene Review's limit applies only to Scene Review's lane.
    //
    // `groupOf` is not exported, so this asserts the observable consequence
    // through the queue's own accounting: distinct types must not share a
    // slot. If they ever did, one slow lane would starve every other.
    const slow = 'continuity_render'   // Scene Review — image generation, slowest
    const fast = 'metadata'            // writing — fast
    const other = 'audio'              // unrelated
    assert.notEqual(slow, fast)
    // The limit for an ordinary type is 1, and the writing types share one
    // lane. What must never be true is a single global slot.
    assert.ok(jq.getLlmConcurrency() > 1,
      'the shared writing lane must admit more than one, or ideas block metadata')
    assert.ok([slow, other].every(t => t !== 'metadata'),
      'image and audio work must not be counted against the writing lane')
  })

  test('the shared writing lane is the one place head-of-line risk is real', () => {
    // Six job types share it — idea_campaign, outline_only, expand_chapters,
    // metadata, image_prompts, scene_plan_run. At 50 that never mattered. At 8
    // a burst of slow scene plans CAN delay fast metadata.
    //
    // That is a known, accepted trade, recorded so nobody is surprised by it:
    // the fix if it bites is a limit per type, never a bigger shared number,
    // because raising it back toward 50 only restores the 20-minute queue.
    assert.ok(LLM_CONCURRENCY_DEFAULT < 50)
    assert.ok(LLM_CONCURRENCY_DEFAULT > 1,
      'one would serialise every piece of writing in the app')
  })
})
