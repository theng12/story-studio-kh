/**
 * resolveStepParams (routes/pipeline.ts) no longer bakes a hardcoded
 * external product id ('deepseek-v4-flash') into the introduction-only /
 * metadata step params when a preset omits a model. It's a pure/sync
 * preset→params mapper with no catalog access, so a missing model now
 * passes through as '' instead of a literal — the async run-batch handler
 * resolves the live-catalog default (via resolveDefaultChatModel) right
 * before enqueueing, and generateMetadata does the same for non-batch runs.
 *
 * These tests pin the pure-mapper behavior. They intentionally mirror the
 * shape of the existing (unowned) pipeline-integration.test.ts /
 * pipeline-metadata-format-defaults.test.ts fixtures without duplicating
 * them.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveStepParams } from '../routes/pipeline.js'

const fakePreset = (data: Record<string, unknown>) => ({ id: 'p1', name: 'Test preset', data })

describe('resolveStepParams — no hardcoded model default', () => {
  test('introduction-only with no saved model returns an empty model, not a literal', () => {
    const params = resolveStepParams('introduction-only', 'EP0001', 'Title', fakePreset({ intro: {} }), null)
    assert.equal(params.model, '')
  })

  test('metadata with no saved model returns an empty model, not a literal', () => {
    const params = resolveStepParams('metadata', 'EP0001', 'Title', fakePreset({ sections: [] }), null)
    assert.equal(params.model, '')
  })

  test('an explicit saved model passes through unchanged for both steps', () => {
    const intro = resolveStepParams(
      'introduction-only', 'EP0001', 'Title',
      fakePreset({ intro: {}, model: 'genstudio-chat-current-v1' }), null,
    )
    assert.equal(intro.model, 'genstudio-chat-current-v1')

    const metadata = resolveStepParams(
      'metadata', 'EP0001', 'Title',
      fakePreset({ sections: [], model: 'genstudio-chat-current-v1' }), null,
    )
    assert.equal(metadata.model, 'genstudio-chat-current-v1')
  })

  test('resolveStepParams never throws for either step when the model is missing (batch preview / dry runs)', () => {
    assert.doesNotThrow(() => resolveStepParams('introduction-only', 'EP0001', 'Title', fakePreset({ intro: {} }), null))
    assert.doesNotThrow(() => resolveStepParams('metadata', 'EP0001', 'Title', fakePreset({ sections: [] }), null))
  })
})
