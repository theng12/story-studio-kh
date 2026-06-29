/**
 * Test the pure plan→selection bridge (services/broll-shot-resolver.ts). The
 * search/download half is network-bound (Pexels/Pixabay) and exercised live.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildSelectionFromPlan } from '../services/broll-shot-resolver.js'
import { normalizePlan } from '../services/broll-plan.js'

describe('buildSelectionFromPlan', () => {
  test('maps live beats to ordered entries with per-beat durations + sha', () => {
    const plan = normalizePlan({
      enabled: true,
      beats: [
        { start_sec: 0, end_sec: 4, line: 'a', queries: ['gas'], source: 'pexels', pool_id: 'vp', clip: 'a.mp4', status: 'matched' },
        { start_sec: 4, end_sec: 9, line: 'b', queries: ['rising'], source: 'pixabay', pool_id: 'vp', clip: 'b.mp4', status: 'matched' },
        { start_sec: 9, end_sec: 12, line: 'c', queries: ['why'], status: 'empty' }, // unresolved → excluded
      ],
    })
    const built = buildSelectionFromPlan(plan, { 'a.mp4': 'sha-a', 'b.mp4': 'sha-b' })!
    assert.equal(built.pool_id, 'vp')
    assert.equal(built.selection.length, 2)
    assert.deepEqual(built.selection[0], { filename: 'a.mp4', sha256: 'sha-a', target_duration: 4 })
    assert.deepEqual(built.selection[1], { filename: 'b.mp4', sha256: 'sha-b', target_duration: 5 })
    assert.equal(built.target_duration, 9)
  })

  test('no live beats → null', () => {
    const plan = normalizePlan({ enabled: true, beats: [{ start_sec: 0, end_sec: 4, line: 'a', queries: ['x'] }] })
    assert.equal(buildSelectionFromPlan(plan, {}), null)
  })

  test('only beats from the first live pool are included', () => {
    const plan = normalizePlan({
      enabled: true,
      beats: [
        { start_sec: 0, end_sec: 4, line: 'a', source: 'pexels', pool_id: 'vp1', clip: 'a.mp4', status: 'matched' },
        { start_sec: 4, end_sec: 8, line: 'b', source: 'pexels', pool_id: 'vp2', clip: 'b.mp4', status: 'matched' },
      ],
    })
    const built = buildSelectionFromPlan(plan, { 'a.mp4': 's1', 'b.mp4': 's2' })!
    assert.equal(built.pool_id, 'vp1')
    assert.equal(built.selection.length, 1)
    assert.equal(built.selection[0]!.filename, 'a.mp4')
  })
})
