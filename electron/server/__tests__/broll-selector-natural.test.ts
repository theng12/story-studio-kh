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
