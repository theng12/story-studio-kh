/**
 * Tests for `describeGenStudioSelectionGap` / `genStudioSelectionGapMessage`
 * in `utils/live-genstudio-model-selection.ts` — the "why" behind what
 * `selectLiveGenStudioModel` decided, added so a picker can tell a user
 * their saved product genuinely disappeared instead of staying silent.
 *
 * `selectLiveGenStudioModel` itself already refuses to silently swap a
 * named saved product (covered by `liveGenStudioModelSelection.test.ts`).
 * These tests confirm the richer classification distinguishes:
 *   - a still-live selection (nothing to report)
 *   - an explicit, owner-published legacy-id migration (stays quiet by design)
 *   - a product that still exists but is temporarily unavailable
 *   - a product that has vanished from the catalog entirely — the case that
 *     must be visible, not healed silently.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  describeGenStudioSelectionGap,
  genStudioSelectionGapMessage,
  selectLiveGenStudioModel,
} from '../utils/live-genstudio-model-selection.ts'

const models = [
  { id: 'writer-fast', available: true },
  { id: 'writer-quality', available: true, legacy_ids: ['old-quality'] },
  { id: 'writer-retired', available: false, disabled_reason: 'Paused by the Gateway' },
]

describe('describeGenStudioSelectionGap', () => {
  test('no saved preference is reported as empty, not a gap', () => {
    const gap = describeGenStudioSelectionGap('', models)
    assert.deepEqual(gap, { kind: 'empty' })
    assert.equal(genStudioSelectionGapMessage(gap), null)
  })

  test('a saved-but-still-live selection resolves cleanly with nothing to report', () => {
    const gap = describeGenStudioSelectionGap('writer-fast', models)
    assert.deepEqual(gap, { kind: 'resolved' })
    assert.equal(genStudioSelectionGapMessage(gap), null)
    // And selectLiveGenStudioModel keeps the exact same product — the
    // saved-but-still-live selection is preserved, not re-picked.
    assert.equal(selectLiveGenStudioModel('writer-fast', models)?.id, 'writer-fast')
  })

  test('an explicit legacy-id migration stays a quiet, published alias', () => {
    const gap = describeGenStudioSelectionGap('old-quality', models)
    assert.deepEqual(gap, { kind: 'migrated', from: 'old-quality', to: 'writer-quality' })
    assert.equal(genStudioSelectionGapMessage(gap), null)
  })

  test('a product that still exists but is disabled is "unavailable", saved id kept', () => {
    const gap = describeGenStudioSelectionGap('writer-retired', models)
    assert.deepEqual(gap, {
      kind: 'unavailable',
      savedModelId: 'writer-retired',
      reason: 'Paused by the Gateway',
    })
    const message = genStudioSelectionGapMessage(gap)
    assert.match(message ?? '', /writer-retired/)
    assert.match(message ?? '', /nothing was swapped automatically/)
    // The selector itself never silently swaps to a different product here.
    assert.equal(selectLiveGenStudioModel('writer-retired', models), null)
  })

  test('a saved-but-vanished selection heals visibly — a distinct message, not silence', () => {
    const gap = describeGenStudioSelectionGap('discontinued-model', models)
    assert.deepEqual(gap, { kind: 'vanished', savedModelId: 'discontinued-model' })
    const message = genStudioSelectionGapMessage(gap)
    assert.match(message ?? '', /discontinued-model/)
    assert.match(message ?? '', /was retired — choose a replacement/)
    // Distinct wording from the "still exists but disabled" case above.
    const unavailableMessage = genStudioSelectionGapMessage(
      describeGenStudioSelectionGap('writer-retired', models),
    )
    assert.notEqual(message, unavailableMessage)
    // And selectLiveGenStudioModel still refuses to fabricate a replacement.
    assert.equal(selectLiveGenStudioModel('discontinued-model', models), null)
  })

  test('vision-gated pickers classify a vision-incapable saved model as unavailable, not vanished', () => {
    const visionModels = [
      { id: 'vision-model', available: true, supports_vision: true },
      { id: 'text-only-model', available: true, supports_vision: false },
    ]
    const gap = describeGenStudioSelectionGap('text-only-model', visionModels, true)
    assert.equal(gap.kind, 'unavailable')
  })
})
