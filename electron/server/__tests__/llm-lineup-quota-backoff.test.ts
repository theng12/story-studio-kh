/**
 * A spent free writing allowance (usually daily) must not be re-asked every 60 s all day. Each
 * consecutive quota stop doubles the shared recheck (1, 2, 4 … capped at 30 min); a success resets it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  executePipelineModelPolicy,
  LLM_LINEUP_LOCAL_RECHECK_MS,
  LLM_LINEUP_MAX_RECHECK_MS,
  type LlmLineupWaitingError,
} from '../lib/ai-client.js'
import { GENSTUDIO_LANGUAGE_FAILURE_CODES, GenStudioChatTerminalFailureError } from '../lib/genstudio-client.js'
import type { PipelinePolicyAttemptCheckpoint } from '../lib/pipeline-model-policy.js'

const policy = { mode: 'single' as const, models: ['pool::gemini-free-all'], assigned_model: 'pool::gemini-free-all', wait_for_availability: true as const }
const quota = () => new GenStudioChatTerminalFailureError({
  id: 'q', state: 'failed', failure_code: GENSTUDIO_LANGUAGE_FAILURE_CODES.QUOTA_EXHAUSTED,
  reserved_credits: 0, settled_credits: 0, released_credits: 0,
})

async function waitMs(scope: string, attempt: () => Promise<string>): Promise<number> {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = { read: (k: string) => entries.get(k) ?? null, write: async (k: string, v: PipelinePolicyAttemptCheckpoint) => { entries.set(k, structuredClone(v)) } }
  const before = Date.now()
  const error = await executePipelineModelPolicy(policy, attempt, store, `k-${Math.random()}`, 'in', { availabilityScope: scope })
    .then(() => null, (e: unknown) => e as LlmLineupWaitingError)
  if (!error) return 0
  return Date.parse(error.retryAt) - before
}

test('consecutive quota stops back off and a success resets the recheck', async () => {
  const scope = `backoff-${Date.now()}`
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 2_000, `${actual} ≈ ${expected}`)
  near(await waitMs(scope, async () => { throw quota() }), LLM_LINEUP_LOCAL_RECHECK_MS)
  near(await waitMs(scope, async () => { throw quota() }), 2 * LLM_LINEUP_LOCAL_RECHECK_MS)
  near(await waitMs(scope, async () => { throw quota() }), 4 * LLM_LINEUP_LOCAL_RECHECK_MS)
  for (let i = 0; i < 6; i++) await waitMs(scope, async () => { throw quota() })
  near(await waitMs(scope, async () => { throw quota() }), LLM_LINEUP_MAX_RECHECK_MS)

  assert.equal(await waitMs(scope, async () => 'written'), 0)
  near(await waitMs(scope, async () => { throw quota() }), LLM_LINEUP_LOCAL_RECHECK_MS)
})
