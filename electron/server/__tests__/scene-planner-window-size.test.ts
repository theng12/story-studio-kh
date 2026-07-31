import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveTargetScenesPerWindow } from '../services/scene-planner.js'

/**
 * `resolveTargetScenesPerWindow` used to pick 10-vs-30 scenes/window off a
 * `chatstudio:` model-id prefix — a retired local-model namespace, and a
 * capability guess from a name regardless (AGENTS.md's first rule). It now
 * sizes off the selected product's PUBLISHED context window via
 * `availableInputTokens` (scene-prompt-batching.ts). These pin the new
 * behaviour: explicit 'small'/'full' still override outright; 'auto' reads
 * the live context/output figures instead of the model id.
 */
describe('resolveTargetScenesPerWindow', () => {
  it('honours explicit small/full overrides regardless of context figures', () => {
    assert.equal(resolveTargetScenesPerWindow('small', 1_000_000, 8_000), 10)
    assert.equal(resolveTargetScenesPerWindow('full', 0, undefined), 30)
  })

  it('auto picks the large window for a generously-published context', () => {
    // A typical modern cloud chat product: large context, modest output.
    assert.equal(resolveTargetScenesPerWindow('auto', 200_000, 16_000), 30)
    assert.equal(resolveTargetScenesPerWindow(undefined, 200_000, 16_000), 30)
  })

  it('auto picks the small window for a constrained published context', () => {
    // A small local-scale context window leaves little available input.
    assert.equal(resolveTargetScenesPerWindow('auto', 8_192, 2_048), 10)
  })

  it('auto falls back to the small window when GenStudio published nothing usable', () => {
    // Model-free runs (deterministic-timeline) or a caller that never
    // resolved the live catalog: no context figure to size from at all —
    // note the function no longer takes a model id at all, only the
    // published figures, so there is nothing to name-sniff.
    assert.equal(resolveTargetScenesPerWindow('auto', undefined, undefined), 10)
    assert.equal(resolveTargetScenesPerWindow('auto', 0, 0), 10)
    assert.equal(resolveTargetScenesPerWindow('auto', null, null), 10)
  })
})
