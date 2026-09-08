import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assignedPipelineModel,
  normalizePipelineModelPolicies,
  pipelinePolicyForJob,
  type PipelinePolicyAttemptCheckpoint,
  type PipelinePolicyCheckpointStore,
  validatePipelineModelCatalogue,
} from '../lib/pipeline-model-policy.js'
import { assertPipelineModelRequestCapabilities, executePipelineModelPolicy, isSafePipelineModelAdvance } from '../lib/ai-client.js'
import {
  GENSTUDIO_LANGUAGE_FAILURE_CODES,
  GenStudioChatCapabilityUnavailableError,
  GenStudioChatProductUnavailableError,
  GenStudioChatTerminalFailureError,
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
