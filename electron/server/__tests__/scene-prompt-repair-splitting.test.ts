/**
 * A SMALL repair set must travel as one request per scene.
 *
 * THE MEASUREMENT (3,544 recorded scene-prompt attempts)
 * -----------------------------------------------------
 * Structured-validation failure rate by request size, DeepSeek V4 Flash — the
 * worst offender in the recorded data:
 *
 *     1 scene    0.0%   (0 failures in 19 attempts)
 *     2 scenes  86.4%
 *     7 scenes  70.0%
 *    20 scenes  28.0%
 *    40 scenes  17.4%
 *
 * The curve runs backwards to intuition: a compact pack of two to seven is the
 * WORST shape a request can take, and a single scene never failed. Repair is
 * precisely where small packs occur — the whole point of repair is to re-ask
 * for the handful of scenes that did not land — and repair attempts are retried
 * against the same deterministic mangling, so one bad remainder becomes a
 * failure loop that spends the entire repair budget without landing a prompt.
 *
 * WHAT MUST NOT REGRESS: a repair set of `MAX_SCENES_PER_SMALL_REPAIR_PACK` or
 * fewer produces N single-scene requests; anything larger keeps normal pack
 * batching so a partial response can never fan a whole episode back out into
 * one paid request per scene.
 *
 * ZERO paid calls — both functions under test are pure.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_SCENES_PER_SMALL_REPAIR_PACK,
  packScenePromptItems,
  scenePromptRepairPackSize,
} from '../generators/scene-plan.js'

/** The grouping a repair path actually performs: pick the repair pack size,
 * then split. Asserting the composition is what makes request COUNTS the
 * subject of the test rather than an implementation detail. */
function repairRequests(sceneIds: readonly string[], packSize: number): string[][] {
  return packScenePromptItems(sceneIds, scenePromptRepairPackSize(sceneIds.length, packSize))
}

function sceneIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `ep0067-scene-${String(index + 1).padStart(4, '0')}`)
}

describe('small scene-prompt repair sets are split one scene per request', () => {
  test('the measured threshold is 7 and is not silently widened', () => {
    assert.equal(MAX_SCENES_PER_SMALL_REPAIR_PACK, 7)
  })

  test('every set from 1 to 7 scenes becomes N single-scene requests', () => {
    for (let count = 1; count <= MAX_SCENES_PER_SMALL_REPAIR_PACK; count++) {
      const ids = sceneIds(count)
      const requests = repairRequests(ids, 40)
      assert.equal(requests.length, count, `${count} missing scene(s) must make ${count} request(s)`)
      assert.ok(requests.every(group => group.length === 1), `${count} missing scene(s) must be sent alone`)
      // Nothing is dropped, duplicated, or reordered by the split.
      assert.deepEqual(requests.flat(), ids)
    }
  })

  test('the 2-scene pack — an 86% failure rate — is never sent as one request', () => {
    assert.deepEqual(
      repairRequests(['scene-a', 'scene-b'], 40),
      [['scene-a'], ['scene-b']],
    )
  })

  test('a larger repair set keeps normal pack batching', () => {
    const ids = sceneIds(8)
    assert.equal(scenePromptRepairPackSize(ids.length, 40), 40)
    assert.deepEqual(repairRequests(ids, 40), [ids])

    // …and still batches rather than fanning out, at real episode scale.
    const big = sceneIds(90)
    const requests = repairRequests(big, 40)
    assert.deepEqual(requests.map(group => group.length), [40, 40, 10])
    assert.deepEqual(requests.flat(), big)
  })

  test('the automatic path (pack size = the outstanding count) splits the same way', () => {
    // The automatic repair loop has no separate batch setting: its pack size is
    // the outstanding set itself, so the threshold is the only thing splitting.
    assert.equal(scenePromptRepairPackSize(7, 7), 1)
    assert.equal(scenePromptRepairPackSize(8, 8), 8)
    assert.equal(repairRequests(sceneIds(7), 7).length, 7)
    assert.equal(repairRequests(sceneIds(8), 8).length, 1)
  })

  test('a non-repair pack size is returned untouched', () => {
    assert.equal(scenePromptRepairPackSize(333, 40), 40)
    assert.equal(scenePromptRepairPackSize(41, 10), 10)
  })
})
