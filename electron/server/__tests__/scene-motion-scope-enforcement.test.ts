import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

async function createEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Motion scope fixture', logline: 'A deterministic scope fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return { project, episodeId: accepted.episode_code, paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code) }
}

async function writeMotionPlan(
  projectSlug: string,
  episodeId: string,
  paths: { episode_dir: string; scene_prompts_dir: string; subtitles_dir: string },
  scope: unknown,
  withImages: boolean,
): Promise<void> {
  const scenes = [
    { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8, approved: true, visual_prompt: 'A still archive.', motion_prompt: 'A slow drift.' },
    { id: 'scene-b', scene_index: 2, start_sec: 8, end_sec: 16, approved: true, visual_prompt: 'A quiet hall.', motion_prompt: 'A gentle push.' },
    { id: 'scene-c', scene_index: 3, start_sec: 16, end_sec: 24, approved: true, visual_prompt: 'A faded map.', motion_prompt: 'A steady pan.' },
  ]
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes }))
  await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({ schema_version: 1, motion_scope: scope }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nScope fixture\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
  if (!withImages) return
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const imageDir = await resolveSceneImagesDir(projectSlug, episodeId, paths.episode_dir)
  await fs.mkdir(imageDir, { recursive: true })
  await Promise.all(scenes.map(scene => fs.writeFile(path.join(imageDir, `${scene.id}.png`), ONE_PIXEL_PNG)))
}

test('batch motion submission snapshots only the opening scenes selected on the narration timeline', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let queued: { slug: string; jobId: string } | null = null
  try {
    const settings = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    const jq = await import('../services/job-queue.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    clearGenStudioCatalogCache()
    service.setVideoModels([{
      id: 'mock-video-v1', display_name: 'Mock Video', available: true, modes: ['image-to-video'], aspect_ratios: ['16:9'],
      variants: [{ operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'mock-price' }],
    }])
    await jq.setQueuePaused(true)
    const { app } = await import('../app.js')
    const { project, episodeId, paths } = await createEpisode('Opening motion snapshot')
    await writeMotionPlan(project.slug, episodeId, paths, { mode: 'opening', end_sec: 12 }, true)

    const response = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-clips-batch`)
      .send({ model: 'mock-video-v1', operation: 'image-to-video', duration_seconds: 5, resolution: '720p' })
      .expect(201)
    queued = { slug: project.slug, jobId: response.body.job_id }

    assert.deepEqual(response.body.params.motion_scene_ids, ['scene-a'])
    assert.deepEqual(Object.keys(response.body.params.scene_durations), ['scene-a'])
    assert.equal(response.body.params.visual_source, 'scene_plan')
    const outsideScope = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-clip`)
      .send({ model: 'mock-video-v1', scene_id: 'scene-b', operation: 'image-to-video', duration_seconds: 5, resolution: '720p' })
      .expect(409)
    assert.match(outsideScope.body.detail, /outside.*saved motion scope/i)
    await fs.writeFile(path.join(paths.episode_dir, 'broll-selection.json'), JSON.stringify({
      schema_version: 1, episode_code: episodeId, source: 'image_pool',
    }))
    const { assertQueuedVisualSource } = await import('../services/video-visual-source.js')
    await assert.rejects(
      () => assertQueuedVisualSource({
        project_slug: project.slug, episode_id: episodeId, type: 'scene_clips_batch', params: response.body.params,
      } as any),
      /visual source changed/i,
    )
    for (const endpoint of [
      `generate-clips-batch`,
      `generate-missing-clips`,
      `generate-clip`,
    ]) {
      const payload = endpoint === 'generate-clip'
        ? { model: 'mock-video-v1', scene_id: 'scene-a', operation: 'image-to-video', duration_seconds: 5, resolution: '720p' }
        : { model: 'mock-video-v1', operation: 'image-to-video', duration_seconds: 5, resolution: '720p' }
      const blocked = await request(app)
        .post(`/api/projects/${project.slug}/scene-review/${episodeId}/${endpoint}`)
        .send(payload)
        .expect(409)
      assert.match(blocked.body.detail, /Motion Review is not used for Image Pool/i)
    }
    for (const [endpoint, payload] of [
      ['generate-image', { model: 'mock-video-v1', scene_id: 'scene-a', operation_id: '00000000-0000-4000-8000-000000000001' }],
      ['generate-missing', { model: 'mock-video-v1' }],
      ['continuity-render', { model: 'mock-video-v1' }],
      ['upload-image/scene-a', { filename: 'replacement.png', data_base64: ONE_PIXEL_PNG.toString('base64') }],
    ] as const) {
      const blocked = await request(app)
        .post(`/api/projects/${project.slug}/scene-review/${episodeId}/${endpoint}`)
        .send(payload)
        .expect(409)
      assert.match(blocked.body.detail, /Scene image (generation|replacement) is not used for Image Pool/i)
    }
    const mp4 = Buffer.alloc(12)
    mp4.write('ftyp', 4, 'ascii')
    const blockedUpload = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/upload-clip/scene-a`)
      .set('Content-Type', 'video/mp4')
      .send(mp4)
      .expect(409)
    assert.match(blockedUpload.body.detail, /Motion Review is not used for Image Pool/i)
    assert.equal(service.providerSubmissionCount('video'), 0)
  } finally {
    const jq = await import('../services/job-queue.js')
    if (queued) {
      await jq.requestJobCancellation(queued.slug, queued.jobId)
      jq.removeTerminalJob(queued.slug, queued.jobId)
    }
    await jq.drainJobPersistenceForShutdown(1_000)
    await jq.setQueuePaused(false)
    await jq.drainJobPersistenceForShutdown(1_000)
    await service.close()
    await temp.cleanup()
  }
})

test('batch execution does not broaden an accepted scene-id snapshot', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateSceneClipsBatchJob } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('Motion snapshot execution')
    await writeMotionPlan(project.slug, episodeId, paths, { mode: 'all' }, false)

    await assert.rejects(
      () => generateSceneClipsBatchJob({
        job_id: 'scope-snapshot', project_slug: project.slug, episode_id: episodeId,
        type: 'scene_clips_batch', title: 'Motion scope', status: 'running',
        created_at: new Date().toISOString(), started_at: new Date().toISOString(), output_lines: [], progress: 0,
        params: { episode_id: episodeId, model: 'genstudio-video:mock-video-v1', motion_scene_ids: ['scene-a'] },
      } as any),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /scene-a/)
        assert.doesNotMatch(message, /scene-b|scene-c/)
        return true
      },
    )
  } finally {
    await temp.cleanup()
  }
})

test('batch execution resolves a queued opening scope against the newly written plan before preflight', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateSceneClipsBatchJob } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('Motion scope after plan rebuild')
    await writeMotionPlan(project.slug, episodeId, paths, { mode: 'opening', end_sec: 20 }, false)
    const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
    plan.scenes[1].motion_choice = 'still'
    await fs.writeFile(planPath, JSON.stringify(plan))
    const job = {
      job_id: 'scope-after-rebuild', project_slug: project.slug, episode_id: episodeId,
      type: 'scene_clips_batch', title: 'Motion scope after rebuild', status: 'running',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(), output_lines: [], progress: 0,
      params: {
        episode_id: episodeId,
        model: 'genstudio-video:mock-video-v1',
        motion_scope: { mode: 'opening', end_sec: 20 },
      },
    } as any

    await assert.rejects(
      () => generateSceneClipsBatchJob(job),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /scene-a/)
        assert.doesNotMatch(message, /scene-b|scene-c/)
        return true
      },
    )
    assert.deepEqual(job.params.motion_scene_ids, ['scene-a'])
  } finally {
    await temp.cleanup()
  }
})

test('batch execution treats a queued off scope as complete without widening to plan scenes', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const { generateSceneClipsBatchJob } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('Motion off after plan rebuild')
    await writeMotionPlan(project.slug, episodeId, paths, { mode: 'off' }, false)
    const job = {
      job_id: 'scope-off-after-rebuild', project_slug: project.slug, episode_id: episodeId,
      type: 'scene_clips_batch', title: 'Motion off after rebuild', status: 'running',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(), output_lines: [], progress: 0,
      params: {
        episode_id: episodeId,
        model: 'genstudio-video:mock-video-v1',
        motion_scope: { mode: 'off' },
      },
    } as any

    await generateSceneClipsBatchJob(job)

    assert.deepEqual(job.params.motion_scene_ids, [])
    assert.equal(job.result?.completion?.expected, 0)
    assert.equal(job.result?.complete, true)
    assert.equal(service.providerSubmissionCount('video'), 0)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('batch execution rejects a stale queued selected scope instead of widening it', async () => {
  const temp = await useTempDataDir()
  try {
    const { generateSceneClipsBatchJob } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('Stale motion scope after plan rebuild')
    await writeMotionPlan(project.slug, episodeId, paths, { mode: 'off' }, false)
    const job = {
      job_id: 'scope-stale-after-rebuild', project_slug: project.slug, episode_id: episodeId,
      type: 'scene_clips_batch', title: 'Stale motion scope after rebuild', status: 'running',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(), output_lines: [], progress: 0,
      params: {
        episode_id: episodeId,
        model: 'genstudio-video:mock-video-v1',
        motion_scope: { mode: 'selected', scene_ids: ['removed-scene'] },
      },
    } as any

    await assert.rejects(() => generateSceneClipsBatchJob(job), /removed-scene.*no longer|no longer.*removed-scene/i)
    assert.equal(job.params.motion_scene_ids, undefined)
  } finally {
    await temp.cleanup()
  }
})

test('motion readiness ignores off-scope scenes without changing their still or clip choice', async () => {
  const temp = await useTempDataDir()
  try {
    const { computeEpisodeStatus } = await import('../services/asset-status.js')
    const { resolveVideoAssetsDir } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('Motion readiness scope')
    await writeMotionPlan(project.slug, episodeId, paths, { mode: 'selected', scene_ids: ['scene-a'] }, false)
    const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
    plan.scenes[0].motion_choice = 'clip'
    plan.scenes[0].rendered_motion_prompt = plan.scenes[0].motion_prompt
    await fs.writeFile(planPath, JSON.stringify(plan))
    const clipsDir = await resolveVideoAssetsDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(clipsDir, { recursive: true })
    await fs.writeFile(path.join(clipsDir, 'scene-a.mp4'), 'accepted clip')

    const status = await computeEpisodeStatus(project.slug, episodeId)

    assert.equal(status.motion_review, true)
    assert.equal(plan.scenes[1].motion_choice, undefined)
  } finally {
    await temp.cleanup()
  }
})

test('restart audits retain saved motion targets, including an explicit off-scope snapshot', async () => {
  const temp = await useTempDataDir()
  try {
    const { auditSceneClips, auditScenePlanOutput } = await import('../boot/executors.js')
    const { resolveVideoAssetsDir } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('Motion restart scope audit')
    await writeMotionPlan(project.slug, episodeId, paths, { mode: 'all' }, false)
    const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
    plan.scenes[0].motion_choice = 'clip'
    plan.scenes[0].rendered_motion_prompt = plan.scenes[0].motion_prompt
    plan.scenes[1].motion_prompt = ''
    await fs.writeFile(planPath, JSON.stringify(plan))
    const clipsDir = await resolveVideoAssetsDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(clipsDir, { recursive: true })
    await fs.writeFile(path.join(clipsDir, 'scene-a.mp4'), tinyVideoBytes())

    const base = { project_slug: project.slug, episode_id: episodeId }
    assert.equal(await auditScenePlanOutput({ ...base, params: { stage: 'motion', motion_scene_ids: ['scene-a'] } }), 'complete')
    assert.equal(await auditScenePlanOutput({ ...base, params: { stage: 'motion', motion_scene_ids: [] } }), 'complete')
    assert.equal(await auditScenePlanOutput({ ...base, params: { stage: 'motion' } }), 'repair-required')

    assert.equal(await auditSceneClips({ ...base, params: { motion_scene_ids: ['scene-a'] } }), 'complete')
    assert.equal(await auditSceneClips({ ...base, params: { motion_scene_ids: [] } }), 'complete')
    assert.equal(await auditSceneClips({ ...base, params: { scene_id: 'scene-b' } }), 'repair-required')
  } finally {
    await temp.cleanup()
  }
})

test('review status preserves Scene Review when saved motion scope is stale, and treats Image Pool as off', async () => {
  const temp = await useTempDataDir()
  try {
    const { app } = await import('../app.js')
    const stale = await createEpisode('Stale selected motion scope')
    await writeMotionPlan(stale.project.slug, stale.episodeId, stale.paths, { mode: 'selected', scene_ids: ['removed-scene'] }, false)

    const staleResponse = await request(app)
      .get(`/api/projects/${stale.project.slug}/scene-review/${stale.episodeId}`)
      .expect(200)
    assert.equal(staleResponse.body.scenes.length, 3)
    assert.deepEqual(staleResponse.body.motion_scene_ids, [])
    assert.match(staleResponse.body.motion_scope_error, /removed-scene.*no longer|no longer.*removed-scene/i)

    const imagePool = await createEpisode('Image Pool motion bypass')
    await writeMotionPlan(imagePool.project.slug, imagePool.episodeId, imagePool.paths, { mode: 'selected', scene_ids: ['removed-scene'] }, false)
    await fs.writeFile(path.join(imagePool.paths.episode_dir, 'broll-selection.json'), JSON.stringify({
      schema_version: 1, episode_code: imagePool.episodeId, source: 'image_pool',
    }))

    const imagePoolResponse = await request(app)
      .get(`/api/projects/${imagePool.project.slug}/scene-review/${imagePool.episodeId}`)
      .expect(200)
    assert.equal(imagePoolResponse.body.visual_source, 'image_pool')
    assert.deepEqual(imagePoolResponse.body.motion_scope, { mode: 'off' })
    assert.deepEqual(imagePoolResponse.body.motion_scene_ids, [])
    assert.equal(imagePoolResponse.body.motion_scope_error, undefined)
  } finally {
    await temp.cleanup()
  }
})

test('review status reports Image Pool even before any Scene Plan exists', async () => {
  const temp = await useTempDataDir()
  try {
    const { app } = await import('../app.js')
    const sourceOnly = await createEpisode('Source-only Image Pool')
    await fs.writeFile(path.join(sourceOnly.paths.episode_dir, 'broll-selection.json'), JSON.stringify({
      schema_version: 1, episode_code: sourceOnly.episodeId, source: 'image_pool',
    }))

    const response = await request(app)
      .get(`/api/projects/${sourceOnly.project.slug}/scene-review/${sourceOnly.episodeId}`)
      .expect(200)
    assert.equal(response.body.scene_plan, null)
    assert.equal(response.body.visual_source, 'image_pool')
  } finally {
    await temp.cleanup()
  }
})
