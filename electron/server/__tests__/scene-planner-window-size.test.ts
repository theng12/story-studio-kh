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
    // A small local-scale context window leaves little available input — and
    // since 2026-09-26 the OUTPUT ceiling is read too, which here binds tighter
    // still: 2,048 output tokens carries ~5 scenes of plan JSON, so 5 is the
    // honest window rather than 10. More, smaller calls is the safe direction.
    assert.equal(resolveTargetScenesPerWindow('auto', 8_192, 2_048), 5)
  })

  it('auto falls back to the small window when the Gateway published nothing usable', () => {
    // Model-free runs (deterministic-timeline) or a caller that never
    // resolved the live catalog: no context figure to size from at all —
    // note the function no longer takes a model id at all, only the
    // published figures, so there is nothing to name-sniff.
    assert.equal(resolveTargetScenesPerWindow('auto', undefined, undefined), 10)
    assert.equal(resolveTargetScenesPerWindow('auto', 0, 0), 10)
    assert.equal(resolveTargetScenesPerWindow('auto', null, null), 10)
  })

  it('auto respects the published OUTPUT ceiling, because one window is one response', () => {
    // Measured on a Studio Hub lane, 2026-09-26: 262,144 tokens of context and
    // only 4,096 of output. The input figure alone says "large window", while
    // one JSON response can carry ~10 scenes of it — asking for 30 is how a
    // plan comes back truncated mid-JSON.
    assert.equal(resolveTargetScenesPerWindow('auto', 262_144, 4_096), 10)
  })

  it('a ceiling that can carry the full window leaves the input-based answer alone', () => {
    // The same context, a ceiling that is not the binding constraint.
    assert.equal(resolveTargetScenesPerWindow('auto', 262_144, 65_536), 30)
    // An unpublished OUTPUT ceiling is not a licence to assume a large input
    // budget: `availableInputTokens` returns 0 for it (pre-existing rule), so
    // the safer small window stands. The new cap changes nothing here.
    assert.equal(resolveTargetScenesPerWindow('auto', 262_144, undefined), 10)
  })

  it('the output ceiling can only ever SHRINK the window, never widen it', () => {
    // A constrained context stays small even when the product can emit plenty.
    assert.equal(resolveTargetScenesPerWindow('auto', 8_192, 65_536), 10)
  })

  it('explicit full/small still override the output ceiling', () => {
    // The caller named a size; that is a deliberate choice, and the §8
    // completeness audit is what protects a run that chooses too much.
    assert.equal(resolveTargetScenesPerWindow('full', 262_144, 4_096), 30)
    assert.equal(resolveTargetScenesPerWindow('small', 262_144, 65_536), 10)
  })

  it('a published request ceiling narrows auto when it is below the input budget', () => {
    // Gemma-4: 32,768 window, 8,192 answer → 24,576 input budget, but the
    // Gateway admits only 23,000 request tokens, so the smaller window is honest.
    assert.equal(resolveTargetScenesPerWindow('auto', 32_768, 8_192, 23_000), 10)
    // A generous request ceiling leaves the context-derived choice standing.
    assert.equal(resolveTargetScenesPerWindow('auto', 200_000, 16_000, 100_000), 30)
    // Absent = unknown, exactly as before.
    assert.equal(resolveTargetScenesPerWindow('auto', 200_000, 16_000, undefined), 30)
    // Explicit sizes still override every published figure.
    assert.equal(resolveTargetScenesPerWindow('full', 32_768, 8_192, 23_000), 30)
  })
})
