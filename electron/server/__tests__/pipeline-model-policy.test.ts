import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assignedPipelineModel,
  normalizePipelineModelPolicies,
  pipelinePolicyForJob,
  rankedPipelineModelCandidates,
  type PipelinePolicyAttemptCheckpoint,
  type PipelinePolicyCheckpointStore,
  validatePipelineModelCatalogue,
} from '../lib/pipeline-model-policy.js'
import { assertPipelineModelRequestCapabilities, executePipelineModelPolicy, isLlmLineupWaitingError, isSafePipelineModelAdvance, llmLineupAvailabilityScope, resolveLivePipelineModel } from '../lib/ai-client.js'
import {
  GENSTUDIO_LANGUAGE_FAILURE_CODES,
  GenStudioChatCapabilityUnavailableError,
  GenStudioChatProductUnavailableError,
  GenStudioChatTerminalFailureError,
  isGenStudioLanguageQuotaExhausted,
  type GenStudioChatModel,
} from '../lib/genstudio-client.js'
import { policyChapterGroups, type OutlineEntry } from '../lib/chunked-narration.js'
import { readScenePolicyRequestPlan } from '../generators/scene-plan.js'

function checkpointStore(entries = new Map<string, PipelinePolicyAttemptCheckpoint>()): PipelinePolicyCheckpointStore {
  return {
    read: key => entries.get(key) ?? null,
    write: async (key, value) => { entries.set(key, structuredClone(value)) },
  }
}

test('Pipeline model policies accept exact products and normalize transport prefixes', () => {
  const policies = normalizePipelineModelPolicies({
    'script-only': { mode: 'single', models: ['genstudio-chat:deepseek-v4-flash'] },
    metadata: { mode: 'backup', models: ['model-a', 'model-b'] },
  })
  assert.deepEqual(policies['script-only'], { mode: 'single', models: ['deepseek-v4-flash'] })
  assert.deepEqual(policies.metadata, { mode: 'backup', models: ['model-a', 'model-b'] })
})

test('Pipeline model policies reject unsupported stages and malformed cardinality', () => {
  assert.throws(() => normalizePipelineModelPolicies({ audio: { mode: 'single', models: ['a'] } }), /does not support/)
  assert.throws(() => normalizePipelineModelPolicies({ metadata: { mode: 'single', models: ['a', 'b'] } }), /exactly one/)
  assert.throws(() => normalizePipelineModelPolicies({ metadata: { mode: 'backup', models: ['a', 'a'] } }), /distinct/)
  assert.throws(() => normalizePipelineModelPolicies({ metadata: { mode: 'distribute', models: [] } }), /non-empty/)
})

test('Stored Pipeline policies are revalidated before a job runs', () => {
  const policy = (value: unknown) => pipelinePolicyForJob({ pipeline_model_policy: { metadata: value } }, 'metadata')
  assert.equal(policy({ mode: 'backup', models: ['primary', 'primary'], assigned_model: 'primary' }), null)
  assert.equal(policy({ mode: 'backup', models: ['primary'], assigned_model: 'primary' }), null)
  assert.equal(policy({ mode: 'single', models: ['primary', 'backup'], assigned_model: 'primary' }), null)
  assert.deepEqual(
    policy({ mode: 'backup', models: ['genstudio-chat:primary', 'backup'], assigned_model: 'genstudio-chat:primary' }),
    { mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary' },
  )
})

test('Pipeline distribution is stable for an episode and independent of queue order', () => {
  const policy = { mode: 'distribute' as const, models: ['model-a', 'model-b', 'model-c'] }
  const first = assignedPipelineModel('metadata', 'EP0042', policy)
  assert.equal(first, assignedPipelineModel('metadata', 'EP0042', policy))
  assert.equal(first, assignedPipelineModel('metadata', 'EP0042', { ...policy, models: [...policy.models] }))
})

test('Pipeline catalogue validation names missing and qualification-only products', () => {
  const policies = normalizePipelineModelPolicies({ metadata: { mode: 'backup', models: ['model-a', 'model-b'] } })
  assert.deepEqual(validatePipelineModelCatalogue(policies, [
    { id: 'model-a', available: true, qualification_only: false },
  ]), ['model_policies.metadata: product "model-b" is not in the live GenStudio catalogue'])
  assert.match(validatePipelineModelCatalogue(policies, [
    { id: 'model-a', available: true, qualification_only: false },
    { id: 'model-b', available: true, qualification_only: true },
  ])[0]!, /qualification-only/)
})

test('A savings lineup resolves renamed products for ranking without rewriting its wire ids', () => {
  const policy = {
    mode: 'backup' as const,
    models: ['paid', 'saved-free-id', 'discounted'],
    assigned_model: 'paid',
    wait_for_availability: true as const,
    prefer_savings: true as const,
  }
  const ordered = rankedPipelineModelCandidates(policy, [
    { id: 'paid', input_credits_per_million_tokens: 1, output_credits_per_million_tokens: 1, minimum_credits: 0 },
    { id: 'renamed-free', legacy_ids: ['saved-free-id'], input_credits_per_million_tokens: 0, output_credits_per_million_tokens: 0, minimum_credits: 0 },
    { id: 'discounted', input_credits_per_million_tokens: 1, output_credits_per_million_tokens: 1, minimum_credits: 0, discount: true },
  ])
  assert.deepEqual(ordered, ['saved-free-id', 'discounted', 'paid'])
})

test('A depleted free lineup candidate advances to the selected paid candidate before submission', async () => {
  const policy = {
    mode: 'backup' as const, models: ['paid', 'free'], assigned_model: 'paid',
    wait_for_availability: true as const, prefer_savings: true as const,
  }
  const candidates = rankedPipelineModelCandidates(policy, [
    { id: 'paid', input_credits_per_million_tokens: 1, output_credits_per_million_tokens: 1, minimum_credits: 0 },
    { id: 'free', input_credits_per_million_tokens: 0, output_credits_per_million_tokens: 0, minimum_credits: 0 },
  ])
  const seen: string[] = []
  const result = await executePipelineModelPolicy(policy, async model => {
    seen.push(model)
    if (model === 'free') throw new GenStudioChatProductUnavailableError(model, { reason: 'daily_quota_depleted' })
    return 'paid result'
  }, checkpointStore(), 'lineup:free-then-paid', 'same-input', { candidates })
  assert.equal(result, 'paid result')
  assert.deepEqual(seen, ['free', 'paid'])
})

test('A published rate promotion ranks ahead of an undiscounted paid lineup model', () => {
  const policy = {
    mode: 'backup' as const, models: ['regular', 'promotion'], assigned_model: 'regular',
    prefer_savings: true as const,
  }
  assert.deepEqual(rankedPipelineModelCandidates(policy, [
    { id: 'regular', input_credits_per_million_tokens: 4, output_credits_per_million_tokens: 4, minimum_credits: 2 },
    {
      id: 'promotion', input_credits_per_million_tokens: 3, output_credits_per_million_tokens: 3, minimum_credits: 1,
      standard_input_credits_per_million_tokens: 4, standard_output_credits_per_million_tokens: 4,
      standard_minimum_credits: 2,
    },
  ]), ['promotion', 'regular'])
})

test('Pipeline backup safety requires a typed zero-settlement terminal failure', () => {
  assert.equal(isSafePipelineModelAdvance(new Error('timeout')), false)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatCapabilityUnavailableError('chat-1', 'structured output is unavailable')), true)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-1', state: 'failed', reserved_credits: 10, settled_credits: 0, released_credits: 10,
  })), true)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-2', state: 'failed', reserved_credits: 10, settled_credits: null, released_credits: null,
  })), false)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-cancelled', state: 'failed', cancelled: true, reserved_credits: 10, settled_credits: 0, released_credits: 10,
  })), false)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-uncertain', state: 'failed', failure_code: GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN,
    reserved_credits: 10, settled_credits: 0, released_credits: 10,
  })), false)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-charged', state: 'failed', reserved_credits: 10, settled_credits: 1, released_credits: 9,
  })), false)
})

test('Pipeline capability guard advances only for the exact structured request requirements', () => {
  const candidate = {
    id: 'candidate', available: true, max_output_tokens: 8_192,
    structured_output_mode: 'json_object', supports_structured_output: true, supports_vision: false, max_input_images: 0,
  } as GenStudioChatModel
  assert.doesNotThrow(() => assertPipelineModelRequestCapabilities(candidate, {
    outputContract: { mode: 'json_object' }, outputBudget: 'long',
  }))
  assert.doesNotThrow(() => assertPipelineModelRequestCapabilities(candidate, {
    outputContract: { mode: 'json_schema', name: 'fixture', schema: { type: 'object' } }, outputBudget: 'long',
  }))
  assert.throws(() => assertPipelineModelRequestCapabilities(candidate, {
    maxTokens: 8_193,
  }), GenStudioChatCapabilityUnavailableError)
  assert.doesNotThrow(() => assertPipelineModelRequestCapabilities(candidate, {
    outputContract: { mode: 'prose' }, outputBudget: 'short',
  }))
})

test('a candidate publishing no output ceiling is usable, and a published one keeps its teeth', () => {
  // Owner decision #6, 2026-09-20. This guard used to compare EVERY request
  // against `candidate.max_output_tokens`, so the catalogue parser's `0` ("not
  // published") made every request look oversized and the four shipped
  // `max_output_tokens: null` products were refused before anything was
  // submitted. They are usable now, because the request carries no ceiling.
  const unpublished = {
    id: 'unpublished-ceiling', available: true, max_output_tokens: 0,
    structured_output_mode: 'json_object', supports_structured_output: true,
    supports_vision: false, max_input_images: 0,
  } as GenStudioChatModel

  assert.doesNotThrow(() => assertPipelineModelRequestCapabilities(unpublished, {
    outputContract: { mode: 'json_object' }, outputBudget: 'long',
  }))
  assert.doesNotThrow(() => assertPipelineModelRequestCapabilities(unpublished, {
    outputContract: { mode: 'prose' },
  }))
  // A named allowance is the CALLER's own ceiling, not a claim about the
  // product, so it is still submitted.
  assert.doesNotThrow(() => assertPipelineModelRequestCapabilities(unpublished, { maxTokens: 4_096 }))
  // But a malformed named allowance is still refused — "the product published
  // nothing" and "this number is unusable" must not collapse together.
  assert.throws(
    () => assertPipelineModelRequestCapabilities(unpublished, { maxTokens: 1.5 }),
    GenStudioChatCapabilityUnavailableError,
  )

  const published = { ...unpublished, max_output_tokens: 8_192 } as GenStudioChatModel
  assert.doesNotThrow(() => assertPipelineModelRequestCapabilities(published, { outputBudget: 'maximum' }))
  assert.throws(
    () => assertPipelineModelRequestCapabilities(published, { maxTokens: 8_193 }),
    GenStudioChatCapabilityUnavailableError,
  )
})

test('Pipeline backup advances once after a proven pre-submit refusal and stays bounded', async () => {
  const seen: string[] = []
  const store = checkpointStore()
  const result = await executePipelineModelPolicy({
    mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary',
  }, async model => {
    seen.push(model)
    if (model === 'primary') throw new GenStudioChatProductUnavailableError(model)
    return 'ok'
  }, store, 'metadata:EP0001', 'request-fingerprint')
  assert.equal(result, 'ok')
  assert.deepEqual(seen, ['primary', 'backup'])
})

test('Pipeline backup refuses an in-memory candidate loop before any provider attempt', async () => {
  await assert.rejects(
    executePipelineModelPolicy({ mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary' }, async () => 'unsafe'),
    /durable checkpoint/i,
  )
})

test('A durable Pipeline checkpoint always requires an input fingerprint', async () => {
  let calls = 0
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
    async () => { calls++; return 'unsafe' },
    checkpointStore(), 'metadata:EP0001',
  ), /checkpoint requires an input fingerprint/)
  assert.equal(calls, 0)
})

test('An unaccepted response loss remains readable and retries the same candidate', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'backup' as const, models: ['primary', 'backup'], assigned_model: 'primary' }
  await assert.rejects(executePipelineModelPolicy(
    policy,
    async () => { throw new Error('network response lost before acceptance') },
    store, 'metadata:EP0000', 'same-input',
  ), /response lost/)
  assert.equal(entries.get('metadata:EP0000')?.status, 'unknown')
  assert.equal(entries.get('metadata:EP0000')?.idempotency_key, undefined)
  const seen: string[] = []
  await executePipelineModelPolicy(
    policy,
    async model => { seen.push(model); return 'same-candidate retry' },
    store, 'metadata:EP0000', 'same-input',
  )
  assert.deepEqual(seen, ['primary'])
})

test('A prepared key survives a response loss and catalog-budget change without switching candidates', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'backup' as const, models: ['primary', 'backup'], assigned_model: 'primary' }
  await assert.rejects(executePipelineModelPolicy(
    policy,
    async (_model, _recovery, _accepted, prepared) => {
      await prepared?.('prepared-primary-key')
      throw new Error('response lost after POST')
    },
    store, 'metadata:prepared', 'same-logical-input',
  ), /response lost/)
  assert.equal(entries.get('metadata:prepared')?.status, 'unknown')
  assert.equal(entries.get('metadata:prepared')?.idempotency_key, 'prepared-primary-key')
  const recovered: Array<{ model: string; idempotencyKey?: string }> = []
  await executePipelineModelPolicy(
    policy,
    async (model, recovery) => {
      recovered.push({ model, idempotencyKey: recovery?.idempotencyKey })
      return 'read-only recovery'
    },
    store, 'metadata:prepared', 'same-logical-input',
  )
  assert.deepEqual(recovered, [{ model: 'primary', idempotencyKey: 'prepared-primary-key' }])
})

test('Chunked policy restart retains an accepted chapter range when today\'s batch size changes', () => {
  const outline = Array.from({ length: 6 }, (_, index) => ({ n: index + 1, title: `Chapter ${index + 1}` })) as OutlineEntry[]
  const job = {
    params: {
      pipeline_model_policy: { mode: 'backup', models: ['primary', 'backup'] },
      pipeline_script_chapter_groups: [[1, 2, 3], [4, 5, 6]],
    },
  } as any
  // Chapters 1 and 5 already reached disk. A new one-chapter live batch
  // limit must not turn the unresolved old 1–3 / 4–6 submissions into new
  // 2–2 / 3–3 / 4–4 requests with different checkpoint identities.
  const resumed = policyChapterGroups(job, 'narrative', outline, [outline[1]!, outline[2]!, outline[3]!], 1)
  assert.deepEqual(resumed?.map(group => group.map(entry => entry.n)), [[1, 2, 3], [4, 5, 6]])
})

test('Scene Plan accepts only a complete persisted request shape for saved-key recovery', () => {
  const saved = {
    model_id: 'primary', context_window_tokens: 128_000, max_output_tokens: 32_768,
    visual_max_tokens: 16_384, active_output_budget: 16_384, prompt_pack_size: 4,
  }
  assert.deepEqual(readScenePolicyRequestPlan(saved), saved)
  assert.equal(readScenePolicyRequestPlan({ ...saved, prompt_pack_size: 0 }), null)
  assert.equal(readScenePolicyRequestPlan({ ...saved, model_id: '' }), null)
})

test('Pipeline backup resumes at the ordered next candidate after a durable uncharged primary failure', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['metadata:EP0002', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'primary',
    status: 'failed_unaccepted', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const seen: string[] = []
  const result = await executePipelineModelPolicy(
    { mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary' },
    async model => { seen.push(model); return 'recovered' },
    checkpointStore(entries), 'metadata:EP0002', 'same-input',
  )
  assert.equal(result, 'recovered')
  assert.deepEqual(seen, ['backup'])
  assert.equal(entries.get('metadata:EP0002')?.status, 'succeeded')
  assert.equal(entries.get('metadata:EP0002')?.candidate_model, 'backup')
})

test('Pipeline backup reattaches an accepted primary after a lost response and never switches candidates', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['scene:EP0003', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'primary',
    status: 'accepted', idempotency_key: 'accepted-primary-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const store = checkpointStore(entries)
  const firstSeen: Array<{ model: string; recovery?: string }> = []
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary' },
    async (model, recovery) => {
      firstSeen.push({ model, recovery: recovery?.idempotencyKey })
      throw new Error('response lost after acceptance')
    }, store, 'scene:EP0003', 'same-input',
  ), /response lost/)
  assert.deepEqual(firstSeen, [{ model: 'primary', recovery: 'accepted-primary-key' }])
  assert.equal(entries.get('scene:EP0003')?.status, 'unknown')

  const secondSeen: Array<{ model: string; recovery?: string }> = []
  const result = await executePipelineModelPolicy(
    { mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary' },
    async (model, recovery) => { secondSeen.push({ model, recovery: recovery?.idempotencyKey }); return 'reattached' },
    store, 'scene:EP0003', 'same-input',
  )
  assert.equal(result, 'reattached')
  assert.deepEqual(secondSeen, [{ model: 'primary', recovery: 'accepted-primary-key' }])
})

test('Pipeline backup checkpoints a newly accepted request before a lost response', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'backup' as const, models: ['primary', 'backup'], assigned_model: 'primary' }
  await assert.rejects(executePipelineModelPolicy(
    policy,
    async (_model, _recovery, accepted) => {
      await accepted?.('new-primary-key')
      throw new Error('response lost after acceptance')
    },
    store, 'research:EP0003', 'same-input',
  ), /response lost/)
  const interrupted = entries.get('research:EP0003')
  assert.equal(interrupted?.status, 'unknown')
  assert.equal(interrupted?.candidate_model, 'primary')
  assert.equal(interrupted?.idempotency_key, 'new-primary-key')
  const seen: Array<{ model: string; recovery?: string }> = []
  await executePipelineModelPolicy(
    policy,
    async (model, recovery) => { seen.push({ model, recovery: recovery?.idempotencyKey }); return 'reattached' },
    store, 'research:EP0003', 'same-input',
  )
  assert.deepEqual(seen, [{ model: 'primary', recovery: 'new-primary-key' }])
})

test('An accepted backup candidate never advances on a later product refusal', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['research:EP0004', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'primary',
    status: 'accepted', idempotency_key: 'accepted-primary-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const seen: string[] = []
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary' },
    async model => { seen.push(model); throw new GenStudioChatProductUnavailableError(model) },
    checkpointStore(entries), 'research:EP0004', 'same-input',
  ), /not available/)
  assert.deepEqual(seen, ['primary'])
  assert.equal(entries.get('research:EP0004')?.status, 'unknown')
  assert.equal(entries.get('research:EP0004')?.idempotency_key, 'accepted-primary-key')
})

test('An accepted candidate advances after its terminal settlement proves zero charge', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['research:EP0006', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'primary',
    status: 'accepted', idempotency_key: 'accepted-primary-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const seen: string[] = []
  const result = await executePipelineModelPolicy(
    { mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary' },
    async model => {
      seen.push(model)
      if (model === 'primary') {
        throw new GenStudioChatTerminalFailureError({
          id: 'accepted-primary', state: 'failed', reserved_credits: 10, settled_credits: 0, released_credits: 10,
        })
      }
      return 'backup result'
    },
    checkpointStore(entries), 'research:EP0006', 'same-input',
  )
  assert.equal(result, 'backup result')
  assert.deepEqual(seen, ['primary', 'backup'])
})

test('An ordinary explicit policy retains an accepted recovery key after a charged terminal failure', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['ordinary:terminal', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'primary',
    status: 'accepted', idempotency_key: 'accepted-primary-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const store = checkpointStore(entries)
  const policy = { mode: 'backup' as const, models: ['primary', 'backup'], assigned_model: 'primary' }
  await assert.rejects(executePipelineModelPolicy(policy, async () => {
    throw new GenStudioChatTerminalFailureError({ id: 'primary', state: 'failed', reserved_credits: 10, settled_credits: 1, released_credits: 9 })
  }, store, 'ordinary:terminal', 'same-input'))
  assert.equal(entries.get('ordinary:terminal')?.status, 'unknown')
  const recovered: string[] = []
  await executePipelineModelPolicy(policy, async (_model, recovery) => {
    recovered.push(recovery?.idempotencyKey || '')
    return 'legacy recovery'
  }, store, 'ordinary:terminal', 'same-input')
  assert.deepEqual(recovered, ['accepted-primary-key'])
})

test('Pipeline policy rejects a malformed durable binding before attempting any candidate', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['metadata:EP0005', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'backup',
    status: 'in_flight', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  let calls = 0
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'backup', models: ['primary', 'backup'], assigned_model: 'primary' },
    async () => { calls++; return 'unsafe' },
    checkpointStore(entries), 'metadata:EP0005', 'same-input',
  ), /checkpoint is invalid/)
  assert.equal(calls, 0)
})

test('Pipeline backup checkpoints exhaustion and never wraps back to its last candidate', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'backup' as const, models: ['primary', 'backup'], assigned_model: 'primary' }
  await assert.rejects(executePipelineModelPolicy(policy, async model => {
    throw new GenStudioChatProductUnavailableError(model)
  }, store, 'cues:EP0004', 'same-input'), /not available/)
  assert.equal(entries.get('cues:EP0004')?.status, 'exhausted')
  let calls = 0
  await assert.rejects(executePipelineModelPolicy(policy, async () => { calls++; return 'unsafe' }, store, 'cues:EP0004', 'same-input'), /Every selected Pipeline backup/)
  assert.equal(calls, 0)
})

test('A shared lineup parks with a durable retry time then safely rechecks every unsubmitted candidate', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = {
    mode: 'backup' as const, models: ['primary', 'backup'], assigned_model: 'primary',
    wait_for_availability: true as const,
  }
  const retryAt = '2026-09-15T00:00:00.000Z'
  const seen: string[] = []
  await assert.rejects(executePipelineModelPolicy(policy, async model => {
    seen.push(model)
    throw new GenStudioChatProductUnavailableError(model, { reason: 'daily_quota_depleted', availableAgainAt: retryAt })
  }, store, 'lineup:wait', 'same-input'), isLlmLineupWaitingError)
  assert.deepEqual(seen, ['primary', 'backup'])
  assert.equal(entries.get('lineup:wait')?.status, 'waiting')
  assert.equal(entries.get('lineup:wait')?.retry_at, retryAt)

  const resumed: string[] = []
  const result = await executePipelineModelPolicy(policy, async model => {
    resumed.push(model)
    return 'rechecked'
  }, store, 'lineup:wait', 'same-input')
  assert.equal(result, 'rechecked')
  assert.deepEqual(resumed, ['primary'])
})

test('A shared lineup clears a fully released terminal key before parking for another candidate', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = {
    mode: 'backup' as const, models: ['primary', 'temporary'], assigned_model: 'primary',
    wait_for_availability: true as const,
  }
  await assert.rejects(executePipelineModelPolicy(policy, async (model, _recovery, accepted) => {
    if (model === 'primary') {
      await accepted?.('released-primary-key')
      throw new GenStudioChatTerminalFailureError({ id: 'primary', state: 'failed', reserved_credits: 10, settled_credits: 0, released_credits: 10 })
    }
    throw new GenStudioChatProductUnavailableError(model, { reason: 'temporary_backpressure', availableAgainAt: '2026-09-15T00:00:00.000Z' })
  }, store, 'lineup:released-then-wait', 'same-input'), isLlmLineupWaitingError)
  const waiting = entries.get('lineup:released-then-wait')
  assert.equal(waiting?.status, 'waiting')
  assert.equal(waiting?.idempotency_key, undefined)
  const recovered: Array<{ model: string; key?: string }> = []
  await executePipelineModelPolicy(policy, async (model, recovery) => {
    recovered.push({ model, key: recovery?.idempotencyKey })
    return 'fresh recheck'
  }, store, 'lineup:released-then-wait', 'same-input')
  assert.deepEqual(recovered, [{ model: 'primary', key: undefined }])
})

test('A fully released published quota exhaustion shares a bounded account/model recheck', async () => {
  const quota = new GenStudioChatTerminalFailureError({
    id: 'quota-job', state: 'failed', failure_code: GENSTUDIO_LANGUAGE_FAILURE_CODES.QUOTA_EXHAUSTED,
    reserved_credits: 10, settled_credits: 0, released_credits: 10,
  })
  assert.equal(isGenStudioLanguageQuotaExhausted(quota), true)
  const policy = { mode: 'single' as const, models: ['quota-model'], assigned_model: 'quota-model', wait_for_availability: true as const }
  const scope = llmLineupAvailabilityScope('first-account-key')
  await assert.rejects(executePipelineModelPolicy(policy, async () => { throw quota }, checkpointStore(), 'lineup:quota', 'same-input', { availabilityScope: scope }), isLlmLineupWaitingError)
  const catalogue = [{ id: 'quota-model', available: true, qualification_only: false }] as GenStudioChatModel[]
  assert.throws(() => resolveLivePipelineModel('quota-model', catalogue, { accountId: scope, shareTemporaryAvailability: true }), GenStudioChatProductUnavailableError)
  assert.doesNotThrow(() => resolveLivePipelineModel('quota-model', catalogue, {
    accountId: llmLineupAvailabilityScope('rotated-account-key'), shareTemporaryAvailability: true,
  }))
})

test('A submitted terminal failure is never replayed as a new candidate identity', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'backup' as const, models: ['primary', 'backup'], assigned_model: 'primary', wait_for_availability: true as const }
  await assert.rejects(executePipelineModelPolicy(policy, async (_model, _recovery, accepted) => {
    await accepted?.('accepted-primary-key')
    throw new GenStudioChatTerminalFailureError({
      id: 'primary', state: 'failed', reserved_credits: 10, settled_credits: 1, released_credits: 9,
    })
  }, store, 'terminal:key', 'same-input'))
  assert.equal(entries.get('terminal:key')?.status, 'failed_terminal')
  let calls = 0
  await assert.rejects(executePipelineModelPolicy(policy, async () => { calls++; return 'unsafe' }, store, 'terminal:key', 'same-input'), /terminal failure/)
  assert.equal(calls, 0)
})

test('Temporary availability sharing stays within one account and never invents a shared quota pool', () => {
  const catalogue = [{
    id: 'live-product', legacy_ids: ['saved-product'], available: false, qualification_only: false,
    availability_reason: 'daily_quota_depleted' as const, available_again_at: null,
  }] as GenStudioChatModel[]
  const originalNow = Date.now
  try {
    Date.now = () => 1_000
    assert.throws(() => resolveLivePipelineModel('saved-product', catalogue, { accountId: 'account-a', shareTemporaryAvailability: true }), (error: unknown) => {
      return error instanceof GenStudioChatProductUnavailableError && error.availableAgainAt === '1970-01-01T00:01:01.000Z'
    })
    Date.now = () => 2_000
    assert.throws(() => resolveLivePipelineModel('saved-product', catalogue, { accountId: 'account-b', shareTemporaryAvailability: true }), (error: unknown) => {
      return error instanceof GenStudioChatProductUnavailableError && error.availableAgainAt === '1970-01-01T00:01:02.000Z'
    })
    Date.now = () => 3_000
    assert.throws(() => resolveLivePipelineModel('saved-product', catalogue, { accountId: 'account-a', shareTemporaryAvailability: true }), (error: unknown) => {
      return error instanceof GenStudioChatProductUnavailableError && error.availableAgainAt === '1970-01-01T00:01:01.000Z'
    })
  } finally {
    Date.now = originalNow
  }
})

test('Live availability uses only future published resets and bounds stale catalogue rechecks', () => {
  const staleCatalogue = [{
    id: 'stale-reset', available: false, qualification_only: false,
    availability_reason: 'daily_quota_depleted' as const, available_again_at: '1970-01-01T00:01:30.000Z',
  }] as GenStudioChatModel[]
  const invalidCatalogue = [{
    id: 'invalid-reset', available: false, qualification_only: false,
    availability_reason: 'temporary_backpressure' as const, available_again_at: 'not-a-date',
  }] as GenStudioChatModel[]
  const futureCatalogue = [{
    id: 'future-reset', available: false, qualification_only: false,
    availability_reason: 'daily_quota_depleted' as const, available_again_at: '1970-01-01T00:03:20.000Z',
  }] as GenStudioChatModel[]
  const originalNow = Date.now
  try {
    Date.now = () => 100_000
    for (const [modelId, catalogue] of [['stale-reset', staleCatalogue], ['invalid-reset', invalidCatalogue]] as const) {
      assert.throws(() => resolveLivePipelineModel(modelId, catalogue, { accountId: `catalogue-${modelId}`, shareTemporaryAvailability: true }), (error: unknown) => {
        return error instanceof GenStudioChatProductUnavailableError && error.availableAgainAt === '1970-01-01T00:02:40.000Z'
      })
    }
    assert.throws(() => resolveLivePipelineModel('future-reset', futureCatalogue, { accountId: 'catalogue-future', shareTemporaryAvailability: true }), (error: unknown) => {
      return error instanceof GenStudioChatProductUnavailableError && error.availableAgainAt === '1970-01-01T00:03:20.000Z'
    })
  } finally {
    Date.now = originalNow
  }
})
