/**
 * Durable generation-control boundaries.
 *
 * These checks deliberately combine the real GenStudio video seam (to prove
 * callback timing) with focused source contracts for queue executors. The
 * source contracts guard wiring which is otherwise difficult to reach without
 * constructing full project media trees.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('continuity image workers stop claiming scenes at a cooperative pause boundary and report the episode denominator', () => {
  const continuity = source('../generators/continuity-render.ts')
  assert.match(continuity, /jq\.isPauseRequested\(job\.job_id\)/)
  assert.match(continuity, /jq\.pauseJobForStall\(job\.job_id/)
  assert.match(continuity, /total:\s*scenes\.length/)
  assert.match(continuity, /not_submitted:/)
  assert.match(continuity, /cancelled:/)
})

async function createEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Checkpoint ordering', logline: 'A deterministic mock episode.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return { project, episodeId: accepted.episode_code, paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code) }
}

async function configureMockGenStudio(baseUrl: string): Promise<void> {
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
}

async function writeScenePrerequisites(paths: { scene_prompts_dir: string; subtitles_dir: string }, episodeId: string): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [{ id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' }],
  }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nTest\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
}

async function writeReadyMotionScene(
  projectSlug: string,
  episodeId: string,
  paths: { scene_prompts_dir: string; episode_dir: string },
): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [{
      id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 8,
      visual_prompt: 'A lantern in a quiet archive.', motion_prompt: 'The camera drifts slowly forward.',
      approved: true,
    }],
  }))
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const imageDir = await resolveSceneImagesDir(projectSlug, episodeId, paths.episode_dir)
  await fs.mkdir(imageDir, { recursive: true })
  await fs.writeFile(path.join(imageDir, 'scene-001.png'), ONE_PIXEL_PNG)
}

async function waitForTerminalJob(
  jq: typeof import('../services/job-queue.js'),
  jobId: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = jq.getJob(jobId)?.status
    if (status && status !== 'queued' && status !== 'running') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function job(projectSlug: string, episodeId: string, type: string, params: Record<string, unknown>): any {
  return {
    job_id: `generation-control-${type}-${Date.now()}`,
    project_slug: projectSlug,
    type,
    episode_id: episodeId,
    title: 'Generation control test',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: { episode_id: episodeId, ...params },
  }
}

function statusPath(operation: 'image' | 'video', taskId: string): string {
  return operation === 'image' ? `/v1/images/${taskId}` : `/v1/videos/${taskId}`
}

function withFirstStatusAssertion(
  service: Awaited<ReturnType<typeof startMockGenStudioService>>,
  operation: 'image' | 'video',
  assertAccepted: (taskId: string) => Promise<void>,
): { restore: () => void; wasObserved: () => boolean } {
  const originalFetch = globalThis.fetch
  let observed = false
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!observed && url.origin === service.baseUrl && url.pathname.startsWith(operation === 'image' ? '/v1/images/' : '/v1/videos/')) {
      const taskId = url.pathname.split('/').at(-1)!
      if (url.pathname === statusPath(operation, taskId)) {
        observed = true
        await assertAccepted(taskId)
      }
    }
    return response
  }
  return { restore: () => { globalThis.fetch = originalFetch }, wasObserved: () => observed }
}

function enableMockVideoCatalog(
  service: Awaited<ReturnType<typeof startMockGenStudioService>>,
  variants?: Array<Record<string, unknown>>,
): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== service.baseUrl || !['/v1/video/models', '/v1/videos/models'].includes(url.pathname)) return response
    const models = await response.json() as Array<Record<string, unknown>>
    return new Response(JSON.stringify(models.map(model => ({ ...model, available: true, ...(variants ? { variants } : {}) }))), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return () => { globalThis.fetch = originalFetch }
}

test('GenStudio video reports each accepted variant before its first status poll', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  const accepted: Array<{ taskId: string; key: string; variantIndex: number; polledBeforeCallback: boolean }> = []
  const imagePath = path.join(temp.dir, 'source.png')
  await fs.writeFile(imagePath, ONE_PIXEL_PNG)

  try {
    const settings = await import('../services/app-settings.js')
    await settings.setGenStudioUrl(service.baseUrl)
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.origin !== service.baseUrl || !['/v1/video/models', '/v1/videos/models'].includes(url.pathname)) return response
      const models = await response.json() as Array<Record<string, unknown>>
      return new Response(JSON.stringify(models.map(model => ({ ...model, available: true }))), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    await import('../providers/video/genstudio.js')
    const { registry } = await import('../providers/registry.js')
    const provider = registry.getVideoProvider('genstudio-video')
    assert.ok(provider)

    service.reset()
    service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'] })
    service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'] })
    await provider.generateVideo({
      mode: 'frames',
      prompt: 'A slow camera move over an ancient stone observatory.',
      apiKey: MOCK_GENSTUDIO_FULL_KEY,
      aspectRatio: 'landscape',
      numberOfVideos: 2,
      modelId: 'mock-video-v1',
      startImagePath: imagePath,
      providerParams: { duration_seconds: 5, resolution: '720p' },
      idempotencyIdentity: 'generation-control-wiring',
      onJobAccepted: (taskId, key, variantIndex) => {
        accepted.push({
          taskId,
          key,
          variantIndex,
          polledBeforeCallback: service.requests.some(request => (
            request.method === 'GET' && request.path === `/v1/videos/${taskId}`
          )),
        })
      },
    })

    assert.deepEqual(accepted.map(item => item.variantIndex), [0, 1])
    assert.ok(accepted.every(item => item.taskId && item.key.startsWith('story-video-')))
    assert.ok(accepted.every(item => !item.polledBeforeCallback), 'accepted IDs must persist before polling')
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('the scene clip route persists the selected published variant on the queued job', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreVideoCatalog: (() => void) | undefined
  try {
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service, [
      { duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'mock-video-price-v1' },
      { duration_seconds: 8, resolution: '1080p', credits_per_video: 90, minimum_credits: 90, price_version: 'mock-video-price-v1' },
    ])
    const pm = await import('../services/project-manager.js')
    const jq = await import('../services/job-queue.js')
    const app = (await import('../app.js')).app
    const project = await pm.createProject({ name: 'Persist selected scene clip variant' })

    const response = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/EP001/generate-clip`)
      .send({
        scene_id: 'scene-001', model: 'mock-video-v1', aspect_ratio: '16:9',
        duration_seconds: 8, resolution: '1080p',
      })
      .expect(201)

    assert.equal(response.body.params.duration_seconds, 8)
    assert.equal(response.body.params.resolution, '1080p')
    assert.equal(service.submissions.filter(entry => entry.operation === 'video').length, 0)
    for (let attempt = 0; attempt < 100; attempt++) {
      const queued = jq.getJob(response.body.job_id)
      if (queued && queued.status !== 'queued' && queued.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally {
    restoreVideoCatalog?.()
    await service.close()
    await temp.cleanup()
  }
})

test('new Motion Review routes require an exact pair and preserve it for durable work', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreVideoCatalog: (() => void) | undefined
  try {
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service, [
      { duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'mock-video-price-v1' },
      { duration_seconds: 8, resolution: '1080p', credits_per_video: 90, minimum_credits: 90, price_version: 'mock-video-price-v1' },
    ])
    const pm = await import('../services/project-manager.js')
    const jq = await import('../services/job-queue.js')
    const app = (await import('../app.js')).app
    const project = await pm.createProject({ name: 'Motion routes require exact variants' })

    await request(app)
      .post(`/api/projects/${project.slug}/scene-review/EP001/generate-clip`)
      .send({ scene_id: 'scene-001', model: 'mock-video-v1' })
      .expect(400)
    await request(app)
      .post(`/api/projects/${project.slug}/scene-review/EP001/generate-clips-batch`)
      .send({ model: 'mock-video-v1', duration_seconds: 5 })
      .expect(400)
    await request(app)
      .post(`/api/projects/${project.slug}/scene-review/EP001/generate-missing-clips`)
      .send({ model: 'mock-video-v1', resolution: '720p' })
      .expect(400)
    assert.equal((await jq.getJobs(project.slug)).length, 0, 'invalid new requests never enter the queue')

    const durable = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/EP001/generate-clips-batch`)
      .send({ model: 'mock-video-v1', duration_seconds: 8, resolution: '1080p' })
      .expect(201)
    assert.equal(durable.body.params.duration_seconds, 8)
    assert.equal(durable.body.params.resolution, '1080p')
    await waitForTerminalJob(jq, durable.body.job_id)

    const episode = await createEpisode('Motion missing clips preserve selected variant')
    await writeReadyMotionScene(episode.project.slug, episode.episodeId, episode.paths)
    const missing = await request(app)
      .post(`/api/projects/${episode.project.slug}/scene-review/${episode.episodeId}/generate-missing-clips`)
      .send({ model: 'mock-video-v1', duration_seconds: 8, resolution: '1080p' })
      .expect(200)
    assert.equal(missing.body.queued, 1)
    const queued = (await jq.getJobs(episode.project.slug)).find(item => item.type === 'scene_clip_generate')
    assert.equal(queued?.params.duration_seconds, 8)
    assert.equal(queued?.params.resolution, '1080p')
    if (queued) await waitForTerminalJob(jq, queued.job_id)
  } finally {
    restoreVideoCatalog?.()
    await service.close()
    await temp.cleanup()
  }
})

test('Jobs retry preserves legacy Motion fallback and an exact selected variant', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreVideoCatalog: (() => void) | undefined
  try {
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service, [
      { duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'mock-video-price-v1' },
      { duration_seconds: 8, resolution: '1080p', credits_per_video: 90, minimum_credits: 90, price_version: 'mock-video-price-v1' },
    ])
    const jq = await import('../services/job-queue.js')
    const { generateSceneClipJob } = await import('../generators/scene-clip.js')
    const app = (await import('../app.js')).app
    const episode = await createEpisode('Jobs retry Motion variants')
    const imagePath = path.join(episode.paths.episode_dir, 'scene-source.png')
    await fs.writeFile(imagePath, ONE_PIXEL_PNG)
    await fs.mkdir(episode.paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(episode.paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      scenes: [{ id: 'scene-001', scene_index: 1, image_path: imagePath, motion_prompt: 'A slow drift across the archive shelves.' }],
    }))

    await request(app)
      .post(`/api/projects/${episode.project.slug}/scene-review/${episode.episodeId}/generate-clip`)
      .send({ scene_id: 'scene-001', model: 'mock-video-v1' })
      .expect(400)

    jq.registerExecutor('scene_clip_generate', async () => { throw new Error('legacy failure') })
    const legacy = jq.enqueuePreparedForTest({
      project_slug: episode.project.slug, type: 'scene_clip_generate', episode_id: episode.episodeId,
      title: 'Legacy motion clip', params: {
        episode_id: episode.episodeId, scene_id: 'scene-001', model: 'genstudio-video:mock-video-v1',
      },
    })
    await waitForTerminalJob(jq, legacy.job_id)
    assert.equal(jq.getJob(legacy.job_id)?.status, 'error')

    service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'] })
    jq.registerExecutor('scene_clip_generate', generateSceneClipJob)
    const legacyRetry = await request(app)
      .post(`/api/projects/${episode.project.slug}/jobs/${legacy.job_id}/retry`)
      .send({})
      .expect(202)
    assert.equal(legacyRetry.body.job.params.duration_seconds, undefined)
    assert.equal(legacyRetry.body.job.params.resolution, undefined)
    const submissionDeadline = Date.now() + 4_000
    while (Date.now() < submissionDeadline && !service.submissions.some(item => item.operation === 'video')) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const legacySubmission = service.submissions.filter(item => item.operation === 'video').at(-1)
    assert.equal(legacySubmission?.parsedBody?.duration_seconds, 5)
    assert.equal(legacySubmission?.parsedBody?.resolution, '720p')
    await waitForTerminalJob(jq, legacyRetry.body.job.job_id, 8_000)

    jq.registerExecutor('scene_clip_generate', async () => { throw new Error('selected failure') })
    const selected = jq.enqueuePreparedForTest({
      project_slug: episode.project.slug, type: 'scene_clip_generate', episode_id: episode.episodeId,
      title: 'Selected motion clip', params: {
        episode_id: episode.episodeId, scene_id: 'scene-001', model: 'genstudio-video:mock-video-v1',
        duration_seconds: 8, resolution: '1080p',
      },
    })
    await waitForTerminalJob(jq, selected.job_id)
    const selectedRetry = await request(app)
      .post(`/api/projects/${episode.project.slug}/jobs/${selected.job_id}/retry`)
      .send({})
      .expect(202)
    assert.equal(selectedRetry.body.job.params.duration_seconds, 8)
    assert.equal(selectedRetry.body.job.params.resolution, '1080p')
    await waitForTerminalJob(jq, selectedRetry.body.job.job_id)
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    restoreVideoCatalog?.()
    await service.close()
    await temp.cleanup()
  }
})

test('scene image writes its exact accepted task before the first image status read', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    const { generateSceneImageJob, resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { project, episodeId, paths } = await createEpisode('Scene checkpoint ordering')
    await writeScenePrerequisites(paths, episodeId)
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    service.queueScenario('image', { states: ['accepted', 'running', 'succeeded'] })
    const status = withFirstStatusAssertion(service, 'image', async taskId => {
      const entry = (await readManifest(outDir)).tasks['scene-001.png']
      const submission = service.submissions.find(item => item.jobId === taskId)
      assert.ok(entry, 'scene manifest exists before first provider poll')
      assert.ok(submission)
      assert.equal(entry.task_id, taskId)
      assert.equal(entry.idempotency_key, submission.idempotencyKey)
      assert.equal(entry.last_state, 'accepted')
    })
    try {
      await generateSceneImageJob(job(project.slug, episodeId, 'scene_image_generate', {
        scene_id: 'scene-001', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
      }))
    } finally {
      status.restore()
    }
    assert.ok(status.wasObserved(), 'scene image must poll the accepted task')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('composition template writes prepared then exact accepted work before its first image status read', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    const { generateCompositionTemplateJob } = await import('../generators/composition-template.js')
    const compositionFilename = 'composition.png'
    const { readManifest } = await import('../services/task-manifest.js')
    const { project, episodeId, paths } = await createEpisode('Composition checkpoint ordering')
    const outDir = path.join(paths.episode_dir, 'img2img-references')
    service.queueScenario('image', { states: ['accepted', 'running', 'succeeded'] })
    const status = withFirstStatusAssertion(service, 'image', async taskId => {
      const entry = (await readManifest(outDir)).tasks[compositionFilename]
      const submission = service.submissions.find(item => item.jobId === taskId)
      assert.ok(entry, 'composition manifest exists before first provider poll')
      assert.ok(submission)
      assert.equal(entry.task_id, taskId)
      assert.equal(entry.idempotency_key, submission.idempotencyKey)
      assert.equal(entry.last_state, 'accepted')
    })
    try {
      await generateCompositionTemplateJob(job(project.slug, episodeId, 'composition_template_generate', {
        model: 'mock-image-v1', prompt: 'A single central archival artifact on black velvet.', aspect_ratio: '16:9', resolution: '1K',
      }))
    } finally {
      status.restore()
    }
    assert.ok(status.wasObserved(), 'composition template must poll the accepted task')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('AI video writes the accepted variant checkpoint before its first video status read', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    const restoreVideoCatalog = enableMockVideoCatalog(service)
    await import('../providers/video/genstudio.js')
    const { generateAiVideo } = await import('../generators/ai-video.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { project, episodeId, paths } = await createEpisode('Video checkpoint ordering')
    await fs.writeFile(path.join(paths.bg_dir, `${episodeId}_Scene01_v1.png`), ONE_PIXEL_PNG)
    service.queueScenario('video', { states: ['accepted', 'running', 'succeeded'] })
    const status = withFirstStatusAssertion(service, 'video', async taskId => {
      const entry = (await readManifest(paths.video_dir)).tasks[`${episodeId}_Video01_v1.mp4`]
      const submission = service.submissions.find(item => item.jobId === taskId)
      assert.ok(entry, 'video manifest exists before first provider poll')
      assert.ok(submission)
      assert.equal(entry.task_id, taskId)
      assert.equal(entry.idempotency_key, submission.idempotencyKey)
      assert.equal(entry.last_state, 'accepted')
    })
    try {
      await generateAiVideo(job(project.slug, episodeId, 'ai_video_generate', {
        model: 'mock-video-v1', mode: 'frames', prompt_source: 'manual',
        manual_prompts: ['A slow push through a lamplit archive.'], number_of_videos_per_prompt: 1,
        aspect_ratio: 'landscape', duration_seconds: 5, resolution: '720p', force: false,
      }))
    } finally {
      status.restore()
      restoreVideoCatalog()
    }
    assert.ok(status.wasObserved(), 'AI video must poll the accepted task')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a scene clip with a removed selected variant fails before a GenStudio video POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    const restoreVideoCatalog = enableMockVideoCatalog(service)
    const { generateSceneClipJob } = await import('../generators/scene-clip.js')
    const { project, episodeId, paths } = await createEpisode('Scene clip stale variant')
    const imagePath = path.join(paths.episode_dir, 'scene-source.png')
    await fs.writeFile(imagePath, ONE_PIXEL_PNG)
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      scenes: [{
        id: 'scene-001', scene_index: 1, image_path: imagePath,
        motion_prompt: 'A slow drift across the archive shelves.',
      }],
    }))

    service.reset()
    await assert.rejects(
      generateSceneClipJob(job(project.slug, episodeId, 'scene_clip_generate', {
        scene_id: 'scene-001', model: 'mock-video-v1', aspect_ratio: '16:9',
        duration_seconds: 8, resolution: '1080p',
      })),
      /does not publish a 8s at 1080p option/,
    )
    assert.equal(service.submissions.filter(entry => entry.operation === 'video').length, 0)
    restoreVideoCatalog()
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('each GenStudio modality exposes its exact accepted identity before its first status read', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  const sourceImage = path.join(temp.dir, 'source.png')
  const sourceAudio = path.join(temp.dir, 'source.wav')
  await fs.writeFile(sourceImage, ONE_PIXEL_PNG)
  await fs.writeFile(sourceAudio, Buffer.from('RIFF mock audio'))
  try {
    await configureMockGenStudio(service.baseUrl)
    const client = await import('../lib/genstudio-client.js')
    const statusPrefix = { image: '/v1/images/', tts: '/v1/jobs/', transcription: '/v1/transcriptions/', video: '/v1/videos/' } as const
    for (const operation of ['image', 'tts', 'transcription', 'video'] as const) {
      service.reset()
      service.queueScenario(operation, { states: ['accepted', 'running', 'succeeded'] })
      let accepted: { taskId: string; key: string } | null = null
      let polled = false
      globalThis.fetch = async (input, init) => {
        const response = await originalFetch(input, init)
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        if (url.origin === service.baseUrl && new RegExp(`^${statusPrefix[operation]}mock-${operation}-\\d+$`).test(url.pathname)) {
          const taskId = url.pathname.split('/').at(-1)!
          assert.ok(accepted, `${operation} must expose acceptance before polling`)
          assert.equal(accepted.taskId, taskId)
          // Transcription persists the stable quote identity; its provider-side
          // confirm POST deliberately namespaces that same identity with
          // "-confirm". The other async products submit the checkpointed key
          // directly.
          const providerKey = service.submissions.find(item => item.jobId === taskId)?.idempotencyKey
          assert.equal(providerKey, operation === 'transcription' ? `${accepted.key}-confirm` : accepted.key)
          polled = true
        }
        return response
      }
      if (operation === 'image') {
        await client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          prompt: 'A tested image checkpoint.', modelId: 'mock-image-v1', aspectRatio: '16:9', requestIdentity: 'checkpoint:image',
          onJobAccepted: (taskId, key) => { accepted = { taskId, key } },
        })
      } else if (operation === 'tts') {
        await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, 'checkpoint.mp3'), {
          text: 'A tested speech checkpoint.', voiceId: 'mock-voice', modelId: 'mock-tts-v1', maxInputCharacters: 1_000, speed: 1,
          requestIdentity: 'checkpoint:tts', onJobAccepted: (taskId, key) => { accepted = { taskId, key } },
        })
      } else if (operation === 'transcription') {
        await client.transcribeWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          audioPath: sourceAudio, modelId: 'mock-whisper-v1', requestIdentity: 'checkpoint:transcription', language: 'en',
          onJobAccepted: (taskId, key) => { accepted = { taskId, key } },
        })
      } else {
        await client.generateVideoWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
          prompt: 'A tested video checkpoint.', modelId: 'mock-video-v1', sourceImagePath: sourceImage,
          aspectRatio: '16:9', durationSeconds: 5, resolution: '720p', requestIdentity: 'checkpoint:video',
          onJobAccepted: (taskId, key) => { accepted = { taskId, key } },
        })
      }
      assert.ok(polled, `${operation} must poll the accepted task`)
    }
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('an accepted GenStudio image stops local monitoring when its cancellation probe changes', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    const client = await import('../lib/genstudio-client.js')
    let cancelled = false
    let acceptedJobId = ''
    service.queueScenario('image', { states: ['accepted', 'running', 'succeeded'] })
    await assert.rejects(
      client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
        prompt: 'Stop local polling after acceptance.', modelId: 'mock-image-v1', aspectRatio: '16:9', requestIdentity: 'checkpoint:cancel',
        isCancelled: () => cancelled,
        onJobAccepted: taskId => { acceptedJobId = taskId; cancelled = true },
      }),
      /Cancelled by user/,
    )
    assert.ok(acceptedJobId)
    assert.equal(service.pollCount(acceptedJobId), 0, 'the changed cancellation probe must prevent polling')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('static mutation tripwires keep queue-producer wiring intact', () => {
  const sceneImage = source('../generators/scene-image.ts')
  const composition = source('../generators/composition-template.ts')
  const aiVideo = source('../generators/ai-video.ts')
  const genstudioVideo = source('../providers/video/genstudio.ts')

  assert.match(sceneImage, /isCancelled:\s*\(\)\s*=>\s*jq\.isCancelled\(job\.job_id\)/)
  assert.match(sceneImage, /onJobAccepted:\s*async\s*\(taskId,\s*\w+IdempotencyKey\)/)
  assert.match(sceneImage, /recordTaskStrict\(outDir,\s*`\$\{scene_id\}\.png`/)
  assert.match(sceneImage, /operation:\s*'image'/)
  assert.match(sceneImage, /last_state:\s*'accepted'/)

  assert.match(composition, /isCancelled:\s*\(\)\s*=>\s*jq\.isCancelled\(job\.job_id\)/)
  assert.match(composition, /const idempotencyKey\s*=\s*buildGenStudioImageIdempotencyKey/)
  assert.match(composition, /recordTaskStrict\(outDir,\s*COMPOSITION_FILENAME/)
  assert.match(composition, /last_state:\s*'prepared'/)
  assert.match(composition, /last_state:\s*'accepted'/)

  assert.match(aiVideo, /onJobAccepted:\s*async\s*\(taskId,\s*idempotencyKey,\s*variantIndex\)/)
  assert.match(aiVideo, /recordTaskStrict\(videoDir,\s*filename/)
  assert.match(aiVideo, /operation:\s*'video'/)
  assert.match(aiVideo, /last_state:\s*'accepted'/)
  assert.match(genstudioVideo, /onJobAccepted\?\.\(taskId,\s*idempotencyKey,\s*index\)/)
})

test('static inventory supplements the runtime checkpoint seams', () => {
  for (const relativePath of [
    '../generators/audio.ts',
    '../generators/subtitles.ts',
    '../generators/images.ts',
    '../generators/scene-images-batch.ts',
    '../generators/continuity-render.ts',
    '../generators/image-pool-generate.ts',
    '../generators/scene-clip.ts',
  ]) {
    const contents = source(relativePath)
    assert.match(contents, /['"]prepared['"]/, `${relativePath} writes prepared evidence`)
    assert.match(contents, /onJobAccepted/, `${relativePath} writes accepted evidence before provider polling`)
  }
})
