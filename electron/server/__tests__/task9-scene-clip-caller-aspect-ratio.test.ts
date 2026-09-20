import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

async function createReadyMotionEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: name,
    logline: 'Disposable caller aspect-ratio fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [{
    id: 'scene-ratio',
    scene_index: 1,
    start_sec: 0,
    end_sec: 8,
    approved: true,
    motion_choice: 'clip',
    motion_prompt: 'The camera drifts across a square archive.',
  }] }))
  await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({
    motion_scope: { mode: 'all' },
    motion_level: 2,
  }))
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const imageDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
  await fs.mkdir(imageDir, { recursive: true })
  await fs.writeFile(path.join(imageDir, 'scene-ratio.png'), ONE_PIXEL_PNG)
  return { project, episodeId }
}

test('Scene Review HTTP does not invent 16:9 when a clip request omits its ratio', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let queuedJobId = ''
  let wasQueuePaused = false
  try {
    const settings = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    const jq = await import('../services/job-queue.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    service.setVideoModels([{
      id: 'mock-video-ratio-route',
      display_name: 'Mock Video Ratio Route',
      available: true,
      modes: ['image-to-video'],
      aspect_ratios: ['4:3'],
      variants: [{
        operation: 'image-to-video',
        duration_seconds: 5,
        resolution: '720p',
        credits_per_video: 50,
        minimum_credits: 50,
        price_version: 'mock-route-ratio-v1',
      }],
    }])
    clearGenStudioCatalogCache()
    wasQueuePaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    const { app } = await import('../app.js')
    const { project, episodeId } = await createReadyMotionEpisode('Missing HTTP clip ratio')

    const response = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-clip`)
      .send({
        scene_id: 'scene-ratio',
        model: 'mock-video-ratio-route',
        operation: 'image-to-video',
        duration_seconds: 5,
        resolution: '720p',
      })

    assert.ok(response.status === 201 || response.status === 400, `unexpected HTTP ${response.status}`)
    if (response.status === 201) {
      queuedJobId = response.body.job_id
      assert.equal(response.body.params.aspect_ratio, undefined,
        'an omitted caller ratio must stay absent for the executor required-field check')
      assert.equal(jq.getJob(queuedJobId)?.params.aspect_ratio, undefined)
    } else {
      assert.match(response.body.detail, /aspect ratio.*required/i)
    }
    assert.equal(service.providerSubmissionCount('video'), 0)
  } finally {
    const jq = await import('../services/job-queue.js')
    const queued = queuedJobId ? jq.getJob(queuedJobId) : null
    if (queued) {
      await jq.requestJobCancellation(queued.project_slug, queuedJobId)
      jq.removeTerminalJob(queued.project_slug, queuedJobId)
    }
    assert.equal(await jq.drainJobPersistenceForShutdown(1_000), true,
      'queued-job cancellation and persistence must drain before the fixture root is removed')
    if (!wasQueuePaused) await jq.setQueuePaused(false)
    assert.equal(await jq.drainJobPersistenceForShutdown(1_000), true,
      'restoring the queue must not leave a late worker or persistence write behind')
    await service.close()
    await temp.cleanup()
  }
})

test('Pipeline motion params preserve an explicit published ratio and leave omission absent', async () => {
  const { resolveStepParams } = await import('../routes/pipeline.js')
  const base = {
    model: 'mock-video-ratio-route',
    operation: 'image-to-video',
    duration_seconds: 5,
    resolution: '720p',
  }
  const missing = resolveStepParams('motion_review', 'EP001', 'Missing ratio', {
    id: 'motion-missing-ratio',
    name: 'Missing ratio',
    data: base,
  })
  const explicit = resolveStepParams('motion_review', 'EP002', 'Published ratio', {
    id: 'motion-published-ratio',
    name: 'Published ratio',
    data: { ...base, aspect_ratio: '4:3' },
  })

  assert.equal(missing.aspect_ratio, undefined)
  assert.equal(explicit.aspect_ratio, '4:3')
})
