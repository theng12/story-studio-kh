/**
 * v1.0.468 — image-to-video motion-prompt scale + level resolution.
 *
 * The LLM-calling generators (generateMotionPromptOnly /
 * generateMotionPromptsForScenes) aren't unit-tested here (they require a live
 * model); this covers the pure, user-facing contract: the 1–4 MOTION_SPECS
 * scale and resolveMotionLevel's explicit → project-default → 2 fallback +
 * clamping.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MOTION_SPECS, resolveMotionLevel } from '../services/scene-planner.js'

describe('MOTION_SPECS — motion-intensity scale', () => {
  test('defines exactly levels 1–4, each with label/allow/camera', () => {
    assert.deepEqual(Object.keys(MOTION_SPECS).sort(), ['1', '2', '3', '4'])
    for (const k of [1, 2, 3, 4]) {
      const spec = MOTION_SPECS[k]!
      assert.ok(spec.label && typeof spec.label === 'string', `level ${k} has a label`)
      assert.ok(spec.allow && spec.allow.length > 10, `level ${k} describes allowed motion`)
      assert.ok(spec.camera && spec.camera.length > 5, `level ${k} describes camera feel`)
    }
  })

  test('levels are ordered Still → Gentle → Moderate → Lively', () => {
    assert.equal(MOTION_SPECS[1]!.label, 'Still')
    assert.equal(MOTION_SPECS[2]!.label, 'Gentle')
    assert.equal(MOTION_SPECS[3]!.label, 'Moderate')
    assert.equal(MOTION_SPECS[4]!.label, 'Lively')
  })
})

describe('resolveMotionLevel — explicit → project default → 2', () => {
  test('explicit value wins', () => {
    assert.equal(resolveMotionLevel(3, 1), 3)
    assert.equal(resolveMotionLevel(1, 4), 1)
  })

  test('falls back to project default when explicit is null/undefined', () => {
    assert.equal(resolveMotionLevel(undefined, 3), 3)
    assert.equal(resolveMotionLevel(null, 4), 4)
  })

  test('falls back to 2 (Gentle) when neither is set', () => {
    assert.equal(resolveMotionLevel(undefined, undefined), 2)
    assert.equal(resolveMotionLevel(null, null), 2)
  })

  test('clamps out-of-range finite values into 1–4', () => {
    assert.equal(resolveMotionLevel(0, undefined), 1, '0 clamps up to 1')
    assert.equal(resolveMotionLevel(9, undefined), 4, '9 clamps down to 4')
    assert.equal(resolveMotionLevel(-5, undefined), 1, 'negative clamps up to 1')
  })

  test('rounds fractional levels', () => {
    assert.equal(resolveMotionLevel(2.4, undefined), 2)
    assert.equal(resolveMotionLevel(3.6, undefined), 4)
  })

  test('ignores non-numeric junk and uses the next source', () => {
    assert.equal(resolveMotionLevel(NaN, 3), 3)
    assert.equal(resolveMotionLevel('x' as unknown as number, undefined), 2)
  })
})
