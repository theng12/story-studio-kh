/**
 * Tests for the pure helper in services/sfx-autofetch.ts. The fetch/resolve
 * orchestration is network-bound (Freesound) and covered by the resolver tests
 * for the matching half; here we pin the dedupe of empty-cue labels.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { distinctEmptyLabels } from '../services/sfx-autofetch.js'
import { normalizePlan } from '../services/sfx-plan.js'

describe('distinctEmptyLabels', () => {
  test('returns only labels of cues without a clip, de-duplicated case-insensitively', () => {
    const plan = normalizePlan({
      enabled: true,
      beds: [
        { label: 'City Night', start_sec: 0, end_sec: 5 },                       // empty → include
        { label: 'rain', start_sec: 5, end_sec: 9, source: 'pool', clip: 'r.mp3' }, // resolved → skip
      ],
      spots: [
        { label: 'door slam', at_sec: 1 },        // empty → include
        { label: 'Door Slam', at_sec: 4 },        // dup (case) → skip
        { label: '   ', at_sec: 6 },               // blank → skip
        { label: 'whoosh', at_sec: 7, source: 'pool', clip: 'w.mp3' }, // resolved → skip
      ],
    })
    assert.deepEqual(distinctEmptyLabels(plan), ['City Night', 'door slam'])
  })

  test('empty plan → no labels', () => {
    assert.deepEqual(distinctEmptyLabels(normalizePlan({})), [])
  })
})
