import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

async function createContinuityFixture(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{ title: name, logline: 'Paid replacement fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'neutral' }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [{ id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' }],
  }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nFixture\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
  await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({ schema_version: 1 }))
  return { project, episodeId, paths }
}

test('Continuity freezes the exact original request before POST and returns a durable paid wait after positive infrastructure settlement', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = String(input)
      if ((init?.method || 'GET') === 'GET' && url.startsWith(`${service.baseUrl}/v1/images/`)
        && !url.endsWith('/file') && response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.clone().json() as Record<string, unknown>
        if (body.state === 'failed') {
          return Response.json({ ...body, reserved_credits: 7, settled_credits: 2, released_credits: 5 }, { status: response.status })
        }
      }
      if (url.startsWith(`${service.baseUrl}/v1/image/models`) && response.headers.get('content-type')?.includes('application/json')) {
        const models = await response.clone().json() as Array<Record<string, any>>
        return Response.json(models.map(model => ({
          ...model, chargeable: true, supports_image_to_image: true,
          supports_reference_images: true, max_reference_images: 1,
          output_options: model.output_options.map((row: Record<string, unknown>) => ({
            ...row, credits_per_image: 4, price_version: 'mock-image-price-v1',
            reference_generation_credits: 5, reference_generation_price_version: 'mock-image-reference-price-v1',
          })),
        })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Paid Continuity original identity')
    await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({ schema_version: 1, use_episode_sheet: true }))
    const referenceDir = path.join(paths.episode_dir, 'img2img-references')
    await fs.mkdir(referenceDir, { recursive: true })
    await fs.writeFile(path.join(referenceDir, 'master.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlM0AAAAASUVORK5CYII=', 'base64'))
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'paid-continuity-original', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Paid Continuity original', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' },
    }
    const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
    service.queueScenario('image', {
      states: ['accepted', 'failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 7, finalCredits: 2,
    })

    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const result = await runContinuityRenderJob(job)
    assert.deepEqual(result, { kind: 'paid-image-wait' })

    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    const entry = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.deepEqual(entry.original_output_selector, {
      resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'reference-guided',
    })
    assert.equal(entry.original_output_selector.reference_mode, 'reference-guided')
    assert.equal(entry.original_reference_inputs?.length, 1)
    assert.equal(entry.original_reference_inputs?.[0]?.role, 'episode-reference-1')
    assert.match(entry.original_reference_identity_hash || '', /^[a-f0-9]{64}$/)
    assert.equal(entry.original_output_path, await fs.realpath(path.dirname(outputPath)).then(parent => path.join(parent, path.basename(outputPath))))
    assert.match(entry.input_hash || '', /^sha256:/)
    assert.match(entry.request_scope || '', /:selector:[a-f0-9]{64}:references:[a-f0-9]{64}$/)

    const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(durable.status, 'running')
    assert.equal(durable.paid_image_replacement_attempts.length, 1)
    assert.equal(durable.paid_image_replacement_attempts[0].state, 'waiting')
    assert.equal(durable.paid_image_replacement_attempts[0].output_path, entry.original_output_path)
    assert.equal(service.providerSubmissionCount('image'), 1, 'elapsed time or wait creation never submits a replacement')
    assert.deepEqual(await runContinuityRenderJob(job), { kind: 'paid-image-wait' })
    assert.equal(service.providerSubmissionCount('image'), 1, 'before-due re-entry remains a wait and submits nothing')
    const { decidePaidImageReplacement } = await import('../services/image-paid-replacement.js')
    const originalReferenceBytes = await fs.readFile(entry.original_reference_inputs![0]!.path)
    await fs.writeFile(entry.original_reference_inputs![0]!.path, Buffer.from('changed reference bytes'))
    const changedReference = await decidePaidImageReplacement({
      job,
      asset: {
        assetKey: 'scene-001.png', manifestDir: outDir, manifestKey: 'scene-001.png', outputPath,
        owningRoot: pm.getProjectDir(project.slug)!, trustedOriginal: { prompt: 'A lantern in a quiet archive.', baseScope: 'missing' },
        modelId: 'mock-image-v1', apiKey: MOCK_GENSTUDIO_FULL_KEY,
      },
    })
    assert.equal(changedReference.action, 'blocked')
    assert.equal(service.providerSubmissionCount('image'), 1, 'changed original reference bytes block before replacement admission')
    await fs.writeFile(entry.original_reference_inputs![0]!.path, originalReferenceBytes)

    const eligibleAt = Date.now() - 1_000
    durable.paid_image_replacement_attempts[0].eligible_at = new Date(eligibleAt).toISOString()
    durable.paid_image_replacement_attempts[0].terminal_observed_at = new Date(eligibleAt - 30 * 60_000).toISOString()
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [durable] }))
    Object.assign(job, durable)
    const committed = await decidePaidImageReplacement({
      job,
      asset: {
        assetKey: 'scene-001.png', manifestDir: outDir, manifestKey: 'scene-001.png',
        outputPath, owningRoot: pm.getProjectDir(project.slug)!,
        trustedOriginal: { prompt: 'A lantern in a quiet archive.', baseScope: 'missing' },
        modelId: 'mock-image-v1', apiKey: MOCK_GENSTUDIO_FULL_KEY,
      },
      now: () => new Date(eligibleAt + 1),
      dependencies: {
        readControl: async () => ({ id: entry.task_id, state: 'failed', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 7, settled_credits: 2, released_credits: 5 }),
        artifactExists: async () => false,
        getSetting: async () => ({ enabled: true, additional_credit_ceiling: 20 }),
        resolveRate: async () => ({ credits: 4, priceVersion: 'mock-image-price-v1', basis: 'published-rate' as const }),
        refreshAdmission: async () => ({ capacity_verified: true, limitSource: 'account-overview', available_paid_slots: 2, queue_near_capacity: false, submissions_blocked: false, retry_after_ms: 0, credit_balance: 20, paid_concurrency_limit: 2, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 10, generation_submissions_per_minute: 5 } as any),
      },
    })
    assert.equal(committed.action, 'commit')
    assert.equal(service.providerSubmissionCount('image'), 1, 'commitment itself makes no provider POST')
    Object.assign(job, JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0])
    await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({ schema_version: 1, use_episode_sheet: false }))
    service.queueScenario('image', { states: ['succeeded'], reservedCredits: 4, finalCredits: 4 })
    const secondResult = await runContinuityRenderJob(job)
    assert.equal(secondResult, undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 'due re-entry submits exactly the committed replacement through normal admission')
    assert.equal((service.submissions.filter(submission => submission.operation === 'image' && !submission.replay)[1]!.parsedBody!.reference_asset_ids as unknown[]).length, 1)
    const completed = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(completed.paid_image_replacement_attempts[0].state, 'succeeded')
    assert.match(completed.paid_image_replacement_attempts[0].replacement_task_id, /^mock-image-/)
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('Image Pool stays serial and returns its durable paid wait without a replacement POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = String(input)
      if ((init?.method || 'GET') === 'GET' && url.startsWith(`${service.baseUrl}/v1/images/`)
        && !url.endsWith('/file') && response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.clone().json() as Record<string, unknown>
        if (body.state === 'failed') return Response.json({ ...body, reserved_credits: 9, settled_credits: 3, released_credits: 6 })
      }
      if (url.startsWith(`${service.baseUrl}/v1/image/models`) && response.headers.get('content-type')?.includes('application/json')) {
        const models = await response.clone().json() as Array<Record<string, any>>
        return Response.json(models.map(model => ({ ...model, chargeable: true, output_options: model.output_options.map((row: Record<string, unknown>) => ({ ...row, credits_per_image: 4, price_version: 'mock-image-price-v1' })) })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const pools = await import('../services/broll-pool-manager.js')
    const { readManifest } = await import('../services/task-manifest.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const project = await pm.createProject({ name: 'Paid pool original identity' })
    const poolRoot = path.join(pm.getProjectDir(project.slug)!, 'paid-pool')
    await fs.mkdir(poolRoot, { recursive: true })
    const pool = await pools.createPool({ name: 'Paid Pool', folder_path: poolRoot, media: 'image' })
    await fs.writeFile(path.join(poolRoot, 'gen-paid-run-0001.png'), 'already complete')
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'paid-pool-original', project_slug: project.slug, type: 'image_pool_generate', episode_id: 'POOL',
      title: 'Paid Pool', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { pool_id: pool.id, prompts: ['Already present.', 'A quiet archive at night.'], model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', variants: 1, run_id: 'paid-run' },
    }
    const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_CAPACITY_UNAVAILABLE', reservedCredits: 9 })
    const { generateImagePoolImages } = await import('../generators/image-pool-generate.js')
    assert.deepEqual(await generateImagePoolImages(job), { kind: 'paid-image-wait' })
    const entry = (await readManifest(poolRoot)).tasks['gen-paid-run-0002.png']!
    assert.deepEqual(entry.original_reference_inputs, [])
    assert.equal(entry.original_output_selector?.reference_mode, 'normal')
    assert.match(entry.idempotency_key || '', /^story-image-/)
    assert.equal(service.providerSubmissionCount('image'), 1)
    const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    const eligibleAt = Date.now() - 1_000
    durable.paid_image_replacement_attempts[0].eligible_at = new Date(eligibleAt).toISOString()
    durable.paid_image_replacement_attempts[0].terminal_observed_at = new Date(eligibleAt - 30 * 60_000).toISOString()
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [durable] }))
    Object.assign(job, durable)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_CAPACITY_UNAVAILABLE', reservedCredits: 4 })
    await assert.rejects(generateImagePoolImages(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 2)
    assert.equal(JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state, 'failed')
    await assert.rejects(generateImagePoolImages(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 2, 'a failed paid replacement never chains another attempt')
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('durable thumbnails checkpoint the real accepted identity and latch a paid wait', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = String(input)
      if ((init?.method || 'GET') === 'GET' && url.startsWith(`${service.baseUrl}/v1/images/`)
        && !url.endsWith('/file') && response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.clone().json() as Record<string, unknown>
        if (body.state === 'failed') return Response.json({ ...body, reserved_credits: 8, settled_credits: 2, released_credits: 6 })
      }
      if (url.startsWith(`${service.baseUrl}/v1/image/models`) && response.headers.get('content-type')?.includes('application/json')) {
        const models = await response.clone().json() as Array<Record<string, any>>
        return Response.json(models.map(model => ({ ...model, chargeable: true, output_options: model.output_options.map((row: Record<string, unknown>) => ({ ...row, credits_per_image: 4, price_version: 'mock-image-price-v1' })) })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const { toMdPath } = await import('../lib/episode-artifacts.js')
    const { readManifest } = await import('../services/task-manifest.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const { project, episodeId, paths } = await createContinuityFixture('Paid thumbnail original identity')
    const promptPath = toMdPath(paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(promptPath), { recursive: true })
    await fs.writeFile(promptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA moonlit archive with one bright lantern.\n')
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'paid-thumb-original', project_slug: project.slug, type: 'thumb_images', episode_id: episodeId,
      title: 'Paid Thumbnail', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { episode_id: episodeId, mode: 'thumbs', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' },
    }
    const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 8 })
    const { generateImages, resolveImageDirs } = await import('../generators/images.js')
    assert.deepEqual(await generateImages(job), { kind: 'paid-image-wait' })
    const { thumbDir } = await resolveImageDirs(project.slug, promptPath, episodeId)
    const filename = `${episodeId.toUpperCase()}_Thumb01_v1.png`
    const entry = (await readManifest(thumbDir)).tasks[filename]!
    assert.match(entry.idempotency_key || '', /^story-image-/)
    assert.equal(entry.original_output_selector?.reference_mode, 'normal')
    const checkpoint = job.params.genstudio_recovery.assets[filename]
    assert.match(checkpoint.job_id, /^mock-image-/)
    assert.equal(checkpoint.idempotency_key, entry.idempotency_key)
    assert.equal(checkpoint.state, 'failed')
    assert.equal(service.providerSubmissionCount('image'), 1)
    const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    const eligibleAt = Date.now() - 1_000
    durable.paid_image_replacement_attempts[0].eligible_at = new Date(eligibleAt).toISOString()
    durable.paid_image_replacement_attempts[0].terminal_observed_at = new Date(eligibleAt - 30 * 60_000).toISOString()
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [durable] }))
    Object.assign(job, durable)
    service.queueScenario('image', { states: ['succeeded'], reservedCredits: 4, finalCredits: 4 })
    assert.equal(await generateImages(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2)
    assert.equal(JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state, 'succeeded')
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})
