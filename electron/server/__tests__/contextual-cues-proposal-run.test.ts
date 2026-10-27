/**
 * Contextual Cues proposal runs, driven end to end against the mock GenStudio.
 *
 * Pins three owner-visible promises:
 *  - "Propose cues" after a partial run pays only for the missing batches, even
 *    though a new click is a new action id — and never reuses batches from a
 *    different Scene Plan;
 *  - an approval made on the review page while a proposal runs survives it;
 *  - the preset's "Auto-approve safe proposals" holds a crowding cue for review
 *    instead of failing the whole run.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let mock: MockGenStudioService
let slug = ''
let episode = ''
let planPath = ''
let generator: typeof import('../generators/contextual-cues.js')
let cues: typeof import('../services/contextual-cues.js')

const plan = {
  generated_at: '2026-10-01T00:00:00.000Z',
  total_duration_sec: 400,
  scenes: [
    { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 100, transcript_segment: 'Berlin, 1919.', visual_prompt: '' },
    { id: 'scene-2', scene_index: 2, start_sec: 100, end_sec: 200, transcript_segment: 'Paris, 1920.', visual_prompt: '' },
    { id: 'scene-3', scene_index: 3, start_sec: 200, end_sec: 300, transcript_segment: 'Rome, 1921.', visual_prompt: '' },
  ],
}

const answer = (sceneId: string, title: string, offset = 0.2) =>
  ({ outputText: JSON.stringify({ cues: [{ scene_id: sceneId, title, kind: 'location_date', anchor_offset_sec: offset }] }) })

function job(actionId: string, extra: Record<string, unknown> = {}): any {
  return {
    job_id: `job-${actionId}`, project_slug: slug, episode_id: episode, type: 'contextual_cues', status: 'running',
    params: { model: 'mock-chat-v1', density: 'editorial', placement: 'top-right', auto_approve: false,
      generation_action: { kind: 'fresh', id: actionId }, ...extra },
    output_lines: [], progress: 0,
  }
}

const chatSubmissions = () => mock.submissions.filter(s => s.operation === 'chat' && !s.replay)

before(async () => {
  isolated = await useTempDataDir()
  mock = await startMockGenStudioService()
  // One scene per request, so a three-scene plan is three paid batches.
  mock.chatModels = [{
    id: 'mock-chat-v1', display_name: 'Mock Chat', available: true, qualification_only: false,
    context_window_tokens: 128_000, max_output_tokens: 4_096, max_structured_items_per_request: 1,
    controls: ['temperature', 'max_output_tokens'], activation_blockers: [],
    supports_structured_output: true, structured_output_mode: 'request_json_schema',
  }]
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Cue run fixture', episode_prefix: 'EP', episode_digits: 4 })
  slug = project.slug
  await pm.updateConfig(slug, { contextual_cues: { enabled: true, auto_approve_cues: false } } as any)
  const [idea] = await ideas.addIdeas(slug, [{ title: 'Cue run', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  episode = (await ideas.acceptIdea(slug, idea!.id, false)).episode_code!
  const paths = await utils.resolveEpisodePathsByCodeWithSidecar(slug, episode, 'scene_plan.json')
  planPath = await utils.resolveScenePlanPath(slug, episode, paths.episode_dir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify(plan))
  await import('../boot/providers.js')
  generator = await import('../generators/contextual-cues.js')
  cues = await import('../services/contextual-cues.js')
})

after(async () => {
  const jq = await import('../services/job-queue.js')
  await jq._waitForJobPersistenceForTesting?.()
  await mock.close()
  await isolated.cleanup()
})

async function reset(): Promise<void> {
  await fs.rm(cues.contextualCuePath(planPath), { force: true })
  await cues.removeContextualCueProgress(planPath)
  mock.submissions.length = 0
}

/** Progress saved by an earlier click (action A) that finished batch 0 only. */
async function savePartialRunFromActionA(sourcePlan = plan): Promise<void> {
  const settings = cues.normalizeContextualCueProposalSettings(job('A').params)
  await cues.writeContextualCueProgress(planPath, {
    schema_version: 1,
    fingerprint: `${cues.contextualCueProgressFingerprint(sourcePlan as any, settings)}:fresh:A`,
    source_scene_plan_generated_at: sourcePlan.generated_at,
    model: 'mock-chat-v1', batch_size: 1, total_scenes: 3, total_batches: 3,
    completed_batches: [{ index: 0, scene_ids: ['scene-1'], candidates: [{ scene_id: 'scene-1', title: 'Berlin', kind: 'location_date' }] }],
    updated_at: '2026-10-01T00:00:00.000Z',
  })
}

describe('Contextual Cues proposal runs', () => {
  test('a new Propose cues click continues a partial run and pays only for the missing batches', async () => {
    await reset()
    await savePartialRunFromActionA()
    mock.queueScenario('chat', answer('scene-2', 'Paris'))
    mock.queueScenario('chat', answer('scene-3', 'Rome'))
    await generator.generateContextualCues(job('B'))
    assert.equal(chatSubmissions().length, 2, 'batch 1 was already paid for under action A')
    const titles = (await cues.readContextualCueTimeline(planPath))!.cues.map(cue => cue.title).sort()
    assert.deepEqual(titles, ['Berlin', 'Paris', 'Rome'])
  })

  test('progress for a different Scene Plan is never reused', async () => {
    await reset()
    await savePartialRunFromActionA({ ...plan, generated_at: '2026-09-01T00:00:00.000Z' })
    for (const [scene, title] of [['scene-1', 'Bonn'], ['scene-2', 'Lyon'], ['scene-3', 'Pisa']]) mock.queueScenario('chat', answer(scene!, title!))
    await generator.generateContextualCues(job('C'))
    assert.equal(chatSubmissions().length, 3)
    const titles = (await cues.readContextualCueTimeline(planPath))!.cues.map(cue => cue.title)
    assert.ok(!titles.includes('Berlin'), 'a candidate from another plan must not leak in')
  })

  test('an approval made while the proposal runs is not overwritten', async () => {
    await reset()
    await cues.writeContextualCueTimeline(planPath, {
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      cues: [{ id: 'cue-scene-1', scene_id: 'scene-1', start_sec: 0.2, end_sec: 4.2, title: 'Old Berlin', kind: 'location_date',
        placement: 'top-right', template: 'map-pin', entrance: 'fade', exit: 'dissolve', status: 'proposed',
        created_at: '', updated_at: '' } as any],
    })
    // The reviewer approves (and retitles) the proposal while batch 1 is out.
    mock.queueScenario('chat', answer('scene-1', 'New Berlin'))
    mock.queueScenario('chat', answer('scene-2', 'Paris'))
    mock.queueScenario('chat', answer('scene-3', 'Rome'))
    const run = generator.generateContextualCues(job('D'))
    await waitFor(() => chatSubmissions().length >= 1, { label: 'first cue batch submitted' })
    const timeline = (await cues.readContextualCueTimeline(planPath))!
    timeline.cues[0] = { ...timeline.cues[0]!, title: 'Berlin, approved', status: 'approved' }
    await cues.writeContextualCueTimeline(planPath, timeline)
    await run
    const saved = (await cues.readContextualCueTimeline(planPath))!.cues
    const scene1 = saved.filter(cue => cue.scene_id === 'scene-1')
    assert.equal(scene1.length, 1, 'one cue per scene; the reviewed one wins')
    assert.equal(scene1[0]!.title, 'Berlin, approved')
    assert.equal(scene1[0]!.status, 'approved')
  })

  test('the preset auto-approve holds a crowding cue back instead of failing the whole run', async () => {
    await reset()
    await cues.writeContextualCueTimeline(planPath, {
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      // An approved cue at the very end of scene 1 that the scene-2 proposal crowds.
      cues: [{ id: 'manual-1', scene_id: 'scene-1', start_sec: 96, end_sec: 99.9, title: 'Hand-made', kind: 'location_date',
        placement: 'top-right', template: 'map-pin', entrance: 'fade', exit: 'dissolve', status: 'approved',
        created_at: '', updated_at: '' } as any],
    })
    mock.queueScenario('chat', { outputText: JSON.stringify({ cues: [] }) })
    mock.queueScenario('chat', answer('scene-2', 'Paris', 0))
    mock.queueScenario('chat', answer('scene-3', 'Rome'))
    await generator.generateContextualCues(job('E', { auto_approve: true }))
    const saved = (await cues.readContextualCueTimeline(planPath))!
    const byTitle = new Map(saved.cues.map(cue => [cue.title, cue.status]))
    assert.equal(byTitle.get('Paris'), 'proposed', 'held for review, not approved unchecked')
    assert.equal(byTitle.get('Rome'), 'approved')
    assert.equal(saved.auto_approval_holds?.[0]?.cue_id, 'cue-scene-2')
  })

  test('saving a label edit while nothing runs keeps a partial proposal’s progress (owner decision 2026-10-03)', async () => {
    await reset()
    await savePartialRunFromActionA()
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    const { app } = await import('../app.js')
    const { default: request } = await import('supertest')
    // v1.4.365 — the page's save moved to the merged Sound & Labels route. The
    // promise under test is unchanged: a manual save never discards batches the
    // customer already paid for.
    const res = await request(app).put(`/api/projects/${slug}/sound-and-labels/${episode}/labels`).send({ cues: [] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(await cues.readContextualCueProgress(planPath), 'the paid batches stay for the next proposal')
  })

  test('the old page routes answer 410 with the new address, not a bare 404', async () => {
    // A 404 reads like the feature was deleted. The merge has to say where it
    // went, or every bookmark and every older link dead-ends in silence.
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    const { app } = await import('../app.js')
    const { default: request } = await import('supertest')
    for (const path of ['contextual-cues', 'sound-design']) {
      const res = await request(app).get(`/api/projects/${slug}/${path}/${episode}`)
      assert.equal(res.status, 410, `${path} must answer 410`)
      assert.match(String(res.body?.detail || ''), /Sound & Labels/)
      assert.equal(res.body?.moved_to, '/sound-and-labels')
    }
  })
})
