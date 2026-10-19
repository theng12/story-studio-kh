import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
const service = await startMockGenStudioService()
const pm = await import('../services/project-manager.js')
const ideas = await import('../services/idea-manager.js')
const settings = await import('../services/app-settings.js')
const secrets = await import('../services/app-secrets-store.js')
const genstudio = await import('../lib/genstudio-client.js')
await import('../providers/text/genstudio.js')
const { runScenePlanJob, scenePromptRequestIsUnresolved } = await import('../generators/scene-plan.js')
const jq = await import('../services/job-queue.js')
const { resolveEpisodePathsByCode } = await import('../services/utils.js')
const { router, scenePromptAutoRepairParams, scenePromptAutoRepairRecoveries } = await import('../routes/jobs.js')
const { scenePromptPackOutputContract } = await import('../lib/story-output-contracts.js')
const app = express().use(express.json()).use('/api', router)

let sequence = 0

function promptResult(sceneId: string, prompt = `A distinct cinematic prompt for ${sceneId}.`): string {
  return JSON.stringify({ results: [{ scene_id: sceneId, visual_prompt: prompt }] })
}

function promptResponseFormat(sceneIds: string[]) {
  const contract = scenePromptPackOutputContract(sceneIds, 'visual')
  assert.equal(contract.mode, 'json_object')
  return {
    type: 'json_schema',
    json_schema: { name: 'story_scene_prompt_pack', strict: true, schema: (contract as any).schema },
  }
}

async function seedCompletedPromptRequest(key: string, sceneIds: string[], outputText: string): Promise<void> {
  service.queueScenario('chat', { states: ['succeeded'], outputText })
  const response = await fetch(`${service.baseUrl}/v1/chat/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      model_id: 'mock-chat-v1', input: [{ role: 'user', content: 'saved prompt request' }],
      response_format: promptResponseFormat(sceneIds), max_output_tokens: 2_048,
    }),
  })
  assert.equal(response.status, 202)
}

async function fixture(missingCount: number) {
  sequence++
  const project = await pm.createProject({ name: `Paid Prompt Generator ${sequence}`, episode_prefix: 'EP', episode_digits: 4 })
  // 1.4.300 — these tests are about the stop; Off/Warn would write plain prompts instead.
  await pm.updateConfig(project.slug, { safety_checks: { scene_prompts: 'block' } } as any)
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Repair', logline: 'Repair prompts.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'quiet' }], 'test')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${accepted.episode_code}_stitched.srt`)
  await fs.writeFile(stitched, ['1', '00:00:00,000 --> 00:00:01,000', 'Opening.', ''].join('\n'))
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, missing_sections: [], sections: [{ slug: 'full', source_srt: 'full.srt', cues_added: 1 }] }))
  const originalPrompt = 'An already verified archival prompt that must stay byte-identical.'
  const scenes = Array.from({ length: missingCount + 1 }, (_, index) => ({
    id: `scene-${String(index + 1).padStart(4, '0')}`,
    scene_index: index + 1,
    start_sec: index,
    end_sec: index + 1,
    transcript_segment: `Narration ${index + 1}`,
    visual_prompt: index === 0 ? originalPrompt : '',
  }))
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1,
    generated_at: '2026-09-06T00:00:00.000Z',
    timeline_built_at: '2026-09-06T00:00:00.000Z',
    planner_model: 'deterministic-timeline',
    source_stitched_srt: path.basename(stitched),
    total_duration_sec: scenes.length,
    research_used: false,
    planning_stage: 'visual',
    scenes,
  }, null, 2))
  const params = {
    episode_id: accepted.episode_code,
    stage: 'visual',
    model: 'genstudio-chat:mock-chat-v1',
    use_research: false,
    prompt_pack_size: 50,
    regenerate_empty_prompts: true,
    auto_repair_missing_prompts: true,
  }
  return { project, episodeId: accepted.episode_code, planPath, originalPrompt, params }
}

function directJob(f: Awaited<ReturnType<typeof fixture>>, id: string): any {
  return {
    job_id: id,
    project_slug: f.project.slug,
    episode_id: f.episodeId,
    type: 'scene_plan_run',
    title: 'Auto repair scene prompts',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: f.params,
  }
}

function chatSubmissions() {
  return service.submissions.filter(entry => entry.operation === 'chat' && !entry.replay)
}

function queuePromptPackOutputs(sceneIds: string[], packSize: number): void {
  for (let index = 0; index < sceneIds.length; index += packSize) {
    const group = sceneIds.slice(index, index + packSize)
    service.queueScenario('chat', {
      states: ['succeeded'],
      outputText: JSON.stringify({ results: group.map((sceneId, offset) => ({
        scene_id: sceneId,
        visual_prompt: `A distinct cinematic composition for ${sceneId}, subject ${offset + 1}, with unique lighting and location.`,
      })) }),
    })
  }
}

async function withPipelineChatModel<T>(maxOutputTokens: number | null, run: () => Promise<T>): Promise<T> {
  const mock = service as any
  const original = mock.handleCatalog
  mock.handleCatalog = function (pathname: string, incoming: unknown, response: any): boolean {
    if (pathname !== '/v1/chat/models') return original.call(this, pathname, incoming, response)
    const encoded = Buffer.from(JSON.stringify([{
      id: 'mock-chat-v1', display_name: 'Mock Chat', description: 'In-process LLM fixture.',
      available: true, qualification_only: false,
      context_window_tokens: 128_000, max_output_tokens: maxOutputTokens,
      max_structured_items_per_request: 250,
      controls: ['temperature', 'top_p', 'max_output_tokens'], activation_blockers: [],
      supports_structured_output: true, structured_output_mode: 'request_json_schema',
    }]))
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(encoded.length) })
    response.end(encoded)
    return true
  }
  genstudio.clearGenStudioCatalogCache()
  try {
    return await run()
  } finally {
    mock.handleCatalog = original
    genstudio.clearGenStudioCatalogCache()
  }
}

function waitForStatus(jobId: string, statuses: string[]): Promise<any> {
  const current = jq.getJob(jobId)
  if (current && statuses.includes(current.status)) return Promise.resolve(current)
  return new Promise(resolve => {
    const onUpdate = (job: any) => {
      if (job.job_id !== jobId || !statuses.includes(job.status)) return
      jq.jobEvents.off('update', onUpdate)
      // Update events carry the slim stream view; the assertions read the full record.
      resolve(jq.getJob(jobId) ?? job)
    }
    jq.jobEvents.on('update', onUpdate)
  })
}

async function seedTerminalJob(
  f: Awaited<ReturnType<typeof fixture>>,
  jobId: string,
  params: Record<string, unknown> = f.params,
  overrides: Record<string, unknown> = {},
) {
  await fs.writeFile(path.join(temp.dir, 'projects', f.project.slug, 'jobs.json'), JSON.stringify({ jobs: [{
    job_id: jobId,
    project_slug: f.project.slug,
    type: 'scene_plan_run',
    episode_id: f.episodeId,
    title: 'Scene Plan Prompts',
    status: 'error',
    created_at: '2026-09-06T00:00:00.000Z',
    started_at: '2026-09-06T00:00:01.000Z',
    finished_at: '2026-09-06T00:01:00.000Z',
    error: 'Visual prompt generation incomplete.',
    output_lines: [],
    params,
    ...overrides,
  }] }))
  await jq.getJobs(f.project.slug)
}

before(async () => {
  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  genstudio.clearGenStudioCatalogCache()
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await service.close()
  await temp.cleanup()
})

test('Pipeline checkpoints a no-ceiling request as an omission and recovers its saved pack without another paid POST', async () => {
  service.reset()
  await withPipelineChatModel(null, async () => {
    const f = await fixture(8)
    const sceneIds = Array.from({ length: 8 }, (_, index) => `scene-${String(index + 2).padStart(4, '0')}`)
    const outputText = JSON.stringify({ results: sceneIds.map((sceneId, index) => ({
      scene_id: sceneId,
      visual_prompt: `A distinct cinematic composition for ${sceneId}, subject ${index + 1}, with unique lighting and location.`,
    })) })
    service.queueScenario('chat', { states: ['succeeded'], outputText })
    const first = directJob(f, 'pipeline-no-ceiling-first')
    first.params = {
      ...f.params,
      auto_repair_missing_prompts: false,
      pipeline_model_policy: {
        scene_plan: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' },
      },
    }

    await runScenePlanJob(first)

    const savedShape = {
      model_id: 'mock-chat-v1', context_window_tokens: 128_000, max_output_tokens: null,
      visual_max_tokens: null, active_output_budget: null, prompt_pack_size: 50,
    }
    assert.deepEqual(first.params.pipeline_scene_request_plan, savedShape)
    assert.deepEqual((await jq.loadAuthoritativeJob(f.project.slug, first.job_id))?.params.pipeline_scene_request_plan, savedShape)
    assert.equal('max_output_tokens' in (chatSubmissions()[0]!.parsedBody || {}), false)

    const plan = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
    for (const scene of plan.scenes.slice(1)) scene.visual_prompt = ''
    await fs.writeFile(f.planPath, JSON.stringify(plan, null, 2))
    const recoveryKey = chatSubmissions()[0]!.idempotencyKey
    const postsBeforeRetry = service.requests.filter(
      entry => entry.method === 'POST' && entry.path === '/v1/chat/responses',
    ).length
    const retry = directJob(f, 'pipeline-no-ceiling-retry')
    retry.params = {
      ...structuredClone(first.params),
      prompt_max_tokens: 1_024,
      prompt_pack_size: 1,
      scene_prompt_recoveries: [{ idempotency_key: recoveryKey, scene_ids: sceneIds }],
    }
    delete retry.params.pipeline_scene_prompt_pack_sizes

    await runScenePlanJob(retry)

    assert.deepEqual(retry.params.pipeline_scene_request_plan, savedShape)
    assert.equal(service.providerSubmissionCount('chat'), 1, 'saved-key recovery must not create a replacement paid POST')
    assert.equal(
      service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/chat/responses').length,
      postsBeforeRetry,
      'saved-key recovery must issue literally zero replacement POST requests',
    )
    assert.equal(service.requests.filter(entry => entry.method === 'GET' && entry.path.endsWith(`/by-idempotency-key/${recoveryKey}`)).length, 1)
    assert.ok(retry.output_lines.includes('Visual pack output budget: none published; max_output_tokens omitted.'))
  })
})

test('direct and Pipeline no-ceiling requests preserve an explicit allowance and derive 20-scene packs', async () => {
  await withPipelineChatModel(null, async () => {
    for (const pipeline of [false, true]) {
      service.reset()
      const f = await fixture(21)
      const sceneIds = Array.from({ length: 21 }, (_, index) => `scene-${String(index + 2).padStart(4, '0')}`)
      queuePromptPackOutputs(sceneIds, 20)
      const job = directJob(f, `explicit-no-ceiling-${pipeline ? 'pipeline' : 'direct'}`)
      job.params = {
        ...f.params,
        prompt_max_tokens: 8_192,
        auto_repair_missing_prompts: false,
        ...(pipeline ? {
          pipeline_model_policy: {
            scene_plan: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' },
          },
        } : {}),
      }

      await runScenePlanJob(job)

      const submissions = chatSubmissions()
      assert.equal(submissions.length, 2, pipeline ? 'Pipeline pack count' : 'direct pack count')
      assert.deepEqual(submissions.map(entry => (entry.parsedBody as any).max_output_tokens), [8_192, 8_192])
      assert.deepEqual(submissions.map(entry => (
        (entry.parsedBody as any)?.response_format?.json_schema?.schema
          ?.properties?.results?.items?.properties?.scene_id?.enum?.length
      )), [20, 1])
      assert.ok(job.output_lines.some((line: string) => /selected output allowance/i.test(line)))
      assert.ok(job.output_lines.every((line: string) => !/this model can only return/i.test(line)))
      if (pipeline) {
        assert.deepEqual(job.params.pipeline_scene_request_plan, {
          model_id: 'mock-chat-v1', context_window_tokens: 128_000, max_output_tokens: null,
          visual_max_tokens: 8_192, active_output_budget: 8_192, prompt_pack_size: 20,
        })
        assert.equal(job.params.pipeline_scene_prompt_pack_sizes?.visual, 20)
      }
    }
  })
})

test('Pipeline checkpoints the published ceiling separately from an explicit caller ceiling', async () => {
  service.reset()
  await withPipelineChatModel(4_096, async () => {
    const f = await fixture(1)
    service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
    const job = directJob(f, 'pipeline-explicit-ceiling')
    job.params = {
      ...f.params,
      prompt_max_tokens: 2_048,
      pipeline_model_policy: {
        scene_plan: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' },
      },
    }

    await runScenePlanJob(job)

    assert.deepEqual(job.params.pipeline_scene_request_plan, {
      model_id: 'mock-chat-v1', context_window_tokens: 128_000, max_output_tokens: 4_096,
      visual_max_tokens: 2_048, active_output_budget: 2_048, prompt_pack_size: 5,
    })
    assert.equal((chatSubmissions()[0]!.parsedBody as any).max_output_tokens, 2_048)
  })
})

test('Pipeline checkpoints complete rows from a token-truncated pack and repairs only the malformed tail', async () => {
  service.reset()
  const f = await fixture(2)
  const preservedPrompt = 'A complete cinematic prompt returned before the output ceiling.'
  service.queueScenario('chat', {
    states: ['succeeded'],
    finishReason: 'length',
    outputText: '{"results":[{"scene_id":"scene-0002","visual_prompt":"A complete cinematic prompt returned before the output ceiling."},{"scene_id":"scene-0003","visual_prompt":"cut off',
  })
  service.queueScenario('chat', {
    states: ['succeeded'],
    outputText: promptResult('scene-0003', 'A repaired prompt for only the malformed trailing scene.'),
  })
  const job = directJob(f, 'pipeline-truncated-pack-salvage')
  job.params = {
    ...f.params,
    prompt_max_tokens: 4_096,
    regenerate_empty_prompts: false,
    auto_repair_missing_prompts: false,
    pipeline_model_policy: {
      scene_plan: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' },
    },
  }

  await runScenePlanJob(job)

  assert.equal(service.providerSubmissionCount('chat'), 2)
  assert.deepEqual(chatSubmissions().map(entry => (
    (entry.parsedBody as any)?.response_format?.json_schema?.schema
      ?.properties?.results?.items?.properties?.scene_id?.enum
  )), [['scene-0002', 'scene-0003'], ['scene-0003']])
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.equal(saved.scenes[1].visual_prompt, preservedPrompt)
  assert.equal(saved.scenes[2].visual_prompt, 'A repaired prompt for only the malformed trailing scene.')
  assert.equal(job.result?.complete, true)
})

test('Pipeline replaces a salvaged duplicate prompt that the durable audit rejects', async () => {
  service.reset()
  const f = await fixture(1)
  service.queueScenario('chat', {
    states: ['succeeded'],
    finishReason: 'length',
    outputText: `{"results":[{"scene_id":"scene-0002","visual_prompt":${JSON.stringify(f.originalPrompt)}},{"scene_id":"scene-0002","visual_prompt":"cut off`,
  })
  service.queueScenario('chat', {
    states: ['succeeded'],
    outputText: promptResult('scene-0002', 'A distinct replacement for the audit-rejected duplicate.'),
  })
  const job = directJob(f, 'pipeline-truncated-duplicate-repair')
  job.params = {
    ...f.params,
    regenerate_empty_prompts: false,
    auto_repair_missing_prompts: false,
    pipeline_model_policy: {
      scene_plan: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' },
    },
  }

  await runScenePlanJob(job)

  assert.equal(service.providerSubmissionCount('chat'), 2)
  assert.deepEqual(chatSubmissions().map(entry => (
    (entry.parsedBody as any)?.response_format?.json_schema?.schema
      ?.properties?.results?.items?.properties?.scene_id?.enum
  )), [['scene-0002'], ['scene-0002']])
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.equal(saved.scenes[1].visual_prompt, 'A distinct replacement for the audit-rejected duplicate.')
  assert.equal(job.result?.complete, true)
})

test('Pipeline continues settled missing-only repair beyond two passes while durable progress continues', async () => {
  service.reset()
  const f = await fixture(3)
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0003') })
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0004') })
  const job = directJob(f, 'pipeline-improving-repair-passes')
  job.params = {
    ...f.params,
    prompt_max_tokens: 4_096,
    regenerate_empty_prompts: false,
    auto_repair_missing_prompts: false,
    pipeline_model_policy: {
      scene_plan: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' },
    },
  }

  await runScenePlanJob(job)

  assert.deepEqual(chatSubmissions().map(entry => (
    (entry.parsedBody as any)?.response_format?.json_schema?.schema
      ?.properties?.results?.items?.properties?.scene_id?.enum
  )), [
    ['scene-0002', 'scene-0003', 'scene-0004'],
    ['scene-0002'], ['scene-0003'], ['scene-0004'],
    ['scene-0003'], ['scene-0004'],
    ['scene-0004'],
  ])
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.ok(saved.scenes.slice(1).every((scene: any) => scene.visual_prompt.trim()))
})

test('Pipeline stops ordinary missing-only repair after two consecutive settled passes make no durable progress', async () => {
  service.reset()
  const f = await fixture(1)
  for (let index = 0; index < 3; index++) {
    service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  }
  const job = directJob(f, 'pipeline-stalled-repair-passes')
  job.params = {
    ...f.params,
    regenerate_empty_prompts: false,
    auto_repair_missing_prompts: false,
    pipeline_model_policy: {
      scene_plan: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' },
    },
  }

  await assert.rejects(runScenePlanJob(job), /incomplete/i)

  assert.equal(service.providerSubmissionCount('chat'), 3)
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.equal(saved.scenes[1].visual_prompt, '')
  assert.equal(job.result?.complete, false)
})

test('explicit repair fans a large missing tail into single-scene requests and preserves verified prompts', async () => {
  service.reset()
  const f = await fixture(8)
  for (let index = 2; index <= 9; index++) {
    const id = `scene-${String(index).padStart(4, '0')}`
    service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult(id) })
  }

  await runScenePlanJob(directJob(f, 'large-tail'))

  assert.equal(service.providerSubmissionCount('chat'), 8)
  for (const submission of chatSubmissions()) {
    const sceneIds = (submission.parsedBody as any)?.response_format?.json_schema?.schema
      ?.properties?.results?.items?.properties?.scene_id?.enum
    assert.equal(sceneIds?.length, 1, submission.bodyText)
  }
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.ok(saved.scenes.slice(1).every((scene: any) => scene.visual_prompt.trim()))
})

test('the explicit paid repair asks with the caller’s allowance, not a hardcoded 2,048', async () => {
  // `prompt_max_tokens` is the owner's choice, already clamped to what the selected product
  // publishes (`resolveScenePromptTokenBudget`). This path used to clamp that again, to a
  // stage-specific `2_048` of our own — the same shape the owner removed from the motion stage
  // on 2026-09-26 ("we follow the published per-model figure and invent no ceiling"), and the
  // one shape this module forbids: every reduction is reported by `describeScenePromptPackSize`,
  // so a number that changes quietly is the defect. Each request here carries ONE scene
  // (`packScenePromptItems(missing, 1)`), so the cap never protected a pack from truncation.
  //
  // 3,072 is above the old cap and below the mock product's published 4,096, so it is a value
  // only the caller's own allowance can produce.
  service.reset()
  const f = await fixture(2)
  const job = directJob(f, 'paid-repair-budget')
  job.params = { ...f.params, prompt_max_tokens: 3_072 }
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0003') })

  await runScenePlanJob(job)

  const budgets = [...new Set(chatSubmissions().map(entry => (entry.parsedBody as any).max_output_tokens))]
  assert.deepEqual(budgets, [3_072],
    `every paid-repair request carries the caller's allowance: ${JSON.stringify(budgets)}`)
})

test('explicit repair makes one diagnosed repair pass, then stops after a full pass with zero durable progress', async () => {
  service.reset()
  const f = await fixture(1)
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  const job = directJob(f, 'no-progress')

  await assert.rejects(runScenePlanJob(job), /incomplete/i)

  assert.equal(service.providerSubmissionCount('chat'), 2)
  assert.ok(job.output_lines.some((line: string) => /missing count did not improve/i.test(line)))
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.equal(saved.scenes[1].visual_prompt, '')
})

test('a settled structured-output failure receives one missing-only repair request', async () => {
  service.reset()
  const f = await fixture(1)
  service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_STRUCTURED_OUTPUT_INVALID' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })

  await runScenePlanJob(directJob(f, 'settled-invalid'))

  assert.equal(service.providerSubmissionCount('chat'), 2)
  const requested = chatSubmissions().map(entry => (entry.parsedBody as any)?.response_format?.json_schema?.schema
    ?.properties?.results?.items?.properties?.scene_id?.enum)
  assert.deepEqual(requested, [['scene-0002'], ['scene-0002']])
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.match(saved.scenes[1].visual_prompt, /scene-0002/)
})

test('one paid action replays its identity while a later explicit action mints fresh provider work', async () => {
  service.reset()
  const f = await fixture(1)
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  const firstAction = directJob(f, 'paid-action-one')

  await assert.rejects(runScenePlanJob(firstAction), /incomplete/i)
  const firstSubmissions = chatSubmissions()
  assert.equal(firstSubmissions.length, 2)

  await assert.rejects(runScenePlanJob(firstAction), /incomplete/i)
  const firstActionAttempts = service.submissions.filter(entry => entry.operation === 'chat')
  assert.deepEqual(
    firstActionAttempts.slice(2).map(entry => ({ key: entry.idempotencyKey, jobId: entry.jobId, replay: entry.replay })),
    firstSubmissions.map(entry => ({ key: entry.idempotencyKey, jobId: entry.jobId, replay: true })),
  )

  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  await runScenePlanJob(directJob(f, 'paid-action-two'))
  const fresh = chatSubmissions().at(-1)!
  assert.ok(!firstSubmissions.some(entry => entry.idempotencyKey === fresh.idempotencyKey))
  assert.ok(!firstSubmissions.some(entry => entry.jobId === fresh.jobId))
})

test('authorization refusal stops before any later paid scene request', async () => {
  service.reset()
  const restrictedKey = 'gsk_mock_models_without_chat'
  service.registerKey(restrictedKey, ['models:read', 'usage:read'])
  await secrets.setApiKey('genstudio', restrictedKey)
  genstudio.clearGenStudioCatalogCache()
  const f = await fixture(3)
  try {
    await assert.rejects(runScenePlanJob(directJob(f, 'auth-refusal')), /not allowed|scopes|product access/i)
    assert.equal(service.providerSubmissionCount('chat'), 0)
    const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
    assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
    assert.ok(saved.scenes.slice(1).every((scene: any) => scene.visual_prompt === ''))
  } finally {
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    genstudio.clearGenStudioCatalogCache()
  }
})

test('a local checkpoint failure stops before the next paid scene request', async () => {
  service.reset()
  const f = await fixture(2)
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0003') })
  const barrier = service.pauseNextSubmitResponse()
  const running = runScenePlanJob(directJob(f, 'checkpoint-refusal'))

  await barrier.started
  await fs.rm(f.planPath)
  await fs.mkdir(f.planPath)
  barrier.release()

  await assert.rejects(running, /could not save the returned prompt/i)
  assert.equal(service.providerSubmissionCount('chat'), 1)
})

test('an unresolved accepted request fences every later scene and repair request', async () => {
  service.reset()
  const f = await fixture(3)
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })
  // Owner decision 2026-10-12: the lost request is resent once; that resend is lost too.
  service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })
  const job = directJob(f, 'uncertain-request')

  await assert.rejects(runScenePlanJob(job), (error: any) => {
    assert.match(error.message, /incomplete/i)
    assert.match(error.message, /could not confirm whether an earlier prompt request was accepted/i)
    assert.doesNotMatch(error.message, /Automatic Gateway repair is exhausted/i)
    return true
  })

  assert.equal(service.providerSubmissionCount('chat'), 3, 'one fresh resend, never a third request')
  assert.ok(job.output_lines.some((line: string) => /still unresolved/i.test(line)))
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.match(saved.scenes[1].visual_prompt, /scene-0002/)
  assert.ok(saved.scenes.slice(2).every((scene: any) => scene.visual_prompt === ''))
})

test('a lost prompt request is resent once with a fresh identity and the scene prompts complete', async () => {
  service.reset()
  const f = await fixture(2)
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0003') })

  await runScenePlanJob(directJob(f, 'lost-request-resent'))

  const keys = chatSubmissions().map(entry => entry.idempotencyKey)
  assert.equal(keys.length, 3)
  assert.match(keys[2]!, /^story-chat-resend-/)
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.match(saved.scenes[2].visual_prompt, /scene-0003/)
})

test('a normal Scene Plan retry reclaims an ambiguous request before any replacement work', async () => {
  service.reset()
  const f = await fixture(2)
  const params = { ...f.params, auto_repair_missing_prompts: false }
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })
  // Owner decision 2026-10-12: the lost request is resent once; that resend is lost too.
  service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })
  const original = directJob(f, 'normal-uncertain-request')
  original.params = params

  await assert.rejects(runScenePlanJob(original), /could not confirm whether an earlier prompt request was accepted/i)

  assert.equal(original.params.scene_prompt_recoveries?.length, 1)
  assert.deepEqual(original.params.scene_prompt_recoveries[0]?.scene_ids, ['scene-0003'])
  const recoveryKey = original.params.scene_prompt_recoveries[0]?.idempotency_key
  assert.equal(typeof recoveryKey, 'string')
  const retry = directJob(f, 'normal-uncertain-retry')
  retry.params = structuredClone(original.params)

  await assert.rejects(runScenePlanJob(retry), /could not confirm whether an earlier prompt request was accepted/i)

  // The saved identity is the resend, so the retry reclaims it and never sends a third request.
  assert.equal(service.providerSubmissionCount('chat'), 3)
  assert.ok(service.requests.some(entry => entry.method === 'GET' && entry.path.endsWith(`/by-idempotency-key/${recoveryKey}`)))
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.match(saved.scenes[1].visual_prompt, /scene-0002/)
  assert.equal(saved.scenes[2].visual_prompt, '')
})

test('improving passes retry only the durable remainder until every prompt verifies', async () => {
  service.reset()
  const f = await fixture(3)
  for (let index = 0; index < 3; index++) service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0003') })
  service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0004') })

  await runScenePlanJob(directJob(f, 'improving-passes'))

  assert.equal(service.providerSubmissionCount('chat'), 9)
  const requested = chatSubmissions().map(entry => (entry.parsedBody as any)?.response_format?.json_schema?.schema
    ?.properties?.results?.items?.properties?.scene_id?.enum?.[0])
  assert.deepEqual(requested, [
    'scene-0002', 'scene-0003', 'scene-0004',
    'scene-0002', 'scene-0003', 'scene-0004',
    'scene-0003', 'scene-0004',
    'scene-0004',
  ])
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.ok(saved.scenes.slice(1).every((scene: any) => scene.visual_prompt.trim()))
})

test('server-owned retry scope overrides episode identity and strips every wider writer flag', () => {
  const params = scenePromptAutoRepairParams({
    episode_id: 'WRONG', model: 'genstudio-chat:deepseek-v4-flash', pipeline_chain: 'chain-1', prompt_pack_size: 50,
    force: true, prompt_limit: 2, target_scene_count: 200, regenerate_prompt_scene_id: 'scene-2',
    reword_prompt: true, replan_scene_id: 'scene-1', regenerate_motion_prompt_scene_id: 'scene-1',
    regenerate_empty_motion_prompts: true, generate_motion_prompts: true, motion_level: 4,
    planning_mode: 'two-pass', window_size: 'full', cross_window_context: true,
    neighbor_context_back: 3, neighbor_context_forward: 4, skip_intro: true,
    scene_prompt_recoveries: [{ idempotency_key: 'stale-key', scene_ids: ['scene-0002'] }],
  }, 'EP0227')
  assert.deepEqual(params, {
    episode_id: 'EP0227', model: 'genstudio-chat:deepseek-v4-flash', pipeline_chain: 'chain-1', prompt_pack_size: 50,
    neighbor_context_back: 3, neighbor_context_forward: 4,
    stage: 'visual', regenerate_empty_prompts: true, auto_repair_missing_prompts: true,
  })
})

test('HTTP action derives missing scope from disk, rejects client scene IDs, and replaces the exact terminal row once', async () => {
  const f = await fixture(1)
  const pipelineParams: Record<string, unknown> = {
    ...f.params, episode_id: 'WRONG', pipeline_chain: 'chain-1', force: true, prompt_limit: 99,
  }
  delete pipelineParams.stage
  delete pipelineParams.regenerate_empty_prompts
  delete pipelineParams.auto_repair_missing_prompts
  pipelineParams.pipeline_chain = [{ type: 'continuity_render' }]
  await seedTerminalJob(f, 'paid-prompt-route', pipelineParams, {
    content_pack_provenance: [{ pack_id: 'pack.example', version: '1.0.0', archive_sha256: 'abc', item_ids: ['style.example'] }],
  })
  await request(app)
    .post(`/api/projects/${f.project.slug}/jobs/paid-prompt-route/auto-repair-scene-prompts`)
    .send({ scene_ids: ['scene-0001'] })
    .expect(400)
  assert.ok(jq.getJob('paid-prompt-route'))

  const responses = await Promise.all([
    request(app).post(`/api/projects/${f.project.slug}/jobs/paid-prompt-route/auto-repair-scene-prompts`).send({}),
    request(app).post(`/api/projects/${f.project.slug}/jobs/paid-prompt-route/auto-repair-scene-prompts`).send({}),
  ])
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 404])
  const accepted = responses.find(response => response.status === 202)!
  assert.equal(accepted.body.missing_prompts, 1)
  const replacement = jq.getJob(accepted.body.job.job_id)!
  assert.equal(replacement.params.episode_id, f.episodeId)
  assert.equal(replacement.params.model, f.params.model)
  assert.deepEqual(replacement.params.pipeline_chain, [{ type: 'continuity_render' }])
  assert.equal(replacement.params.auto_repair_missing_prompts, true)
  assert.equal('force' in replacement.params, false)
  assert.equal('prompt_limit' in replacement.params, false)
  assert.deepEqual(replacement.content_pack_provenance, [{ pack_id: 'pack.example', version: '1.0.0', archive_sha256: 'abc', item_ids: ['style.example'] }])
  await jq._waitForJobPersistenceForTesting()
})

test('unsettled provider evidence blocks a fresh paid repair identity', async () => {
  service.reset()
  service.queueScenario('chat', { states: ['running', 'running', 'succeeded'] })
  const providerResponse = await fetch(`${service.baseUrl}/v1/chat/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'unsettled-prompt-route-provider',
    },
    body: JSON.stringify({ model_id: 'mock-chat-v1', messages: [] }),
  })
  assert.equal(providerResponse.status, 202)
  const provider = await providerResponse.json() as { id: string }
  const f = await fixture(1)
  await seedTerminalJob(f, 'unsettled-prompt-route', f.params, {
    genstudio_jobs: [{
      id: provider.id, operation: 'chat.response', state: 'running',
      updated_at: '2026-09-06T00:00:30.000Z',
    }],
  })
  const seeded = jq.getJob('unsettled-prompt-route')!
  assert.equal(seeded.genstudio_jobs?.[0]?.state, 'running')
  assert.equal(jq.hasUnsettledProviderEvidence(seeded), true)
  const response = await request(app)
    .post(`/api/projects/${f.project.slug}/jobs/unsettled-prompt-route/auto-repair-scene-prompts`).send({})
    .expect(409)
  assert.match(response.body.detail, /unsettled provider evidence/i)
  assert.ok(jq.getJob('unsettled-prompt-route'))
})

test('provider settlement during the disk audit is re-read into exact recovery before replacement', async () => {
  service.reset()
  const f = await fixture(1)
  const responseFormat = JSON.stringify(promptResponseFormat(['scene-0002']))
  service.queueScenario('chat', { states: ['running', 'running', 'succeeded'] })
  const providerResponse = await fetch(`${service.baseUrl}/v1/chat/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'audit-settlement-key',
    },
    body: JSON.stringify({ model_id: 'mock-chat-v1', messages: [], response_format: JSON.parse(responseFormat) }),
  })
  assert.equal(providerResponse.status, 202)
  const provider = await providerResponse.json() as { id: string }
  await seedTerminalJob(f, 'audit-settlement-route', f.params, {
    genstudio_jobs: [{
      id: provider.id, operation: 'chat.response', state: 'running',
      updated_at: '2026-09-06T00:01:00.000Z',
      request: { method: 'POST', path: '/v1/chat/responses', idempotency_key: 'audit-settlement-key', response_format: responseFormat, captured_at: '2026-09-06T00:00:00.000Z' },
    }],
  })
  // Let the automatic history audit observe the real still-running provider
  // task first. The update below then models a later settlement callback that
  // lands while the route is awaiting its Scene Plan disk read.
  await jq.recheckJobProviderStatus(f.project.slug, 'audit-settlement-route')
  const mutableFs = fs as any
  const readFile = mutableFs.readFile.bind(mutableFs)
  let settled = false
  mutableFs.readFile = async (...args: any[]) => {
    if (!settled && String(args[0]) === f.planPath) {
      settled = true
      await jq.recordGenStudioJob('audit-settlement-route', {
        id: provider.id, operation: 'chat.response', state: 'succeeded',
        updated_at: new Date().toISOString(),
        request: { method: 'POST', path: '/v1/chat/responses', idempotency_key: 'audit-settlement-key', response_format: responseFormat, captured_at: '2026-09-06T00:00:00.000Z' },
      })
    }
    return readFile(...args)
  }
  try {
    const response = await request(app)
      .post(`/api/projects/${f.project.slug}/jobs/audit-settlement-route/auto-repair-scene-prompts`).send({})
      .expect(202)
    assert.deepEqual(response.body.job.params.scene_prompt_recoveries, [{
      idempotency_key: 'audit-settlement-key', scene_ids: ['scene-0002'],
    }])
  } finally {
    mutableFs.readFile = readFile
  }
})

test('terminal submission uncertainty remains blocked even though its provider row is settled', async () => {
  const f = await fixture(1)
  await seedTerminalJob(f, 'uncertain-terminal-route', f.params, {
    genstudio_jobs: [{
      id: 'chat-uncertain-terminal', operation: 'chat.response', state: 'failed',
      failure_code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN', updated_at: '2026-09-06T00:02:00.000Z',
    }],
  })
  const response = await request(app)
    .post(`/api/projects/${f.project.slug}/jobs/uncertain-terminal-route/auto-repair-scene-prompts`).send({})
    .expect(409)
  assert.match(response.body.detail, /could not prove whether an earlier prompt request was accepted/i)
  assert.ok(jq.getJob('uncertain-terminal-route'))
})

test('only exact saved scene-pack contracts become newest-first read-only recoveries', () => {
  const exact = JSON.stringify(promptResponseFormat(['scene-0002']))
  const job = {
    genstudio_jobs: [
      { id: 'older', operation: 'chat.response', state: 'succeeded', updated_at: '2026-09-06T00:01:00.000Z', request: { idempotency_key: 'older-key', response_format: exact } },
      { id: 'newer', operation: 'chat.response', state: 'succeeded', updated_at: '2026-09-06T00:02:00.000Z', request: { idempotency_key: 'newer-key', response_format: exact } },
      { id: 'wrong-contract', operation: 'chat.response', state: 'succeeded', updated_at: '2026-09-06T00:03:00.000Z', request: { idempotency_key: 'wrong-key', response_format: JSON.stringify({ type: 'json_schema', json_schema: { name: 'other', strict: true, schema: {} } }) } },
    ],
  } as any
  assert.deepEqual(scenePromptAutoRepairRecoveries(job, ['scene-0002']), [
    { idempotency_key: 'newer-key', scene_ids: ['scene-0002'] },
    { idempotency_key: 'older-key', scene_ids: ['scene-0002'] },
  ])
})

test('completed provider output is recovered first and only its durable remainder is newly submitted', async () => {
  service.reset()
  const recoveryKey = 'saved-scene-prompt-recovery-key'
  await seedCompletedPromptRequest(recoveryKey, ['scene-0002'], promptResult('scene-0002', 'Recovered completed prompt.'))
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0003', 'Newly repaired remaining prompt.') })
  const f = await fixture(2)
  const job = directJob(f, 'recover-before-replace')
  job.params = {
    ...f.params,
    scene_prompt_recoveries: [{ idempotency_key: recoveryKey, scene_ids: ['scene-0002'] }],
  }

  await runScenePlanJob(job)

  assert.equal(service.providerSubmissionCount('chat'), 2, 'one historical submission plus one new request for the remaining scene')
  assert.ok(service.requests.some(entry => entry.method === 'GET' && entry.path.endsWith(`/by-idempotency-key/${recoveryKey}`)))
  const newSubmissions = chatSubmissions().filter(entry => entry.idempotencyKey !== recoveryKey)
  assert.equal(newSubmissions.length, 1)
  const newIds = (newSubmissions[0]!.parsedBody as any)?.response_format?.json_schema?.schema
    ?.properties?.results?.items?.properties?.scene_id?.enum
  assert.deepEqual(newIds, ['scene-0003'])
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.equal(saved.scenes[1].visual_prompt, 'Recovered completed prompt.')
  assert.equal(saved.scenes[2].visual_prompt, 'Newly repaired remaining prompt.')
})

test('a completed provider output can finish the repair with zero replacement POSTs', async () => {
  service.reset()
  const recoveryKey = 'saved-only-scene-prompt-key'
  await seedCompletedPromptRequest(recoveryKey, ['scene-0002'], promptResult('scene-0002', 'Recovered without replacement.'))
  const f = await fixture(1)
  const job = directJob(f, 'recover-without-post')
  job.params = { ...f.params, scene_prompt_recoveries: [{ idempotency_key: recoveryKey, scene_ids: ['scene-0002'] }] }

  await runScenePlanJob(job)

  assert.equal(service.providerSubmissionCount('chat'), 1, 'the only POST is the historical request')
  assert.equal(chatSubmissions().filter(entry => entry.idempotencyKey !== recoveryKey).length, 0)
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.equal(saved.scenes[1].visual_prompt, 'Recovered without replacement.')
})

test('a saved prompt recovery performs its exact GET even when the current policy product is unavailable', async () => {
  service.reset()
  const recoveryKey = 'policy-unavailable-scene-prompt-key'
  await seedCompletedPromptRequest(recoveryKey, ['scene-0002'], promptResult('scene-0002', 'Recovered despite retired policy product.'))
  const f = await fixture(1)
  const job = directJob(f, 'policy-unavailable-recovery')
  job.params = {
    ...f.params,
    model: 'unavailable-current-policy-product',
    pipeline_model_policy: {
      scene_plan: {
        mode: 'single',
        models: ['unavailable-current-policy-product'],
        assigned_model: 'unavailable-current-policy-product',
      },
    },
    pipeline_scene_request_plan: {
      model_id: 'unavailable-current-policy-product',
      context_window_tokens: 128_000,
      max_output_tokens: 4_096,
      visual_max_tokens: 4_096,
      active_output_budget: 4_096,
      prompt_pack_size: 50,
    },
    pipeline_scene_prompt_pack_sizes: { visual: 50 },
    scene_prompt_recoveries: [{ idempotency_key: recoveryKey, scene_ids: ['scene-0002'] }],
  }

  await runScenePlanJob(job)

  assert.equal(service.providerSubmissionCount('chat'), 1, 'only the historical request was posted')
  assert.ok(service.requests.some(entry => entry.method === 'GET' && entry.path.endsWith(`/by-idempotency-key/${recoveryKey}`)))
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.equal(saved.scenes[1].visual_prompt, 'Recovered despite retired policy product.')
})

test('newest overlapping recovery wins and satisfied older keys are not fetched', async () => {
  service.reset()
  await seedCompletedPromptRequest('older-overlap-key', ['scene-0002'], promptResult('scene-0002', 'Older recovered prompt.'))
  await seedCompletedPromptRequest('newer-overlap-key', ['scene-0002'], promptResult('scene-0002', 'Newest recovered prompt.'))
  const f = await fixture(1)
  const job = directJob(f, 'newest-recovery-first')
  job.params = {
    ...f.params,
    scene_prompt_recoveries: [
      { idempotency_key: 'newer-overlap-key', scene_ids: ['scene-0002'] },
      { idempotency_key: 'older-overlap-key', scene_ids: ['scene-0002'] },
    ],
  }

  await runScenePlanJob(job)

  const lookups = service.requests.filter(entry => entry.method === 'GET' && entry.path.includes('/by-idempotency-key/'))
  assert.deepEqual(lookups.map(entry => entry.path.split('/').at(-1)), ['newer-overlap-key'])
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[1].visual_prompt, 'Newest recovered prompt.')
})

test('a settled but unusable recovered output permits one fresh missing-only request', async () => {
  service.reset()
  await seedCompletedPromptRequest('invalid-recovery-key', ['scene-0002'], '{"results":[]}')
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002', 'Fresh after invalid recovery.') })
  const f = await fixture(1)
  const job = directJob(f, 'invalid-recovery-replacement')
  job.params = { ...f.params, scene_prompt_recoveries: [{ idempotency_key: 'invalid-recovery-key', scene_ids: ['scene-0002'] }] }

  await runScenePlanJob(job)

  assert.equal(service.providerSubmissionCount('chat'), 2)
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.equal(saved.scenes[1].visual_prompt, 'Fresh after invalid recovery.')
})

test('an unprovable saved recovery lookup stops before any paid POST', async () => {
  service.reset()
  const f = await fixture(1)
  const job = directJob(f, 'missing-recovery-record')
  job.params = { ...f.params, scene_prompt_recoveries: [{ idempotency_key: 'missing-recovery-key', scene_ids: ['scene-0002'] }] }

  await assert.rejects(runScenePlanJob(job), /incomplete/i)

  assert.equal(service.providerSubmissionCount('chat'), 0)
  assert.ok(service.requests.some(entry => entry.method === 'GET' && entry.path.endsWith('/by-idempotency-key/missing-recovery-key')))
  assert.equal(service.requests.some(entry => entry.method === 'POST' && entry.path === '/v1/chat/responses'), false)
  assert.ok(job.output_lines.some((line: string) => /recover that exact request before any fresh work/i.test(line)))
})

test('a plain local failure with newly persisted running chat evidence stops the next paid key', () => {
  const running = {
    genstudio_jobs: [{ id: 'chat-running', operation: 'chat.response', state: 'running', updated_at: '2026-09-06T00:02:00.000Z' }],
    remote_cancellations: {},
  } as any
  const settled = {
    genstudio_jobs: [{ id: 'chat-failed', operation: 'chat.response', state: 'failed', updated_at: '2026-09-06T00:02:00.000Z' }],
    remote_cancellations: {},
  } as any
  assert.equal(scenePromptRequestIsUnresolved(running, new Error('language job timed out')), true)
  assert.equal(scenePromptRequestIsUnresolved(settled, new Error('structured output invalid')), false)
})

test('an accepted chat timeout keeps its exact evidence and starts no next paid POST', async () => {
  service.reset()
  const f = await fixture(2)
  service.queueScenario('chat', { states: ['accepted', 'running', 'succeeded'], outputText: promptResult('scene-0002') })
  const barrier = service.pauseNextSubmitResponse()
  jq.registerExecutor('scene_plan_run', runScenePlanJob)
  const queued = jq.enqueuePreparedForTest({
    project_slug: f.project.slug,
    type: 'scene_plan_run',
    episode_id: f.episodeId,
    title: 'Paid prompt repair timeout',
    // One attempt's invariant. Paid prompt runs auto-retry since 1.4.257 (owner, 2026-10-07);
    // the next attempt recovering this exact key first is covered by the free-fleet test below.
    params: { ...f.params, auto_retry: false },
  })

  await barrier.started
  const realNow = Date.now
  let advanced = realNow()
  // The client's own limit is a week (the gateway decides when a job is over); jump past it.
  Date.now = () => (advanced += 8 * 24 * 60 * 60_000)
  try {
    barrier.release()
    const settled = await waitForStatus(queued.job_id, ['error', 'cancelled', 'done'])
    assert.equal(settled.status, 'error')
    assert.equal(service.providerSubmissionCount('chat'), 1)
    assert.ok(settled.genstudio_jobs?.some((entry: any) => (
      entry.operation === 'chat.response' && ['accepted', 'running'].includes(entry.state)
    )))
    assert.ok(settled.output_lines.some((line: string) => /recover that exact request before any fresh work/i.test(line)))
  } finally {
    Date.now = realNow
    barrier.release()
  }
})

test('complete or absent artifacts leave the terminal row available for ordinary Retry', async () => {
  const complete = await fixture(1)
  const completePlan = JSON.parse(await fs.readFile(complete.planPath, 'utf8'))
  completePlan.scenes[1].visual_prompt = 'A complete second prompt.'
  await fs.writeFile(complete.planPath, JSON.stringify(completePlan))
  await seedTerminalJob(complete, 'complete-prompt-route')
  const completeResponse = await request(app)
    .post(`/api/projects/${complete.project.slug}/jobs/complete-prompt-route/auto-repair-scene-prompts`).send({})
    .expect(409)
  assert.match(completeResponse.body.detail, /already complete/i)
  assert.ok(jq.getJob('complete-prompt-route'))

  const absent = await fixture(1)
  await fs.rm(absent.planPath)
  await seedTerminalJob(absent, 'absent-prompt-route')
  const absentResponse = await request(app)
    .post(`/api/projects/${absent.project.slug}/jobs/absent-prompt-route/auto-repair-scene-prompts`).send({})
    .expect(409)
  assert.match(absentResponse.body.detail, /No authoritative Scene Plan/i)
  assert.ok(jq.getJob('absent-prompt-route'))

  const timeline = await fixture(1)
  await seedTerminalJob(timeline, 'timeline-prompt-route', {
    ...timeline.params,
    stage: 'timeline',
    regenerate_empty_prompts: false,
    model: 'deterministic-timeline',
  })
  const timelineResponse = await request(app)
    .post(`/api/projects/${timeline.project.slug}/jobs/timeline-prompt-route/auto-repair-scene-prompts`).send({})
    .expect(409)
  assert.match(timelineResponse.body.detail, /not visual-prompt work/i)
  assert.ok(jq.getJob('timeline-prompt-route'))
})

test('Pause lets an accepted scene settle, then starts no next paid request', async () => {
  service.reset()
  const f = await fixture(2)
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0002') })
  service.queueScenario('chat', { states: ['succeeded'], outputText: promptResult('scene-0003') })
  const barrier = service.pauseNextSubmitResponse()
  jq.registerExecutor('scene_plan_run', runScenePlanJob)
  const queued = jq.enqueuePreparedForTest({
    project_slug: f.project.slug,
    type: 'scene_plan_run',
    episode_id: f.episodeId,
    title: 'Paid prompt repair',
    params: f.params,
  })

  await barrier.started
  const pausedRequest = await jq.pauseJob(queued.job_id)
  assert.equal(pausedRequest?.pause_requested, true)
  barrier.release()
  const settled = await waitForStatus(queued.job_id, ['paused', 'error', 'done'])

  assert.equal(settled.status, 'paused')
  assert.equal(service.providerSubmissionCount('chat'), 1)
  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.match(saved.scenes[1].visual_prompt, /scene-0002/)
  assert.equal(saved.scenes[2].visual_prompt, '')
})

test('one pack still running at the Gateway does not make another pack\'s settled failure look unresolved', () => {
  const job = {
    genstudio_jobs: [{
      id: 'chat-pack-2', operation: 'chat.response', state: 'running', request_key: 'pack-2-key',
      updated_at: '2026-10-06T00:00:00.000Z',
    }],
    remote_cancellations: {},
  } as any
  const settled = new Error('structured output invalid')
  assert.equal(scenePromptRequestIsUnresolved(job, settled, 'pack-3-key'), false,
    'pack 3 settled; pack 2 running elsewhere must not block its repair')
  assert.equal(scenePromptRequestIsUnresolved(job, settled, 'pack-2-key'), true, 'its own running request still fences it')
  assert.equal(scenePromptRequestIsUnresolved(job, settled, ''), false, 'a request that was never prepared has no provider evidence')
})

test('free-fleet prompts: the queue auto-retries, recovers the stuck pack by its key, and finishes every prompt', async () => {
  service.reset()
  const freeModel = 'studio-hub::mock-chat-v1'
  service.chatModels = [{
    id: freeModel, display_name: 'Free Mock Chat', description: 'In-process LLM fixture.',
    available: true, qualification_only: false, context_window_tokens: 128_000, max_output_tokens: 4_096,
    max_structured_items_per_request: null, controls: ['temperature', 'top_p', 'max_output_tokens'],
    activation_blockers: [], supports_structured_output: true, structured_output_mode: 'request_json_schema',
  }]
  genstudio.clearGenStudioCatalogCache()
  const realNow = Date.now
  let clock: ReturnType<typeof setInterval> | undefined
  try {
    const f = await fixture(6)
    const pair = (a: string, b: string) => JSON.stringify({ results: [a, b].map(sceneId => ({
      scene_id: sceneId, visual_prompt: `A distinct cinematic composition for ${sceneId} with its own light and place.`,
    })) })
    service.queueScenario('chat', { states: ['succeeded'], outputText: pair('scene-0002', 'scene-0003') })
    service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })
    // Owner decision 2026-10-12: the lost pack is resent once at once; that resend is lost too.
    service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })
    service.queueScenario('chat', { states: ['succeeded'], outputText: pair('scene-0006', 'scene-0007') })
    jq.registerExecutor('scene_plan_run', runScenePlanJob)
    const queued = jq.enqueuePreparedForTest({
      project_slug: f.project.slug, type: 'scene_plan_run', episode_id: f.episodeId, title: 'Free scene prompts',
      params: { ...f.params, model: `genstudio-chat:${freeModel}`, prompt_pack_size: 2, regenerate_empty_prompts: false, auto_repair_missing_prompts: false },
    })

    await waitFor(() => Boolean(jq.getJob(queued.job_id)?.auto_retry?.next_retry_at) || jq.getJob(queued.job_id)?.status === 'error', {
      label: 'first attempt ends and waits for its automatic retry', timeoutMs: 30_000,
    })
    const waiting = jq.getJob(queued.job_id)!
    assert.notEqual(waiting.status, 'error', waiting.output_lines.join('\n'))
    assert.equal(waiting.auto_retry?.eligible, true)
    assert.ok(Date.parse(waiting.auto_retry!.next_retry_at!) - realNow() >= 50_000, 'free fleet waits about a minute')
    const recovery = waiting.params.scene_prompt_recoveries
    assert.deepEqual(recovery?.map((entry: any) => entry.scene_ids), [['scene-0004', 'scene-0005']])
    const stuckKey = recovery[0].idempotency_key
    assert.equal(chatSubmissions().filter(entry => entry.idempotencyKey === stuckKey).length, 1)

    // While Story waits, the Gateway finishes the held request (a late result is adopted).
    const held = [...(service as any).jobs.values()].find((job: any) => job.idempotencyKey === stuckKey)
    held.scenario = { ...held.scenario, states: ['succeeded'], failureCode: null, outputText: pair('scene-0004', 'scene-0005') }
    held.stateIndex = 0

    let skipped = 0
    Date.now = () => realNow() + skipped
    clock = setInterval(() => { skipped += 2 * 60_000 }, 250)
    await waitFor(() => ['done', 'error'].includes(jq.getJob(queued.job_id)?.status || ''), {
      label: 'automatic retry finishes', timeoutMs: 30_000, maxWallClockMs: Number.POSITIVE_INFINITY,
    })
    clearInterval(clock)
    Date.now = realNow
    const finished = jq.getJob(queued.job_id)!
    assert.equal(finished.status, 'done', finished.error || finished.output_lines.join('\n'))
    assert.equal(finished.auto_retry?.attempt, 2)
    assert.ok(service.requests.some(entry => entry.method === 'GET' && entry.path.endsWith(`/by-idempotency-key/${stuckKey}`)))
    assert.equal(service.providerSubmissionCount('chat'), 4,
      'one POST per pack plus the lost pack\'s one resend: the stuck resend is collected by its key, never re-bought, and no empty pack is sent')
    const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
    assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
    assert.ok(saved.scenes.slice(1).every((scene: any) => scene.visual_prompt.trim()), 'all prompts finished')
  } finally {
    if (clock) clearInterval(clock)
    Date.now = realNow
    service.chatModels = null
    genstudio.clearGenStudioCatalogCache()
  }
})

// 1.4.300 "Every scene has a picture prompt": Warn writes a plain prompt from the scene's own narration line,
// but only on the last automatic try (earlier tries keep asking the writer).
test('scene_prompts Warn writes a plain prompt for a scene still missing one on the last try', async () => {
  service.reset()
  const f = await fixture(1)
  await pm.updateConfig(f.project.slug, { safety_checks: { scene_prompts: 'warn' } } as any)
  for (let index = 0; index < 6; index++) {
    service.queueScenario('chat', { states: ['succeeded'], outputText: '{"results":[]}' })
  }
  const params = {
    ...f.params,
    regenerate_empty_prompts: false,
    auto_repair_missing_prompts: false,
    pipeline_model_policy: { scene_plan: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' } },
  }
  const early = directJob(f, 'plain-prompt-early')
  early.params = params
  early.auto_retry = { eligible: true, reason: 'free', attempt: 1, max_attempts: 3 }
  await assert.rejects(runScenePlanJob(early), /incomplete/i, 'an earlier automatic try still stops so the writer is asked again')

  const job = directJob(f, 'plain-prompt-last')
  job.params = params
  await runScenePlanJob(job)

  const saved = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, f.originalPrompt)
  assert.match(saved.scenes[1].visual_prompt, /A picture of this moment in the story: Narration 2/)
  // (This fixture's joined subtitle file has no verification record, so that check warns too.)
  assert.ok(job.result?.safety_warnings?.some((w: any) => w.check === 'scene_prompts'))
  assert.equal(job.result?.complete, true)
})
