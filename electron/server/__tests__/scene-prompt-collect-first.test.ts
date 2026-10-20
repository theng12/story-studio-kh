/**
 * Collect-first: a Scene Plan run asks the Gateway for what it already answered
 * before it asks for anything new.
 *
 * Production, 2026-10-20. Three jobs held accepted writing answers nobody had
 * saved, and every route that could have re-run them repacked the missing
 * scenes into a brand-new request and orphaned the answer:
 *
 *   - Sprout SS0119/SS0121: a terminal row, Retry makes a new row that carries
 *     only params, so the children on the old row were gone.
 *   - Science EP0011 (recovery row, same-row requeue): the one saved recovery
 *     descriptor covered scenes 1-250, already complete; an accepted repair
 *     child for the next pack was never named in params.
 *   - History EP0015 (no recovery id): native recovery builds a NEW row and
 *     inherits neither the children nor the keys it had already rejected.
 *
 * One collector reads the job's own saved children (json_object or json_schema)
 * and collects each by its exact saved key before any new generation; Retry and
 * recovery carry that evidence, and the rejected keys, onto the row they create.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
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
const { runScenePlanJob } = await import('../generators/scene-plan.js')
const jq = await import('../services/job-queue.js')
const { resolveEpisodePathsByCode } = await import('../services/utils.js')
const { registerAllExecutors } = await import('../boot/executors.js')
const { dispatchEpisodeRecoveryStep, EPISODE_RECOVERY_ORDER } = await import('../services/episode-recovery.js')
const { scenePromptPackOutputContract } = await import('../lib/story-output-contracts.js')

let sequence = 0
const NOW = '2026-10-20T04:00:00.000Z'

const idsOf = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `scene-${String(from + i).padStart(4, '0')}`)
const answer = (ids: string[]) => JSON.stringify({ results: ids.map(id => ({ scene_id: id, visual_prompt: `Saved Gateway answer for ${id}, one distinct composition.` })) })

async function seedAnswer(key: string, outputText: string, responseFormat: unknown): Promise<string> {
  service.queueScenario('chat', { states: ['succeeded'], outputText })
  const response = await fetch(`${service.baseUrl}/v1/chat/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ model_id: 'mock-chat-v1', input: [{ role: 'user', content: 'saved prompt request' }], response_format: responseFormat }),
  })
  assert.equal(response.status, 202)
  return String((await response.json() as { id: string }).id)
}

const JSON_OBJECT = { type: 'json_object' }
function jsonSchema(ids: string[]) {
  const contract = scenePromptPackOutputContract(ids, 'visual') as any
  return { type: 'json_schema', json_schema: { name: 'story_scene_prompt_pack', strict: true, schema: contract.schema } }
}

/** The evidence entry Story saved for a settled chat request. `ids` is what the preview still shows; `undefined` format means the preview was pruned. */
function child(key: string, format: unknown, ids?: string[], state = 'succeeded') {
  if (format === undefined) return { id: `provider-${key.slice(-8)}`, operation: 'chat.response', state, updated_at: NOW, request_key: key }
  return {
    id: `provider-${key.slice(-8)}`,
    operation: 'chat.response',
    state,
    updated_at: NOW,
    request: {
      method: 'POST', path: '/v1/chat/responses', idempotency_key: key, captured_at: NOW,
      response_format: JSON.stringify(format),
      ...(ids ? { messages: [
        { role: 'system', text: 'Return strict JSON only: {"results":[{"scene_id":"exact input id","visual_prompt":"text"}]}', length: 90, truncated: false },
        { role: 'user', text: `STYLE BIBLE:\nx\n\nSCENES:\n${JSON.stringify(ids.map(scene_id => ({ scene_id, narration: 'n' })))}`, length: 100, truncated: false },
      ] } : {}),
    },
  }
}

async function fixture(missingCount: number) {
  sequence++
  const project = await pm.createProject({ name: `Collect First ${sequence}`, episode_prefix: 'EP', episode_digits: 4 })
  await pm.updateConfig(project.slug, { safety_checks: { scene_prompts: 'block' } } as any)
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Collect', logline: 'Collect first.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'quiet' }], 'test')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${accepted.episode_code}_stitched.srt`)
  await fs.writeFile(stitched, ['1', '00:00:00,000 --> 00:00:01,000', 'Opening.', ''].join('\n'))
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, missing_sections: [], sections: [{ slug: 'full', source_srt: 'full.srt', cues_added: 1 }] }))
  const scenes = Array.from({ length: missingCount + 1 }, (_, index) => ({
    id: `scene-${String(index + 1).padStart(4, '0')}`, scene_index: index + 1, start_sec: index, end_sec: index + 1,
    transcript_segment: `Narration ${index + 1}`,
    visual_prompt: index === 0 ? 'An already verified archival prompt that must stay byte-identical.' : '',
  }))
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1, generated_at: '2026-09-06T00:00:00.000Z', timeline_built_at: '2026-09-06T00:00:00.000Z',
    planner_model: 'deterministic-timeline', source_stitched_srt: path.basename(stitched), total_duration_sec: scenes.length,
    research_used: false, planning_stage: 'visual', scenes,
  }, null, 2))
  const params = {
    episode_id: accepted.episode_code, stage: 'visual', model: 'genstudio-chat:mock-chat-v1', use_research: false,
    prompt_pack_size: 50, regenerate_empty_prompts: true, auto_repair_missing_prompts: false,
  }
  return { project, episodeId: accepted.episode_code, planPath, params }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function directJob(f: Fixture, id: string, extra: Record<string, unknown> = {}): any {
  return {
    job_id: id, project_slug: f.project.slug, episode_id: f.episodeId, type: 'scene_plan_run', title: 'Scene Plan Prompts',
    status: 'running', created_at: NOW, started_at: NOW, finished_at: null, error: null, output_lines: [], params: f.params, ...extra,
  }
}

const posts = () => service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/chat/responses').length
const gets = (key: string) => service.requests.filter(entry => entry.method === 'GET' && entry.path.endsWith(`/by-idempotency-key/${key}`)).length
async function savedPrompts(f: Fixture): Promise<Record<string, string>> {
  const plan = JSON.parse(await fs.readFile(f.planPath, 'utf8'))
  return Object.fromEntries(plan.scenes.map((scene: any) => [scene.id, scene.visual_prompt]))
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

test('Science11 shape: an accepted json_object child the saved descriptor never names is collected before any new request', async () => {
  service.reset()
  const f = await fixture(6) // scene-0002..0007 missing
  const covered = idsOf(4, 7)
  const key = 'story-chat-7645537c0000000000000000000000000000000000000000'
  await seedAnswer(key, answer(covered), JSON_OBJECT)
  // A set this small goes one scene per request.
  for (const id of idsOf(2, 3)) service.queueScenario('chat', { states: ['succeeded'], outputText: answer([id]) })
  const job = directJob(f, 'science11-same-row', {
    genstudio_jobs: [child(key, JSON_OBJECT, covered)],
    // The only descriptor on the row: scenes already complete, so it used to be the end of the story.
    params: { ...f.params, scene_prompt_recoveries: [{ idempotency_key: 'story-chat-resend-3dfbdeaa', scene_ids: ['scene-0001'] }] },
  })
  const before = posts()

  await runScenePlanJob(job)

  assert.equal(gets(key), 1, 'the saved child is read back by its exact key')
  assert.equal(posts() - before, 2, 'only the two scenes no saved answer covers are requested')
  const requested = service.submissions.filter(entry => entry.operation === 'chat' && !entry.replay).slice(-2).flatMap(entry => (entry.parsedBody as any)
    ?.response_format?.json_schema?.schema?.properties?.results?.items?.properties?.scene_id?.enum)
  assert.deepEqual(requested, idsOf(2, 3))
  const saved = await savedPrompts(f)
  for (const id of covered) assert.match(saved[id]!, /Saved Gateway answer/)
})

test('a child whose preview was pruned is still collected, scoped to what is still missing', async () => {
  service.reset()
  const f = await fixture(4)
  const key = 'story-chat-pruned0000000000000000000000000000000000000000'
  await seedAnswer(key, answer(idsOf(2, 5)), JSON_OBJECT)
  const job = directJob(f, 'pruned-preview', { genstudio_jobs: [child(key, undefined)] })
  const before = posts()

  await runScenePlanJob(job)

  assert.equal(posts() - before, 0, 'nothing new is generated')
  assert.equal(gets(key), 1)
  const saved = await savedPrompts(f)
  for (const id of idsOf(2, 5)) assert.match(saved[id]!, /Saved Gateway answer/)
})

test('Sprout shape: Retry carries the old row\'s settled children onto the new row, and that row collects them', async () => {
  service.reset()
  const f = await fixture(3)
  const covered = idsOf(2, 4)
  const key = 'story-chat-sprout0000000000000000000000000000000000000000'
  await seedAnswer(key, answer(covered), jsonSchema(covered))
  await fs.writeFile(path.join(temp.dir, 'projects', f.project.slug, 'jobs.json'), JSON.stringify({ jobs: [{
    job_id: 'sprout-terminal', project_slug: f.project.slug, type: 'scene_plan_run', episode_id: f.episodeId,
    title: 'Scene Plan Prompts', status: 'error', created_at: NOW, started_at: NOW, finished_at: NOW,
    error: 'Scene plan visual prompts incomplete: 100/276 required item(s) verified.', output_lines: [],
    params: f.params, genstudio_jobs: [child(key, jsonSchema(covered), covered)],
  }] }))
  await jq.getJobs(f.project.slug)

  const retried = jq.retryTerminalJob(f.project.slug, 'sprout-terminal')

  assert.deepEqual((retried.params.scene_prompt_recoveries as any[]).map(entry => entry.idempotency_key), [key])
  const before = posts()
  await runScenePlanJob(directJob(f, 'sprout-retry', { params: structuredClone(retried.params) }))
  assert.equal(posts() - before, 0)
  assert.equal(gets(key), 1)
  const saved = await savedPrompts(f)
  for (const id of covered) assert.match(saved[id]!, /Saved Gateway answer/)
})

test('History15 shape: recovery builds a new row that inherits the accepted child and the rejected keys, and never replays a rejected answer', async () => {
  service.reset()
  const f = await fixture(5) // scene-0002..0006 missing
  const rejected = 'story-chat-ca71b61f0000000000000000000000000000000000000000'
  const repair = 'story-chat-a19cd02a0000000000000000000000000000000000000000'
  await seedAnswer(rejected, 'this is not json at all', JSON_OBJECT)
  await seedAnswer(repair, answer(idsOf(2, 6)), JSON_OBJECT)
  await fs.writeFile(path.join(temp.dir, 'projects', f.project.slug, 'jobs.json'), JSON.stringify({ jobs: [{
    job_id: '7c6df964', project_slug: f.project.slug, type: 'scene_plan_run', episode_id: f.episodeId,
    title: 'Pipeline: Scene Plan', status: 'error', created_at: NOW, started_at: NOW, finished_at: NOW,
    error: 'Scene plan visual prompts incomplete: 0/415 required item(s) verified.', output_lines: [],
    params: f.params, rejected_idempotency_keys: [rejected],
    genstudio_jobs: [child(rejected, JSON_OBJECT, idsOf(2, 6)), child(repair, JSON_OBJECT, idsOf(2, 6))],
  }] }))
  await jq.getJobs(f.project.slug)

  const plan: any = {
    version: 1, id: 'plan-h15', project_slug: f.project.slug, episode_id: f.episodeId, target: 'scene_plan_run',
    steps: { scene_plan_run: { job_id: 'recovery-plan-h15-scene_plan_run', type: 'scene_plan_run', title: 'Scene Plan', params: structuredClone(f.params), source_job_id: '7c6df964' } },
    completed: [], first_unresolved: 'scene_plan_run', message: '',
  }
  const verified = Object.fromEntries(EPISODE_RECOVERY_ORDER.map(step => [step, step !== 'scene_plan_run'])) as any
  await dispatchEpisodeRecoveryStep(plan, { verified, message: 'Ready.' }, await jq.getJobs(f.project.slug), ['7c6df964'])

  const row = jq.getJob('recovery-plan-h15-scene_plan_run')!
  assert.ok(row, 'recovery created its row')
  assert.deepEqual(row.rejected_idempotency_keys, [rejected], 'the keys the old row refused travel with the recovery')
  assert.deepEqual((row.params.scene_prompt_recoveries as any[]).map(entry => entry.idempotency_key), [repair],
    'only the accepted child is carried; the rejected one is not')

  const before = posts()
  await runScenePlanJob(directJob(f, 'history15-row', {
    params: structuredClone(row.params), rejected_idempotency_keys: row.rejected_idempotency_keys,
  }))
  assert.equal(posts() - before, 0, 'no new paid request while a saved answer covers the missing scenes')
  assert.equal(gets(repair), 1)
  assert.equal(gets(rejected), 0, 'a rejected answer is never replayed')
  const saved = await savedPrompts(f)
  for (const id of idsOf(2, 6)) assert.match(saved[id]!, /Saved Gateway answer/)
})

test('restart requeue: a settled accepted child is collected by its key, with zero new POSTs', async () => {
  // 0f1cda0f requeues a restart-interrupted writing job once its children settle and the audit is
  // still incomplete. That same row must collect the child it already holds before any new pack.
  registerAllExecutors({ loadSettings: false })
  service.reset()
  const f = await fixture(4) // scene-0002..0005 missing
  const covered = idsOf(2, 5)
  const key = 'story-chat-requeue000000000000000000000000000000000000000'
  const providerId = await seedAnswer(key, answer(covered), JSON_OBJECT)
  const accepted = { ...child(key, JSON_OBJECT, covered, 'accepted'), id: providerId }
  await fs.writeFile(path.join(temp.dir, 'projects', f.project.slug, 'jobs.json'), JSON.stringify({ jobs: [
    directJob(f, 'restart-requeue', { genstudio_jobs: [accepted], remote_cancellations: {} }),
  ] }))
  const before = posts()

  await jq.getJobs(f.project.slug)
  await waitFor(() => jq.getJob('restart-requeue')?.status === 'done', { label: 'the requeued scene plan to finish', timeoutMs: 12_000 })
    .catch(() => {})
  await jq._waitForJobPersistenceForTesting()

  const row = jq.getJob('restart-requeue')!
  assert.equal(row.status, 'done', row.output_lines.join(' | '))
  assert.ok(row.output_lines.some(line => /picking this step up where it stopped/.test(line)), 'it went through the automatic restart requeue')
  assert.equal(posts() - before, 0, 'the requeued run asked the Gateway for nothing new')
  const saved = await savedPrompts(f)
  for (const id of covered) assert.match(saved[id]!, /Saved Gateway answer/)
})
