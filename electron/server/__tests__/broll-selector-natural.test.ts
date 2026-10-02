import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { selectBroll } from '../lib/broll-selector.js'

describe('B-Roll natural-duration selection', () => {
  test('uses complete native durations without the rotate pacing cap', () => {
    const result = selectBroll({
      pool: [
        { filename: 'long.mp4', duration: 42, sha256: 'long', tags: [], normalized: true },
      ],
      target_duration: 40,
      selection_mode: 'manual',
      pacing_mode: 'natural',
      seed: 1,
    })

    assert.equal(result.selection.length, 1)
    assert.equal(result.selection[0]?.target_duration, 42)
  })

  test('keeps the existing rotate cap for cadence-based selection', () => {
    const result = selectBroll({
      pool: [
        { filename: 'long.mp4', duration: 42, sha256: 'long', tags: [], normalized: true },
      ],
      target_duration: 14,
      selection_mode: 'manual',
      pacing_mode: 'rotate',
      seed: 1,
    })

    assert.equal(result.selection[0]?.target_duration, 15)
  })
})

describe('B-Roll repeat avoidance relaxes instead of looping a handful of clips', () => {
  const pool = Array.from({ length: 10 }, (_, i) => ({ filename: `c${i}.mp4`, duration: 10, sha256: `s${i}`, tags: [], normalized: true }))

  test('reuses recent clips when the unused ones cannot fill the narration', () => {
    const result = selectBroll({
      pool, target_duration: 60, selection_mode: 'random', pacing_mode: 'natural', seed: 3,
      exclude_shas: pool.slice(0, 8).map(c => c.sha256),
    })
    // Only 2 unused clips (20 s) for 60 s: without the relax this loops c8/c9.
    assert.equal(new Set(result.selection.map(s => s.sha256)).size, result.selection.length)
    assert.ok(result.warnings.some(w => w.includes('reused')))
  })

  test('keeps excluding recent clips when the rest is enough', () => {
    const result = selectBroll({
      pool, target_duration: 30, selection_mode: 'random', pacing_mode: 'natural', seed: 3,
      exclude_shas: pool.slice(0, 5).map(c => c.sha256),
    })
    assert.ok(result.selection.every(s => !pool.slice(0, 5).some(c => c.sha256 === s.sha256)))
    assert.equal(result.warnings.length, 0)
  })
})
