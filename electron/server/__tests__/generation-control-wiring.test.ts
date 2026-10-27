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
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { fiveSecondVideoBytes } from './fixtures/tiny-video.js'

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

async function writeFinishScenePrerequisites(
  paths: { scene_prompts_dir: string; subtitles_dir: string },
  episodeId: string,
  scenes: Array<{ id: string; scene_index: number; visual_prompt: string }>,
): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes }))
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
  await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({
    motion_scope: { mode: 'all' }, motion_level: 2,
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
    // A terminal status is published before runJob's finally block releases the
    // worker slot, and the queue refuses Retry/enqueue while the previous
    // executor is still unwinding (job-queue.ts assertNoSettlingWorker). Require
    // the slot to be free too, or a following Retry races the settling worker.
    if (status && status !== 'queued' && status !== 'running'
      && !jq._isJobWorkerActiveForTesting(jobId)) return
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

async function clearHeldFixtureJobs(
  jq: typeof import('../services/job-queue.js'),
  jobIds: string[],
  wasPaused: boolean,
): Promise<void> {
  for (const jobId of jobIds) {
    const queued = jq.getJob(jobId)
    if (queued) await jq.requestJobCancellation(queued.project_slug, jobId).catch(() => {})
  }
  await jq._waitForJobPersistenceForTesting()
  if (!wasPaused) await jq.setQueuePaused(false)
  await jq._waitForJobPersistenceForTesting()
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

test('Gateway video reports each accepted variant before its first status poll', async () => {
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
      providerParams: { operation: 'image-to-video', duration_seconds: 5, resolution: '720p' },
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
  let queuedJobId = ''
  let wasQueuePaused = false
  try {
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service, [
      { operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'mock-video-price-v1' },
      { operation: 'image-to-video', duration_seconds: 8, resolution: '1080p', credits_per_video: 90, minimum_credits: 90, price_version: 'mock-video-price-v1' },
    ])
    const jq = await import('../services/job-queue.js')
    wasQueuePaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    const app = (await import('../app.js')).app
    const { project, episodeId, paths } = await createEpisode('Persist selected scene clip variant')
    await writeReadyMotionScene(project.slug, episodeId, paths)

    const response = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-clip`)
      .send({
        scene_id: 'scene-001', model: 'mock-video-v1', aspect_ratio: '16:9',
        operation: 'image-to-video', duration_seconds: 8, resolution: '1080p',
      })
      .expect(201)
    queuedJobId = response.body.job_id

    assert.equal(response.body.params.duration_seconds, 8)
    assert.equal(response.body.params.resolution, '1080p')
    assert.equal(response.body.params.operation, 'image-to-video')
    assert.equal(jq.getJob(queuedJobId)?.params.duration_seconds, 8)
    assert.equal(service.submissions.filter(entry => entry.operation === 'video').length, 0)
  } finally {
    restoreVideoCatalog?.()
    const jq = await import('../services/job-queue.js')
    await clearHeldFixtureJobs(jq, queuedJobId ? [queuedJobId] : [], wasQueuePaused)
    await service.close()
    await temp.cleanup()
  }
})

test('Follow narration resolves and saves each scene duration from the selected published resolution', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreVideoCatalog: (() => void) | undefined
  let queuedJobId = ''
  let wasQueuePaused = false
  try {
    const jq = await import('../services/job-queue.js')
    wasQueuePaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service, [
      { operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'mock-video-price-v1' },
      { operation: 'image-to-video', duration_seconds: 8, resolution: '720p', credits_per_video: 80, minimum_credits: 80, price_version: 'mock-video-price-v1' },
      { operation: 'image-to-video', duration_seconds: 12, resolution: '1080p', credits_per_video: 120, minimum_credits: 120, price_version: 'mock-video-price-v1' },
    ])
    const app = (await import('../app.js')).app
    const { project, episodeId, paths } = await createEpisode('Follow narration queues exact scene durations')
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      scenes: [
        { id: 'scene-round-up', scene_index: 1, start_sec: 0, end_sec: 4.2, approved: true, motion_prompt: 'A slow drift.' },
        { id: 'scene-cap', scene_index: 2, start_sec: 4.2, end_sec: 16.2, approved: true, motion_prompt: 'A gentle push.' },
      ],
    }))
    await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({
      motion_scope: { mode: 'all' }, motion_level: 2,
    }))
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const imageDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(imageDir, { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(imageDir, 'scene-round-up.png'), ONE_PIXEL_PNG),
      fs.writeFile(path.join(imageDir, 'scene-cap.png'), ONE_PIXEL_PNG),
    ])

    const response = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-clips-batch`)
      .send({ model: 'mock-video-v1', duration_mode: 'follow_narration', resolution: '720p' })
      .expect(201)
    queuedJobId = response.body.job_id

    assert.equal(response.body.params.duration_mode, 'follow_narration')
    assert.deepEqual(response.body.params.scene_durations, {
      'scene-round-up': { duration_seconds: 5, narration_duration_seconds: 4.2 },
      'scene-cap': { duration_seconds: 8, narration_duration_seconds: 12 },
    })
    assert.equal(service.submissions.filter(entry => entry.operation === 'video').length, 0)
  } finally {
    restoreVideoCatalog?.()
    const jq = await import('../services/job-queue.js')
    await clearHeldFixtureJobs(jq, queuedJobId ? [queuedJobId] : [], wasQueuePaused)
    await service.close()
    await temp.cleanup()
  }
})

test('Finish missing derives the exact decodable target set and replays one action identity', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  let queuedJobId = ''
  try {
    await jq.setQueuePaused(true)
    const app = (await import('../app.js')).app
    const { project, episodeId, paths } = await createEpisode('Finish exact missing targets')
    await writeFinishScenePrerequisites(paths, episodeId, [
      { id: 'scene-valid', scene_index: 1, visual_prompt: '' },
      { id: 'scene-corrupt', scene_index: 2, visual_prompt: 'Repair the corrupt saved image.' },
      { id: 'scene-missing', scene_index: 3, visual_prompt: 'Generate the missing saved image.' },
    ])
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const imageDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(imageDir, { recursive: true })
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(path.join(imageDir, 'scene-valid.png'))
    await fs.writeFile(path.join(imageDir, 'scene-corrupt.png'), 'not an image')

    const readiness = await request(app)
      .get(`/api/projects/${project.slug}/scene-review/${episodeId}`)
      .expect(200)
    assert.equal(readiness.body.stats.with_image, 1)
    assert.equal(readiness.body.scenes.find((scene: any) => scene.id === 'scene-corrupt').image_filename, null)

    const url = `/api/projects/${project.slug}/scene-review/${episodeId}/finish-missing`
    const actionId = '11111111-1111-4111-8111-111111111111'
    const body = {
      action_id: actionId,
      model: 'mock-image-v1',
      aspect_ratio: '16:9',
      resolution: '1K',
      scene_ids: ['scene-valid', 'client-invented-scene'],
    }
    const first = await request(app).post(url).send(body).expect(200)
    queuedJobId = first.body.job_id
    assert.deepEqual(first.body.queued_scene_ids, ['scene-corrupt', 'scene-missing'])
    assert.equal(first.body.queued, 2)
    assert.ok(queuedJobId)

    const internal = jq.getJob(queuedJobId)!
    assert.deepEqual(internal.params.scene_ids, ['scene-corrupt', 'scene-missing'])
    assert.equal(internal.params.missing_only, true)
    assert.equal(internal.params.manual_image_finish.action_id, actionId)

    const replay = await request(app).post(url).send(body).expect(200)
    assert.equal(replay.body.reused, true)
    assert.equal(replay.body.job_id, queuedJobId)
    assert.equal((await jq.getJobs(project.slug)).filter(job =>
      job.params?.manual_image_finish?.action_id === actionId).length, 1)

    await request(app).post(url).send({ ...body, model: 'another-model' }).expect(409)
  } finally {
    if (queuedJobId) await jq.requestJobCancellation(jq.getJob(queuedJobId)!.project_slug, queuedJobId).catch(() => {})
    await jq.setQueuePaused(false)
    await temp.cleanup()
  }
})

test('Replace uncertain hydrates the private durable identity receipt after a cold project load', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  let queuedJobId = ''
  try {
    await jq.setQueuePaused(true)
    const app = (await import('../app.js')).app
    const { project, episodeId, paths } = await createEpisode('Replace cold durable receipt')
    await writeFinishScenePrerequisites(paths, episodeId, [
      { id: 'scene-uncertain', scene_index: 1, visual_prompt: 'Replace only after exact confirmation.' },
    ])
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { imageManifestIdentityHash } = await import('../lib/manifest-recovery.js')
    const imageDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(imageDir, { recursive: true })
    const uncertainEntry = {
      provider: 'genstudio-image',
      task_id: '',
      submitted_at: '2026-09-06T00:00:00.000Z',
      input_hash: 'old-input',
      idempotency_key: 'story-image-old-uncertain',
      operation: 'image' as const,
      last_state: 'prepared',
      request_scope: 'old-scope',
    }
    await fs.writeFile(path.join(imageDir, '.task-manifest.json'), JSON.stringify({
      schema_version: 1,
      tasks: { 'scene-uncertain.png': uncertainEntry },
    }))
    const sourceJobId = 'cold-finish-source'
    const jobsPath = path.join(temp.dir, 'projects', project.slug, 'jobs.json')
    await fs.writeFile(jobsPath, JSON.stringify({ jobs: [{
      job_id: sourceJobId,
      project_slug: project.slug,
      type: 'continuity_render',
      episode_id: episodeId,
      title: 'Finish missing images',
      status: 'error',
      created_at: '2026-09-06T00:00:00.000Z',
      started_at: '2026-09-06T00:00:00.000Z',
      finished_at: '2026-09-06T00:01:00.000Z',
      error: 'Earlier outcome uncertain',
      output_lines: [],
      params: {
        episode_id: episodeId,
        model: 'mock-image-v1',
        scene_ids: ['scene-uncertain'],
        manual_image_finish: {
          action_id: '22222222-2222-4222-8222-222222222222',
          replace_uncertain: false,
          uncertain_scene_ids: ['scene-uncertain'],
          uncertain_identity_hashes: { 'scene-uncertain': imageManifestIdentityHash(uncertainEntry) },
        },
      },
    }] }))

    const response = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/replace-uncertain`)
      .send({
        action_id: '33333333-3333-4333-8333-333333333333',
        source_job_id: sourceJobId,
        model: 'mock-image-v1',
        aspect_ratio: '16:9',
        resolution: '1K',
      })
      .expect(200)
    queuedJobId = response.body.job_id
    const internal = jq.getJob(queuedJobId)!
    assert.equal(internal.params.manual_image_finish.source_job_id, sourceJobId)
    assert.equal(
      internal.params.manual_image_finish.expected_uncertain_identity_hashes['scene-uncertain'],
      imageManifestIdentityHash(uncertainEntry),
    )
    assert.equal(jq.getPublicJob(sourceJobId)?.params.manual_image_finish.uncertain_identity_hashes, undefined)
    const persisted = JSON.parse(await fs.readFile(jobsPath, 'utf8'))
    assert.equal(
      persisted.jobs.find((job: any) => job.job_id === sourceJobId)
        .params.manual_image_finish.uncertain_identity_hashes['scene-uncertain'],
      imageManifestIdentityHash(uncertainEntry),
    )
  } finally {
    if (queuedJobId) await jq.requestJobCancellation(jq.getJob(queuedJobId)!.project_slug, queuedJobId).catch(() => {})
    await jq.setQueuePaused(false)
    await temp.cleanup()
  }
})

test('the generic Gateway provider filters the exact image-to-video operation before matching duplicate variants', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreVideoCatalog: (() => void) | undefined
  const imagePath = path.join(temp.dir, 'source.png')
  await fs.writeFile(imagePath, ONE_PIXEL_PNG)
  try {
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service, [
      { operation: 'text-to-video', duration_seconds: 3, resolution: '480p', credits_per_video: 1, minimum_credits: 1, price_version: 'mixed-v1' },
      { operation: 'image-to-video', duration_seconds: 3, resolution: '480p', credits_per_video: 9, minimum_credits: 9, price_version: 'mixed-v1' },
      { operation: 'image-to-video', duration_seconds: 8, resolution: '1080p', credits_per_video: 90, minimum_credits: 90, price_version: 'mixed-v1' },
    ])
    await import('../providers/video/genstudio.js')
    const { registry } = await import('../providers/registry.js')
    const provider = registry.getVideoProvider('genstudio-video')
    assert.ok(provider)

    await provider.generateVideo({
      mode: 'frames', prompt: 'A steady push through a misty archive.', apiKey: MOCK_GENSTUDIO_FULL_KEY,
      aspectRatio: 'landscape', numberOfVideos: 1, modelId: 'mock-video-v1', startImagePath: imagePath,
      providerParams: { operation: 'image-to-video', duration_seconds: 3, resolution: '480p' },
    })
    const submitted = service.submissions.find(entry => entry.operation === 'video')?.parsedBody
    assert.equal(submitted?.mode, 'image-to-video')
    assert.equal(submitted?.duration_seconds, 3)
    assert.equal(submitted?.resolution, '480p')

    await assert.rejects(
      () => provider.generateVideo({
        mode: 'frames', prompt: 'An invalid legacy request.', apiKey: MOCK_GENSTUDIO_FULL_KEY,
        aspectRatio: 'landscape', numberOfVideos: 1, modelId: 'mock-video-v1', startImagePath: imagePath,
        providerParams: { duration_seconds: 3, resolution: '480p' },
      }),
      /must include.*image-to-video/i,
    )
    assert.equal(service.providerSubmissionCount('video'), 1)
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
  const queuedJobIds: string[] = []
  let wasQueuePaused = false
  try {
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service, [
      { operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'mock-video-price-v1' },
      { operation: 'image-to-video', duration_seconds: 8, resolution: '1080p', credits_per_video: 90, minimum_credits: 90, price_version: 'mock-video-price-v1' },
    ])
    const jq = await import('../services/job-queue.js')
    wasQueuePaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    const app = (await import('../app.js')).app
    const { project, episodeId, paths } = await createEpisode('Motion routes require exact variants')
    await writeReadyMotionScene(project.slug, episodeId, paths)

    await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-clip`)
      .send({ scene_id: 'scene-001', model: 'mock-video-v1' })
      .expect(400)
    await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-clips-batch`)
      .send({ model: 'mock-video-v1', duration_seconds: 5 })
      .expect(400)
    await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-missing-clips`)
      .send({ model: 'mock-video-v1', resolution: '720p' })
      .expect(400)
    assert.equal((await jq.getJobs(project.slug)).length, 0, 'invalid new requests never enter the queue')

    const durable = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/generate-clips-batch`)
      .send({ model: 'mock-video-v1', operation: 'image-to-video', duration_seconds: 8, resolution: '1080p' })
      .expect(201)
    queuedJobIds.push(durable.body.job_id)
    assert.equal(durable.body.params.duration_seconds, 8)
    assert.equal(durable.body.params.resolution, '1080p')
    assert.equal(durable.body.params.operation, 'image-to-video')

    const episode = await createEpisode('Motion missing clips preserve selected variant')
    await writeReadyMotionScene(episode.project.slug, episode.episodeId, episode.paths)
    const missing = await request(app)
      .post(`/api/projects/${episode.project.slug}/scene-review/${episode.episodeId}/generate-missing-clips`)
      .send({ model: 'mock-video-v1', operation: 'image-to-video', duration_seconds: 8, resolution: '1080p' })
      .expect(200)
    assert.equal(missing.body.queued, 1)
    const queued = (await jq.getJobs(episode.project.slug)).find(item => item.type === 'scene_clip_generate')
    assert.equal(queued?.params.duration_seconds, 8)
    assert.equal(queued?.params.resolution, '1080p')
    assert.equal(queued?.params.operation, 'image-to-video')
    if (queued) queuedJobIds.push(queued.job_id)
  } finally {
    restoreVideoCatalog?.()
    const jq = await import('../services/job-queue.js')
    await clearHeldFixtureJobs(jq, queuedJobIds, wasQueuePaused)
    await service.close()
    await temp.cleanup()
  }
})

test('Jobs retry fails closed for legacy Motion variants and preserves an exact selected operation', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreVideoCatalog: (() => void) | undefined
  try {
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service, [
      { operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 50, minimum_credits: 50, price_version: 'mock-video-price-v1' },
      { operation: 'image-to-video', duration_seconds: 8, resolution: '1080p', credits_per_video: 90, minimum_credits: 90, price_version: 'mock-video-price-v1' },
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

    jq.registerExecutor('scene_clip_generate', generateSceneClipJob)
    const legacyRetry = await request(app)
      .post(`/api/projects/${episode.project.slug}/jobs/${legacy.job_id}/retry`)
      .send({})
      .expect(202)
    assert.equal(legacyRetry.body.job.params.duration_seconds, undefined)
    assert.equal(legacyRetry.body.job.params.resolution, undefined)
    await waitForTerminalJob(jq, legacyRetry.body.job.job_id, 8_000)
    assert.equal(jq.getJob(legacyRetry.body.job.job_id)?.status, 'error')
    assert.equal(service.submissions.filter(item => item.operation === 'video').length, 0)

    jq.registerExecutor('scene_clip_generate', async () => { throw new Error('selected failure') })
    const selected = jq.enqueuePreparedForTest({
      project_slug: episode.project.slug, type: 'scene_clip_generate', episode_id: episode.episodeId,
      title: 'Selected motion clip', params: {
        episode_id: episode.episodeId, scene_id: 'scene-001', model: 'genstudio-video:mock-video-v1',
        operation: 'image-to-video', duration_seconds: 8, resolution: '1080p',
      },
    })
    await waitForTerminalJob(jq, selected.job_id)
    const selectedRetry = await request(app)
      .post(`/api/projects/${episode.project.slug}/jobs/${selected.job_id}/retry`)
      .send({})
      .expect(202)
    assert.equal(selectedRetry.body.job.params.duration_seconds, 8)
    assert.equal(selectedRetry.body.job.params.resolution, '1080p')
    assert.equal(selectedRetry.body.job.params.operation, 'image-to-video')
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

test('a scene clip with a removed selected variant fails before a Gateway video POST', async () => {
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
        operation: 'image-to-video', duration_seconds: 8, resolution: '1080p',
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

test('a scene clip checkpoints its exact published operation before the first video status read', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreVideoCatalog: (() => void) | undefined
  try {
    await configureMockGenStudio(service.baseUrl)
    restoreVideoCatalog = enableMockVideoCatalog(service)
    const { generateSceneClipJob, resolveVideoAssetsDir } = await import('../generators/scene-clip.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { project, episodeId, paths } = await createEpisode('Scene clip operation provenance')
    const imagePath = path.join(paths.episode_dir, 'scene-source.png')
    await fs.writeFile(imagePath, ONE_PIXEL_PNG)
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      scenes: [{ id: 'scene-001', scene_index: 1, image_path: imagePath, motion_prompt: 'A slow drift across archive shelves.' }],
    }))
    const outDir = await resolveVideoAssetsDir(project.slug, episodeId, paths.episode_dir)
    service.queueScenario('video', {
      states: ['accepted', 'running', 'succeeded'],
      videoArtifact: fiveSecondVideoBytes(),
    })
    const status = withFirstStatusAssertion(service, 'video', async taskId => {
      const entry = (await readManifest(outDir)).tasks['scene-001.mp4']
      assert.equal(entry?.task_id, taskId)
      assert.equal(entry?.operation, 'video')
      assert.equal(entry?.variant_operation, 'image-to-video')
    })
    try {
      await generateSceneClipJob(job(project.slug, episodeId, 'scene_clip_generate', {
        scene_id: 'scene-001', model: 'mock-video-v1', aspect_ratio: '16:9',
        operation: 'image-to-video', duration_seconds: 5, resolution: '720p',
      }))
    } finally {
      status.restore()
    }
    assert.ok(status.wasObserved(), 'scene clip must checkpoint before polling')
  } finally {
    restoreVideoCatalog?.()
    await service.close()
    await temp.cleanup()
  }
})

test('each Gateway modality exposes its exact accepted identity before its first status read', async () => {
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
          aspectRatio: '16:9', operation: 'image-to-video', durationSeconds: 5, resolution: '720p', requestIdentity: 'checkpoint:video',
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

test('an accepted Gateway image stops local monitoring when its cancellation probe changes', async () => {
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
  const sceneClip = source('../generators/scene-clip.ts')
  const genstudioVideo = source('../providers/video/genstudio.ts')

  assert.match(sceneImage, /isCancelled:\s*\(\)\s*=>\s*jq\.isCancelled\(job\.job_id\)/)
  assert.match(sceneImage, /onJobAccepted:\s*async\s*\(taskId,\s*\w+IdempotencyKey\)/)
  assert.match(sceneImage, /compareAndRecordImageTaskStrict\(outDir,\s*filename,\s*previousOwner,\s*preparedOwner\)/)
  assert.match(sceneImage, /promoteCurrentImageTaskArtifactStrict\(/)
  assert.match(sceneImage, /operation:\s*'image'/)
  assert.match(sceneImage, /last_state:\s*'accepted'/)

  assert.match(composition, /isCancelled:\s*\(\)\s*=>\s*jq\.isCancelled\(job\.job_id\)/)
  assert.match(composition, /const idempotencyKey\s*=\s*buildGenStudioImageIdempotencyKey/)
  assert.match(composition, /recordTaskStrict\(outDir,\s*COMPOSITION_FILENAME/)
  assert.match(composition, /last_state:\s*'prepared'/)
  assert.match(composition, /last_state:\s*'accepted'/)

  assert.match(sceneClip, /onJobAccepted:\s*async\s*\(providerJobId,\s*acceptedIdempotencyKey\)/)
  assert.match(sceneClip, /recordTaskStrict\(outDir,\s*manifestKey/)
  assert.match(sceneClip, /operation:\s*'video'/)
  assert.match(sceneClip, /last_state:\s*'accepted'/)
  assert.match(genstudioVideo, /onJobAccepted\?\.\(taskId,\s*idempotencyKey,\s*index\)/)
})

test('static inventory supplements the runtime checkpoint seams', () => {
  for (const relativePath of [
    '../generators/audio.ts',
    '../services/subtitle-recovery.ts',
    '../generators/images.ts',
    '../generators/continuity-render.ts',
    '../generators/image-pool-generate.ts',
    '../generators/scene-clip.ts',
  ]) {
    const contents = source(relativePath)
    assert.match(contents, /['"]prepared['"]/, `${relativePath} writes prepared evidence`)
    assert.match(contents, /onJobAccepted/, `${relativePath} writes accepted evidence before provider polling`)
  }
})
