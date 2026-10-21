/**
 * HTTP RED contract for the first preset-authority slice.
 *
 * It uses the real Express routes, project store, and paused queue in an
 * isolated temp data directory. No provider is started and no job executes.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import request from 'supertest'
import './_helpers.js'
import { setTestSafeStorageAvailable } from './safe-storage-test-double.js'

const paced = {
  mode: 'variable',
  min_sec: 1,
  max_sec: 5,
  periods: [
    { start_sec: 0, end_sec: 300, min_sec: 1, max_sec: 5 },
    { start_sec: 300, end_sec: 600, min_sec: 10, max_sec: 20 },
    { start_sec: 600, end_sec: null, min_sec: 20, max_sec: 30 },
  ],
}

let isolated: { dir: string }
let app: any
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let secrets: typeof import('../services/app-secrets-store.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js').resolveEpisodePathsByCode
let stampFreshGenerationAction: typeof import('../lib/fresh-generation-action.js').stampFreshGenerationAction
let pipelineRepairFingerprint: typeof import('../routes/pipeline.js').pipelineRepairFingerprint
let scenePlanVisualSnapshot: typeof import('../routes/scene-plan.js').scenePlanVisualSnapshot
let projectSlug = ''
let episodes: Array<{ episode_code: string; title: string }> = []

before(async () => {
  // The canonical harness owns this fixture. A data dir outside
  // STORY_STUDIO_TEST_HARNESS_ROOT is refused by the retained-filesystem guard,
  // so every atomic write the app makes into it (app-settings, ideas, jobs) would
  // fail on its rename.
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the data root is isolated')
  isolated = { dir: await fs.mkdtemp(path.join(harnessRoot, 'preset-authority-http-')) }
  process.env.STORY_STUDIO_DATA_DIR = isolated.dir
  setTestSafeStorageAvailable(true)
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;[jq, pm, ideas, secrets] = await Promise.all([
    import('../services/job-queue.js'),
    import('../services/project-manager.js'),
    import('../services/idea-manager.js'),
    import('../services/app-secrets-store.js'),
  ])
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
  ;({ stampFreshGenerationAction } = await import('../lib/fresh-generation-action.js'))
  ;({ pipelineRepairFingerprint } = await import('../routes/pipeline.js'))
  ;({ scenePlanVisualSnapshot } = await import('../routes/scene-plan.js'))
  app = (await import('../app.js')).app
  await jq.setQueuePaused(true)

  const project = await pm.createProject({
    name: 'Preset authority HTTP fixture', episode_prefix: 'EP', episode_digits: 4,
  })
  projectSlug = project.slug
  const rows = await ideas.addIdeas(projectSlug, [
    'Explicit current alternative', 'Configured pointer', 'Wrong pool', 'Stale pointer',
  ].map((title) => ({
    title, logline: '', themes: [], suggested_chapters: 1,
    suggested_length: 'short', mood: 'calm',
  })), 'mock-chat-v1')
  episodes = []
  for (const row of rows) {
    assert.ok(row)
    const accepted = await ideas.acceptIdea(projectSlug, row.id, false)
    episodes.push({ episode_code: accepted.episode_code, title: row.title })
  }
})

after(async () => {
  await jq?._waitForJobPersistenceForTesting()
  delete process.env.STORY_STUDIO_DATA_DIR
  setTestSafeStorageAvailable(true)
})

async function setCurrentPresets(pointer = 'scene-active') {
  await pm.updateConfig(projectSlug, {
    scene_plan_presets: [{
      id: 'scene-active', name: 'Configured active', type: 'scene-plan',
      data: { model: 'mock-chat-v1' },
    }, {
      // Current membership in the correct pool keeps this owner-retained old,
      // untyped production alternative valid even though it is not the pointer.
      id: 'scene-retained-old', name: 'Original production alternative 2024',
      data: {
        model: 'mock-chat-v1', use_research: false,
        reusable_guidance: 'Keep the geography coherent.',
        intended_image_model: 'mock-image-v1', prompt_char_cap: 'auto',
        avoid_legible_text: true, pacing: paced,
        motion_scope: { mode: 'all' }, motion_level: 3,
        custom_instructions: 'FOREIGN LEGACY EPISODE TEXT',
      },
    }],
    'scene_plan_last_preset_scene-plan': pointer,
    script_presets: [{ id: 'script-wrong-pool', name: 'Script only', data: { model: 'mock-chat-v1' } }],
  } as any)
}

async function writeOldEpisodeContinuity(episodeId: string) {
  const paths = await resolveEpisodePathsByCode(projectSlug, episodeId)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({
    pacing: { mode: 'uniform', min_sec: 24, max_sec: 24 },
    motion_scope: { mode: 'selected', scene_ids: ['episode-only-scene'] },
    motion_level: 1,
    use_episode_sheet: true,
  }))
}

test('manual Scene Plan resolves a valid explicit current-pool alternative and replays its accepted body before current state', async () => {
  await setCurrentPresets()
  const episode = episodes[0]!
  await writeOldEpisodeContinuity(episode.episode_code)
  const body = {
    stage: 'timeline', title: episode.title,
    preset_id: 'scene-retained-old',
    operation_id: '81010000-0000-4000-8000-000000000001',
    custom_instructions: 'Direction for this episode only.',
  }

  const first = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${episode.episode_code}/run`)
    .send(body)
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const accepted = structuredClone(first.body.params)
  assert.equal(accepted.resolved_preset?.pool, 'scene_plan_presets')
  assert.equal(accepted.resolved_preset?.id, 'scene-retained-old')
  assert.match(accepted.resolved_preset?.content_fingerprint || '', /^[0-9a-f]{64}$/)
  assert.equal(accepted.resolved_preset?.data?.reusable_guidance, 'Keep the geography coherent.')
  assert.equal(accepted.resolved_preset?.data?.custom_instructions, undefined,
    'legacy foreign episode guidance is excluded from the reusable accepted snapshot')
  assert.deepEqual(accepted.pacing, paced,
    'the exact selected preset outranks old episode pacing for NEW admission')
  assert.deepEqual(accepted.motion_scope, { mode: 'all' })
  assert.match(accepted.custom_instructions || '', /Direction for this episode only/)
  assert.match(accepted.custom_instructions || '', /Keep the geography coherent/)

  await pm.updateConfig(projectSlug, {
    scene_plan_presets: [],
    'scene_plan_last_preset_scene-plan': 'deleted-after-acceptance',
  } as any)
  await secrets.setApiKey('genstudio', '')

  const replay = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${episode.episode_code}/run`)
    .send(body)
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(replay.body.reused, true)
  assert.equal(replay.body.job_id, first.body.job_id)
  assert.deepEqual(replay.body.params, accepted,
    'accepted replay adopts the immutable saved params without re-resolving or rehashing runtime state')

  const changed = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${episode.episode_code}/run`)
    .send({ ...body, custom_instructions: 'A different submitted body.' })
  assert.equal(changed.status, 409, JSON.stringify(changed.body))
})

test('manual Scene Plan omission uses only the configured pointer and rejects wrong-pool, deleted, and stale references', async () => {
  await setCurrentPresets()
  const activeEpisode = episodes[1]!
  await writeOldEpisodeContinuity(activeEpisode.episode_code)
  const omitted = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${activeEpisode.episode_code}/run`)
    .send({
      stage: 'timeline', title: activeEpisode.title,
    })
  assert.equal(omitted.status, 201, JSON.stringify(omitted.body))
  assert.equal(omitted.body.params.resolved_preset?.id, 'scene-active')
  assert.equal(omitted.body.params.use_research, true)
  assert.equal(omitted.body.params.prompt_pack_size, 'auto')
  assert.equal(omitted.body.params.prompt_max_tokens, 'auto')
  assert.equal(omitted.body.params.creative_direction, undefined)
  assert.equal(omitted.body.params.custom_instructions, undefined)
  assert.equal(omitted.body.params.avoid_legible_text, undefined)
  assert.deepEqual(omitted.body.params.pacing, { mode: 'uniform', min_sec: 24, max_sec: 24 })
  assert.deepEqual(omitted.body.params.motion_scope, { mode: 'selected', scene_ids: ['episode-only-scene'] },
    'a sparse preset falls back to the current saved episode continuity')

  const wrongPoolEpisode = episodes[2]!
  const wrongPool = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${wrongPoolEpisode.episode_code}/run`)
    .send({
      stage: 'timeline', title: wrongPoolEpisode.title, preset_id: 'script-wrong-pool',
      operation_id: '81030000-0000-4000-8000-000000000003',
    })
  assert.equal(wrongPool.status, 409, JSON.stringify(wrongPool.body))
  assert.match(wrongPool.body.detail || '', /preset|scene plan|current/i)

  const deleted = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${wrongPoolEpisode.episode_code}/run`)
    .send({
      stage: 'timeline', title: wrongPoolEpisode.title, preset_id: 'deleted-scene-preset',
      operation_id: '81040000-0000-4000-8000-000000000004',
    })
  assert.equal(deleted.status, 409, JSON.stringify(deleted.body))

  await setCurrentPresets('stale-selected-id')
  const staleEpisode = episodes[3]!
  const stale = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${staleEpisode.episode_code}/run`)
    .send({
      stage: 'timeline', title: staleEpisode.title,
      operation_id: '81050000-0000-4000-8000-000000000005',
    })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.match(stale.body.detail || '', /preset|selected|missing/i)
})

test('manual and Pipeline accept the same numeric preset cap without an intended image model', async () => {
  const project = await pm.createProject({ name: 'Numeric Scene Plan cap parity' })
  await pm.updateConfig(project.slug, {
    scene_plan_presets: [{
      id: 'numeric-cap', name: 'Numeric cap', type: 'scene-plan',
      data: { model: 'mock-chat-v1', prompt_char_cap: 3_210, motion_scope: { mode: 'all' } },
    }],
    'scene_plan_last_preset_scene-plan': 'numeric-cap',
  } as any)
  const rows = await ideas.addIdeas(project.slug, ['Manual numeric cap', 'Pipeline numeric cap'].map(title => ({
    title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  })), 'mock-chat-v1')
  const manualEpisode = await ideas.acceptIdea(project.slug, rows[0]!.id, false)
  const pipelineEpisode = await ideas.acceptIdea(project.slug, rows[1]!.id, false)
  for (const episodeId of [manualEpisode.episode_code, pipelineEpisode.episode_code]) {
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    await fs.mkdir(paths.episode_dir, { recursive: true })
    await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({
      pacing: { mode: 'uniform', min_sec: 6, max_sec: 9 },
      motion_scope: { mode: 'off' },
      motion_level: 2,
    }))
  }
  await ideas.setEpisodeStatusOverrides(project.slug, pipelineEpisode.episode_code, {
    script: true, merged_audio: true, subtitles: true,
  })

  const manual = await request(app)
    .post(`/api/projects/${project.slug}/scene-plan/${manualEpisode.episode_code}/run`)
    .send({
      stage: 'timeline', title: 'Manual numeric cap', preset_id: 'numeric-cap',
      operation_id: '81210000-0000-4000-8000-000000000021',
    })
  assert.equal(manual.status, 201, JSON.stringify(manual.body))
  assert.equal(manual.body.params.prompt_char_cap, 3_210)

  const pipeline = await request(app)
    .post(`/api/projects/${project.slug}/pipeline/run-batch`)
    .send({
      episode_ids: [pipelineEpisode.episode_code], steps: ['scene_plan'], force: true,
      operation_id: '81220000-0000-4000-8000-000000000022',
      preset_ids: { scene_plan: 'numeric-cap' },
    })
  assert.equal(pipeline.status, 201, JSON.stringify(pipeline.body))
  const accepted = jq.getJob(pipeline.body.jobs[0].job_id)!
  assert.equal(accepted.params.prompt_char_cap, manual.body.params.prompt_char_cap,
    'Pipeline and manual admission use the same exact preset value')
  assert.deepEqual(accepted.params.motion_scope, { mode: 'all' },
    'the exact portable preset scope wins over the captured episode-owned selection')
})

test('NEW admissions reject present malformed preset identities while accepted replay still wins first', async () => {
  await setCurrentPresets()
  const malformedManual = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${episodes[2]!.episode_code}/run`)
    .send({ stage: 'timeline', preset_id: null, operation_id: '81110000-0000-4000-8000-000000000011' })
  assert.equal(malformedManual.status, 409, JSON.stringify(malformedManual.body))
  assert.match(malformedManual.body.detail || '', /non-empty string/i)

  const malformedNewPipeline = await request(app).post(`/api/projects/${projectSlug}/pipeline/run-batch`).send({
    episode_ids: [episodes[2]!.episode_code], steps: ['scene_plan'], force: true,
    operation_id: '81120000-0000-4000-8000-000000000012', preset_ids: null,
  })
  assert.equal(malformedNewPipeline.status, 400, JSON.stringify(malformedNewPipeline.body))
  assert.match(malformedNewPipeline.body.detail || '', /preset_ids/i)

  const acceptedBody = {
    episode_ids: ['EP9301'], steps: ['scene_plan'], force: true,
    operation_id: '81130000-0000-4000-8000-000000000013', preset_ids: null,
  }
  const accepted = jq.enqueuePreparedForTest({
    project_slug: projectSlug, type: 'scene_plan_run', episode_id: 'EP9301', title: 'Historical accepted DTO',
    params: {
      ...stampFreshGenerationAction(acceptedBody, acceptedBody.operation_id),
      episode_id: 'EP9301', pipeline_batch_id: acceptedBody.operation_id, pipeline_chain: [],
    },
  })
  const replay = await request(app).post(`/api/projects/${projectSlug}/pipeline/run-batch`).send(acceptedBody)
  assert.equal(replay.status, 201, JSON.stringify(replay.body))
  assert.deepEqual(replay.body.reused_jobs, [{ episode_id: 'EP9301', job_id: accepted.job_id, type: 'scene_plan_run' }])
})

test('manual Scene Plan binds an accepted UUID to its episode and serializes overlapping admission', async () => {
  await setCurrentPresets()
  const firstEpisode = episodes[2]!
  const otherEpisode = episodes[3]!
  await Promise.all([
    writeOldEpisodeContinuity(firstEpisode.episode_code),
    writeOldEpisodeContinuity(otherEpisode.episode_code),
  ])
  const body = {
    stage: 'timeline', preset_id: 'scene-active',
    operation_id: '81070000-0000-4000-8000-000000000007',
  }
  const [left, right] = await Promise.all([
    request(app).post(`/api/projects/${projectSlug}/scene-plan/${firstEpisode.episode_code}/run`).send(body),
    request(app).post(`/api/projects/${projectSlug}/scene-plan/${firstEpisode.episode_code}/run`).send(body),
  ])
  assert.deepEqual([left.status, right.status].sort(), [200, 201],
    `overlap must adopt one accepted job: ${JSON.stringify([left.body, right.body])}`)
  assert.equal(left.body.job_id, right.body.job_id)

  const crossEpisode = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${otherEpisode.episode_code}/run`)
    .send(body)
  assert.equal(crossEpisode.status, 409, JSON.stringify(crossEpisode.body))
  assert.match(crossEpisode.body.detail || '', /episode|route|belongs/i)

  const wrongRouteBody = {
    stage: 'timeline', preset_id: 'scene-active',
    operation_id: '81140000-0000-4000-8000-000000000014',
  }
  jq.enqueuePreparedForTest({
    project_slug: projectSlug, type: 'chapter-only', episode_id: otherEpisode.episode_code,
    title: 'Different accepted route', params: stampFreshGenerationAction(wrongRouteBody, wrongRouteBody.operation_id),
  })
  const wrongRoute = await request(app)
    .post(`/api/projects/${projectSlug}/scene-plan/${otherEpisode.episode_code}/run`)
    .send(wrongRouteBody)
  assert.equal(wrongRoute.status, 409, JSON.stringify(wrongRoute.body))
  assert.match(wrongRoute.body.detail || '', /route|belongs/i)
})

test('manual motion resolves the portable preset scope before freezing current-episode targets', async () => {
  const episode = episodes[3]!
  const paths = await resolveEpisodePathsByCode(projectSlug, episode.episode_code)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({
    motion_scope: { mode: 'selected', scene_ids: ['episode-scene-a'] },
    motion_level: 1,
  }))
  await fs.writeFile(path.join(paths.episode_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
    { id: 'episode-scene-a', start_sec: 0, end_sec: 5, visual_prompt: 'A', motion_prompt: '' },
    { id: 'episode-scene-b', start_sec: 5, end_sec: 10, visual_prompt: 'B', motion_prompt: '' },
  ] }))
  const snapshot = await scenePlanVisualSnapshot(
    projectSlug, episode.episode_code, 'motion', undefined, { mode: 'all' },
  )
  assert.deepEqual(snapshot.motion_scope, { mode: 'all' })
  assert.deepEqual(snapshot.motion_scene_ids, ['episode-scene-a', 'episode-scene-b'])
})

test('Pipeline adopts an accepted raw action before current preset, catalogue, key, or episode preflight', async () => {
  const body = {
    episode_ids: ['EP9999'], steps: ['scene_plan'], force: true,
    operation_id: '81060000-0000-4000-8000-000000000006',
    preset_ids: { scene_plan: 'scene-retired-after-acceptance' },
  }
  const stamped = stampFreshGenerationAction(body, body.operation_id)
  const accepted = jq.enqueuePreparedForTest({
    project_slug: projectSlug,
    type: 'scene_plan_run',
    episode_id: 'EP9999',
    title: 'Accepted Pipeline Scene Plan',
    params: {
      ...stamped,
      episode_id: 'EP9999',
      model: 'captured-model',
      pacing: paced,
      resolved_preset: {
        pool: 'scene_plan_presets', id: 'scene-retired-after-acceptance',
        content_fingerprint: 'a'.repeat(64),
        data: { model: 'captured-model', pacing: paced },
      },
      pipeline_batch_id: body.operation_id,
    },
  })
  const before = structuredClone(accepted.params)
  await pm.updateConfig(projectSlug, {
    scene_plan_presets: [],
    'scene_plan_last_preset_scene-plan': 'deleted-after-acceptance',
  } as any)
  await secrets.setApiKey('genstudio', '')

  const replay = await request(app)
    .post(`/api/projects/${projectSlug}/pipeline/run-batch`)
    .send(body)
  assert.equal(replay.status, 201, JSON.stringify(replay.body))
  assert.deepEqual(replay.body.reused_jobs, [{
    episode_id: 'EP9999', job_id: accepted.job_id, type: 'scene_plan_run',
  }])
  assert.deepEqual(jq.getJob(accepted.job_id)?.params, before)

  const changed = await request(app)
    .post(`/api/projects/${projectSlug}/pipeline/run-batch`)
    .send({ ...body, preset_ids: { scene_plan: 'different-preset' } })
  assert.equal(changed.status, 409, JSON.stringify(changed.body))
})

test('Pipeline force replay reports unaccepted requested episodes as incomplete without redispatch', async () => {
  const body = {
    episode_ids: ['EP9101', 'EP9102'], steps: ['scene_plan'], force: true,
    operation_id: '81080000-0000-4000-8000-000000000008',
    preset_ids: { scene_plan: 'captured-scene' },
  }
  const stamped = stampFreshGenerationAction(body, body.operation_id)
  const accepted = jq.enqueuePreparedForTest({
    project_slug: projectSlug, type: 'scene_plan_run', episode_id: 'EP9101', title: 'Accepted subset',
    params: { ...stamped, episode_id: 'EP9101', pipeline_batch_id: body.operation_id, pipeline_chain: [] },
  })
  const replay = await request(app).post(`/api/projects/${projectSlug}/pipeline/run-batch`).send(body)
  assert.equal(replay.status, 201, JSON.stringify(replay.body))
  assert.deepEqual(replay.body.reused_jobs, [{ episode_id: 'EP9101', job_id: accepted.job_id, type: 'scene_plan_run' }])
  assert.deepEqual(replay.body.incomplete_episode_ids, ['EP9102'])
  assert.ok(replay.body.blocked.some((item: any) => item.episode_id === 'EP9102'))
  assert.equal(replay.body.enqueued, 0)
})

test('Pipeline repair replay uses immutable raw ownership before mutable preflight and rejects unverifiable legacy rows', async () => {
  const body = {
    episode_ids: ['EP9201'], steps: ['scene_plan'], repair_missing: true,
    action_id: '81090000-0000-4000-8000-000000000009',
    preset_ids: { scene_plan: 'deleted-after-acceptance' },
  }
  const rawFingerprint = pipelineRepairFingerprint(body)
  const accepted = jq.enqueuePreparedForTest({
    project_slug: projectSlug, type: 'scene_plan_run', episode_id: 'EP9201', title: 'Accepted repair',
    params: {
      episode_id: 'EP9201', pipeline_batch_id: body.action_id, pipeline_chain: [],
      pipeline_repair: { action_id: body.action_id },
      pipeline_repair_raw_request_fingerprint: rawFingerprint,
      pipeline_repair_request_fingerprint: 'resolved-proof-is-not-raw-proof',
    },
  })
  const replay = await request(app).post(`/api/projects/${projectSlug}/pipeline/run-batch`).send(body)
  assert.equal(replay.status, 201, JSON.stringify(replay.body))
  assert.deepEqual(replay.body.reused_jobs, [{ episode_id: 'EP9201', job_id: accepted.job_id, type: 'scene_plan_run' }])

  const legacyBody = { ...body, action_id: '81100000-0000-4000-8000-000000000010' }
  const legacy = jq.enqueuePreparedForTest({
    project_slug: projectSlug, type: 'scene_plan_run', episode_id: 'EP9202', title: 'Legacy repair',
    params: {
      episode_id: 'EP9202', pipeline_batch_id: legacyBody.action_id, pipeline_chain: [],
      pipeline_repair: { action_id: legacyBody.action_id },
      pipeline_repair_request_fingerprint: 'legacy-resolved-proof',
    },
  })
  const incompatible = await request(app).post(`/api/projects/${projectSlug}/pipeline/run-batch`).send(legacyBody)
  assert.equal(incompatible.status, 409, JSON.stringify(incompatible.body))
  assert.equal(incompatible.body.code, 'accepted_repair_unverifiable')
  assert.deepEqual(incompatible.body.saved_jobs, [{ episode_id: 'EP9202', job_id: legacy.job_id, type: 'scene_plan_run' }])
})
