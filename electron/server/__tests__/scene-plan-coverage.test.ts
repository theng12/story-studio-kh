/**
 * v1.0.522 — pins the audio-coverage safeguard (services/scene-planner.ts):
 * "every second of narration must have a scene."
 *
 *   - computePlanCoverage: exact head/internal/tail gap math; float-noise
 *     gaps (≤0.05s) ignored; zero-gap plan → all zeros.
 *   - repairPlanCoverage: internal gaps closed by extending the PRECEDING
 *     scene (starts never move), last scene extended to the real audio end,
 *     ≤2s head pulled to 0, >2s head left alone (intro-skip / gate's job).
 *   - The 2s render-gate threshold (COVERAGE_FAIL_SEC) boundary behavior.
 *
 * Pure imports only — no temp dirs, no env mutation.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  computePlanCoverage,
  inspectScenePlanCoverage,
  repairPlanCoverage,
  COVERAGE_FAIL_SEC,
  COVERAGE_NOISE_SEC,
} from '../services/scene-planner.js'

function scene(id: string, start: number, end: number) {
  return {
    id, start_sec: start, end_sec: end,
    scene_index: 0, transcript_segment: '', visual_prompt: '', approved: true,
  } as any
}

describe('computePlanCoverage', () => {
  test('EP0018-shaped plan: head 0, internal gaps, big tail — exact numbers', () => {
    // audio 100s; scenes cover [0,20] [21,40] [40.5,60] → gaps 1 + 0.5, tail 40
    const cov = computePlanCoverage(
      [scene('a', 0, 20), scene('b', 21, 40), scene('c', 40.5, 60)],
      100,
    )
    assert.equal(cov.headGapSec, 0)
    assert.equal(cov.internalGaps.length, 2)
    assert.deepEqual(cov.internalGaps.map(g => g.afterSceneId), ['a', 'b'])
    assert.ok(Math.abs(cov.internalGapTotalSec - 1.5) < 1e-9)
    assert.ok(Math.abs(cov.tailGapSec - 40) < 1e-9)
    assert.ok(Math.abs(cov.uncoveredTotalSec - 41.5) < 1e-9)
  })

  test('head gap counted from 0 to the first scene start', () => {
    const cov = computePlanCoverage([scene('a', 28, 100)], 100)
    assert.equal(cov.headGapSec, 28)
    assert.equal(cov.tailGapSec, 0)
    assert.equal(cov.uncoveredTotalSec, 28)
  })

  test('float-noise gaps are ignored', () => {
    const cov = computePlanCoverage(
      [scene('a', 0, 50.000001), scene('b', 50.00002, 99.98)],
      100 - 0.03,   // 0.02 + noise tail — under the 0.05 noise floor... tail = 99.97-99.98 <0
    )
    assert.equal(cov.internalGaps.length, 0, 'sub-noise internal gap ignored')
    assert.equal(cov.uncoveredTotalSec, 0)
    assert.ok(COVERAGE_NOISE_SEC === 0.05, 'noise floor pinned')
  })

  test('gap-free contiguous plan reaching the audio end → all zeros', () => {
    const cov = computePlanCoverage(
      [scene('a', 0, 33.3), scene('b', 33.3, 66.6), scene('c', 66.6, 100)],
      100,
    )
    assert.deepEqual(
      [cov.headGapSec, cov.internalGaps.length, cov.tailGapSec, cov.uncoveredTotalSec],
      [0, 0, 0, 0],
    )
  })

  test('empty plan → the whole audio is uncovered (as head)', () => {
    const cov = computePlanCoverage([], 60)
    assert.equal(cov.uncoveredTotalSec, 60)
  })
})

describe('repairPlanCoverage', () => {
  test('closes internal gaps by extending the PREVIOUS scene; starts untouched', () => {
    const { scenes, changes } = repairPlanCoverage(
      [scene('a', 0, 20), scene('b', 21, 40), scene('c', 41.2, 100)],
      100,
    )
    assert.equal(scenes[0]!.end_sec, 21, 'a extended to b.start')
    assert.equal(scenes[1]!.end_sec, 41.2, 'b extended to c.start')
    assert.deepEqual(scenes.map(s => s.start_sec), [0, 21, 41.2], 'no start moved')
    assert.ok(changes.some(c => /Closed 2 gap/.test(c)))
  })

  test('extends the last scene to the real audio end, with the long-hold warning past 30s', () => {
    const small = repairPlanCoverage([scene('a', 0, 99)], 100)
    assert.equal(small.scenes[0]!.end_sec, 100)
    assert.ok(small.changes.some(c => /Extended final scene by 1\.0s/.test(c)))
    assert.ok(!small.changes.some(c => /long hold/.test(c)), 'no warning for a 1s extension')

    const big = repairPlanCoverage([scene('a', 0, 100)], 246.8)
    assert.equal(big.scenes[0]!.end_sec, 246.8)
    assert.ok(big.changes.some(c => /long hold/.test(c)), '146.8s extension warns loudly')
  })

  test('≤2s head pulled to 0; >2s head (intro-skip) left alone', () => {
    const leadIn = repairPlanCoverage([scene('a', 1.4, 100)], 100)
    assert.equal(leadIn.scenes[0]!.start_sec, 0, 'lead-in noise closed')

    const introSkip = repairPlanCoverage([scene('a', 28, 100)], 100)
    assert.equal(introSkip.scenes[0]!.start_sec, 28, 'intentional intro-skip preserved')
  })

  test('input scenes are not mutated', () => {
    const input = [scene('a', 0, 20), scene('b', 25, 90)]
    repairPlanCoverage(input, 100)
    assert.equal(input[0]!.end_sec, 20)
    assert.equal(input[1]!.end_sec, 90)
  })

  test('repaired plan always passes the render gate', () => {
    const messy = [scene('a', 0, 20), scene('b', 21, 40), scene('c', 41.2, 60)]
    const { scenes } = repairPlanCoverage(messy, 1122.9)   // EP0018-scale tail
    const after = computePlanCoverage(scenes, 1122.9)
    assert.equal(after.uncoveredTotalSec, 0)
  })
})

describe('render-gate threshold (COVERAGE_FAIL_SEC)', () => {
  test('pinned at 2s; 2.0 passes, 2.1 fails the > comparison', () => {
    assert.equal(COVERAGE_FAIL_SEC, 2)
    const atLimit = computePlanCoverage([scene('a', 0, 98)], 100)
    assert.ok(!(atLimit.uncoveredTotalSec > COVERAGE_FAIL_SEC), '2.0s total is absorbed, not fatal')
    const overLimit = computePlanCoverage([scene('a', 0, 97.9)], 100)
    assert.ok(overLimit.uncoveredTotalSec > COVERAGE_FAIL_SEC, '2.1s total trips the gate')
  })
})

describe('inspectScenePlanCoverage', () => {
  test('marks internal gaps pending while exempting a branded opening', () => {
    const result = inspectScenePlanCoverage({
      total_duration_sec: 100,
      opening_mode: 'branded-opening',
      scenes: [scene('a', 15, 40), scene('b', 41.5, 70), scene('c', 72, 100)],
    } as any)
    assert.equal(result.authoritative, true)
    assert.equal(result.headCovered, true)
    assert.equal(result.complete, false)
    assert.equal(result.blockingUncoveredSec, 3.5)
    assert.equal(result.coverage?.internalGaps.length, 2)
  })

  test('a contiguous branded-opening plan is complete', () => {
    const result = inspectScenePlanCoverage({
      total_duration_sec: 100,
      opening_mode: 'branded-opening',
      scenes: [scene('a', 15, 55), scene('b', 55, 100)],
    } as any)
    assert.equal(result.complete, true)
    assert.equal(result.blockingUncoveredSec, 0)
  })

  test('from-start plans count a missing head interval', () => {
    const result = inspectScenePlanCoverage({
      total_duration_sec: 100,
      opening_mode: 'from-start',
      scenes: [scene('a', 5, 100)],
    } as any)
    assert.equal(result.headCovered, false)
    assert.equal(result.complete, false)
    assert.equal(result.blockingUncoveredSec, 5)
  })

  test('legacy plans without duration remain backward-compatible', () => {
    const result = inspectScenePlanCoverage({ scenes: [scene('a', 0, 10)] } as any)
    assert.equal(result.authoritative, false)
    assert.equal(result.complete, true)
  })
})
