/**
 * v1.0.521 — pins the scene-body ordering contract of buildScenePlayOrder
 * (generators/video.ts), the fix for "scenes rush by / get reused" on
 * scene-plan episodes:
 *
 *   - PLAN-STRICT: plan order, exact per-scene durations, EXACTLY one entry
 *     per scene — even when the narration is 3× the plan total (no reuse).
 *   - Plan-strict ignores shuffle.
 *   - Classic pools keep the legacy cycling behavior (regression guard).
 *
 * Pure imports only — no temp dirs, no env mutation (same pattern as
 * video-encode-argv.test.ts).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildScenePlayOrder } from '../generators/video.js'

const CLIPS = ['/tmp/s1.mp4', '/tmp/s2.mp4', '/tmp/s3.mp4', '/tmp/s4.mp4']
const DURS = [2.5, 6.0, 4.25, 9.3]   // realistic plan windows (EP0017 shape)
const PLAN_TOTAL = DURS.reduce((a, b) => a + b, 0)   // 22.05

function base(overrides: Record<string, any> = {}) {
  return {
    availableClips: CLIPS,
    availableDurations: DURS,
    sceneDuration: 10,
    sceneFillDuration: PLAN_TOTAL,
    durationPerCycle: PLAN_TOTAL,
    shuffle: false,
    planStrict: true,
    ...overrides,
  }
}

describe('buildScenePlayOrder — plan-strict (scene-plan episodes)', () => {
  test('plan order + exact durations + no reuse, even with narration 3× the plan total', () => {
    const { scenePlayOrder } = buildScenePlayOrder(base({
      sceneFillDuration: PLAN_TOTAL * 3,   // narration much longer than plan
    }))
    assert.equal(scenePlayOrder.length, CLIPS.length, 'exactly one entry per scene — no fill/reuse')
    assert.deepEqual(scenePlayOrder.map(c => c.path), CLIPS, 'plan order preserved')
    assert.deepEqual(scenePlayOrder.map(c => c.duration), DURS, 'exact plan windows, no uniform override')
  })

  test('shuffle is ignored in plan-strict mode', () => {
    const { scenePlayOrder } = buildScenePlayOrder(base({
      shuffle: true,
      random: () => 0,   // would visibly reorder if shuffle were honored
    }))
    assert.deepEqual(scenePlayOrder.map(c => c.path), CLIPS, 'order untouched despite shuffle=true')
  })

  test('warns (log line) when plan total and narration window diverge by >2s', () => {
    const short = buildScenePlayOrder(base({ sceneFillDuration: PLAN_TOTAL + 30 }))
    assert.equal(short.logLines.length, 1, 'divergence surfaced')
    assert.match(short.logLines[0]!, /post-audio tail .*covers the remainder/i)
    assert.match(short.logLines[0]!, /NOT repeated/i)

    const exact = buildScenePlayOrder(base({ sceneFillDuration: PLAN_TOTAL + 0.5 }))
    assert.equal(exact.logLines.length, 0, 'near-match stays quiet')
  })
})

describe('buildScenePlayOrder — legacy cycling (classic pools, regression)', () => {
  test('cycles the whole bag to fill the narration window', () => {
    const { scenePlayOrder } = buildScenePlayOrder(base({
      planStrict: false,
      sceneFillDuration: PLAN_TOTAL * 2.5,   // needs ceil(2.5) = 3 cycles
    }))
    assert.equal(scenePlayOrder.length, CLIPS.length * 3, '3 full cycles (legacy reuse intact)')
    assert.deepEqual(scenePlayOrder.slice(0, 4).map(c => c.path), CLIPS, 'first cycle in order')
    assert.deepEqual(scenePlayOrder.slice(4, 8).map(c => c.path), CLIPS, 'second cycle repeats the bag')
  })

  test('shuffle reorders within a cycle when NOT plan-strict', () => {
    const { scenePlayOrder } = buildScenePlayOrder(base({
      planStrict: false,
      shuffle: true,
      random: () => 0,   // deterministic Fisher-Yates: rotates order
    }))
    assert.equal(scenePlayOrder.length, CLIPS.length, 'single cycle')
    assert.notDeepEqual(scenePlayOrder.map(c => c.path), CLIPS, 'shuffle honored in legacy mode')
  })

})
