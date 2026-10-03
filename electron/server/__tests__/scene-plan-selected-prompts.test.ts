/**
 * Scene Plan "Regenerate prompts" for the selected scenes.
 *
 * Proves: only the ticked scenes' visual_prompt changes; images, approvals,
 * timings and unticked scenes stay byte-identical; a failing scene keeps its
 * old prompt, is named in plain words, and is the only one a Retry rewrites;
 * the route refuses a stale selection and malformed requests.
 * Cannot catch: prompt quality, or the page's checkbox/shift-click behaviour.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
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
const { router } = await import('../routes/scene-plan.js')
const app = express().use(express.json()).use('/api', router)

let sequence = 0
const OLD = (id: string) => `The original prompt for ${id}, which must survive unless rewritten.`

async function fixture() {
  sequence++
  const project = await pm.createProject({ name: `Selected Prompts ${sequence}`, episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Selected', logline: 'x', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'quiet' }], 'test')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${accepted.episode_code}_stitched.srt`)
  await fs.writeFile(stitched, ['1', '00:00:00,000 --> 00:00:04,000', 'Opening.', ''].join('\n'))
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, missing_sections: [], sections: [{ slug: 'full', source_srt: 'full.srt', cues_added: 1 }] }))
  const scenes = ['s1', 's2', 's3', 's4'].map((id, index) => ({
    id,
    scene_index: index + 1,
    start_sec: index,
    end_sec: index + 1,
    transcript_segment: id === 's3' ? '' : `Narration for ${id}.`,
    visual_prompt: OLD(id),
    approved: true,
    image_path: `images/${id}.png`,
  }))
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1, generated_at: '2026-09-06T00:00:00.000Z', timeline_built_at: '2026-09-06T00:00:00.000Z',
    planner_model: 'deterministic-timeline', source_stitched_srt: path.basename(stitched),
    total_duration_sec: scenes.length, research_used: false, planning_stage: 'visual', scenes,
  }, null, 2))
  return { slug: project.slug, episodeId: accepted.episode_code, planPath }
}

function job(f: Awaited<ReturnType<typeof fixture>>, ids: string[]): any {
  return {
    job_id: `selected-${sequence}-${ids.join('-')}`, project_slug: f.slug, episode_id: f.episodeId,
    type: 'scene_plan_run', title: 'Regenerate prompts', status: 'running',
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, error: null,
    output_lines: [],
    params: { episode_id: f.episodeId, model: 'genstudio-chat:mock-chat-v1', regenerate_prompt_scene_ids: ids, use_research: false },
  }
}

const readPlan = async (planPath: string) => JSON.parse(await fs.readFile(planPath, 'utf8'))

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

test('rewrites only the selected prompts and keeps images, approvals and timings', async () => {
  service.reset()
  const f = await fixture()
  const before = await readPlan(f.planPath)
  service.queueScenario('chat', { states: ['succeeded'], outputText: 'A lantern-lit pier at dusk, fresh prompt for s2.' })
  service.queueScenario('chat', { states: ['succeeded'], outputText: 'Fog rolling over the harbour, fresh prompt for s4.' })
  const run = job(f, ['s2', 's4'])
  await runScenePlanJob(run)
  const after = await readPlan(f.planPath)
  assert.match(after.scenes[1].visual_prompt, /fresh prompt for s2/)
  assert.match(after.scenes[3].visual_prompt, /fresh prompt for s4/)
  for (const [i, scene] of after.scenes.entries()) {
    const was = before.scenes[i]
    assert.equal(scene.approved, was.approved, `${scene.id} approval kept`)
    assert.equal(scene.image_path, was.image_path, `${scene.id} image kept`)
    assert.equal(scene.start_sec, was.start_sec)
    assert.equal(scene.end_sec, was.end_sec)
    if (scene.id === 's1' || scene.id === 's3') assert.equal(scene.visual_prompt, was.visual_prompt, `${scene.id} untouched`)
  }
  assert.equal(run.progress, 100)
  assert.equal(run.result?.complete, true)
})

test('a failing scene keeps its prompt, is named plainly, and Retry rewrites only it', async () => {
  service.reset()
  const f = await fixture()
  service.queueScenario('chat', { states: ['succeeded'], outputText: 'Fresh prompt for s1, a quiet morning market.' })
  service.queueScenario('chat', { states: ['failed'], failureCode: 'UPSTREAM_ERROR' })
  const run = job(f, ['s1', 's3', 's4'])
  await assert.rejects(runScenePlanJob(run), (error: any) => {
    assert.match(error.message, /^2 of 3 selected scene prompts could not be rewritten \(scenes #3, #4\)/)
    assert.match(error.message, /keep their previous prompt/)
    return true
  })
  const after = await readPlan(f.planPath)
  assert.match(after.scenes[0].visual_prompt, /Fresh prompt for s1/, 'the success before the failures is saved')
  assert.equal(after.scenes[2].visual_prompt, OLD('s3'))
  assert.equal(after.scenes[3].visual_prompt, OLD('s4'))
  assert.deepEqual(run.params.regenerate_prompt_scene_ids, ['s3', 's4'], 'Retry scope narrowed to the failures')
  const issues = run.result.completion.issues
  assert.deepEqual(issues.map((issue: any) => issue.item_id), ['s3', 's4'])
  assert.match(issues[0].reason, /no narration text/)
})

test('the route enqueues one job for the selection and refuses stale or malformed requests', async () => {
  service.reset()
  const f = await fixture()
  const url = `/api/projects/${f.slug}/scene-plan/${f.episodeId}/regenerate-prompt`
  const op = () => crypto.randomUUID()
  await request(app).post(url).send({ scene_ids: [], model: 'genstudio-chat:mock-chat-v1', operation_id: op() }).expect(400)
  await request(app).post(url).send({ scene_ids: ['s1'], scene_id: 's1', model: 'genstudio-chat:mock-chat-v1', operation_id: op() }).expect(400)
  await request(app).post(url).send({ scene_ids: ['s1'], reword_prompt: true, model: 'genstudio-chat:mock-chat-v1', operation_id: op() }).expect(400)
  const stale = await request(app).post(url).send({ scene_ids: ['s1', 'gone'], model: 'genstudio-chat:mock-chat-v1', operation_id: op() }).expect(409)
  assert.match(stale.body.detail, /1 selected scene is no longer in this episode's plan/)

  await jq.setQueuePaused(true)
  let jobId = ''
  try {
    const created = await request(app).post(url)
      .send({ scene_ids: ['s2', 's1', 's2'], model: 'genstudio-chat:mock-chat-v1', operation_id: op() })
      .expect(201)
    jobId = created.body.job_id
    assert.deepEqual(created.body.params.regenerate_prompt_scene_ids, ['s2', 's1'])
    assert.equal(created.body.params.regenerate_prompt_scene_id, undefined)
    assert.match(created.body.title, /^Regenerate prompts \(2 scenes\)/)
  } finally {
    if (jobId) {
      await jq.requestJobCancellation(f.slug, jobId)
      jq.removeTerminalJob(f.slug, jobId)
    }
    await jq.setQueuePaused(false)
  }
})
