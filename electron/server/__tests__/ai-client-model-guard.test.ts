/**
 * Regression test for the EP0002 expand-chapters crash:
 *   "Cannot read properties of undefined (reading 'startsWith')"
 *
 * Root cause: OutlineReviewPanel.postExpand() omitted `model` from the
 * expand-chapters request body, so setupChunkedJobContext threaded
 * params.model = undefined into callAi, which crashed inside provider
 * dispatch (provider.supportsModel calls modelId.startsWith(...)).
 *
 * The fix lives at three layers (frontend body shape, setupChunkedJobContext
 * validation, and a final guard inside callAi). This test pins the
 * callAi-layer guard — the single seam that catches the entire class of bug
 * from any caller, present or future.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { callAi } from '../lib/ai-client.js'

describe('callAi — model guard', () => {
  test('rejects undefined model with a clear error (no startsWith crash)', async () => {
    await assert.rejects(
      // @ts-expect-error — deliberately passing undefined to exercise the guard
      callAi(undefined, '', 'hello', { anthropic_api_key: 'k' }, false, {}),
      (e: Error) => {
        // Must NOT be the cryptic provider-dispatch crash.
        assert.doesNotMatch(e.message, /startsWith/i,
          'guard must fire BEFORE provider dispatch — not after')
        // Must be the actionable guard message.
        assert.match(e.message, /model is required/i)
        return true
      },
    )
  })

  test('rejects empty-string model with the same clear error', async () => {
    await assert.rejects(
      callAi('', '', 'hello', { anthropic_api_key: 'k' }, false, {}),
      /model is required/i,
    )
  })

  test('rejects non-string model (number) with the same clear error', async () => {
    await assert.rejects(
      // @ts-expect-error — deliberately passing wrong type to exercise the guard
      callAi(42, '', 'hello', { anthropic_api_key: 'k' }, false, {}),
      /model is required/i,
    )
  })
})
