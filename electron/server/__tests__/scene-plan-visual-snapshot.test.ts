import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

test('Scene Plan freezes explicit pacing and exact Next N motion targets before enqueue', async () => {
  const temp = await useTempDataDir()
  const previousDisableListen = process.env.STORY_STUDIO_DISABLE_LISTEN
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const pm = await import('../services/project-manager.js')
    const im = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { assertQueuedVisualSource } = await import('../services/video-visual-source.js')
    const { scenePlanMotionPromptSnapshot, scenePlanVisualSnapshot } = await import('../routes/scene-plan.js')
    const project = await pm.createProject({ name: 'Scene scope snapshot', episode_prefix: 'EP', episode_digits: 3 })
    const [idea] = await im.addIdeas(project.slug, [{ title: 'Scope fixture', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
    const accepted = await im.acceptIdea(project.slug, idea!.id, false)
    const code = accepted.episode_code
    const dirs = await resolveEpisodePathsByCode(project.slug, code)
    await fs.mkdir(dirs.scene_prompts_dir, { recursive: true })
    const settings = { schema_version: 1, pacing: { mode: 'variable', periods: [
      { start_sec: 0, end_sec: 60, min_sec: 1, max_sec: 3 },
      { start_sec: 60, end_sec: null, min_sec: 10, max_sec: 20 },
    ] }, motion_scope: { mode: 'all' }, motion_level: 3 }
    await fs.writeFile(path.join(dirs.episode_dir, 'continuity.json'), JSON.stringify(settings))
    await fs.writeFile(path.join(dirs.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'a', start_sec: 0, end_sec: 5, visual_prompt: 'A', motion_prompt: 'Already saved' },
      { id: 'b', start_sec: 5, end_sec: 10, visual_prompt: 'B' },
      { id: 'c', start_sec: 10, end_sec: 15, visual_prompt: 'C' },
    ] }))
    const timeline = await scenePlanVisualSnapshot(project.slug, code, 'timeline')
    assert.equal(timeline.pacing?.mode, 'variable')
    assert.equal(timeline.pacing?.min_sec, 1)
    const motion = await scenePlanVisualSnapshot(project.slug, code, 'motion', 1)
    assert.deepEqual(motion.motion_scene_ids, ['b'])
    assert.equal(motion.motion_level, 3)
    const singleMotion = await scenePlanMotionPromptSnapshot(project.slug, code, 'b')
    assert.deepEqual(singleMotion, {
      visual_source: 'scene_plan',
      motion_scope: { mode: 'all' },
      motion_level: 3,
      motion_scene_ids: ['b'],
    })
    const jq = await import('../services/job-queue.js')
    const replayOperationId = '00000000-0000-4000-8000-000000000012'
    let replayJob: { job_id: string } | null = null
    await jq.setQueuePaused(true)
    try {
      replayJob = await jq.enqueue({
        project_slug: project.slug,
        type: 'scene_plan_run',
        episode_id: code,
        title: `Regen motion prompt — ${code}`,
        params: {
          ...singleMotion,
          episode_id: code,
          model: 'mock-chat-v1',
          regenerate_motion_prompt_scene_id: 'b',
          generation_action: { id: replayOperationId, kind: 'fresh' },
          generation_action_fingerprint: 'accepted-motion-prompt-snapshot',
        },
      } as any)
      settings.motion_scope = { mode: 'off' }
      await fs.writeFile(path.join(dirs.episode_dir, 'continuity.json'), JSON.stringify(settings))
      const { app } = await import('../app.js')
      const replay = await request(app)
        .post(`/api/projects/${project.slug}/scene-plan/${code}/regenerate-motion-prompt`)
        .send({ scene_id: 'b', model: 'genstudio-chat:mock-chat-v1', operation_id: replayOperationId })
        .expect(200)
      assert.equal(replay.body.reused, true)
      assert.deepEqual(replay.body.params.motion_scene_ids, ['b'])
      assert.equal(replay.body.params.motion_level, 3)
    } finally {
      if (replayJob) {
        await jq.requestJobCancellation(project.slug, replayJob.job_id)
        jq.removeTerminalJob(project.slug, replayJob.job_id)
      }
      await jq.drainJobPersistenceForShutdown(1_000)
      await jq.setQueuePaused(false)
      await jq.drainJobPersistenceForShutdown(1_000)
    }
    assert.deepEqual(motion.motion_scene_ids, ['b'], 'accepted request object remains immutable from later episode edits')
    assert.deepEqual(singleMotion.motion_scene_ids, ['b'], 'accepted single-scene request remains exact after later episode edits')
    assert.equal(singleMotion.motion_level, 3)
    assert.deepEqual((await scenePlanVisualSnapshot(project.slug, code, 'motion')).motion_scene_ids, [])
    await assert.rejects(
      () => scenePlanMotionPromptSnapshot(project.slug, code, 'b'),
      /outside this episode's saved motion scope/i,
    )
    const { app } = await import('../app.js')
    const blockedByScope = await request(app)
      .post(`/api/projects/${project.slug}/scene-plan/${code}/regenerate-motion-prompt`)
      .send({ scene_id: 'b', model: 'unused', operation_id: '00000000-0000-4000-8000-000000000011' })
      .expect(409)
    assert.match(blockedByScope.body.detail, /outside this episode's saved motion scope/i)
    const visualReplayOperationId = '00000000-0000-4000-8000-000000000014'
    const { stampFreshGenerationAction } = await import('../lib/fresh-generation-action.js')
    let visualReplayJob: { job_id: string } | null = null
    await jq.setQueuePaused(true)
    try {
      visualReplayJob = await jq.enqueue({
        project_slug: project.slug,
        type: 'scene_plan_run',
        episode_id: code,
        title: `Regen prompt — ${code}`,
        params: stampFreshGenerationAction({
          visual_source: 'scene_plan',
          motion_scope: { mode: 'off' },
          motion_level: 2,
          episode_id: code,
          model: 'mock-chat-v1',
          regenerate_prompt_scene_id: 'a',
        }, visualReplayOperationId),
      } as any)
      await fs.writeFile(path.join(dirs.episode_dir, 'broll-selection.json'), JSON.stringify({ source: 'image_pool' }))
      const replay = await request(app)
        .post(`/api/projects/${project.slug}/scene-plan/${code}/regenerate-prompt`)
        .send({ scene_id: 'a', model: 'mock-chat-v1', operation_id: visualReplayOperationId })
        .expect(200)
      assert.equal(replay.body.reused, true)
      assert.equal(replay.body.job_id, visualReplayJob.job_id)
    } finally {
      if (visualReplayJob) {
        await jq.requestJobCancellation(project.slug, visualReplayJob.job_id)
        jq.removeTerminalJob(project.slug, visualReplayJob.job_id)
      }
      await jq.drainJobPersistenceForShutdown(1_000)
      await jq.setQueuePaused(false)
      await jq.drainJobPersistenceForShutdown(1_000)
    }
    await assert.rejects(() => scenePlanVisualSnapshot(project.slug, code, 'timeline'), /uses Image Pool/)
    const queued = { project_slug: project.slug, episode_id: code, type: 'scene_plan_run', params: { visual_source: 'scene_plan' } } as any
    await assert.rejects(() => assertQueuedVisualSource(queued), /visual source changed/)
    await assertQueuedVisualSource({ ...queued, type: 'metadata' })
    await assertQueuedVisualSource({ ...queued, params: {} })
    await assert.rejects(() => assertQueuedVisualSource({ ...queued, genstudio_jobs: [{
      id: 'pending:scene-plan-request', operation: 'chat.response', state: 'submitting', updated_at: new Date().toISOString(),
    }] }), /visual source changed/)
    await assert.rejects(() => assertQueuedVisualSource({ ...queued, genstudio_jobs: [{
      id: 'pending:scene-plan-request', operation: 'chat.response', state: 'not_created', updated_at: new Date().toISOString(),
    }] }), /visual source changed/)
    await assertQueuedVisualSource({ ...queued, genstudio_jobs: [{
      id: 'accepted-task', operation: 'chat.response', state: 'accepted', updated_at: new Date().toISOString(),
    }] })
    await assert.rejects(() => assertQueuedVisualSource({ ...queued, type: 'video_assembly' }), /visual source changed/)
    await assertQueuedVisualSource({ ...queued, params: { visual_source: 'image_pool' } })

    for (const [endpoint, body] of [
      [`/api/projects/${project.slug}/scene-plan/${code}/run`, { stage: 'visual', model: 'unused' }],
      [`/api/projects/${project.slug}/scene-plan/${code}/regenerate-prompt`, { scene_id: 'a', model: 'unused', operation_id: 'source-visual-one' }],
      [`/api/projects/${project.slug}/scene-plan/${code}/regenerate-empty-prompts`, { model: 'unused' }],
      [`/api/projects/${project.slug}/scene-plan/${code}/regenerate-motion-prompt`, { scene_id: 'a', model: 'unused', operation_id: '00000000-0000-4000-8000-000000000013' }],
    ] as const) {
      const response = await request(app).post(endpoint).send(body)
      assert.equal(response.status, 409, endpoint)
      assert.match(response.body.detail, /uses Image Pool/, endpoint)
    }
  } finally {
    if (previousDisableListen === undefined) delete process.env.STORY_STUDIO_DISABLE_LISTEN
    else process.env.STORY_STUDIO_DISABLE_LISTEN = previousDisableListen
    await temp.cleanup()
  }
})
