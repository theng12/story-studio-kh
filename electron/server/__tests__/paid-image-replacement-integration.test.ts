import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

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

test('a successful paid thumbnail records only the completed GenStudio settlement', async () => {
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
