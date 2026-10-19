import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitForValue } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

// Keep every app-dependent import below `useTempDataDir()`. project-manager
// resolves STORY_STUDIO_DATA_DIR at module load; a static import here would
// create projects in the user's real application-support directory.
let app: any
let cleanupTemp: () => Promise<void>
let mediaCleanup: typeof import('../services/episode-media-cleanup.js')
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let pathsService: typeof import('../services/utils.js')
let connections: typeof import('../services/youtube-connection-store.js')
let youtubeOperations: typeof import('../services/youtube-operation-store.js')
let sourceVideo: typeof import('../services/youtube-source-video.js')
let jq: typeof import('../services/job-queue.js')
let mock: Awaited<ReturnType<typeof startMockGenStudioService>>

interface SeededEpisode {
  slug: string
  code: string
  title: string
  paths: Awaited<ReturnType<typeof pathsService.resolveEpisodePathsByCode>>
  final: string
}

before(async () => {
  const temp = await useTempDataDir()
  cleanupTemp = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const appModule = await import('../app.js')
  app = appModule.app
  mediaCleanup = await import('../services/episode-media-cleanup.js')
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  pathsService = await import('../services/utils.js')
  connections = await import('../services/youtube-connection-store.js')
  youtubeOperations = await import('../services/youtube-operation-store.js')
  sourceVideo = await import('../services/youtube-source-video.js')
  jq = await import('../services/job-queue.js')

  mock = await startMockGenStudioService()
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: mock.baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)
})

beforeEach(() => { mediaCleanup._resetMediaCleanupStateForTests() })

after(async () => {
  await mock.close()
  await cleanupTemp()
})

async function makeOlder(file: string): Promise<void> {
  const beforeUpload = new Date(Date.now() - 60_000)
  await fs.utimes(file, beforeUpload, beforeUpload)
}

async function seedEpisode(
  name: string,
  withFinalizerPrerequisites = true,
  projectSlug?: string,
  episodeCode = 'EP0001',
): Promise<SeededEpisode> {
  const project = projectSlug ? { slug: projectSlug } : await pm.createProject({ name })
  if (!projectSlug) {
    await pm.updateConfig(project.slug, {
      metadata_presets: [{ id: 'metadata-default', name: 'Default', data: { model: 'mock-chat-v1' } }],
      metadata_last_preset: 'metadata-default',
      // 1.4.300 — these tests pin the cleanup stop, i.e. the retired_media safety check on Block.
      safety_checks: { retired_media: 'block' },
    } as any)
  }
  const [idea] = await im.addIdeas(project.slug, [{
    title: `${name} episode`, logline: '', themes: [], suggested_chapters: 1,
    suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: episodeCode })
  const code = accepted.episode_code
  const paths = await pathsService.resolveEpisodePathsByCode(project.slug, code)
  await Promise.all([
    fs.mkdir(paths.bg_dir, { recursive: true }),
    fs.mkdir(paths.video_dir, { recursive: true }),
  ])
  const final = path.join(paths.video_dir, `${code}_final_video.mp4`)
  await fs.writeFile(final, `final-${project.slug}`)
  await makeOlder(final)
  if (withFinalizerPrerequisites) {
    await im.setEpisodeStatusOverrides(project.slug, code, { script: true, merged_audio: true })
  }
  return { slug: project.slug, code, title: `${name} episode`, paths, final }
}

async function markUploaded(episode: SeededEpisode, channel: string): Promise<void> {
  await connections.configureYouTubeApplication({ client_id: 'cleanup-client', client_secret: 'cleanup-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channel, title: channel, granted_scopes: ['youtube.upload'] },
    tokens: { access_token: `access-${channel}`, refresh_token: `refresh-${channel}`, expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: episode.slug, channel_id: channel, expected_previous_channel_id: null,
  })
  const payload = {
    snippet_json: JSON.stringify({ title: episode.title, description: '', tags: [], categoryId: '24' }),
    status_json: JSON.stringify({ privacyStatus: 'public' }),
    source_sha256: 'a'.repeat(64),
  }
  const opened = await youtubeOperations.createYouTubeOperation({
    project_slug: episode.slug,
    episode_code: episode.code,
    channel_id: channel,
    source_revision: await sourceVideo.resolveYouTubeSourceRevision(episode.final),
    metadata_revision: payload.source_sha256,
    final_payload: payload,
    origin: 'manual',
    final_action: 'manual_upload',
  })
  const accepted = await youtubeOperations.acceptYouTubeOperation({
    project_slug: episode.slug,
    operation_id: opened.operation_id,
    expected_revision: opened.revision,
    channel_id: channel,
    video_id: `video-${episode.slug}`,
    accepted_at: new Date().toISOString(),
    final_payload: payload,
  })
  await youtubeOperations.updateYouTubeOperation({
    project_slug: episode.slug,
    operation_id: accepted.operation_id,
    expected_revision: accepted.revision,
    mutate(record) { record.lifecycle = 'ready' },
  })
}

async function waitForOperation(slug: string, operationId: string) {
  return waitForValue(() => {
    const operation = mediaCleanup.getMediaCleanupOperation(slug, operationId)
    return operation && ['completed', 'failed', 'stopped'].includes(operation.status) ? operation : null
  }, { timeoutMs: 5_000, label: `media cleanup operation ${operationId}` })
}

async function retireImage(episode: SeededEpisode, channel: string): Promise<void> {
  const image = path.join(episode.paths.bg_dir, 'scene-01.png')
  await fs.writeFile(image, `image-${episode.slug}`)
  await makeOlder(image)
  await markUploaded(episode, channel)

  const previewStarted = await mediaCleanup.startMediaCleanupPreview(episode.slug, {
    episode_codes: [episode.code], categories: ['images'],
  })
  const preview = await waitForOperation(episode.slug, previewStarted.operation_id)
  assert.equal(preview.status, 'completed', preview.error)
  assert.equal(preview.preview?.file_count, 1)

  const runStarted = await mediaCleanup.startMediaCleanupRun(episode.slug, {
    preview_id: preview.preview!.preview_id, mode: 'remove',
  })
  const run = await waitForOperation(episode.slug, runStarted.operation_id)
  assert.equal(run.status, 'completed', run.error)
  assert.equal(run.result?.removed_count, 1)
  assert.equal((await mediaCleanup.readLocalMediaCleanupStatus(episode.slug, episode.code)).has_retired_media, true)
}

function retiredIssue(response: any): any {
  return (response.body.issues || []).find((issue: any) => issue.code === 'retired_local_media')
}

test('ordinary Pipeline preflight and run stop durable cleanup media before any job is queued', async () => {
  const episode = await seedEpisode('Cleanup ordinary guard')
  await retireImage(episode, `cleanup-ordinary-${episode.slug}`)

  const preflight = await request(app)
    .post(`/api/projects/${episode.slug}/pipeline/preflight`)
    .send({ episode_ids: [episode.code], steps: ['metadata'] })
  assert.equal(preflight.status, 422)
  assert.equal(preflight.body.ok, false)
  assert.equal(retiredIssue(preflight).episode_id, episode.code)
  assert.deepEqual(preflight.body.eligible_episode_ids, [])

  const run = await request(app)
    .post(`/api/projects/${episode.slug}/pipeline/run-batch`)
    .send({ episode_ids: [episode.code], steps: ['metadata'] })
  assert.equal(run.status, 400)
  assert.match(run.body.detail, /Routine Pipeline will not regenerate intentionally cleaned media/)
  assert.equal(retiredIssue(run).episode_id, episode.code)
  assert.deepEqual(await jq.getJobs(episode.slug), [], 'a durable cleanup stop must queue no work')
})

test('changing the current channel does not erase a durable local cleanup stop', async () => {
  const episode = await seedEpisode('Cleanup channel change')
  const oldChannel = `cleanup-old-${episode.slug}`
  await retireImage(episode, oldChannel)

  const newChannel = `cleanup-new-${episode.slug}`
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: newChannel, title: newChannel, granted_scopes: ['youtube.upload'] },
    tokens: { access_token: `access-${newChannel}`, refresh_token: `refresh-${newChannel}`, expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: episode.slug, channel_id: newChannel, expected_previous_channel_id: oldChannel,
  })

  const run = await request(app)
    .post(`/api/projects/${episode.slug}/pipeline/run-batch`)
    .send({ episode_ids: [episode.code], steps: ['metadata'] })
  assert.equal(run.status, 400)
  assert.equal(retiredIssue(run).episode_id, episode.code)
  assert.deepEqual(await jq.getJobs(episode.slug), [], 'a channel reassignment cannot permit silent regeneration')
})

test('Pipeline finds a durable cleanup sidecar after the episode title changes', async () => {
  const episode = await seedEpisode('Cleanup original title')
  await retireImage(episode, `cleanup-rename-${episode.slug}`)
  const idea = (await im.getIdeas(episode.slug, 'accepted')).find(candidate => candidate.episode_code === episode.code)!
  await im.updateIdea(episode.slug, idea.id, { title: 'Cleanup renamed title' })

  const run = await request(app)
    .post(`/api/projects/${episode.slug}/pipeline/run-batch`)
    .send({ episode_ids: [episode.code], steps: ['metadata'] })
  assert.equal(run.status, 400)
  assert.equal(retiredIssue(run).episode_id, episode.code)
  assert.deepEqual(await jq.getJobs(episode.slug), [], 'a renamed episode cannot lose its cleanup stop')
})

test('cleanup completed after a clean Pipeline preflight is rejected inside queued job admission', async () => {
  const episode = await seedEpisode('Cleanup admission race')
  const image = path.join(episode.paths.bg_dir, 'scene-01.png')
  await fs.writeFile(image, `image-${episode.slug}`)
  await makeOlder(image)
  await markUploaded(episode, `cleanup-admission-${episode.slug}`)

  const previewStarted = await mediaCleanup.startMediaCleanupPreview(episode.slug, {
    episode_codes: [episode.code], categories: ['images'],
  })
  const preview = await waitForOperation(episode.slug, previewStarted.operation_id)
  assert.equal(preview.status, 'completed', preview.error)

  const preflight = await request(app)
    .post(`/api/projects/${episode.slug}/pipeline/preflight`)
    .send({ episode_ids: [episode.code], steps: ['metadata'] })
  assert.equal(preflight.status, 200)
  assert.equal(preflight.body.ok, true)

  let mutationEntered!: () => void
  const mutationStarted = new Promise<void>(resolve => { mutationEntered = resolve })
  let releaseMutation!: () => void
  const mutationReleased = new Promise<void>(resolve => { releaseMutation = resolve })
  let admissionChecks = 0
  const restore = mediaCleanup._setMediaCleanupHooksForTests({
    beforeDestructiveMutation: async () => {
      mutationEntered()
      await mutationReleased
    },
  })
  try {
    const cleanupStarted = await mediaCleanup.startMediaCleanupRun(episode.slug, {
      preview_id: preview.preview!.preview_id, mode: 'remove',
    })
    await mutationStarted

    const queuedAdmission = jq.enqueue({
      project_slug: episode.slug,
      type: 'metadata',
      episode_id: episode.code,
      title: '[batch] metadata admission-race fixture',
      params: { episode_id: episode.code, title: episode.title, model: 'mock-chat-v1' },
    }, {}, async () => {
      admissionChecks++
      const status = await mediaCleanup.readLocalMediaCleanupStatus(episode.slug, episode.code)
      if (status.has_retired_media || status.blocked_reason) throw new Error('cleanup admission guard')
    })

    const admissionRejected = assert.rejects(queuedAdmission, /cleanup admission guard/)
    releaseMutation()
    const cleanup = await waitForOperation(episode.slug, cleanupStarted.operation_id)
    assert.equal(cleanup.status, 'completed', cleanup.error)
    await admissionRejected
  } finally {
    releaseMutation()
    restore()
  }
  assert.equal(admissionChecks, 1, 'the recheck runs only after cleanup releases the shared admission mutex')
  assert.deepEqual(await jq.getJobs(episode.slug), [], 'the stale preflight must not admit a job')
})

test('force bypasses the cleanup stop but still honours normal Pipeline prerequisites', async () => {
  const episode = await seedEpisode('Cleanup force prerequisite', false)
  await retireImage(episode, `cleanup-force-${episode.slug}`)

  const run = await request(app)
    .post(`/api/projects/${episode.slug}/pipeline/run-batch`)
    .send({
      episode_ids: [episode.code], steps: ['metadata'], force: true,
      operation_id: '8d7b9387-0980-4f58-90ea-69591ff7c8f0',
    })
  assert.equal(run.status, 400)
  assert.equal(retiredIssue(run), undefined, 'force deliberately bypasses only the cleanup stop')
  assert.ok((run.body.issues || []).some((issue: any) => issue.code === 'missing_prerequisite'),
    'force must still reject the usual unfinished prerequisites')
  assert.deepEqual(await jq.getJobs(episode.slug), [])
})

test('a cleaned episode is blocked while an untouched selected episode still queues', async () => {
  const cleaned = await seedEpisode('Cleanup mixed blocked')
  await retireImage(cleaned, `cleanup-mixed-${cleaned.slug}`)
  const untouched = await seedEpisode('Cleanup mixed eligible', true, cleaned.slug, 'EP0002')

  await jq.setQueuePaused(true)
  try {
    const run = await request(app)
      .post(`/api/projects/${cleaned.slug}/pipeline/run-batch`)
      .send({ episode_ids: [cleaned.code, untouched.code], steps: ['metadata'] })
    assert.equal(run.status, 201)
    assert.equal(run.body.enqueued, 1)
    assert.equal(retiredIssue(run).episode_id, cleaned.code)
    assert.deepEqual(run.body.blocked.map((row: any) => row.episode_id), [cleaned.code])
    assert.deepEqual(run.body.jobs.map((job: any) => job.episode_id), [untouched.code])
    await jq.requestJobCancellation(cleaned.slug, run.body.jobs[0].job_id)
  } finally {
    await jq.setQueuePaused(false)
  }
})

test('episode rows keep missing asset readiness false and publish local cleanup status separately', async () => {
  const episode = await seedEpisode('Cleanup episode row')
  await retireImage(episode, `cleanup-row-${episode.slug}`)

  const rows = await request(app).get(`/api/projects/${episode.slug}/episodes?refresh=1`)
  assert.equal(rows.status, 200)
  const row = rows.body.find((candidate: any) => candidate.episode_code === episode.code)
  assert.ok(row)
  assert.equal(row.status.images, false, 'removed image files never become ready because cleanup metadata exists')
  assert.equal(row.local_media_status.has_retired_media, true)
  assert.equal(row.local_media_status.state, 'partially_removed')
  assert.equal(row.status.local_media_status, undefined, 'cleanup status is independent from asset readiness')
})

test('retired_media on Warn: the cleaned episode runs, with a warning that its media is made again', async () => {
  const episode = await seedEpisode('Cleanup lenient')
  await retireImage(episode, `cleanup-lenient-${episode.slug}`)
  await pm.updateConfig(episode.slug, { safety_checks: { retired_media: 'warn' } } as any)

  const preflight = await request(app)
    .post(`/api/projects/${episode.slug}/pipeline/preflight`)
    .send({ episode_ids: [episode.code], steps: ['metadata'] })
  assert.equal(preflight.status, 200, JSON.stringify(preflight.body))
  assert.equal(retiredIssue(preflight), undefined)
  assert.deepEqual(preflight.body.eligible_episode_ids, [episode.code])
  assert.ok(preflight.body.warnings.some((w: string) => /removed on purpose will be made again/.test(w)), preflight.body.warnings.join('\n'))
})
