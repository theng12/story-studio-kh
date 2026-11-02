import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const MODEL_ID = 'mock-image-v1'

async function setupThumbnailProject(dir: string, serviceUrl: string) {
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const queue = await import('../services/job-queue.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { toMdPath } = await import('../lib/episode-artifacts.js')
  const { writePromptCompletionManifest } = await import('../services/prompt-completion.js')
  const { generateImages, resolveImageDirs } = await import('../generators/images.js')
  const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')

  await settings.setGenStudioUrl(serviceUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  await import('../providers/image/genstudio.js')

  const project = await pm.createProject({ name: 'Image Retry Project', episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(
    project.slug,
    [{ title: 'Retry Test Episode', logline: 'Test.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'neutral' }],
    'mock-chat-v1',
  )
  const episodeId = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  const promptPath = toMdPath(paths.thumb_prompts_docx)
  await fs.mkdir(path.dirname(promptPath), { recursive: true })
  await fs.writeFile(promptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: Primary\n\nA lonely lighthouse in the storm.\n')
  await writePromptCompletionManifest(path.dirname(promptPath), episodeId, 'thumbnail', 1)

  const { thumbDir } = await resolveImageDirs(project.slug, promptPath, episodeId)
  await fs.mkdir(thumbDir, { recursive: true })

  const makeJob = (jobId: string) => {
    const now = new Date().toISOString()
    const job: any = {
      job_id: jobId,
      project_slug: project.slug,
      type: 'thumb_images',
      episode_id: episodeId,
      title: 'Thumbnails',
      status: 'running',
      created_at: now,
      started_at: now,
      finished_at: null,
      local_execution_complete: false,
      error: null,
      output_lines: [],
      params: { episode_id: episodeId, mode: 'thumbs', model: MODEL_ID, aspect_ratio: '16:9', resolution: '1K' },
    }
    return job
  }

  return {
    settings,
    pm,
    queue,
    project,
    episodeId,
    thumbDir,
    filename: `${episodeId.toUpperCase()}_Thumb01_v1.png`,
    generateImages,
    readManifest,
    recordTaskStrict,
    makeJob,
  }
}

test('generator image retry: disabled setting results in 0 extra physical requests', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const ctx = await setupThumbnailProject(temp.dir, service.baseUrl)
    await ctx.settings.setImageRetrySetting({ enabled: false, retries: 3 })

    // Initial request fails with a terminal error
    service.queueScenario('image', { states: ['failed'], failureCode: 'IMAGE_FAILED' })

    const job = ctx.makeJob('job-retry-disabled')
    await assert.rejects(
      async () => ctx.generateImages(job),
      /Thumbnail generation incomplete/,
    )

    // Only 1 physical submission occurred (the initial one); 0 retries
    assert.equal(service.submissions.length, 1)
    const manifest = await ctx.readManifest(ctx.thumbDir)
    const task = manifest.tasks[ctx.filename]
    assert.ok(task)
    assert.equal(task.last_state, 'failed')
    assert.doesNotMatch(task.request_scope || '', /:retry:/)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('generator image retry: retries: 2 produces exactly 2 extra physical POSTs, same model and payload, then terminal failure', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const ctx = await setupThumbnailProject(temp.dir, service.baseUrl)
    await ctx.settings.setImageRetrySetting({ enabled: true, retries: 2 })

    // Queue 3 failures: initial + retry 1 + retry 2
    service.queueScenario('image', { states: ['failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['failed'], failureCode: 'IMAGE_FAILED' })

    const job = ctx.makeJob('job-retry-count-2')
    await assert.rejects(
      async () => ctx.generateImages(job),
      /Thumbnail generation incomplete/,
    )

    // Exactly 3 submissions: 1 initial + 2 retries
    assert.equal(service.submissions.length, 3)

    // All 3 submissions must use identical model and identical prompt payload
    const [sub0, sub1, sub2] = service.submissions
    const body0 = sub0?.parsedBody as Record<string, unknown> | undefined
    const body1 = sub1?.parsedBody as Record<string, unknown> | undefined
    const body2 = sub2?.parsedBody as Record<string, unknown> | undefined
    assert.ok(body0 && body1 && body2)

    assert.equal(body0.model_id || body0.model, MODEL_ID)
    assert.equal(body1.model_id || body1.model, MODEL_ID)
    assert.equal(body2.model_id || body2.model, MODEL_ID)

    assert.equal(body0.prompt, body1.prompt)
    assert.equal(body1.prompt, body2.prompt)

    // Idempotency keys must be distinct per retry attempt
    assert.notEqual(sub0!.idempotencyKey, sub1!.idempotencyKey)
    assert.notEqual(sub1!.idempotencyKey, sub2!.idempotencyKey)

    // Manifest entry reflects exhausted retry count
    const manifest = await ctx.readManifest(ctx.thumbDir)
    const task = manifest.tasks[ctx.filename]
    assert.ok(task)
    assert.equal(task.last_state, 'failed')
    assert.match(task.request_scope || '', /:retry:2:/)

    // A subsequent run does NOT make a 4th physical POST because the 2-retry budget is exhausted
    const followUpJob = ctx.makeJob('job-retry-count-2-followup')
    await assert.rejects(
      async () => ctx.generateImages(followUpJob),
      /Thumbnail generation incomplete/,
    )
    assert.equal(service.submissions.length, 3, 'No additional POST made after retry budget exhausted')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('generator image retry: restart reuses durable retry key and does not reset attempt budget', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const ctx = await setupThumbnailProject(temp.dir, service.baseUrl)
    await ctx.settings.setImageRetrySetting({ enabled: true, retries: 2 })

    // Scenario 1 fails, scenario 2 (retry 1) succeeds
    service.queueScenario('image', { states: ['failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['succeeded'] })

    const job = ctx.makeJob('job-restart-1')
    await ctx.generateImages(job)

    assert.equal(service.submissions.length, 2)
    const manifest = await ctx.readManifest(ctx.thumbDir)
    assert.equal(manifest.tasks[ctx.filename]?.last_state, 'succeeded')

    // Simulate process restart: fresh job instance runs against the existing manifest
    const restartJob = ctx.makeJob('job-restart-2')
    await ctx.generateImages(restartJob)

    // No new submissions made because the task succeeded and was recovered
    assert.equal(service.submissions.length, 2)
    assert.match(restartJob.output_lines.join('\n'), /Skipping EP0001_Thumb01 \(exists\)/)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('generator image retry: :selector: suffix is stripped cleanly before retry scope calculation', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const ctx = await setupThumbnailProject(temp.dir, service.baseUrl)
    await ctx.settings.setImageRetrySetting({ enabled: true, retries: 2 })

    // In images.ts, initial thumbnail submission always attaches :selector: to the scope.
    // 1st scenario fails with IMAGE_FAILED.
    // 2nd scenario (retry 1) succeeds.
    service.queueScenario('image', { states: ['failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['succeeded'] })

    const job = ctx.makeJob('job-selector-retry')
    await ctx.generateImages(job)

    // Verify 2 submissions were made (initial + retry 1)
    assert.equal(service.submissions.length, 2)
    const [initialSub, retrySub] = service.submissions
    assert.notEqual(initialSub!.idempotencyKey, retrySub!.idempotencyKey)

    // Verify manifest has succeeded task with request_scope containing :retry:1:
    const manifest = await ctx.readManifest(ctx.thumbDir)
    const task = manifest.tasks[ctx.filename]
    assert.ok(task)
    assert.equal(task.last_state, 'succeeded')
    assert.match(task.request_scope || '', /:retry:1:/)
    assert.match(task.request_scope || '', /:selector:/)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})
