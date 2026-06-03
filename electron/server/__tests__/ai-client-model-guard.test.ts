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

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { callAi } from '../lib/ai-client.js'
import { registry } from '../providers/registry.js'
import { LEGACY_MODEL_ALIASES } from '../models/types.js'

// Register the DeepSeek text provider so the alias-routing test below resolves
// a real provider (self-registration on import). v1.0.248 — kie text was
// removed, and the retired Claude aliases now point at DeepSeek.
before(async () => {
  await import('../providers/text/deepseek.js')
})

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

  // Retired/removed ids are remapped via LEGACY_MODEL_ALIASES before dispatch
  // so saved projects keep working. v1.0.248 — kie text was removed, so the old
  // Claude-via-kie ids now alias to the DeepSeek default. This pins the
  // mechanism deterministically (no network / key dependence): the retired id
  // has no provider of its own, but its alias target resolves to a live,
  // registered provider — which is exactly what callAi normalises to.
  test('retired/removed model ids alias to a live, registered provider', () => {
    const target = LEGACY_MODEL_ALIASES['claude-opus-4-6']
    assert.equal(target, 'deepseek-v4-flash')
    assert.equal(registry.findTextProviderForModel('claude-opus-4-6'), undefined,
      'the raw retired id must NOT resolve — proving the alias is required')
    assert.equal(registry.findTextProviderForModel(target)?.meta.id, 'deepseek',
      'the alias target must resolve to the DeepSeek provider')
    // A former kie chat id also degrades to the working DeepSeek default.
    assert.equal(LEGACY_MODEL_ALIASES['claude-sonnet-4-5-kie'], 'deepseek-v4-flash')
  })
})
