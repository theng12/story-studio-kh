import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { waitFor } from './_timing.js'

const FREE_FLEET_IMAGE_MODEL = 'studio-hub::mock-image-v1'

function imageCatalogRow(id: string, chargeable: boolean) {
  return {
    id, display_name: 'Mock Image', description: 'In-process PNG fixture.',
    available: true, qualification_only: false, chargeable,
    aspect_ratios: ['16:9', '1:1'], default_aspect_ratio: '16:9', default_resolution: '1K',
    output_options: [
      { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true,
        credits_per_image: chargeable ? 4 : 0, price_version: 'mock-image-price-v1' },
      { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: false,
        credits_per_image: chargeable ? 4 : 0, price_version: 'mock-image-price-v1' },
    ],
    supports_seed: true, supports_image_to_image: false, operations: ['image.generation'],
    max_prompt_characters: 4800, prompt_token_allowance: 1200,
    min_reference_images: 0, max_reference_images: 0,
  }
}

async function writeAuthoritativeFixture(job: any): Promise<void> {
  const queue = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  await queue._waitForJobPersistenceForTesting()
  const jobsFile = path.join(pm.getProjectDir(job.project_slug)!, 'jobs.json')
  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
  queue._forgetProjectPersistenceForTesting(job.project_slug)
}

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

async function waitForPaidAttempt(
  jobsFile: string,
  predicate: (attempt: any) => boolean,
  diagnostic: string,
): Promise<void> {
  for (let turn = 0; turn < 1_000; turn++) {
    const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    if (durable.paid_image_replacement_attempts?.some(predicate)) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error(`Worker barrier exhausted: ${diagnostic}`)
}

function blockedCheckpointJob(projectSlug: string, state: 'waiting' | 'succeeded') {
  const now = new Date().toISOString()
  return {
    job_id: `blocked-checkpoint-${state}`, project_slug: projectSlug, type: 'thumb_images', episode_id: 'EP001',
    title: 'Blocked checkpoint stale copy', status: 'running', created_at: now, started_at: now, finished_at: null,
    local_execution_complete: false, error: null, output_lines: [], params: {},
    paid_image_replacement_attempts: [{
      asset_key: 'EP001_Thumb01_v1.png', manifest_dir: '/project/thumbs', manifest_key: 'EP001_Thumb01_v1.png',
      output_path: '/project/thumbs/EP001_Thumb01_v1.png', state,
      original_task_id: 'original-task', original_idempotency_key: 'story-original-key', input_hash: 'sha256:original',
      output_selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
      reference_inputs: [], reference_identity_hash: 'reference-hash', failure_code: 'SITE_PLACEMENT_EXHAUSTED',
      reserved_credits: 8, settled_credits: 2, released_credits: 6,
      terminal_observed_at: now, eligible_at: now,
    }],
  }
}

test('blocked checkpoint trusts an authoritative active attempt when the local copy is missing it', async () => {
  const temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const jq = await import('../services/job-queue.js')
  const project = await pm.createProject({ name: 'Authoritative paid block active' })
  const authoritative: any = blockedCheckpointJob(project.slug, 'waiting')
  const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
  await writeAuthoritativeFixture(authoritative)
  const staleLocal = structuredClone(authoritative)
  delete staleLocal.paid_image_replacement_attempts
  let updates = 0
  const onUpdate = (updated: any) => { if (updated.job_id === authoritative.job_id) updates++ }
  jq.jobEvents.on('update', onUpdate)
  try {
    assert.equal(await jq.checkpointPaidImageReplacementBlockedIfPresent(
      staleLocal, 'EP001_Thumb01_v1.png', 'paid image replacement is currently off on this machine',
    ), true)
    assert.equal(staleLocal.paid_image_replacement_attempts[0].state, 'blocked')
    assert.equal(staleLocal.paid_image_replacement_attempts[0].reason, 'paid image replacement is currently off on this machine')
    const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(durable.paid_image_replacement_attempts[0].state, 'blocked')
    assert.equal(updates, 1)
  } finally {
    jq.jobEvents.off('update', onUpdate)
    await temp.cleanup()
  }
})

test('blocked checkpoint cleanly ignores a stale local active attempt when authority is terminal', async () => {
  const temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const jq = await import('../services/job-queue.js')
  const project = await pm.createProject({ name: 'Authoritative paid block terminal' })
  const authoritative: any = blockedCheckpointJob(project.slug, 'succeeded')
  const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
  await writeAuthoritativeFixture(authoritative)
  const staleLocal = structuredClone(authoritative)
  staleLocal.paid_image_replacement_attempts[0].state = 'waiting'
  let updates = 0
  const onUpdate = (updated: any) => { if (updated.job_id === authoritative.job_id) updates++ }
  jq.jobEvents.on('update', onUpdate)
  try {
    assert.equal(await jq.checkpointPaidImageReplacementBlockedIfPresent(
      staleLocal, 'EP001_Thumb01_v1.png', 'paid image replacement is currently off on this machine',
    ), false)
    assert.equal(staleLocal.paid_image_replacement_attempts[0].state, 'waiting')
    assert.equal(JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state, 'succeeded')
    assert.equal(updates, 0)
  } finally {
    jq.jobEvents.off('update', onUpdate)
    await temp.cleanup()
  }
})

test('current machine Off revokes every supported committed image submit permission', async () => {
  const temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const jq = await import('../services/job-queue.js')
  const settings = await import('../services/app-settings.js')
  try {
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 10 })
    for (const type of ['continuity_render', 'image_pool_generate', 'thumb_images'] as const) {
      const project = await pm.createProject({ name: `Committed Off ${type}` })
      const authoritative: any = blockedCheckpointJob(project.slug, 'waiting')
      authoritative.job_id = `committed-off-${type}`
      authoritative.type = type
      const attempt = authoritative.paid_image_replacement_attempts[0]
      attempt.state = 'committed'
      attempt.replacement_scope = `scope-${type}`
      attempt.quoted_credits = 3
      attempt.price_version = 'price-v1'
      attempt.replacement_committed_at = new Date().toISOString()
      const entry: any = {
        task_id: attempt.original_task_id,
        idempotency_key: attempt.original_idempotency_key,
        input_hash: attempt.input_hash,
        original_output_path: attempt.output_path,
        original_output_selector: attempt.output_selector,
        original_reference_inputs: attempt.reference_inputs,
        original_reference_identity_hash: attempt.reference_identity_hash,
        replacement_of_task_id: attempt.original_task_id,
        replacement_scope: attempt.replacement_scope,
        replacement_quoted_credits: attempt.quoted_credits,
        replacement_price_version: attempt.price_version,
        replacement_committed_at: attempt.replacement_committed_at,
      }
      const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
      await writeAuthoritativeFixture(authoritative)

      const permission = await jq.getPaidImageReplacementSubmitPermission(
        authoritative, attempt.asset_key, attempt.manifest_dir, attempt.manifest_key, entry,
      )
      assert.equal(permission, null, `${type} cannot cross its committed submit boundary while current setting is Off`)
      const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
      assert.equal(durable.paid_image_replacement_attempts[0].state, 'blocked')
      assert.match(durable.paid_image_replacement_attempts[0].reason, /currently off/i)
    }
  } finally {
    await temp.cleanup()
  }
})

test('automatic missing-only run continues through repeated fully refunded failures while preserving completed scenes', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const previousRetryDelay = process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS
  process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Manual terminal Finish')
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'Replace the fully refunded failed image.' },
      { id: 'scene-complete', scene_index: 2, visual_prompt: 'Preserve this completed image.' },
    ] }))
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const completedPath = path.join(outDir, 'scene-complete.png')
    await sharp({ create: { width: 3, height: 3, channels: 3, background: '#123456' } }).png().toFile(completedPath)
    const completedBytes = await fs.readFile(completedPath)
    const now = new Date().toISOString()
    const automaticJob: any = {
      job_id: 'automatic-image-failure', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Automatic image failure', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001'], missing_only: true,
      },
    }
    await writeAuthoritativeFixture(automaticJob)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    assert.equal(await runContinuityRenderJob(automaticJob), undefined)
    assert.equal(service.providerSubmissionCount('image'), 3, 'two fully refunded failures are followed by a successful replacement')
    assert.equal(new Set(service.submissions.filter(s => s.operation === 'image').map(s => s.idempotencyKey)).size, 3, 'each confirmed failure receives a distinct replacement identity')
    assert.equal(automaticJob.paid_image_replacement_attempts, undefined)
    await sharp(path.join(outDir, 'scene-001.png')).stats()
    assert.deepEqual(await fs.readFile(completedPath), completedBytes, 'completed output is byte-identical')
    const completedEntry = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completedEntry.last_state, 'succeeded')
    assert.match(completedEntry.request_scope || '', /:retry:/, 'the retry scope persists before the replacement POST')
    assert.match(automaticJob.output_lines.join('\n'), /attempt 3/)
  } finally {
    if (previousRetryDelay === undefined) delete process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS
    else process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS = previousRetryDelay
    await service.close()
    await temp.cleanup()
  }
})

test('queue auto-retries one terminal free-fleet image under a fresh key and preserves its completed neighbor', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  const jq = await import('../services/job-queue.js')
  const wasQueuePaused = jq.isQueuePaused()
  let queuedJobId = ''
  let projectSlug = ''
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    await jq.setQueuePaused(true)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow(FREE_FLEET_IMAGE_MODEL, false)])
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Free fleet queue retry')
    projectSlug = project.slug
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'Retry this one free image.' },
      { id: 'scene-complete', scene_index: 2, visual_prompt: 'Keep this completed image.' },
    ] }))
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const completedPath = path.join(outDir, 'scene-complete.png')
    await sharp({ create: { width: 3, height: 3, channels: 3, background: '#314159' } }).png().toFile(completedPath)
    const completedBytes = await fs.readFile(completedPath)
    service.queueScenario('image', {
      states: ['accepted', 'failed'], failureCode: 'IMAGE_FAILED', reservedCredits: 0, finalCredits: 0,
    })
    service.queueScenario('image', { states: ['accepted', 'succeeded'], reservedCredits: 0, finalCredits: 0 })
    jq.registerExecutor('continuity_render', runContinuityRenderJob)
    const queued = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Free image auto-retry', params: {
        episode_id: episodeId, model: FREE_FLEET_IMAGE_MODEL, aspect_ratio: '16:9', resolution: '1K', seed: 42,
        scene_ids: ['scene-001', 'scene-complete'], missing_only: true,
      },
    })
    queuedJobId = queued.job_id
    await jq.setQueuePaused(false)

    await waitFor(() => Boolean(jq.getJob(queuedJobId)?.auto_retry?.next_retry_at), {
      label: 'free image waits before its automatic retry', timeoutMs: 10_000,
    })
    assert.equal(jq.getJob(queuedJobId)?.auto_retry?.max_attempts, 3)
    assert.ok(Date.parse(jq.getJob(queuedJobId)!.auto_retry!.next_retry_at!) - Date.now() > 50_000,
      'a fleet hiccup lasts minutes, so the free retry waits about a minute rather than two seconds')
    // Fast-forward the retry wait: the clock jumps two minutes every quarter second.
    const realNow = Date.now
    let skipped = 0
    Date.now = () => realNow() + skipped
    const clock = setInterval(() => { skipped += 2 * 60_000 }, 250)
    try {
      // Each jump is credited back to waitFor's scheduled-time budget; only its
      // wall-clock backstop would read the fake clock, so it is lifted here.
      await waitFor(() => ['done', 'error'].includes(jq.getJob(queuedJobId)?.status || ''), {
        label: 'free image queue auto-retry finishes', timeoutMs: 10_000, maxWallClockMs: Number.POSITIVE_INFINITY,
      })
    } finally {
      clearInterval(clock)
      Date.now = realNow
    }
    const completedJob = jq.getJob(queuedJobId)!
    assert.equal(completedJob.status, 'done', completedJob.error || completedJob.output_lines.join('\n'))
    assert.equal(completedJob.auto_retry?.attempt, 2)
    assert.equal(service.providerSubmissionCount('image'), 2)
    const submissions = service.submissions.filter(candidate => candidate.operation === 'image')
    assert.notEqual(submissions[0]!.idempotencyKey, submissions[1]!.idempotencyKey,
      'the retry must not replay the terminal failed provider key')
    assert.deepEqual(await fs.readFile(completedPath), completedBytes, 'the completed neighbor stays byte-identical')
    assert.equal(submissions.every(submission => submission.parsedBody?.prompt === 'Retry this one free image.'), true,
      'the completed neighbor is never submitted')
    const finalEntry = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(finalEntry.last_state, 'succeeded')
    assert.match(finalEntry.request_scope || '', /:retry:/)
    const expectedRetryKey = client.buildGenStudioImageIdempotencyKey({
      prompt: 'Retry this one free image.', modelId: FREE_FLEET_IMAGE_MODEL,
      aspectRatio: '16:9', resolution: '1K', seed: 42,
      requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${finalEntry.request_scope}`,
      outputFormat: 'jpeg',
    })
    assert.equal(submissions[1]!.parsedBody?.output_format, 'jpeg')
    assert.equal(submissions[1]!.idempotencyKey, expectedRetryKey, 'terminal task id produces one reproducible retry identity')
    assert.deepEqual(completedJob.params.scene_ids, ['scene-001'], 'the next attempt is narrowed to unresolved images')
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    if (projectSlug && queuedJobId && jq.getJob(queuedJobId)?.status !== 'done') {
      await jq.forceAbandonJob(projectSlug, queuedJobId)
    }
    if (jq.isQueuePaused() !== wasQueuePaused) await jq.setQueuePaused(wasQueuePaused)
    await service.close()
    await temp.cleanup()
  }
})

test('turning automatic replacement Off after a zero-settlement decision prevents its replacement POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreImageProvider: (() => void) | undefined
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { registry } = await import('../providers/registry.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const realProvider = registry.getImageProvider('genstudio-image')!
    let generationCalls = 0
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        generationCalls++
        if (generationCalls === 2) {
          await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
        }
        return realProvider.generateImage(request)
      },
    })
    restoreImageProvider = () => registry.registerImage(realProvider)

    const { project, episodeId, paths } = await createContinuityFixture('Zero settlement Off before submit')
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'Do not submit after automatic replacement is turned off.' },
    ] }))
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'zero-settlement-off-before-submit', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Zero settlement Off before submit', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', scene_ids: ['scene-001'], missing_only: true },
    }
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(generationCalls, 2, 'the second generator call is reached only after the fully refunded decision')
    assert.equal(service.providerSubmissionCount('image'), 1, 'Off before the replacement POST prevents new provider work')
  } finally {
    restoreImageProvider?.()
    await service.close()
    await temp.cleanup()
  }
})

test('manual Finish replaces one known terminal IMAGE_FAILED image immediately while preserving completed scenes', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Manual terminal IMAGE_FAILED')
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'Replace the terminal image.' },
      { id: 'scene-complete', scene_index: 2, visual_prompt: 'Preserve this completed image.' },
    ] }))
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const completedPath = path.join(outDir, 'scene-complete.png')
    await sharp({ create: { width: 3, height: 3, channels: 3, background: '#123456' } }).png().toFile(completedPath)
    const completedBytes = await fs.readFile(completedPath)
    const now = new Date().toISOString()
    const originalJob: any = {
      job_id: 'manual-image-failure', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Manual image failure', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: { episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', scene_ids: ['scene-001'], missing_only: true },
    }
    await writeAuthoritativeFixture(originalJob)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'IMAGE_FAILED' })
    await assert.rejects(runContinuityRenderJob(originalJob), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 1)
    const failedEntry = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(failedEntry.last_state, 'failed')

    const manualJob: any = {
      ...originalJob,
      job_id: 'manual-terminal-finish',
      title: 'Finish missing images',
      output_lines: [],
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001', 'scene-complete'], missing_only: true,
        manual_image_finish: { action_id: '44444444-4444-4444-8444-444444444444', replace_uncertain: false },
      },
    }
    await writeAuthoritativeFixture(manualJob)
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    assert.equal(await runContinuityRenderJob(manualJob), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 'the explicit click makes exactly one fresh POST')
    await sharp(path.join(outDir, 'scene-001.png')).stats()
    assert.deepEqual(await fs.readFile(completedPath), completedBytes, 'completed output is byte-identical')
    const completedEntry = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.ok(completedEntry.superseded_image_requests?.some(entry => entry.task_id === failedEntry.task_id))
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('manual Finish continues after two confirmed refunds only while the live policy is On', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const previousRetryDelay = process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS
  process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Manual Finish refunded retry')
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'manual-finish-refunded-retry', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Finish missing images', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', scene_ids: ['scene-001'], missing_only: true,
        manual_image_finish: { action_id: '10101010-1010-4010-8010-101010101010', replace_uncertain: false },
      },
    }
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })

    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 3, 'the manual POST is followed only by policy-approved refunded retries')
    assert.equal(new Set(service.submissions.filter(s => s.operation === 'image').map(s => s.idempotencyKey)).size, 3)
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    assert.match((await readManifest(outDir)).tasks['scene-001.png']!.request_scope || '', /:retry:/)
  } finally {
    if (previousRetryDelay === undefined) delete process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS
    else process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS = previousRetryDelay
    await service.close()
    await temp.cleanup()
  }
})

test('manual Finish keeps one attempt when the live recovery policy is Off', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreImageProvider: (() => void) | undefined
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { registry } = await import('../providers/registry.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const realProvider = registry.getImageProvider('genstudio-image')!
    let generationCalls = 0
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        generationCalls++
        if (generationCalls === 2) {
          await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
        }
        return realProvider.generateImage(request)
      },
    })
    restoreImageProvider = () => registry.registerImage(realProvider)

    const { project, episodeId } = await createContinuityFixture('Manual Finish policy Off')
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'manual-finish-policy-off', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Finish missing images', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', scene_ids: ['scene-001'], missing_only: true,
        manual_image_finish: { action_id: '20202020-2020-4020-8020-202020202020', replace_uncertain: false },
      },
    }
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'IMAGE_FAILED' })
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })

    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 1, 'Off stops after Finish\'s explicit request')
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await writeAuthoritativeFixture(job)
    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 1,
      'a restart promotes the terminal Finish request to automatic recovery and rechecks Off before its POST')
    // A crash can leave the local manifest accepted even though the remote
    // request has since failed. Discovering that failure must not restore the
    // already-used manual authority either.
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const outDir = job.output_dir!
    const saved = (await readManifest(outDir)).tasks['scene-001.png']!
    await recordTaskStrict(outDir, 'scene-001.png', { ...saved, last_state: 'accepted' })
    await writeAuthoritativeFixture(job)
    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 1, 'a newly observed terminal failure still obeys Off')

  } finally {
    restoreImageProvider?.()
    await service.close()
    await temp.cleanup()
  }
})

test('automatic missing-only run replaces a released exhausted-failover image and preserves completed scenes', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Automatic exhausted failover retry')
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'Replace only the released failover.' },
      { id: 'scene-complete', scene_index: 2, visual_prompt: 'Preserve this completed image.' },
    ] }))
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const completedPath = path.join(outDir, 'scene-complete.png')
    await sharp({ create: { width: 3, height: 3, channels: 3, background: '#654321' } }).png().toFile(completedPath)
    const completedBytes = await fs.readFile(completedPath)
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'automatic-exhausted-failover', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Automatic exhausted failover', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001', 'scene-complete'], missing_only: true,
      },
    }
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', {
      states: ['accepted', 'failed'], failureCode: 'SITE_FAILOVER_EXHAUSTED', reservedCredits: 9,
    })
    service.queueScenario('image', { states: ['accepted', 'succeeded'], reservedCredits: 4, finalCredits: 4 })
    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 'the same run submits exactly one fresh image request')
    await sharp(path.join(outDir, 'scene-001.png')).stats()
    assert.deepEqual(await fs.readFile(completedPath), completedBytes, 'the completed scene remains byte-identical')
    const completedEntry = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completedEntry.last_state, 'succeeded')
    assert.match(job.output_lines.join('\n'), /attempt 2\)/)
    const successfulSubmissions = service.submissions.filter(submission => submission.operation === 'image')
    assert.equal(new Set(successfulSubmissions.map(submission => submission.idempotencyKey)).size, 2, 'the replacement has a fresh stable identity')

    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 're-entry after completion submits nothing')


  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('Image Pool and paid thumbnails each retry one released exhausted failover in the same run', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = String(input)
      if (url.startsWith(`${service.baseUrl}/v1/image/models`) && response.headers.get('content-type')?.includes('application/json')) {
        const models = await response.clone().json() as Array<Record<string, any>>
        return Response.json(models.map(model => ({
          ...model, chargeable: true,
          output_options: model.output_options.map((row: Record<string, unknown>) => ({
            ...row, credits_per_image: 4, price_version: 'mock-image-price-v1',
          })),
        })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const pools = await import('../services/broll-pool-manager.js')
    const { toMdPath } = await import('../lib/episode-artifacts.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const poolProject = await pm.createProject({ name: 'Automatic failover Image Pool' })
    const poolRoot = path.join(pm.getProjectDir(poolProject.slug)!, 'automatic-failover-pool')
    await fs.mkdir(poolRoot, { recursive: true })
    const pool = await pools.createPool({ name: 'Automatic Failover Pool', folder_path: poolRoot, media: 'image' })
    const now = new Date().toISOString()
    const poolJob: any = {
      job_id: 'automatic-failover-pool', project_slug: poolProject.slug, type: 'image_pool_generate', episode_id: 'POOL',
      title: 'Automatic failover pool', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { pool_id: pool.id, prompts: ['A quiet archive.'], model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', variants: 1, run_id: 'automatic-failover' },
    }
    await writeAuthoritativeFixture(poolJob)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_FAILOVER_EXHAUSTED', reservedCredits: 9 })
    service.queueScenario('image', { states: ['accepted', 'succeeded'], reservedCredits: 4, finalCredits: 4 })
    const { generateImagePoolImages } = await import('../generators/image-pool-generate.js')
    assert.equal(await generateImagePoolImages(poolJob), undefined)
    await sharp(path.join(poolRoot, 'gen-automatic-failover-0001.png')).stats()
    assert.equal(service.providerSubmissionCount('image'), 2)

    const thumbnail = await createContinuityFixture('Automatic failover thumbnail')
    const promptPath = toMdPath(thumbnail.paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(promptPath), { recursive: true })
    await fs.writeFile(promptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA moonlit archive.\n')
    const thumbJob: any = {
      job_id: 'automatic-failover-thumbnail', project_slug: thumbnail.project.slug, type: 'thumb_images', episode_id: thumbnail.episodeId,
      title: 'Automatic failover thumbnail', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { episode_id: thumbnail.episodeId, mode: 'thumbs', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' },
    }
    await writeAuthoritativeFixture(thumbJob)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_FAILOVER_EXHAUSTED', reservedCredits: 9 })
    service.queueScenario('image', { states: ['accepted', 'succeeded'], reservedCredits: 4, finalCredits: 4 })
    const { generateImages, resolveImageDirs } = await import('../generators/images.js')
    assert.equal(await generateImages(thumbJob), undefined)
    const { thumbDir } = await resolveImageDirs(thumbnail.project.slug, promptPath, thumbnail.episodeId)
    await sharp(path.join(thumbDir, `${thumbnail.episodeId.toUpperCase()}_Thumb01_v1.png`)).stats()
    assert.equal(service.providerSubmissionCount('image'), 4)
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('manual Finish rejoins an accepted image through recovery without another provider POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Manual accepted rejoin')
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const idempotencyKey = 'story-image-existing-active'
    service.queueScenario('image', { states: ['accepted', 'running', 'succeeded'] })
    const submitted = await fetch(`${service.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        model_id: 'mock-image-v1', prompt: 'A lantern in a quiet archive.',
        aspect_ratio: '16:9', resolution: '1K',
      }),
    })
    assert.equal(submitted.status, 202)
    const accepted = await submitted.json() as { id: string; state: string }
    assert.equal(accepted.state, 'accepted')
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: accepted.id, submitted_at: new Date().toISOString(),
      input_hash: 'old-active-input', idempotency_key: idempotencyKey, operation: 'image',
      last_state: 'accepted', request_scope: 'old-active-scope',
    })
    const postsBeforeFinish = service.providerSubmissionCount('image')
    const now = new Date().toISOString()
    const finishJob: any = {
      job_id: 'manual-accepted-rejoin', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Finish missing images', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001'], missing_only: true,
        manual_image_finish: {
          action_id: '77777777-7777-4777-8777-777777777777', replace_uncertain: false,
        },
      },
    }
    await writeAuthoritativeFixture(finishJob)

    assert.equal(await runContinuityRenderJob(finishJob), undefined)
    assert.equal(service.providerSubmissionCount('image'), postsBeforeFinish, 'Finish only rejoins the accepted request')
    await sharp(path.join(outDir, 'scene-001.png')).stats()
    const completed = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completed.task_id, accepted.id)
    assert.equal(completed.idempotency_key, idempotencyKey)
    assert.equal(completed.last_state, 'succeeded')
    assert.deepEqual(finishJob.params.manual_image_finish.still_generating_scene_ids, [])
    assert.ok(service.pollCount(accepted.id) >= 2, 'Finish observes the active state, then long-polls the same request')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('manual Finish replays a provider-absent prepared image with its original key only', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Manual prepared absent replay')
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const original = buildPaidImageOriginalIdentity({
      prompt: 'A lantern in a quiet archive.', baseScope: 'missing', references: [],
      selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
    })
    const oldKey = client.buildGenStudioImageIdempotencyKey({
      prompt: 'A lantern in a quiet archive.', modelId: 'mock-image-v1', aspectRatio: '16:9', resolution: '1K',
      requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${original.requestScope}`,
    })
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-09-06T00:00:00.000Z',
      input_hash: original.inputHash, idempotency_key: oldKey, operation: 'image',
      last_state: 'prepared', request_scope: original.requestScope,
    })
    const now = new Date().toISOString()
    const finishJob: any = {
      job_id: 'manual-prepared-absent', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Finish missing images', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001'], missing_only: true,
        // Deliberately different from the prior request scope: resume must
        // retain the prepared request identity, not mint a new manual key.
        manual_image_finish: { action_id: '99999999-9999-4999-8999-999999999999', replace_uncertain: false },
      },
    }
    await writeAuthoritativeFixture(finishJob)
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })

    assert.equal(await runContinuityRenderJob(finishJob), undefined)
    assert.equal(service.providerSubmissionCount('image'), 1)
    assert.equal(service.submissions[0]!.idempotencyKey, oldKey)
    const completed = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completed.request_scope, original.requestScope)
    assert.equal(completed.input_hash, original.inputHash)
    assert.equal(completed.idempotency_key, oldKey)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

for (const drift of [
  {
    name: 'model id',
    oldModel: 'studio-hub-local::mock-image-v1',
    oldSeed: 42,
    currentSeed: 42,
  },
  {
    name: 'seed',
    oldModel: FREE_FLEET_IMAGE_MODEL,
    oldSeed: 41,
    currentSeed: 42,
  },
  // Prompt repair, Regenerate prompts or a style-bible edit after preparation: the frozen
  // facts no longer validate against the current scene (TN0294 class). Free work rebuilds.
  {
    name: 'prompt',
    oldModel: FREE_FLEET_IMAGE_MODEL,
    oldSeed: 42,
    currentSeed: 42,
    oldPrompt: 'A lantern in a quiet archive, before the prompt was repaired.',
  },
  {
    name: 'legacy entry without frozen details',
    oldModel: FREE_FLEET_IMAGE_MODEL,
    oldSeed: 42,
    currentSeed: 42,
    oldPrompt: 'A lantern in a quiet archive, before the prompt was repaired.',
    legacy: true,
  },
] as Array<{ name: string; oldModel: string; oldSeed: number; currentSeed: number; oldPrompt?: string; legacy?: boolean }>)
  test(`a provider-absent free-fleet prepared image self-heals ${drift.name} drift`, async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') {
        return Response.json([imageCatalogRow(FREE_FLEET_IMAGE_MODEL, false)])
      }
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture(`Prepared free ${drift.name} drift`)
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    await fs.mkdir(outDir, { recursive: true })
    const oldPrompt = drift.oldPrompt || 'A lantern in a quiet archive.'
    const original = buildPaidImageOriginalIdentity({
      prompt: oldPrompt, baseScope: 'missing', references: [],
      selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
    })
    const requestIdentity = `${project.slug}:${episodeId}:scene:scene-001:image:${original.requestScope}`
    const oldKey = client.buildGenStudioImageIdempotencyKey({
      prompt: oldPrompt, modelId: drift.oldModel, aspectRatio: '16:9', resolution: '1K',
      seed: drift.oldSeed, requestIdentity,
    })
    const expectedKey = client.buildGenStudioImageIdempotencyKey({
      prompt: 'A lantern in a quiet archive.', modelId: FREE_FLEET_IMAGE_MODEL,
      aspectRatio: '16:9', resolution: '1K', seed: drift.currentSeed, requestIdentity,
      outputFormat: 'jpeg',
    })
    assert.notEqual(oldKey, expectedKey, 'the fixture must exercise a changed prepared identity')
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-10-05T00:00:00.000Z',
      input_hash: original.inputHash, idempotency_key: oldKey, operation: 'image',
      last_state: 'prepared', request_scope: original.requestScope,
      ...(drift.legacy ? {} : {
        original_output_selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' as const },
        original_reference_inputs: [], original_reference_identity_hash: original.referenceIdentityHash,
        original_output_path: outputPath,
      }),
    })
    const now = new Date().toISOString()
    const job: any = {
      job_id: `prepared-free-${drift.name.replaceAll(' ', '-')}`,
      project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Resume free prepared scene', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: FREE_FLEET_IMAGE_MODEL, aspect_ratio: '16:9', resolution: '1K',
        seed: drift.currentSeed, scene_ids: ['scene-001'], missing_only: true,
      },
    }
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', { states: ['accepted', 'succeeded'], reservedCredits: 0, finalCredits: 0 })

    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 1)
    const submission = service.submissions.find(candidate => candidate.operation === 'image')!
    assert.equal(submission.idempotencyKey, expectedKey, 'the absent stale reservation is replaced under current frozen facts')
    assert.equal(submission.parsedBody?.model_id, FREE_FLEET_IMAGE_MODEL)
    assert.equal(submission.parsedBody?.seed, drift.currentSeed)
    assert.equal(submission.parsedBody?.resolution, '1K')
    assert.equal(submission.parsedBody?.output_format, 'jpeg')
    assert.equal(submission.parsedBody?.prompt, 'A lantern in a quiet archive.', 'the current scene prompt is sent')
    assert.equal(submission.parsedBody?.width, undefined)
    assert.equal(submission.parsedBody?.height, undefined)
    const completed = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completed.idempotency_key, expectedKey)
    assert.equal(completed.model_id, FREE_FLEET_IMAGE_MODEL, 'future resumes retain the exact submitted model id')
    assert.equal((completed as any).image_seed, drift.currentSeed, 'future resumes retain the exact submitted seed')
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

// TN0355 scene 65 (2026-10-06): a terminal free-fleet image went through the paid
// replacement decision, whose control read threw (or was not "failed"), so every retry
// answered "may still be recoverable" and never submitted. Free work takes the ordinary
// path: one new request under a retry identity derived from the dead task.
for (const control of ['throws', 'succeeded'] as const) {
  for (const fleet of [true, false]) {
    test(`a terminal ${fleet ? 'free-fleet' : 'paid'} image whose control read ${control} ${fleet ? 'is resubmitted once under a new key' : 'stays fail-closed'}`, async () => {
      const temp = await useTempDataDir()
      const service = await startMockGenStudioService()
      const originalFetch = globalThis.fetch
      const deadTask = `dead-${fleet ? 'free' : 'paid'}-${control}-task`
      const modelId = fleet ? FREE_FLEET_IMAGE_MODEL : 'mock-image-v1'
      try {
        const settings = await import('../services/app-settings.js')
        const secrets = await import('../services/app-secrets-store.js')
        const client = await import('../lib/genstudio-client.js')
        const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
        const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
        const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
        const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
        await settings.setGenStudioUrl(service.baseUrl)
        await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
        await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
        globalThis.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow(modelId, !fleet)])
          if (url.pathname.includes(deadTask)) {
            if (control === 'throws') throw new TypeError('fetch failed')
            return Response.json({
              id: deadTask, state: 'succeeded', operation: 'image.generation', model_id: modelId,
              cancellable: false, cancelled: false, failure_code: null,
              reserved_credits: 0, settled_credits: 0, released_credits: 0,
            })
          }
          return originalFetch(input, init)
        }
        client.clearGenStudioCatalogCache()
        await import('../providers/image/genstudio.js')

        const { project, episodeId, paths } = await createContinuityFixture(`Terminal ${fleet ? 'free' : 'paid'} ${control}`)
        const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
        const outputPath = path.join(outDir, 'scene-001.png')
        await fs.mkdir(outDir, { recursive: true })
        const selector = { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' as const }
        const original = buildPaidImageOriginalIdentity({
          prompt: 'A lantern in a quiet archive.', baseScope: 'missing', references: [], selector,
        })
        const oldKey = client.buildGenStudioImageIdempotencyKey({
          prompt: 'A lantern in a quiet archive.', modelId, aspectRatio: '16:9', resolution: '1K', seed: 42,
          requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${original.requestScope}`,
          outputFormat: 'jpeg',
        })
        await recordTaskStrict(outDir, 'scene-001.png', {
          provider: 'genstudio-image', task_id: deadTask, submitted_at: '2026-10-06T00:00:00.000Z',
          input_hash: original.inputHash, idempotency_key: oldKey, operation: 'image',
          last_state: 'failed', request_scope: original.requestScope, model_id: modelId, image_seed: 42,
          original_output_selector: selector, original_reference_inputs: [],
          original_reference_identity_hash: original.referenceIdentityHash, original_output_path: outputPath,
        })
        const now = new Date().toISOString()
        const job: any = {
          job_id: `terminal-${fleet ? 'free' : 'paid'}-${control}`, project_slug: project.slug, type: 'continuity_render',
          episode_id: episodeId, title: 'Finish missing images', status: 'running', created_at: now, started_at: now,
          finished_at: null, local_execution_complete: false, error: null, output_lines: [],
          paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
          params: {
            episode_id: episodeId, model: modelId, aspect_ratio: '16:9', resolution: '1K', seed: 42,
            scene_ids: ['scene-001'], missing_only: true,
          },
        }
        await writeAuthoritativeFixture(job)
        service.queueScenario('image', { states: ['accepted', 'succeeded'], reservedCredits: 0, finalCredits: 0 })

        if (!fleet) {
          await assert.rejects(runContinuityRenderJob(job), (error: any) => {
            assert.equal(error.message,
              "Scene images incomplete: 0 of 1 made; finished images are saved. Scene 1 couldn't be made after 1 try: "
              + 'The original task may still be recoverable; no replacement was submitted. Press Retry to try again.')
            return true
          })
          assert.equal(service.providerSubmissionCount('image'), 0, 'paid work never resubmits while the original may be recoverable')
          return
        }
        assert.equal(await runContinuityRenderJob(job), undefined, job.output_lines.join('\n'))
        assert.equal(service.providerSubmissionCount('image'), 1)
        const submission = service.submissions.find(candidate => candidate.operation === 'image')!
        assert.notEqual(submission.idempotencyKey, oldKey, 'the dead key is never replayed')
        const completed = (await readManifest(outDir)).tasks['scene-001.png']!
        assert.equal(completed.last_state, 'succeeded')
        assert.match(completed.request_scope || '', /:retry:/)
        assert.equal(submission.idempotencyKey, client.buildGenStudioImageIdempotencyKey({
          prompt: 'A lantern in a quiet archive.', modelId, aspectRatio: '16:9', resolution: '1K', seed: 42,
          requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${completed.request_scope}`,
          outputFormat: 'jpeg',
        }), 'one reproducible retry identity derived from the dead task')
        await sharp(outputPath).stats()
      } finally {
        globalThis.fetch = originalFetch
        const client = await import('../lib/genstudio-client.js')
        client.clearGenStudioCatalogCache()
        await service.close()
        await temp.cleanup()
      }
    })
  }
}

for (const recoveryCase of [
  { name: 'keeps its frozen model and seed', frozenFacts: true },
  { name: 'does not invent missing legacy model and seed', frozenFacts: false },
]) test(`a completed exact-key prepared image ${recoveryCase.name} after current settings drift`, async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') {
        return Response.json([imageCatalogRow(FREE_FLEET_IMAGE_MODEL, false)])
      }
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture(
      recoveryCase.frozenFacts ? 'Prepared recovered frozen facts' : 'Prepared recovered legacy facts',
    )
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    await fs.mkdir(outDir, { recursive: true })
    const original = buildPaidImageOriginalIdentity({
      prompt: 'A lantern in a quiet archive.', baseScope: 'missing', references: [],
      selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
    })
    const oldModel = 'studio-hub-local::mock-image-v1'
    const oldSeed = 41
    const oldKey = client.buildGenStudioImageIdempotencyKey({
      prompt: 'A lantern in a quiet archive.', modelId: oldModel,
      aspectRatio: '16:9', resolution: '1K', seed: oldSeed, outputFormat: 'jpeg',
      requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${original.requestScope}`,
    })
    service.queueScenario('image', { states: ['succeeded'], reservedCredits: 0, finalCredits: 0 })
    const seeded = await originalFetch(`${service.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': oldKey,
      },
      body: JSON.stringify({
        model_id: oldModel, prompt: 'A lantern in a quiet archive.',
        aspect_ratio: '16:9', resolution: '1K', seed: oldSeed, output_format: 'jpeg',
      }),
    })
    assert.equal(seeded.status, 202)
    const seededTask = await seeded.json() as { id: string; state: string }
    assert.equal(seededTask.state, 'succeeded')
    const postsBeforeRecovery = service.providerSubmissionCount('image')
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-10-05T00:00:00.000Z',
      input_hash: original.inputHash, idempotency_key: oldKey, operation: 'image',
      last_state: 'prepared', request_scope: original.requestScope,
      ...(recoveryCase.frozenFacts ? { model_id: oldModel, image_seed: oldSeed } : {}),
      original_output_selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
      original_reference_inputs: [], original_reference_identity_hash: original.referenceIdentityHash,
      original_output_path: outputPath,
    })
    const now = new Date().toISOString()
    const job: any = {
      job_id: `prepared-recovered-${recoveryCase.frozenFacts ? 'frozen' : 'legacy'}`,
      project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Recover completed prepared scene', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: FREE_FLEET_IMAGE_MODEL, aspect_ratio: '16:9', resolution: '1K',
        seed: 42, scene_ids: ['scene-001'], missing_only: true,
      },
    }
    await writeAuthoritativeFixture(job)

    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), postsBeforeRecovery,
      'exact-key recovery must not submit another provider request')
    await sharp(outputPath).stats()
    const completed = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completed.last_state, 'succeeded')
    assert.equal(completed.task_id, seededTask.id)
    assert.equal(completed.idempotency_key, oldKey)
    assert.equal(completed.model_id, recoveryCase.frozenFacts ? oldModel : undefined)
    assert.equal(completed.image_seed, recoveryCase.frozenFacts ? oldSeed : undefined)
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

test('a completed exact-key legacy preparation without frozen original facts cannot promote a changed prompt', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') {
        return Response.json([imageCatalogRow(FREE_FLEET_IMAGE_MODEL, false)])
      }
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Prepared recovered unfrozen legacy prompt')
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    await fs.mkdir(outDir, { recursive: true })
    const requestScope = 'legacy-missing'
    const oldPrompt = 'An obsolete observatory prompt.'
    const oldKey = client.buildGenStudioImageIdempotencyKey({
      prompt: oldPrompt, modelId: FREE_FLEET_IMAGE_MODEL,
      aspectRatio: '16:9', resolution: '1K', seed: 42, outputFormat: 'jpeg',
      requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${requestScope}`,
    })
    service.queueScenario('image', { states: ['succeeded'], reservedCredits: 0, finalCredits: 0 })
    const seeded = await originalFetch(`${service.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': oldKey,
      },
      body: JSON.stringify({
        model_id: FREE_FLEET_IMAGE_MODEL, prompt: oldPrompt,
        aspect_ratio: '16:9', resolution: '1K', seed: 42, output_format: 'jpeg',
      }),
    })
    assert.equal(seeded.status, 202)
    const postsBeforeRecovery = service.providerSubmissionCount('image')
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-10-05T00:00:00.000Z',
      input_hash: 'legacy-unfrozen-input', idempotency_key: oldKey, operation: 'image',
      last_state: 'prepared', request_scope: requestScope,
    })
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'prepared-recovered-unfrozen-legacy', project_slug: project.slug,
      type: 'continuity_render', episode_id: episodeId, title: 'Reject changed legacy prepared prompt',
      status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: FREE_FLEET_IMAGE_MODEL, aspect_ratio: '16:9', resolution: '1K',
        seed: 42, scene_ids: ['scene-001'], missing_only: true,
      },
    }
    await writeAuthoritativeFixture(job)

    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), postsBeforeRecovery)
    await assert.rejects(fs.stat(outputPath), { code: 'ENOENT' })
    assert.ok(job.output_lines.some((line: string) => /saved prepared image request no longer matches/i.test(line)))
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

test('a provider-absent paid prepared image stays fail-closed when its key no longer matches', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow('mock-image-v1', true)])
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Prepared paid mismatch')
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    await fs.mkdir(outDir, { recursive: true })
    const original = buildPaidImageOriginalIdentity({
      prompt: 'A lantern in a quiet archive.', baseScope: 'missing', references: [],
      selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
    })
    const oldKey = client.buildGenStudioImageIdempotencyKey({
      prompt: 'A lantern in a quiet archive.', modelId: 'mock-image-v1', aspectRatio: '16:9', resolution: '1K',
      seed: 41, requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${original.requestScope}`,
    })
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-10-05T00:00:00.000Z',
      input_hash: original.inputHash, idempotency_key: oldKey, operation: 'image',
      last_state: 'prepared', request_scope: original.requestScope,
      original_output_selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
      original_reference_inputs: [], original_reference_identity_hash: original.referenceIdentityHash,
      original_output_path: outputPath,
    })
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'prepared-paid-mismatch', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Resume paid prepared scene', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', seed: 42,
        scene_ids: ['scene-001'], missing_only: true,
      },
    }
    await writeAuthoritativeFixture(job)

    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 0)
    assert.ok(job.output_lines.some((line: string) => /saved prepared image request no longer matches/i.test(line)))
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

for (const recoveryCase of [
  { name: 'accepted lookup returns absent', taskId: 'missing-accepted-free-task', state: 'accepted', lookupStatus: 404 },
  { name: 'prepared lookup is uncertain', taskId: '', state: 'prepared', lookupStatus: 500 },
]) test(`free-fleet recovery makes no duplicate POST when an ${recoveryCase.name}`, async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    const oldKey = `story-image-${recoveryCase.state}-free-recovery`
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow(FREE_FLEET_IMAGE_MODEL, false)])
      if (recoveryCase.lookupStatus === 500 && url.pathname === `/v1/images/by-idempotency-key/${oldKey}`) {
        return Response.json({ detail: 'temporary lookup failure' }, { status: 500 })
      }
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture(`Free recovery ${recoveryCase.state}`)
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    await fs.mkdir(outDir, { recursive: true })
    const original = buildPaidImageOriginalIdentity({
      prompt: 'A lantern in a quiet archive.', baseScope: 'missing', references: [],
      selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
    })
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: recoveryCase.taskId, submitted_at: '2026-10-05T00:00:00.000Z',
      input_hash: original.inputHash, idempotency_key: oldKey, operation: 'image',
      last_state: recoveryCase.state, request_scope: original.requestScope,
      original_output_selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
      original_reference_inputs: [], original_reference_identity_hash: original.referenceIdentityHash,
      original_output_path: outputPath,
    })
    const now = new Date().toISOString()
    const job: any = {
      job_id: `free-recovery-${recoveryCase.state}`, project_slug: project.slug,
      type: 'continuity_render', episode_id: episodeId, title: 'Recover free prepared scene',
      status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: FREE_FLEET_IMAGE_MODEL, aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001'], missing_only: true,
      },
    }
    await writeAuthoritativeFixture(job)

    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 0)
    assert.ok(job.output_lines.some((line: string) => /Could not confirm the earlier Gateway request/i.test(line)))
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

test('manual pause after an absent free prepared lookup still prevents the healed POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  const jq = await import('../services/job-queue.js')
  const wasQueuePaused = jq.isQueuePaused()
  let queuedJobId = ''
  let projectSlug = ''
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    await jq.setQueuePaused(true)
    const { project, episodeId, paths } = await createContinuityFixture('Manual pause before healed free submit')
    projectSlug = project.slug
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    await fs.mkdir(outDir, { recursive: true })
    const original = buildPaidImageOriginalIdentity({
      prompt: 'A lantern in a quiet archive.', baseScope: 'missing', references: [],
      selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
    })
    const oldKey = client.buildGenStudioImageIdempotencyKey({
      prompt: 'A lantern in a quiet archive.', modelId: 'studio-hub-local::mock-image-v1',
      aspectRatio: '16:9', resolution: '1K', seed: 42,
      requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${original.requestScope}`,
    })
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-10-05T00:00:00.000Z',
      input_hash: original.inputHash, idempotency_key: oldKey, operation: 'image',
      last_state: 'prepared', request_scope: original.requestScope,
      original_output_selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
      original_reference_inputs: [], original_reference_identity_hash: original.referenceIdentityHash,
      original_output_path: outputPath,
    })
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow(FREE_FLEET_IMAGE_MODEL, false)])
      if (url.pathname === `/v1/images/by-idempotency-key/${oldKey}`) {
        await jq.pauseJob(queuedJobId, 'manual')
        return Response.json({ detail: 'not found' }, { status: 404 })
      }
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    jq.registerExecutor('continuity_render', runContinuityRenderJob)
    const queued = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Resume free prepared scene', params: {
        episode_id: episodeId, model: FREE_FLEET_IMAGE_MODEL, aspect_ratio: '16:9', resolution: '1K', seed: 42,
        scene_ids: ['scene-001'], missing_only: true,
      },
    })
    queuedJobId = queued.job_id
    await jq.setQueuePaused(false)

    await waitFor(() => jq.getJob(queuedJobId)?.status === 'paused', {
      label: 'manual pause after absent prepared lookup',
    })
    assert.equal(jq.getJob(queuedJobId)?.pause_origin, 'manual')
    assert.equal(service.providerSubmissionCount('image'), 0)
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    if (projectSlug && queuedJobId && jq.getJob(queuedJobId)) {
      await jq.forceAbandonJob(projectSlug, queuedJobId)
    }
    if (jq.isQueuePaused() !== wasQueuePaused) await jq.setQueuePaused(wasQueuePaused)
    await service.close()
    await temp.cleanup()
  }
})

test('a prepared key found terminal becomes one fresh manual replacement instead of replaying it', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const oldKey = 'story-image-prepared-terminal-key'
    service.queueScenario('image', { states: ['failed'], failureCode: 'provider_error' })
    await assert.rejects(client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      prompt: 'A lantern in a quiet archive.', modelId: 'mock-image-v1', aspectRatio: '16:9',
      requestIdentity: 'pre-existing-prepared-request', idempotencyKey: oldKey,
    }))
    assert.equal(service.providerSubmissionCount('image'), 1)

    const { project, episodeId, paths } = await createContinuityFixture('Manual prepared terminal replacement')
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-09-06T00:00:00.000Z',
      input_hash: 'saved-prepared-hash', idempotency_key: oldKey, operation: 'image',
      last_state: 'prepared', request_scope: 'missing',
    })
    const now = new Date().toISOString()
    const finishJob: any = {
      job_id: 'manual-prepared-terminal', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Finish missing images', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001'], missing_only: true,
        manual_image_finish: { action_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', replace_uncertain: false },
      },
    }
    await writeAuthoritativeFixture(finishJob)
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })

    assert.equal(await runContinuityRenderJob(finishJob), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2)
    assert.notEqual(service.submissions[1]!.idempotencyKey, oldKey, 'a terminal prepared request must be superseded by a new retry identity')
    const completed = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completed.last_state, 'succeeded')
    assert.notEqual(completed.idempotency_key, oldKey)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('manual Finish never replaces a malformed prepared record or an accepted task with an absent lookup', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const malformed = await createContinuityFixture('Manual malformed prepared')
    const malformedDir = await resolveSceneImagesDir(malformed.project.slug, malformed.episodeId, malformed.paths.episode_dir)
    await fs.mkdir(malformedDir, { recursive: true })
    await recordTaskStrict(malformedDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-09-06T00:00:00.000Z', input_hash: 'saved-input',
      operation: 'image', last_state: 'prepared', request_scope: 'missing',
    })
    const now = new Date().toISOString()
    const malformedJob: any = {
      job_id: 'manual-malformed-prepared', project_slug: malformed.project.slug, type: 'continuity_render', episode_id: malformed.episodeId,
      title: 'Finish missing images', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: { episode_id: malformed.episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', scene_ids: ['scene-001'], missing_only: true,
        manual_image_finish: { action_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', replace_uncertain: false } },
    }
    await writeAuthoritativeFixture(malformedJob)
    await assert.rejects(runContinuityRenderJob(malformedJob), /incomplete/i)
    assert.ok(malformedJob.output_lines.some((line: string) => /no idempotency key/i.test(line)))
    assert.equal(service.providerSubmissionCount('image'), 0, 'a prepared record without an identity cannot become a fresh paid request')

    // A legacy forced re-render is deliberate fresh work, not a recovery. Its
    // malformed historical record must not prevent the new action from owning
    // a fresh provider request.
    const forcedJob: any = {
      ...malformedJob, job_id: 'force-malformed-prepared', output_lines: [],
      params: { ...malformedJob.params, force: true, missing_only: false, manual_image_finish: undefined },
    }
    await writeAuthoritativeFixture(forcedJob)
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    assert.equal(await runContinuityRenderJob(forcedJob), undefined)
    assert.equal(service.providerSubmissionCount('image'), 1, 'force owns a fresh request despite the malformed historical prepared record')

    service.reset()
    const accepted = await createContinuityFixture('Manual accepted absent lookup')
    const acceptedDir = await resolveSceneImagesDir(accepted.project.slug, accepted.episodeId, accepted.paths.episode_dir)
    await fs.mkdir(acceptedDir, { recursive: true })
    await recordTaskStrict(acceptedDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: 'missing-accepted-task', submitted_at: '2026-09-06T00:00:00.000Z',
      input_hash: 'saved-input', idempotency_key: 'story-image-accepted-absent', operation: 'image', last_state: 'accepted', request_scope: 'missing',
    })
    const acceptedJob: any = {
      ...malformedJob, job_id: 'manual-accepted-absent', project_slug: accepted.project.slug, episode_id: accepted.episodeId,
      params: { ...malformedJob.params, episode_id: accepted.episodeId,
        manual_image_finish: { action_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', replace_uncertain: false } },
    }
    await writeAuthoritativeFixture(acceptedJob)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/images/missing-accepted-task') return Response.json({ detail: 'not found' }, { status: 404 })
      return originalFetch(input, init)
    }
    await assert.rejects(runContinuityRenderJob(acceptedJob), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 0, 'an accepted task that cannot be reconciled remains uncertain')
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('a 500 during Finish recovery makes no POST and Replace anyway submits only its exact confirmed scene', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { imageManifestIdentityHash } = await import('../lib/manifest-recovery.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Manual uncertain replacement')
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const uncertainEntry = {
      provider: 'genstudio-image', task_id: '', submitted_at: '2026-09-06T00:00:00.000Z',
      input_hash: 'old-input', idempotency_key: 'story-image-uncertain-old', operation: 'image' as const,
      last_state: 'prepared', request_scope: 'old-uncertain-scope',
    }
    await recordTaskStrict(outDir, 'scene-001.png', uncertainEntry)
    const now = new Date().toISOString()
    const finishJob: any = {
      job_id: 'manual-uncertain-finish', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Finish missing images', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001'], missing_only: true,
        manual_image_finish: {
          action_id: '55555555-5555-4555-8555-555555555555', replace_uncertain: false,
        },
      },
    }
    await writeAuthoritativeFixture(finishJob)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === `/v1/images/by-idempotency-key/${uncertainEntry.idempotency_key}`) {
        return Response.json({ detail: 'temporary provider outage' }, { status: 500 })
      }
      return originalFetch(input, init)
    }
    await assert.rejects(runContinuityRenderJob(finishJob), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 0)
    assert.deepEqual(finishJob.params.manual_image_finish.uncertain_scene_ids, ['scene-001'])
    const confirmedHash = finishJob.params.manual_image_finish.uncertain_identity_hashes['scene-001']
    assert.equal(confirmedHash, imageManifestIdentityHash(uncertainEntry))

    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'Replace the exact uncertain image.' },
      { id: 'scene-other-missing', scene_index: 2, visual_prompt: 'This unconfirmed scene stays untouched.' },
    ] }))
    const replaceJob: any = {
      ...finishJob,
      job_id: 'manual-replace-uncertain',
      output_lines: [],
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001'], missing_only: true,
        manual_image_finish: {
          action_id: '66666666-6666-4666-8666-666666666666', replace_uncertain: true,
          source_job_id: finishJob.job_id,
          expected_uncertain_identity_hashes: { 'scene-001': confirmedHash },
        },
      },
    }
    await writeAuthoritativeFixture(replaceJob)
    globalThis.fetch = originalFetch
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    assert.equal(await runContinuityRenderJob(replaceJob), undefined)
    assert.equal(service.providerSubmissionCount('image'), 1)
    await sharp(path.join(outDir, 'scene-001.png')).stats()
    await assert.rejects(fs.stat(path.join(outDir, 'scene-other-missing.png')), /ENOENT/)
    const replacedEntry = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.ok(replacedEntry.superseded_image_requests?.some(entry => entry.idempotency_key === uncertainEntry.idempotency_key))
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('a restarted Pipeline repair does not submit a second fresh attempt for its failed image', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Pipeline repair restart bound')
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const actionId = '77777777-7777-4777-8777-777777777777'
    await recordTaskStrict(outDir, 'scene-001.png', {
      provider: 'genstudio-image', task_id: 'failed-replacement', submitted_at: new Date().toISOString(),
      input_hash: 'failed-replacement-input', idempotency_key: 'failed-replacement-key', operation: 'image',
      last_state: 'failed', request_scope: `manual-finish:${actionId}:replace:stable`,
    })
    const now = new Date().toISOString()
    const repairJob: any = {
      job_id: 'pipeline-repair-restart', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Repair selected gaps', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        scene_ids: ['scene-001'], missing_only: true,
        pipeline_repair: { action_id: actionId },
      },
    }
    await writeAuthoritativeFixture(repairJob)

    await assert.rejects(runContinuityRenderJob(repairJob), /incomplete/)
    assert.ok(repairJob.output_lines.some((line: string) => /already used its one fresh attempt/.test(line)))
    assert.deepEqual(repairJob.params.manual_image_finish, { action_id: actionId, replace_uncertain: false },
      'generic Retry restores only the original Pipeline repair marker')
    assert.equal(service.providerSubmissionCount('image'), 0)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('Pipeline repair replays its exact prepared image identity after an absent pre-POST attempt', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await client.listImageModels(MOCK_GENSTUDIO_FULL_KEY)
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Pipeline prepared image replay')
    const actionId = '88888888-8888-4888-8888-888888888888'
    const now = new Date().toISOString()
    const params = {
      episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
      scene_ids: ['scene-001'], missing_only: true, pipeline_repair: { action_id: actionId },
    }
    const interrupted: any = {
      job_id: 'pipeline-pre-post-interruption', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Repair selected gaps', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [], params: structuredClone(params),
    }
    await writeAuthoritativeFixture(interrupted)
    let interruptSubmit = true
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (interruptSubmit && url.pathname === '/v1/images/generations' && (init?.method || 'GET') === 'POST') {
        throw new TypeError('simulated interruption before image POST reached the Gateway')
      }
      return originalFetch(input, init)
    }
    await assert.rejects(runContinuityRenderJob(interrupted), /incomplete/)
    assert.equal(service.providerSubmissionCount('image'), 0)

    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const prepared = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(prepared.last_state, 'prepared')
    assert.match(prepared.request_scope || '', new RegExp(`^manual-finish:${actionId}:selector:`))
    assert.ok(prepared.idempotency_key)
    assert.ok(prepared.input_hash)

    interruptSubmit = false
    const restarted: any = {
      ...interrupted,
      job_id: 'pipeline-pre-post-restart',
      output_lines: [],
      params: structuredClone(params),
    }
    await writeAuthoritativeFixture(restarted)
    assert.equal(await runContinuityRenderJob(restarted), undefined)
    assert.equal(service.providerSubmissionCount('image'), 1)
    const completed = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completed.request_scope, prepared.request_scope)
    assert.equal(completed.idempotency_key, prepared.idempotency_key)
    assert.equal(completed.input_hash, prepared.input_hash)
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('Pipeline repair preserves a decodable image owned by scene.image_path', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Pipeline imported image preservation')
    const importedPath = path.join(paths.episode_dir, 'imported-scene.png')
    await sharp({ create: { width: 3, height: 3, channels: 3, background: '#223344' } }).png().toFile(importedPath)
    const importedBytes = await fs.readFile(importedPath)
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-imported', scene_index: 1, visual_prompt: 'Keep imported.', image_path: importedPath },
      { id: 'scene-missing', scene_index: 2, visual_prompt: 'Generate only this missing scene.' },
    ] }))
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'pipeline-imported-preservation', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Repair selected gaps', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [], params: {
        episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', missing_only: true,
        pipeline_repair: { action_id: '99999999-9999-4999-8999-999999999999' },
      },
    }
    await writeAuthoritativeFixture(job)
    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 1)
    assert.deepEqual(await fs.readFile(importedPath), importedBytes)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('Continuity freezes the exact original request before POST and returns a durable paid wait after positive infrastructure settlement', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  let exposeOriginalAsRunning = false
  let imageStatusReads = 0
  let referenceUploads = 0
  let imageGenerationPosts = 0
  let restoreImageProvider: (() => void) | undefined
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method || (input instanceof Request ? input.method : 'GET')
      if (method === 'GET' && url.startsWith(`${service.baseUrl}/v1/images/`) && !url.endsWith('/file')) imageStatusReads++
      if (method === 'POST' && url === `${service.baseUrl}/v1/images/source-images`) referenceUploads++
      if (method === 'POST' && url === `${service.baseUrl}/v1/images/generations`) imageGenerationPosts++
      const response = await originalFetch(input, init)
      if (method === 'GET' && url.startsWith(`${service.baseUrl}/v1/images/`)
        && !url.endsWith('/file') && response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.clone().json() as Record<string, unknown>
        if (body.state === 'failed') {
          if (exposeOriginalAsRunning) return Response.json({ ...body, state: 'running', failure_code: null })
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
    const externalMediaRoot = path.join(temp.dir, 'external-media')
    await fs.mkdir(externalMediaRoot, { recursive: true })
    await pm.updateProject(project.slug, { media_root: externalMediaRoot } as any)
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
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', {
      states: ['accepted', 'failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 7, finalCredits: 2,
    })

    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const result = await runContinuityRenderJob(job)
    assert.deepEqual(result, { kind: 'paid-image-wait' })

    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    assert.ok(outDir.startsWith(externalMediaRoot), 'Continuity output is rooted in external media while references remain project-owned')
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
        owningRoot: pm.getProjectDir(project.slug)!, referenceRoot: pm.getProjectDir(project.slug)!, outputRoot: outDir,
        trustedOriginal: { prompt: 'A lantern in a quiet archive.', baseScope: 'missing' },
        modelId: 'mock-image-v1', apiKey: MOCK_GENSTUDIO_FULL_KEY,
      },
    })
    assert.equal(changedReference.action, 'blocked')
    assert.equal(service.providerSubmissionCount('image'), 1, 'changed original reference bytes block before replacement admission')
    await fs.writeFile(entry.original_reference_inputs![0]!.path, originalReferenceBytes)

    const eligibleAt = Date.now() - 1_000
    durable.paid_image_replacement_attempts[0].eligible_at = new Date(eligibleAt).toISOString()
    durable.paid_image_replacement_attempts[0].terminal_observed_at = new Date(eligibleAt - 30 * 60_000).toISOString()
    await writeAuthoritativeFixture(durable)
    Object.assign(job, durable)
    exposeOriginalAsRunning = true
    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 1, 'elapsed eligibility without terminal evidence makes zero replacement POSTs')
    exposeOriginalAsRunning = false
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    const blockedContinuity = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(blockedContinuity.paid_image_replacement_attempts[0].state, 'blocked')
    assert.match(blockedContinuity.paid_image_replacement_attempts[0].reason, /currently off/i)
    assert.equal(service.providerSubmissionCount('image'), 1, 'a blocked due Continuity attempt submits nothing')
    blockedContinuity.paid_image_replacement_attempts[0].state = 'waiting'
    delete blockedContinuity.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(blockedContinuity)
    Object.assign(job, blockedContinuity)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    const committed = await decidePaidImageReplacement({
      job,
      asset: {
        assetKey: 'scene-001.png', manifestDir: outDir, manifestKey: 'scene-001.png',
        outputPath, owningRoot: pm.getProjectDir(project.slug)!, referenceRoot: pm.getProjectDir(project.slug)!, outputRoot: outDir,
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
    const manifestPath = path.join(outDir, '.task-manifest.json')
    const committedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    const incompleteManifest = structuredClone(committedManifest)
    delete incompleteManifest.tasks['scene-001.png'].replacement_price_version
    await fs.writeFile(manifestPath, JSON.stringify(incompleteManifest))
    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 1, 'jobs-first crash before the manifest mirror makes zero replacement POSTs')
    await fs.writeFile(manifestPath, JSON.stringify(committedManifest))
    const blockedMirror = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(blockedMirror.paid_image_replacement_attempts[0].state, 'blocked')
    blockedMirror.paid_image_replacement_attempts[0].state = 'committed'
    delete blockedMirror.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(blockedMirror)
    Object.assign(job, blockedMirror)

    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    const revokedCommit = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(revokedCommit.paid_image_replacement_attempts[0].state, 'blocked')
    assert.equal(service.providerSubmissionCount('image'), 1, 'Off revokes a lane-delayed committed Continuity POST')
    revokedCommit.paid_image_replacement_attempts[0].state = 'committed'
    delete revokedCommit.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(revokedCommit)
    Object.assign(job, revokedCommit)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })

    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#123456' } })
      .png().toFile(outputPath)
    const committedArtifactBytes = await fs.readFile(outputPath)
    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 1, 'a decoder-valid original artifact at committed/before-POST makes zero replacement POSTs')
    assert.deepEqual(await fs.readFile(outputPath), committedArtifactBytes, 'committed/before-POST reconciliation preserves the original artifact')
    assert.equal(
      JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state,
      'committed',
      'a committed attempt without a replacement task is not blessed as paid success',
    )
    await fs.rm(outputPath)
    await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({ schema_version: 1, use_episode_sheet: false }))
    service.queueScenario('image', { states: ['succeeded'], reservedCredits: 4, finalCredits: 4 })

    await fs.writeFile(entry.original_reference_inputs![0]!.path, Buffer.from('mutated after durable commitment'))
    await assert.rejects(
      runContinuityRenderJob(job),
      /incomplete/i,
      'the real generator must revalidate frozen reference bytes immediately before a committed replacement POST',
    )
    assert.equal(service.providerSubmissionCount('image'), 1, 'commit-to-POST reference mutation fails closed without spending')
    await fs.writeFile(entry.original_reference_inputs![0]!.path, originalReferenceBytes)

    const { registry } = await import('../providers/registry.js')
    const { GenStudioImageTerminalFailureError } = await import('../lib/genstudio-client.js')
    const realProvider = registry.getImageProvider('genstudio-image')!
    restoreImageProvider = () => registry.registerImage(realProvider)
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        await request.onJobAccepted?.('known-continuity-paid-failure', request.idempotencyKey || 'missing-key')
        throw new GenStudioImageTerminalFailureError({
          id: 'known-continuity-paid-failure', state: 'failed', cancelled: false, failure_code: 'PROVIDER_ERROR',
          reserved_credits: 5, settled_credits: 3, released_credits: 2,
        } as any)
      },
    })
    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    const settledFailure = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(settledFailure.paid_image_replacement_attempts[0].state, 'failed')
    assert.equal(settledFailure.paid_image_replacement_attempts[0].actual_settled_credits, 3)
    settledFailure.paid_image_replacement_attempts[0].state = 'committed'
    delete settledFailure.paid_image_replacement_attempts[0].replacement_task_id
    delete settledFailure.paid_image_replacement_attempts[0].actual_settled_credits
    delete settledFailure.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(settledFailure)
    Object.assign(job, settledFailure)
    registry.registerImage(realProvider)
    restoreImageProvider = undefined

    const secondResult = await runContinuityRenderJob(job)
    assert.equal(secondResult, undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 'due re-entry submits exactly the committed replacement through normal admission')
    assert.equal((service.submissions.filter(submission => submission.operation === 'image' && !submission.replay)[1]!.parsedBody!.reference_asset_ids as unknown[]).length, 1)
    const completed = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(completed.paid_image_replacement_attempts[0].state, 'succeeded')
    assert.match(completed.paid_image_replacement_attempts[0].replacement_task_id, /^mock-image-/)
    assert.equal(completed.paid_image_replacement_attempts[0].actual_settled_credits, 4, 'successful provider results preserve authoritative settlement')

    completed.paid_image_replacement_attempts[0].state = 'submitted'
    await writeAuthoritativeFixture(completed)
    Object.assign(job, completed)
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 'artifact-before-checkpoint recovery never resubmits Continuity')
    assert.equal(JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state, 'succeeded')

    const submittedWithoutArtifact = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    const paidTaskId = submittedWithoutArtifact.paid_image_replacement_attempts[0].replacement_task_id
    const paidRecoveryEvidence = submittedWithoutArtifact.params.genstudio_recovery.assets['scene-001.png']
    assert.equal(paidRecoveryEvidence.job_id, paidTaskId, 'accepted replacement task identity is durable')
    assert.match(paidRecoveryEvidence.idempotency_key, /^story-image-/, 'accepted replacement idempotency identity is durable')
    submittedWithoutArtifact.paid_image_replacement_attempts[0].state = 'submitted'
    await writeAuthoritativeFixture(submittedWithoutArtifact)
    Object.assign(job, submittedWithoutArtifact)
    await fs.rm(outputPath)
    const submissionsBeforeRecovery = service.providerSubmissionCount('image')
    const statusReadsBeforeRecovery = imageStatusReads
    const uploadsBeforeRecovery = referenceUploads
    const observedStates: string[] = []
    const jq = await import('../services/job-queue.js')
    const submittedManifestEntry = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(
      jq.getPaidImageReplacementRecoveryEntry(job, 'scene-001.png', outDir, 'scene-001.png', submittedManifestEntry)?.task_id,
      paidTaskId,
      'durable submitted task and idempotency evidence authorize only read-only recovery',
    )
    const onSubmittedRecoveryUpdate = (updated: any) => {
      if (updated.job_id === job.job_id) observedStates.push(updated.paid_image_replacement_attempts?.[0]?.state)
    }
    jq.jobEvents.on('update', onSubmittedRecoveryUpdate)
    try {
      assert.equal(await runContinuityRenderJob(job), undefined)
    } finally {
      jq.jobEvents.off('update', onSubmittedRecoveryUpdate)
    }
    assert.ok(imageStatusReads > statusReadsBeforeRecovery, 're-entry reads the accepted replacement task status')
    assert.equal(service.providerSubmissionCount('image'), submissionsBeforeRecovery, 'submitted recovery makes no generation POST while Off')
    assert.equal(referenceUploads, uploadsBeforeRecovery, 'submitted recovery makes no reference upload POST while Off')
    assert.ok(!observedStates.includes('blocked'), 'submitted evidence is never converted to blocked during read-only recovery')
    await sharp(outputPath).stats()
    const recoveredWithoutArtifact = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(recoveredWithoutArtifact.paid_image_replacement_attempts[0].state, 'succeeded')
    assert.equal(recoveredWithoutArtifact.paid_image_replacement_attempts[0].replacement_task_id, paidTaskId)

    const crashSeamFailures: string[] = []
    for (const crashCase of [
      {
        label: 'missing checkpoint while Off', enabled: false,
        mutate: (candidate: any) => { delete candidate.params.genstudio_recovery.assets['scene-001.png'] },
      },
      {
        label: 'mismatched checkpoint while On', enabled: true,
        mutate: (candidate: any) => {
          candidate.params.genstudio_recovery.assets['scene-001.png'] = {
            ...paidRecoveryEvidence,
            job_id: 'other-replacement-task',
            idempotency_key: 'story-image-other-replacement',
          }
        },
      },
    ]) {
      try {
        const crashCandidate = structuredClone(recoveredWithoutArtifact)
        crashCandidate.paid_image_replacement_attempts[0].state = 'submitted'
        delete crashCandidate.paid_image_replacement_attempts[0].actual_settled_credits
        crashCase.mutate(crashCandidate)
        await writeAuthoritativeFixture(crashCandidate)
        Object.assign(job, crashCandidate)
        await settings.setPaidImageReplacementSetting({ enabled: crashCase.enabled, additional_credit_ceiling: 20 })
        await fs.rm(outputPath, { force: true })
        const generationPostsBeforeCrashRecovery = imageGenerationPosts
        const uploadsBeforeCrashRecovery = referenceUploads
        const readsBeforeCrashRecovery = imageStatusReads
        const crashStates: string[] = []
        const onCrashRecoveryUpdate = (updated: any) => {
          if (updated.job_id === job.job_id) crashStates.push(updated.paid_image_replacement_attempts?.[0]?.state)
        }
        jq.jobEvents.on('update', onCrashRecoveryUpdate)
        try {
          assert.equal(await runContinuityRenderJob(job), undefined)
        } finally {
          jq.jobEvents.off('update', onCrashRecoveryUpdate)
        }
        assert.ok(imageStatusReads > readsBeforeCrashRecovery, `${crashCase.label} reads the authoritative accepted task`)
        assert.equal(imageGenerationPosts, generationPostsBeforeCrashRecovery, `${crashCase.label} makes no generation POST`)
        assert.equal(referenceUploads, uploadsBeforeCrashRecovery, `${crashCase.label} makes no upload POST`)
        assert.ok(!crashStates.includes('blocked'), `${crashCase.label} never converts submitted evidence to blocked`)
        await sharp(outputPath).stats()
        const crashRecovered = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
        assert.equal(crashRecovered.paid_image_replacement_attempts[0].state, 'succeeded')
        assert.equal(crashRecovered.paid_image_replacement_attempts[0].replacement_task_id, paidTaskId)
      } catch (error) {
        crashSeamFailures.push(`${crashCase.label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    assert.deepEqual(crashSeamFailures, [])
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
  } finally {
    restoreImageProvider?.()
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('Image Pool stays serial and returns its durable paid wait without a replacement POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  let restoreImageProvider: (() => void) | undefined
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
    await writeAuthoritativeFixture(job)
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
    await writeAuthoritativeFixture(durable)
    Object.assign(job, durable)
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    await assert.rejects(generateImagePoolImages(job), /incomplete/i)
    const blockedPool = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(blockedPool.paid_image_replacement_attempts[0].state, 'blocked')
    assert.match(blockedPool.paid_image_replacement_attempts[0].reason, /currently off/i)
    assert.equal(service.providerSubmissionCount('image'), 1, 'a blocked due Pool attempt submits nothing')
    blockedPool.paid_image_replacement_attempts[0].state = 'waiting'
    delete blockedPool.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(blockedPool)
    Object.assign(job, blockedPool)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    const { registry } = await import('../providers/registry.js')
    const { GenStudioImageTerminalFailureError } = await import('../lib/genstudio-client.js')
    const realProvider = registry.getImageProvider('genstudio-image')!
    restoreImageProvider = () => registry.registerImage(realProvider)
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        await request.onJobAccepted?.('unknown-pool-paid-failure', request.idempotencyKey || 'missing-key')
        throw new GenStudioImageTerminalFailureError({
          id: 'unknown-pool-paid-failure', state: 'failed', cancelled: false, failure_code: 'PROVIDER_ERROR',
          reserved_credits: 4, settled_credits: -1, released_credits: 5,
        } as any)
      },
    })
    await assert.rejects(generateImagePoolImages(job), /incomplete/i)
    const unknownSettlement = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(unknownSettlement.paid_image_replacement_attempts[0].state, 'failed')
    assert.equal(unknownSettlement.paid_image_replacement_attempts[0].actual_settled_credits, undefined, 'invalid settlement is not authoritative')
    unknownSettlement.paid_image_replacement_attempts[0].state = 'committed'
    delete unknownSettlement.paid_image_replacement_attempts[0].replacement_task_id
    delete unknownSettlement.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(unknownSettlement)
    Object.assign(job, unknownSettlement)
    registry.registerImage(realProvider)
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    await assert.rejects(generateImagePoolImages(job), /incomplete/i)
    const revokedCommit = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(revokedCommit.paid_image_replacement_attempts[0].state, 'blocked')
    assert.equal(service.providerSubmissionCount('image'), 1, 'Off revokes a lane-delayed committed Pool POST')
    revokedCommit.paid_image_replacement_attempts[0].state = 'committed'
    delete revokedCommit.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(revokedCommit)
    Object.assign(job, revokedCommit)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    let paidImageUrl = ''
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        const result = await realProvider.generateImage(request)
        paidImageUrl = result.urls[0] || ''
        return { urls: result.urls, settledCredits: (result as any).settledCredits }
      },
    })
    service.queueScenario('image', { states: ['succeeded'], reservedCredits: 4, finalCredits: 4 })
    assert.equal(await generateImagePoolImages(job), undefined)
    registry.registerImage(realProvider)
    assert.equal(service.providerSubmissionCount('image'), 2)
    const completed = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(completed.paid_image_replacement_attempts[0].state, 'succeeded', 'accepted task id completes a paid attempt when the provider result omits taskId')
    assert.match(completed.paid_image_replacement_attempts[0].replacement_task_id, /^mock-image-/)
    assert.equal(completed.paid_image_replacement_attempts[0].actual_settled_credits, 4, 'successful provider results preserve authoritative settlement')
    const paidTaskId = completed.paid_image_replacement_attempts[0].replacement_task_id
    const poolArtifactPath = path.join(poolRoot, 'gen-paid-run-0002.png')
    const committedArtifactBytes = await fs.readFile(poolArtifactPath)
    completed.paid_image_replacement_attempts[0].state = 'committed'
    delete completed.paid_image_replacement_attempts[0].replacement_task_id
    await writeAuthoritativeFixture(completed)
    Object.assign(job, completed)
    assert.equal(await generateImagePoolImages(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 'Pool committed/before-POST artifact reconciliation makes zero replacement POSTs')
    assert.deepEqual(await fs.readFile(poolArtifactPath), committedArtifactBytes, 'Pool preserves a decoder-valid original artifact')
    assert.equal(
      JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state,
      'committed',
      'Pool does not bless committed/no-task evidence as paid success',
    )

    await fs.writeFile(poolArtifactPath, Buffer.from('nonempty but corrupt committed artifact'))
    assert.equal(await generateImagePoolImages(job), undefined)
    await sharp(poolArtifactPath).stats()
    assert.equal(
      JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state,
      'succeeded',
      'Pool removes a corrupt committed artifact from initialReady and completes only through the exact paid task',
    )
    assert.equal(service.providerSubmissionCount('image'), 2, 'corrupt committed recovery reuses the exact paid idempotency identity')

    completed.paid_image_replacement_attempts[0].state = 'submitted'
    completed.paid_image_replacement_attempts[0].replacement_task_id = paidTaskId
    await writeAuthoritativeFixture(completed)
    Object.assign(job, completed)
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    assert.equal(await generateImagePoolImages(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 'artifact-before-checkpoint recovery never resubmits Image Pool')
    assert.equal(JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state, 'succeeded')
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })

    const noIdentity = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    noIdentity.paid_image_replacement_attempts[0].state = 'committed'
    delete noIdentity.paid_image_replacement_attempts[0].replacement_task_id
    await writeAuthoritativeFixture(noIdentity)
    Object.assign(job, noIdentity)
    await fs.rm(poolArtifactPath)
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        const result = await realProvider.generateImage({ ...request, onJobAccepted: undefined })
        return { urls: result.urls }
      },
    })
    for (let replay = 0; replay < 2; replay++) {
      await assert.rejects(generateImagePoolImages(job), /incomplete/i)
      await assert.rejects(fs.stat(poolArtifactPath), { code: 'ENOENT' })
      assert.equal(service.providerSubmissionCount('image'), 2, 'missing completion identity replays no duplicate paid POST')
      assert.equal(JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state, 'committed')
    }
    const paidSubmissions = service.submissions.filter(submission => submission.operation === 'image')
    assert.equal(paidSubmissions.filter(submission => !submission.replay).length, 2)
    assert.equal(new Set(paidSubmissions.map(submission => submission.idempotencyKey)).size, 2, 're-entry reuses the exact paid idempotency identity')

    let conflictingProviderCalls = 0
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        conflictingProviderCalls++
        await request.onJobAccepted?.('accepted-conflict', request.idempotencyKey || 'missing-key')
        return { urls: [paidImageUrl], taskId: 'result-conflict' }
      },
    })
    for (let replay = 0; replay < 2; replay++) {
      await assert.rejects(generateImagePoolImages(job), /incomplete/i)
      await assert.rejects(fs.stat(poolArtifactPath), { code: 'ENOENT' })
      assert.equal(service.providerSubmissionCount('image'), 2, 'conflicting completion identities make no duplicate paid POST')
    }
    assert.equal(conflictingProviderCalls, 2)
    const conflicting = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0]
    assert.equal(conflicting.state, 'submitted')
    assert.equal(conflicting.replacement_task_id, 'accepted-conflict')
  } finally {
    restoreImageProvider?.()
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('durable thumbnails checkpoint the real accepted identity and latch a paid wait', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  let originalPositiveFailureUrl = ''
  let restoreImageProvider: (() => void) | undefined
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = String(input)
      if ((init?.method || 'GET') === 'GET' && url.startsWith(`${service.baseUrl}/v1/images/`)
        && !url.endsWith('/file') && response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.clone().json() as Record<string, unknown>
        if (body.state === 'failed' && (!originalPositiveFailureUrl || originalPositiveFailureUrl === url)) {
          originalPositiveFailureUrl = url
          return Response.json({ ...body, reserved_credits: 8, settled_credits: 2, released_credits: 6 })
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
    const { toMdPath } = await import('../lib/episode-artifacts.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { registry } = await import('../providers/registry.js')
    const { GenStudioImageTerminalFailureError } = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const { project, episodeId, paths } = await createContinuityFixture('Paid thumbnail original identity')
    const savedReferenceDir = path.join(pm.getProjectDir(project.slug)!, 'thumbnail-reference-assets')
    const savedReferencePath = path.join(savedReferenceDir, 'reference.png')
    const savedReferenceBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlM0AAAAASUVORK5CYII=', 'base64')
    await fs.mkdir(savedReferenceDir, { recursive: true })
    await fs.writeFile(savedReferencePath, savedReferenceBytes)
    const promptPath = toMdPath(paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(promptPath), { recursive: true })
    await fs.writeFile(promptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA moonlit archive with one bright lantern.\n')
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'paid-thumb-original', project_slug: project.slug, type: 'thumb_images', episode_id: episodeId,
      title: 'Paid Thumbnail', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: {
        episode_id: episodeId, mode: 'thumbs', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        thumbnail_reference_asset: { id: 'saved-reference', filename: 'reference.png' },
      },
    }
    const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 8 })
    const { generateImages, resolveImageDirs } = await import('../generators/images.js')
    assert.deepEqual(await generateImages(job), { kind: 'paid-image-wait' })
    const { thumbDir } = await resolveImageDirs(project.slug, promptPath, episodeId)
    const filename = `${episodeId.toUpperCase()}_Thumb01_v1.png`
    const entry = (await readManifest(thumbDir)).tasks[filename]!
    assert.match(entry.idempotency_key || '', /^story-image-/)
    assert.equal(entry.original_output_selector?.reference_mode, 'reference-guided')
    assert.equal(entry.original_reference_inputs?.[0]?.path, await fs.realpath(savedReferencePath))
    const checkpoint = job.params.genstudio_recovery.assets[filename]
    assert.match(checkpoint.job_id, /^mock-image-/)
    assert.equal(checkpoint.idempotency_key, entry.idempotency_key)
    assert.equal(checkpoint.state, 'failed')
    assert.equal(service.providerSubmissionCount('image'), 1)
    const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    const eligibleAt = Date.now() - 1_000
    durable.paid_image_replacement_attempts[0].eligible_at = new Date(eligibleAt).toISOString()
    durable.paid_image_replacement_attempts[0].terminal_observed_at = new Date(eligibleAt - 30 * 60_000).toISOString()
    await writeAuthoritativeFixture(durable)
    Object.assign(job, durable)
    await fs.rm(savedReferencePath)
    await assert.rejects(generateImages(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 1, 'a committed thumbnail with a deleted frozen reference makes zero replacement POSTs')
    await fs.writeFile(savedReferencePath, savedReferenceBytes)
    const blockedReference = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(blockedReference.paid_image_replacement_attempts[0].state, 'blocked')
    blockedReference.paid_image_replacement_attempts[0].state = 'waiting'
    delete blockedReference.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(blockedReference)
    Object.assign(job, blockedReference)

    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    await assert.rejects(generateImages(job), /incomplete/i)
    const blockedThumb = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(blockedThumb.paid_image_replacement_attempts[0].state, 'blocked')
    assert.match(blockedThumb.paid_image_replacement_attempts[0].reason, /currently off/i)
    assert.equal(service.providerSubmissionCount('image'), 1, 'a blocked due thumbnail attempt submits nothing')
    blockedThumb.paid_image_replacement_attempts[0].state = 'waiting'
    delete blockedThumb.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(blockedThumb)
    Object.assign(job, blockedThumb)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })

    const originalFailureCheckpoint = structuredClone(job.params.genstudio_recovery.assets[filename])
    const realProvider = registry.getImageProvider('genstudio-image')!
    restoreImageProvider = () => registry.registerImage(realProvider)
    registry.registerImage({
      ...realProvider,
      generateImage: async () => {
        throw new GenStudioImageTerminalFailureError({
          id: '', state: 'failed', cancelled: false, failure_code: 'CLOUD_PROVIDER_EXHAUSTED',
          reserved_credits: 4, settled_credits: 0, released_credits: 4,
        } as any)
      },
    })
    await assert.rejects(generateImages(job), /provider task identity/i)
    const missingIdentity = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(missingIdentity.paid_image_replacement_attempts[0].state, 'committed')
    assert.equal(missingIdentity.paid_image_replacement_attempts[0].replacement_task_id, undefined)
    assert.deepEqual(missingIdentity.params.genstudio_recovery.assets[filename], originalFailureCheckpoint, 'missing paid failure identity writes no fake recovery checkpoint')
    assert.equal(service.providerSubmissionCount('image'), 1)
    registry.registerImage(realProvider)
    restoreImageProvider = undefined

    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    await assert.rejects(generateImages(job), /incomplete/i)
    const revokedCommit = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    assert.equal(revokedCommit.paid_image_replacement_attempts[0].state, 'blocked')
    assert.equal(service.providerSubmissionCount('image'), 1, 'Off revokes a lane-delayed committed thumbnail POST')
    revokedCommit.paid_image_replacement_attempts[0].state = 'committed'
    delete revokedCommit.paid_image_replacement_attempts[0].reason
    await writeAuthoritativeFixture(revokedCommit)
    Object.assign(job, revokedCommit)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })

    process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS = '1'
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'CLOUD_PROVIDER_EXHAUSTED', reservedCredits: 4 })
    await assert.rejects(generateImages(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 2)
    const paidFailedJob = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    const paidFailedAttempt = paidFailedJob.paid_image_replacement_attempts[0]
    assert.equal(paidFailedAttempt.state, 'failed')
    assert.match(paidFailedAttempt.replacement_task_id, /^mock-image-/)
    assert.equal(paidFailedAttempt.actual_settled_credits, 0)
    const paidFailureSubmission = service.submissions.find(submission => submission.jobId === paidFailedAttempt.replacement_task_id)!
    const paidFailureCheckpoint = paidFailedJob.params.genstudio_recovery.assets[filename]
    assert.equal(paidFailureCheckpoint.job_id, paidFailedAttempt.replacement_task_id)
    assert.equal(paidFailureCheckpoint.idempotency_key, paidFailureSubmission.idempotencyKey)
    assert.equal(paidFailureCheckpoint.state, 'failed')
    await assert.rejects(generateImages(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 2, 'a failed paid thumbnail replacement never enters the ordinary retry ladder')

    const failed = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    const failedReplacementTaskId = failed.paid_image_replacement_attempts[0].replacement_task_id
    failed.paid_image_replacement_attempts[0].state = 'committed'
    delete failed.paid_image_replacement_attempts[0].replacement_task_id
    delete failed.paid_image_replacement_attempts[0].actual_settled_credits
    await writeAuthoritativeFixture(failed)
    Object.assign(job, failed)
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
      .png().toFile(path.join(thumbDir, filename))
    const committedArtifactBytes = await fs.readFile(path.join(thumbDir, filename))
    failed.params.thumb_number = 1
    failed.params.force = true
    const submissionsBeforeForcedCommittedArtifact = service.submissions.length
    assert.equal(await generateImages(job), undefined)
    assert.equal(service.submissions.length, submissionsBeforeForcedCommittedArtifact, 'targeted force cannot bypass a committed paid artifact into another replacement POST')
    assert.equal(service.providerSubmissionCount('image'), 2, 'thumbnail committed/before-POST artifact reconciliation makes zero replacement jobs')
    assert.deepEqual(await fs.readFile(path.join(thumbDir, filename)), committedArtifactBytes, 'thumbnail preserves the decoder-valid original artifact')
    assert.equal(JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0].state, 'committed')

    delete failed.params.thumb_number
    delete failed.params.force
    failed.paid_image_replacement_attempts[0].state = 'submitted'
    failed.paid_image_replacement_attempts[0].replacement_task_id = failedReplacementTaskId
    await writeAuthoritativeFixture(failed)
    Object.assign(job, failed)
    await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 20 })
    assert.equal(await generateImages(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2, 'artifact-before-checkpoint recovery never resubmits thumbnails')
    const recoveredPaidThumb = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0]
    assert.equal(recoveredPaidThumb.state, 'succeeded')
    assert.equal(recoveredPaidThumb.actual_settled_credits, undefined, 'artifact recovery has no authoritative replacement settlement')
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })

    originalPositiveFailureUrl = ''
    const fleetFixture = await createContinuityFixture('Paid thumbnail fleet failure')
    const fleetPromptPath = toMdPath(fleetFixture.paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(fleetPromptPath), { recursive: true })
    await fs.writeFile(fleetPromptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA still moonlit courtyard.\n')
    const fleetNow = new Date().toISOString()
    const fleetJob: any = {
      job_id: 'paid-thumb-fleet', project_slug: fleetFixture.project.slug, type: 'thumb_images', episode_id: fleetFixture.episodeId,
      title: 'Paid Thumbnail Fleet', status: 'running', created_at: fleetNow, started_at: fleetNow, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: fleetNow },
      params: { episode_id: fleetFixture.episodeId, mode: 'thumbs', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' },
    }
    const fleetJobsFile = path.join(pm.projectsRoot(), fleetFixture.project.slug, 'jobs.json')
    await writeAuthoritativeFixture(fleetJob)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 8 })
    assert.deepEqual(await generateImages(fleetJob), { kind: 'paid-image-wait' })
    const fleetDurable = JSON.parse(await fs.readFile(fleetJobsFile, 'utf8')).jobs[0]
    const fleetEligibleAt = Date.now() - 1_000
    fleetDurable.paid_image_replacement_attempts[0].eligible_at = new Date(fleetEligibleAt).toISOString()
    fleetDurable.paid_image_replacement_attempts[0].terminal_observed_at = new Date(fleetEligibleAt - 30 * 60_000).toISOString()
    await writeAuthoritativeFixture(fleetDurable)
    Object.assign(fleetJob, fleetDurable)
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_CAPACITY_UNAVAILABLE', reservedCredits: 4 })
    await assert.rejects(generateImages(fleetJob), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 4)
    await assert.rejects(generateImages(fleetJob), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 4, 'a fleet-busy paid thumbnail failure never enters its minutes-long retry ladder')
  } finally {
    delete process.env.STORY_STUDIO_IMAGE_RETRY_BASE_MS
    restoreImageProvider?.()
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('a successful paid thumbnail records only the completed Gateway settlement', async () => {
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
          return Response.json({ ...body, reserved_credits: 8, settled_credits: 2, released_credits: 6 })
        }
      }
      if (url.startsWith(`${service.baseUrl}/v1/image/models`) && response.headers.get('content-type')?.includes('application/json')) {
        const models = await response.clone().json() as Array<Record<string, any>>
        return Response.json(models.map(model => ({
          ...model, chargeable: true,
          output_options: model.output_options.map((row: Record<string, unknown>) => ({
            ...row, credits_per_image: 4, price_version: 'mock-image-price-v1',
          })),
        })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const { toMdPath } = await import('../lib/episode-artifacts.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const { project, episodeId, paths } = await createContinuityFixture('Paid thumbnail success settlement')
    const promptPath = toMdPath(paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(promptPath), { recursive: true })
    await fs.writeFile(promptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA quiet moonlit archive.\n')
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'paid-thumb-success', project_slug: project.slug, type: 'thumb_images', episode_id: episodeId,
      title: 'Paid Thumbnail Success', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { episode_id: episodeId, mode: 'thumbs', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' },
    }
    const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', {
      states: ['accepted', 'failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 8, finalCredits: 2,
    })
    const { generateImages } = await import('../generators/images.js')
    assert.deepEqual(await generateImages(job), { kind: 'paid-image-wait' })
    const durable = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0]
    const eligibleAt = Date.now() - 1_000
    durable.paid_image_replacement_attempts[0].eligible_at = new Date(eligibleAt).toISOString()
    durable.paid_image_replacement_attempts[0].terminal_observed_at = new Date(eligibleAt - 30 * 60_000).toISOString()
    await writeAuthoritativeFixture(durable)
    Object.assign(job, durable)
    service.queueScenario('image', { states: ['succeeded'], reservedCredits: 4, finalCredits: 4 })
    assert.equal(await generateImages(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 2)
    const completed = JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts[0]
    assert.equal(completed.state, 'succeeded')
    assert.equal(completed.actual_settled_credits, 4)
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('a configured thumbnail reference missing before the original manifest exists blocks the real generator before POST', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const { toMdPath } = await import('../lib/episode-artifacts.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const { project, episodeId, paths } = await createContinuityFixture('Missing thumbnail reference')
    const promptPath = toMdPath(paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(promptPath), { recursive: true })
    await fs.writeFile(promptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA quiet archive.\n')
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'missing-thumb-reference', project_slug: project.slug, type: 'thumb_images', episode_id: episodeId,
      title: 'Missing thumbnail reference', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: {
        episode_id: episodeId, mode: 'thumbs', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
        thumbnail_reference_asset: { id: 'saved-reference', filename: 'missing.png' },
      },
    }
    const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
    await writeAuthoritativeFixture(job)
    const { generateImages } = await import('../generators/images.js')
    await assert.rejects(generateImages(job), /saved thumbnail reference is unavailable locally/i)
    assert.equal(service.providerSubmissionCount('image'), 0)
    assert.equal(JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs[0].paid_image_replacement_attempts, undefined)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a thumbnail paid-wait latch wins after another active worker fails while the pool drains', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  let restoreImageProvider: (() => void) | undefined
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = String(input)
      if ((init?.method || 'GET') === 'GET' && url.startsWith(`${service.baseUrl}/v1/images/`)
        && !url.endsWith('/file') && response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.clone().json() as Record<string, unknown>
        if (body.state === 'failed') {
          return Response.json({ ...body, reserved_credits: 8, settled_credits: 2, released_credits: 6 })
        }
      }
      if (url.startsWith(`${service.baseUrl}/v1/image/models`) && response.headers.get('content-type')?.includes('application/json')) {
        const models = await response.clone().json() as Array<Record<string, any>>
        return Response.json(models.map(model => ({
          ...model, chargeable: true,
          output_options: model.output_options.map((row: Record<string, unknown>) => ({
            ...row, credits_per_image: 4, price_version: 'mock-image-price-v1',
          })),
        })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const { toMdPath } = await import('../lib/episode-artifacts.js')
    const { registry } = await import('../providers/registry.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const { project, episodeId, paths } = await createContinuityFixture('Paid wait drain precedence')
    const promptPath = toMdPath(paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(promptPath), { recursive: true })
    await fs.writeFile(promptPath, [
      '# Thumbnail Prompts', '', '## Thumbnail 1: First', '', 'A quiet archive.', '',
      '## Thumbnail 2: Second', '', 'A moonlit courtyard.', '',
    ].join('\n'))
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'paid-wait-drain', project_slug: project.slug, type: 'thumb_images', episode_id: episodeId,
      title: 'Paid wait drain', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { episode_id: episodeId, mode: 'thumbs', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' },
    }
    const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
    await writeAuthoritativeFixture(job)
    const realProvider = registry.getImageProvider('genstudio-image')!
    restoreImageProvider = () => registry.registerImage(realProvider)
    let providerCalls = 0
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        providerCalls++
        if (providerCalls === 1) return realProvider.generateImage(request)
        await waitForPaidAttempt(
          jobsFile,
          attempt => attempt.state === 'waiting',
          'thumbnail worker never observed the paid-wait latch',
        )
        throw new Error('second active worker failed after the paid-wait latch')
      },
    })
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 8 })
    const { generateImages } = await import('../generators/images.js')
    assert.deepEqual(await generateImages(job), { kind: 'paid-image-wait' })
    assert.equal(service.providerSubmissionCount('image'), 1)
    assert.equal(providerCalls, 2, 'the second worker was already active and drained before the exported wait returned')
  } finally {
    restoreImageProvider?.()
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('a Continuity paid-wait latch wins after another active worker fails while the pool drains', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  let restoreImageProvider: (() => void) | undefined
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
        return Response.json(models.map(model => ({
          ...model, chargeable: true,
          output_options: model.output_options.map((row: Record<string, unknown>) => ({
            ...row, credits_per_image: 4, price_version: 'mock-image-price-v1',
          })),
        })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const { registry } = await import('../providers/registry.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 20 })
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')
    const { project, episodeId, paths } = await createContinuityFixture('Continuity paid wait drain precedence')
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'A quiet archive.' },
      { id: 'scene-002', scene_index: 2, visual_prompt: 'A moonlit courtyard.' },
    ] }))
    const now = new Date().toISOString()
    const job: any = {
      job_id: 'continuity-paid-wait-drain', project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
      title: 'Continuity paid wait drain', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      paid_image_replacement: { enabled: true, wait_minutes: 30, max_replacements_per_asset: 1, additional_credit_ceiling: 20, snapshotted_at: now },
      params: { episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' },
    }
    const jobsFile = path.join(pm.projectsRoot(), project.slug, 'jobs.json')
    await writeAuthoritativeFixture(job)
    const realProvider = registry.getImageProvider('genstudio-image')!
    restoreImageProvider = () => registry.registerImage(realProvider)
    let providerCalls = 0
    registry.registerImage({
      ...realProvider,
      generateImage: async request => {
        providerCalls++
        if (providerCalls === 1) return realProvider.generateImage(request)
        await waitForPaidAttempt(
          jobsFile,
          attempt => attempt.state === 'waiting',
          'Continuity worker never observed the paid-wait latch',
        )
        throw new Error('second active Continuity worker failed after the paid-wait latch')
      },
    })
    service.queueScenario('image', { states: ['accepted', 'failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 8 })
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    assert.deepEqual(await runContinuityRenderJob(job), { kind: 'paid-image-wait' })
    assert.equal(service.providerSubmissionCount('image'), 1)
    assert.equal(providerCalls, 2)
  } finally {
    restoreImageProvider?.()
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('a thumbnail left prepared with no task is replayed, not failed forever', async () => {
  // **The gateway had no such job because none was ever created.** That is an
  // authoritative answer, and the one reading under which submitting again
  // cannot duplicate paid work.
  //
  // Before this, the recovery fell through to `uncertain` — which the image
  // generator throws on — so a thumbnail whose submit never landed failed once
  // per attempt, forever, with `Could not confirm the prepared image by its
  // idempotency key: GenStudio KH request failed: No such job.` The message
  // named the cause exactly and nothing acted on it.
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = String(input)
      if (url.startsWith(`${service.baseUrl}/v1/image/models`) && response.headers.get('content-type')?.includes('application/json')) {
        const models = await response.clone().json() as Array<Record<string, any>>
        return Response.json(models.map(model => ({
          ...model, chargeable: true,
          output_options: model.output_options.map((row: Record<string, unknown>) => ({
            ...row, credits_per_image: 4, price_version: 'mock-image-price-v1',
          })),
        })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { toMdPath } = await import('../lib/episode-artifacts.js')
    const { recordTaskStrict } = await import('../services/task-manifest.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const thumbnail = await createContinuityFixture('Prepared thumbnail replay')
    const promptPath = toMdPath(thumbnail.paths.thumb_prompts_docx)
    await fs.mkdir(path.dirname(promptPath), { recursive: true })
    await fs.writeFile(promptPath, '# Thumbnail Prompts\n\n## Thumbnail 1: First\n\nA moonlit archive.\n')

    const now = new Date().toISOString()
    const thumbJob: any = {
      job_id: 'prepared-thumbnail-replay', project_slug: thumbnail.project.slug, type: 'thumb_images', episode_id: thumbnail.episodeId,
      title: 'Prepared thumbnail replay', status: 'running', created_at: now, started_at: now, finished_at: null,
      local_execution_complete: false, error: null, output_lines: [],
      params: { episode_id: thumbnail.episodeId, mode: 'thumbs', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' },
    }
    await writeAuthoritativeFixture(thumbJob)

    const { generateImages, resolveImageDirs } = await import('../generators/images.js')
    const { thumbDir } = await resolveImageDirs(thumbnail.project.slug, promptPath, thumbnail.episodeId)
    await fs.mkdir(thumbDir, { recursive: true })
    // The state a failed submit leaves behind: an identity reserved, and no task.
    // No `request_scope`, deliberately — that is the pre-scope shape, and the one
    // whose `input_hash` the generator cannot be expected to reproduce here.
    const filename = `${thumbnail.episodeId.toUpperCase()}_Thumb01_v1.png`
    await recordTaskStrict(thumbDir, filename, {
      provider: 'genstudio-image',
      task_id: '',
      submitted_at: now,
      idempotency_key: `prepared-thumbnail-${thumbnail.episodeId}`,
      last_state: 'prepared',
    })

    service.queueScenario('image', { states: ['accepted', 'succeeded'], reservedCredits: 4, finalCredits: 4 })
    assert.equal(await generateImages(thumbJob), undefined)
    await sharp(path.join(thumbDir, filename)).stats()
    assert.equal(
      service.providerSubmissionCount('image'), 1,
      'a prepared entry that the Gateway says is absent must be submitted once — not twice, and not failed',
    )
    assert.ok(
      !thumbJob.output_lines.some((line: string) => line.includes('Could not confirm the prepared image')),
      'the replay must not still report the prepared image as unconfirmable',
    )
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('an unfinished scene image is explained in plain words with what to do next', async () => {
  const { unresolvedSceneImagesMessage } = await import('../generators/continuity-render.js')
  const scenes = [{ id: 'tn0355-scene-0064', scene_index: 64 }, { id: 'tn0355-scene-0065', scene_index: 65 }]
  const issues = [{ item_id: 'tn0355-scene-0065', reason: 'No free Mac answered in time.' }]
  assert.equal(
    unresolvedSceneImagesMessage({ auto_retry: { eligible: true, reason: '', attempt: 3, max_attempts: 3 } }, scenes, issues),
    "Scene images incomplete: 1 of 2 made; finished images are saved. Scene 65 couldn't be made after 3 tries: No free Mac answered in time. Press Retry to try again.",
  )
  assert.match(
    unresolvedSceneImagesMessage({ auto_retry: { eligible: true, reason: '', attempt: 1, max_attempts: 3 } }, scenes, issues),
    /after 1 try: .* Story Studio will try again automatically\.$/,
  )
})
