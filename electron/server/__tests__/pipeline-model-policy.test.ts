import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pipelinePolicyForJob,
  type PipelinePolicyAttemptCheckpoint,
  type PipelinePolicyCheckpointStore,
} from '../lib/pipeline-model-policy.js'
import { assertPipelineModelRequestCapabilities, executePipelineModelPolicy, isSafePipelineModelAdvance, resolveLivePipelineModel } from '../lib/ai-client.js'
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

test('A stored policy runs only its assigned model; a retired-lineup policy defers to the job model', () => {
  const policy = (value: unknown) => pipelinePolicyForJob({ pipeline_model_policy: { metadata: value } }, 'metadata')
  assert.equal(policy({ mode: 'single', models: ['primary'], assigned_model: 'other' }), null)
  assert.deepEqual(
    policy({ mode: 'single', models: ['genstudio-chat:primary'], assigned_model: 'genstudio-chat:primary' }),
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
  )
  // Queued by an older build with backups: only the model this episode was assigned runs.
  assert.deepEqual(
    policy({ mode: 'backup', models: ['primary', 'backup'], assigned_model: 'backup' }),
    { mode: 'single', models: ['backup'], assigned_model: 'backup' },
  )
  // Queued under the retired lineup: `params.model` already names the one model.
  assert.equal(policy({ mode: 'backup', models: ['a', 'b'], assigned_model: 'a', wait_for_availability: true }), null)
})

test('A safe terminal stop requires a typed failure without cancellation or an uncertain outcome', () => {
  assert.equal(isSafePipelineModelAdvance(new Error('timeout')), false)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatCapabilityUnavailableError('chat-1', 'structured output is unavailable')), true)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-1', state: 'failed', reserved_credits: 10, settled_credits: 0, released_credits: 10,
  })), true)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-2', state: 'failed', reserved_credits: 10, settled_credits: null, released_credits: null,
  })), true)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-cancelled', state: 'failed', cancelled: true, reserved_credits: 10, settled_credits: 0, released_credits: 10,
  })), false)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-uncertain', state: 'failed', failure_code: GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN,
    reserved_credits: 10, settled_credits: 0, released_credits: 10,
  })), false)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-charged', state: 'failed', reserved_credits: 10, settled_credits: 1, released_credits: 9,
  })), true)
  assert.equal(isSafePipelineModelAdvance(new GenStudioChatTerminalFailureError({
    id: 'chat-held', state: 'failed', recovery_required: true,
  })), false)
})

test('Pipeline capability guard checks only the exact structured request requirements', () => {
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

test('A durable Pipeline checkpoint always requires an input fingerprint', async () => {
  let calls = 0
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
    async () => { calls++; return 'unsafe' },
    checkpointStore(), 'metadata:EP0001',
  ), /checkpoint requires an input fingerprint/)
  assert.equal(calls, 0)
})

test('An unaccepted response loss remains readable and retries the same model', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'single' as const, models: ['primary'], assigned_model: 'primary' }
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

test('A prepared key survives a response loss and catalog-budget change', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'single' as const, models: ['primary'], assigned_model: 'primary' }
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
  const resumed = policyChapterGroups(job, 'narrative', outline, [outline[1]!, outline[2]!, outline[3]!],
    [[outline[0]!, outline[1]!, outline[2]!], [outline[3]!, outline[4]!, outline[5]!]])
  assert.deepEqual(resumed?.map(group => group.map(entry => entry.n)), [[1, 2, 3], [4, 5, 6]])
})

test('Scene Plan accepts only a complete persisted request shape for saved-key recovery', () => {
  const saved = {
    model_id: 'primary', context_window_tokens: 128_000, max_output_tokens: 32_768,
    visual_max_tokens: 16_384, active_output_budget: 16_384, prompt_pack_size: 4,
  }
  assert.deepEqual(readScenePolicyRequestPlan(saved), saved)
  assert.deepEqual(readScenePolicyRequestPlan({
    ...saved, max_output_tokens: null, visual_max_tokens: null, active_output_budget: null,
  }), {
    ...saved, max_output_tokens: null, visual_max_tokens: null, active_output_budget: null,
  })
  assert.deepEqual(readScenePolicyRequestPlan({
    ...saved, max_output_tokens: 0, visual_max_tokens: null, active_output_budget: null,
  }), {
    ...saved, max_output_tokens: null, visual_max_tokens: null, active_output_budget: null,
  })
  assert.equal(readScenePolicyRequestPlan({ ...saved, prompt_pack_size: 0 }), null)
  assert.equal(readScenePolicyRequestPlan({ ...saved, model_id: '' }), null)
  for (const value of ['4096', 1.5, -1]) {
    assert.equal(readScenePolicyRequestPlan({ ...saved, max_output_tokens: value }), null)
    assert.equal(readScenePolicyRequestPlan({ ...saved, visual_max_tokens: value }), null)
    assert.equal(readScenePolicyRequestPlan({ ...saved, active_output_budget: value }), null)
  }
  assert.equal(readScenePolicyRequestPlan({ ...saved, visual_max_tokens: 0 }), null)
  assert.equal(readScenePolicyRequestPlan({ ...saved, active_output_budget: 0 }), null)
})

test('A confirmed terminal quota failure lets the next run make a fresh request on the same model', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'single' as const, models: ['pool::gemini-free-all'], assigned_model: 'pool::gemini-free-all' }
  const quota = new GenStudioChatTerminalFailureError({
    id: 'quota-job', state: 'failed', failure_code: GENSTUDIO_LANGUAGE_FAILURE_CODES.QUOTA_EXHAUSTED,
    reserved_credits: 10, settled_credits: 0, released_credits: 10,
  })
  await assert.rejects(executePipelineModelPolicy(policy, async (_model, _recovery, accepted) => {
    await accepted?.('spent-key')
    throw quota
  }, store, 'metadata:EP0002', 'same-input'), (error: unknown) => error === quota)
  assert.equal(entries.get('metadata:EP0002')?.status, 'failed_unaccepted')
  assert.equal(entries.get('metadata:EP0002')?.idempotency_key, undefined)
  const seen: Array<{ model: string; key?: string }> = []
  const result = await executePipelineModelPolicy(policy, async (model, recovery) => {
    seen.push({ model, key: recovery?.idempotencyKey })
    return 'fresh'
  }, store, 'metadata:EP0002', 'same-input')
  assert.equal(result, 'fresh')
  assert.deepEqual(seen, [{ model: 'pool::gemini-free-all', key: undefined }])
  assert.equal(entries.get('metadata:EP0002')?.status, 'succeeded')
})

test('An older build\'s checkpoint that had moved to a backup reconnects on that model, never a new one', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['scene:EP0009', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 1, candidate_model: 'backup',
    status: 'accepted', idempotency_key: 'accepted-backup-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const seen: Array<{ model: string; key?: string }> = []
  await executePipelineModelPolicy(
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
    async (model, recovery) => { seen.push({ model, key: recovery?.idempotencyKey }); return 'reattached' },
    checkpointStore(entries), 'scene:EP0009', 'same-input',
  )
  assert.deepEqual(seen, [{ model: 'backup', key: 'accepted-backup-key' }])
})

test('An accepted request reattaches after a lost response and never switches models', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['scene:EP0003', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'primary',
    status: 'accepted', idempotency_key: 'accepted-primary-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const store = checkpointStore(entries)
  const firstSeen: Array<{ model: string; recovery?: string }> = []
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
    async (model, recovery) => {
      firstSeen.push({ model, recovery: recovery?.idempotencyKey })
      throw new Error('response lost after acceptance')
    }, store, 'scene:EP0003', 'same-input',
  ), /response lost/)
  assert.deepEqual(firstSeen, [{ model: 'primary', recovery: 'accepted-primary-key' }])
  assert.equal(entries.get('scene:EP0003')?.status, 'unknown')

  const secondSeen: Array<{ model: string; recovery?: string }> = []
  const result = await executePipelineModelPolicy(
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
    async (model, recovery) => { secondSeen.push({ model, recovery: recovery?.idempotencyKey }); return 'reattached' },
    store, 'scene:EP0003', 'same-input',
  )
  assert.equal(result, 'reattached')
  assert.deepEqual(secondSeen, [{ model: 'primary', recovery: 'accepted-primary-key' }])
})

test('A newly accepted request is checkpointed before a lost response', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
  const store = checkpointStore(entries)
  const policy = { mode: 'single' as const, models: ['primary'], assigned_model: 'primary' }
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

test('An accepted request keeps its key on a later product refusal', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['research:EP0004', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'primary',
    status: 'accepted', idempotency_key: 'accepted-primary-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const seen: string[] = []
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
    async model => { seen.push(model); throw new GenStudioChatProductUnavailableError(model) },
    checkpointStore(entries), 'research:EP0004', 'same-input',
  ), /isn't available right now/)
  assert.deepEqual(seen, ['primary'])
  assert.equal(entries.get('research:EP0004')?.status, 'unknown')
  assert.equal(entries.get('research:EP0004')?.idempotency_key, 'accepted-primary-key')
})

test('An ordinary explicit policy starts fresh after a terminal failure regardless of legacy settlement', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['ordinary:terminal', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'primary',
    status: 'accepted', idempotency_key: 'accepted-primary-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  const store = checkpointStore(entries)
  const policy = { mode: 'single' as const, models: ['primary'], assigned_model: 'primary' }
  await assert.rejects(executePipelineModelPolicy(policy, async () => {
    throw new GenStudioChatTerminalFailureError({ id: 'primary', state: 'failed', reserved_credits: 10, settled_credits: 1, released_credits: 9 })
  }, store, 'ordinary:terminal', 'same-input'))
  assert.equal(entries.get('ordinary:terminal')?.status, 'failed_unaccepted')
  assert.equal(entries.get('ordinary:terminal')?.idempotency_key, undefined)
  const recovered: string[] = []
  await executePipelineModelPolicy(policy, async (_model, recovery) => {
    recovered.push(recovery?.idempotencyKey || '')
    return 'legacy recovery'
  }, store, 'ordinary:terminal', 'same-input')
  assert.deepEqual(recovered, [''])
})

test('Held and cancelled terminal failures retain their accepted recovery key', async () => {
  for (const flags of [{ recovery_required: true }, { recovery_state: 'unknown_outcome' }, { cancelled: true }]) {
    const entries = new Map<string, PipelinePolicyAttemptCheckpoint>()
    await assert.rejects(executePipelineModelPolicy(
      { mode: 'single', models: ['primary'], assigned_model: 'primary' },
      async (_model, _recovery, accepted) => {
        await accepted?.('held-primary-key')
        throw new GenStudioChatTerminalFailureError({ id: 'held', state: 'failed', ...flags })
      }, checkpointStore(entries), 'held:key', 'same-input',
    ))
    assert.equal(entries.get('held:key')?.status, 'unknown')
    assert.equal(entries.get('held:key')?.idempotency_key, 'held-primary-key')
  }
})

test('Pipeline policy rejects a malformed durable binding before any request', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['metadata:EP0005', {
    input_fingerprint: 'same-input', candidates: ['primary', 'backup'], candidate_index: 0, candidate_model: 'backup',
    status: 'in_flight', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  let calls = 0
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
    async () => { calls++; return 'unsafe' },
    checkpointStore(entries), 'metadata:EP0005', 'same-input',
  ), /checkpoint is invalid/)
  assert.equal(calls, 0)
})

test('A request an older build recorded as a charged terminal failure is never replayed', async () => {
  const entries = new Map<string, PipelinePolicyAttemptCheckpoint>([['terminal:key', {
    input_fingerprint: 'same-input', candidates: ['primary'], candidate_index: 0, candidate_model: 'primary',
    status: 'failed_terminal', idempotency_key: 'accepted-primary-key', updated_at: '2026-09-09T00:00:00.000Z',
  }]])
  let calls = 0
  await assert.rejects(executePipelineModelPolicy(
    { mode: 'single', models: ['primary'], assigned_model: 'primary' },
    async () => { calls++; return 'unsafe' }, checkpointStore(entries), 'terminal:key', 'same-input',
  ), /terminal failure/)
  assert.equal(calls, 0)
})

test('an unavailable catalogue row invents no retry window', () => {
  // `availability_reason` and `available_again_at` described a temporary
  // absence, and no gateway has published either since the old GenStudio was
  // retired — so the cooldown they fed was dead code that read as a working
  // feature. The honest statement is the one asserted here: a row that is simply
  // unavailable carries NO retry time, because nobody stated one.
  const catalogue = [{
    id: 'live-product', legacy_ids: ['saved-product'], available: false, qualification_only: false,
  }] as GenStudioChatModel[]
  assert.throws(
    () => resolveLivePipelineModel('saved-product', catalogue),
    (error: unknown) => error instanceof GenStudioChatProductUnavailableError
      && error.availabilityReason === null
      && error.availableAgainAt === null,
  )
})

test('a catalogue refusal carries the gateway\'s own activation blockers', () => {
  const catalogue = [{
    id: 'locked-product', available: false, qualification_only: false, locked: true,
    activation_blockers: ['No Studio Hub location offering this model is answering.'],
  }] as GenStudioChatModel[]
  assert.throws(
    () => resolveLivePipelineModel('locked-product', catalogue),
    (error: unknown) => error instanceof GenStudioChatProductUnavailableError
      && error.activationBlockers.length === 1
      && /No Studio Hub location offering this model is answering/.test(error.message),
  )
})
