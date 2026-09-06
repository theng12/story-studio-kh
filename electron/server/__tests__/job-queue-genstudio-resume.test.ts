import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { readManifest, recordTaskStrict } from '../services/task-manifest.js'
import type { Job } from '../models/types.js'
import { waitFor as waitForScheduled } from './_timing.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

async function waitForDone(jobId: string, jobsFile: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && jq.getJob(jobId)?.status !== 'done') {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  let persistedStatus = ''
  while (Date.now() < deadline && persistedStatus !== 'done') {
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
    persistedStatus = persisted.jobs.find((item: any) => item.job_id === jobId)?.status || ''
    if (persistedStatus !== 'done') await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(persistedStatus, 'done', JSON.stringify(jq.getJob(jobId)))
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  await waitForScheduled(check, { label: message, timeoutMs })
}

describe('startup recovery for explicitly checkpointed GenStudio assets', () => {
  for (const scenario of [
    { type: 'audio' as const, operation: 'tts' as const, jobId: 'genstudio-tts-restart' },
    { type: 'subtitles_transcribe' as const, operation: 'transcription' as const, jobId: 'genstudio-stt-restart' },
  ]) {
    test(`requeues interrupted ${scenario.operation} with the same durable request identity`, async () => {
      const project = await pm.createProject({ name: `GenStudio ${scenario.operation} Resume` })
      const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
      let executions = 0
      jq.registerExecutor(scenario.type, async (job) => {
        executions++
        const checkpoint = (job.params as any).genstudio_recovery
        assert.equal(checkpoint.route, 'genstudio')
        assert.equal(checkpoint.assets.asset.idempotency_key, `story-${scenario.operation}-stable`)
      })
      await fs.writeFile(jobsFile, JSON.stringify({ jobs: [{
        job_id: scenario.jobId,
        project_slug: project.slug,
        type: scenario.type,
        episode_id: 'EP0001',
        title: `GenStudio ${scenario.operation}`,
        status: 'running',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        output_lines: [],
        params: {
          genstudio_recovery: {
            version: 1,
            route: 'genstudio',
            assets: {
              asset: {
                operation: scenario.operation,
                idempotency_key: `story-${scenario.operation}-stable`,
                job_id: `provider-${scenario.operation}-same`,
                state: 'running',
                updated_at: new Date().toISOString(),
              },
            },
          },
        },
      }] }))

      await jq.getJobs(project.slug)
      await waitForDone(scenario.jobId, jobsFile)
      const resumed = jq.getJob(scenario.jobId)!
      assert.equal(executions, 1)
      assert.equal(resumed.status, 'done')
      assert.match(resumed.output_lines.join('\n'), /checkpointed GenStudio asset job/i)
      assert.doesNotMatch(JSON.stringify(resumed.params), /api[_-]?key|authorization|bearer/i)
    })
  }

  test('checkpointed audio recovery downloads a settled artifact before generic provider reconciliation', async () => {
    const service = await startMockGenStudioService()
    const { setGenStudioUrl } = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { recoverTtsToFile } = await import('../lib/genstudio-client.js')
    try {
      await setGenStudioUrl(service.baseUrl)
      await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
      service.queueScenario('tts', { states: ['succeeded'] })
      const idempotencyKey = 'story-tts-restart-artifact'
      const submitted = await fetch(`${service.baseUrl}/v1/audio/jobs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model_id: 'mock-tts-v1', voice_id: 'mock-voice', text: 'recover me', speed: 1 }),
      }).then(response => response.json()) as { id: string }

      const project = await pm.createProject({ name: 'GenStudio TTS Artifact Resume' })
      const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
      const outputPath = path.join(tempDir, 'recovered-audio.mp3')
      let executions = 0
      jq.registerExecutor('audio', async job => {
        executions++
        const checkpoint = (job.params as any).genstudio_recovery.assets.asset
        assert.equal(checkpoint.idempotency_key, idempotencyKey)
        assert.equal(checkpoint.job_id, submitted.id)
        await recoverTtsToFile(MOCK_GENSTUDIO_FULL_KEY, outputPath, submitted.id, { text: 'recover me', speed: 1 })
        const stat = await fs.stat(outputPath)
        assert.ok(stat.size > 0)
      })
      service.requests.length = 0
      await fs.writeFile(jobsFile, JSON.stringify({ jobs: [{
        job_id: 'genstudio-tts-artifact-restart',
        project_slug: project.slug,
        type: 'audio',
        episode_id: 'EP0002',
        title: 'GenStudio TTS artifact recovery',
        status: 'running',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        output_lines: [],
        params: {
          genstudio_recovery: {
            version: 1,
            route: 'genstudio',
            assets: {
              asset: {
                operation: 'tts',
                idempotency_key: idempotencyKey,
                job_id: submitted.id,
                output_path: outputPath,
                state: 'running',
                updated_at: new Date().toISOString(),
              },
            },
          },
        },
        genstudio_jobs: [{
          id: submitted.id,
          operation: 'voice.tts',
          state: 'running',
          updated_at: new Date().toISOString(),
        }],
        remote_cancellations: {},
      }] }))

      await jq.getJobs(project.slug)
      await waitForDone('genstudio-tts-artifact-restart', jobsFile)

      const recovered = jq.getJob('genstudio-tts-artifact-restart')!
      assert.equal(executions, 1)
      assert.equal(recovered.status, 'done')
      assert.match(recovered.output_lines.join('\n'), /resuming the checkpointed GenStudio asset job/i)
      assert.doesNotMatch(recovered.output_lines.join('\n'), /reconciling the existing GenStudio request/i)
      assert.ok((await fs.stat(outputPath)).size > 0)
      assert.ok(service.requests.every(request => request.method === 'GET'))
      assert.deepEqual(
        service.requests.filter(request => request.path !== '/v1/account/overview').map(request => request.path),
        [`/v1/jobs/${submitted.id}`, `/v1/jobs/${submitted.id}/audio`],
      )
      assert.equal(service.providerSubmissionCount('tts'), 1)
    } finally {
      await service.close()
    }
  })
})

/**
 * v1.4.81 — the same recovery, for the job type that actually needed it.
 *
 * The owner force-quit mid-batch with three scene renders running. GenStudio
 * kept generating for the twenty-one minutes the app was dead. On relaunch the
 * three renders were neither resumed nor failed: they sat `running` on the
 * reconcile-only path, holding no lane, so the scheduler started three MORE
 * episodes and he watched three become six — while ~254 images he had already
 * paid for stayed on the server, uncollected.
 *
 * Everything needed to collect them already existed and is proven by the audio
 * tests above. Image work was simply never added to the gate.
 */
describe('startup recovery for interrupted image-episode renders', () => {
  function imageEvidence(id: string, state: string) {
    return { id, operation: 'image.generation' as const, state, updated_at: new Date().toISOString() }
  }

  function interruptedRender(jobId: string, project: string, extra: Record<string, unknown> = {}) {
    return {
      job_id: jobId,
      project_slug: project,
      type: 'continuity_render',
      episode_id: 'DK0054',
      title: '[batch] scene_review — DK0054',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
      remote_cancellations: {},
      ...extra,
    }
  }

  test('an interrupted render resumes itself instead of reconciling forever', async () => {
    const project = await pm.createProject({ name: 'Image Restart Resume' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    let executions = 0
    jq.registerExecutor('continuity_render', async () => { executions++ })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [interruptedRender('image-restart-resume', project.slug, {
      // Exactly the owner's shape: some images finished while the app was dead,
      // the rest were still reserved at the provider.
      genstudio_jobs: [
        imageEvidence('job_settled_while_dead', 'succeeded'),
        imageEvidence('job_still_reserved', 'reserved'),
      ],
    })] }))

    await jq.getJobs(project.slug)
    await waitForDone('image-restart-resume', jobsFile)

    const resumed = jq.getJob('image-restart-resume')!
    assert.equal(executions, 1)
    assert.equal(resumed.status, 'done')
    const lines = resumed.output_lines.join('\n')
    assert.match(lines, /reclaimed from its saved task id at no extra credits/i)
    // The bug was that it took THIS path and stayed there.
    assert.doesNotMatch(lines, /reconciling the existing GenStudio request/i)
    assert.doesNotMatch(lines, /Interrupted by app restart/i)
  })

  test('images that all finished during the outage still resume, because nothing downloaded them', async () => {
    // Before the fix this shape did not even reach the reconcile path: with no
    // UNSETTLED evidence it fell through to "Interrupted by app restart", and
    // every already-paid image waited on the owner noticing and clicking Retry.
    const project = await pm.createProject({ name: 'Image Restart All Settled' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    let executions = 0
    jq.registerExecutor('continuity_render', async () => { executions++ })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [interruptedRender('image-restart-all-settled', project.slug, {
      genstudio_jobs: [imageEvidence('job_a', 'succeeded'), imageEvidence('job_b', 'succeeded')],
    })] }))

    await jq.getJobs(project.slug)
    await waitForDone('image-restart-all-settled', jobsFile)

    assert.equal(executions, 1)
    assert.equal(jq.getJob('image-restart-all-settled')!.status, 'done')
  })

  test('evidence that proves nothing reclaimable is NOT requeued into a paid lane', async () => {
    // A terminally failed task cannot be collected, so resuming on the strength
    // of it would submit and pay for fresh work behind the owner's back. This
    // job keeps the old interrupted behaviour on purpose.
    const project = await pm.createProject({ name: 'Image Restart Unreclaimable' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    let executions = 0
    jq.registerExecutor('continuity_render', async () => { executions++ })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [interruptedRender('image-restart-unreclaimable', project.slug, {
      genstudio_jobs: [imageEvidence('job_dead', 'failed')],
    })] }))

    // No observation window needed: `getJobs` awaits the load, and the load
    // decides this job's fate inside that await. If it were ever going to be
    // requeued, it would already be queued by the time this returns.
    await jq.getJobs(project.slug)

    assert.equal(executions, 0)
    assert.equal(jq.getJob('image-restart-unreclaimable')!.status, 'error')
  })

  test('a pool render without its run id is not resumed, because it would rename every output', async () => {
    // Pool filenames are `gen-<run_id>-NNNN.png`. Resuming without the saved
    // run id derives NEW names, so every manifest lookup misses, every image is
    // submitted again, and the paid ones are orphaned in the folder. Filename
    // stability is a precondition for auto-resume, not a detail.
    const project = await pm.createProject({ name: 'Image Pool Restart No Run Id' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    let executions = 0
    jq.registerExecutor('image_pool_generate', async () => { executions++ })
    const base = interruptedRender('pool-restart-no-run-id', project.slug, {
      type: 'image_pool_generate',
      genstudio_jobs: [imageEvidence('job_pool_settled', 'succeeded')],
    })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [base] }))

    await jq.getJobs(project.slug)

    assert.equal(executions, 0)
    assert.equal(jq.getJob('pool-restart-no-run-id')!.status, 'error')
  })

  test('a pool render WITH its run id resumes, because its filenames are stable', async () => {
    const project = await pm.createProject({ name: 'Image Pool Restart With Run Id' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    let executions = 0
    jq.registerExecutor('image_pool_generate', async () => { executions++ })
    const base = interruptedRender('pool-restart-with-run-id', project.slug, {
      type: 'image_pool_generate',
      params: { run_id: '1787766994541-pooljob' },
      genstudio_jobs: [imageEvidence('job_pool_settled_2', 'succeeded')],
    })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [base] }))

    await jq.getJobs(project.slug)
    await waitForDone('pool-restart-with-run-id', jobsFile)

    assert.equal(executions, 1)
  })
})

describe('automatic recovery for cooperative Continuity Render stall holds', () => {
  const sceneId = 'scene-stable-001'

  function providerEvidence(id: string, state: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      operation: 'image.generation' as const,
      state,
      updated_at: new Date().toISOString(),
      ...extra,
    }
  }

  function stalledRender(
    jobId: string,
    projectSlug: string,
    taskId: string,
    extra: Partial<Job> = {},
  ): Job {
    return {
      job_id: jobId,
      project_slug: projectSlug,
      type: 'continuity_render',
      episode_id: 'EP0001',
      title: '[batch] continuity render — EP0001',
      status: 'paused',
      pause_origin: 'stall',
      pause_requested: false,
      local_execution_complete: true,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: ['Automatic submission hold: test fixture reached the cooperative boundary.'],
      params: { episode_id: 'EP0001', scene_ids: [sceneId] },
      genstudio_jobs: [providerEvidence(taskId, 'succeeded')],
      remote_cancellations: {},
      ...extra,
    }
  }

  async function submitImage(
    service: Awaited<ReturnType<typeof startMockGenStudioService>>,
    idempotencyKey: string,
    states: Array<'accepted' | 'running' | 'succeeded' | 'failed'>,
  ): Promise<string> {
    service.queueScenario('image', { states })
    const response = await fetch(`${service.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model_id: 'mock-image-v1', prompt: sceneId, aspect_ratio: '16:9' }),
    }).then(result => result.json()) as { id: string }
    return response.id
  }

  async function writeFixture(job: Job): Promise<{ jobsFile: string; manifestDir: string }> {
    const jobsFile = path.join(tempDir, 'projects', job.project_slug, 'jobs.json')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const episodeId = String(job.params.episode_id || job.episode_id)
    const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
    const manifestDir = await resolveSceneImagesDir(job.project_slug, episodeId.toUpperCase(), paths.episode_dir)
    const idempotencyKey = job.genstudio_jobs![0]!.request?.idempotency_key || `story-image-${job.job_id}`
    job.genstudio_jobs![0]!.request = {
      method: 'POST', path: '/v1/images/generations', captured_at: new Date().toISOString(),
      idempotency_key: idempotencyKey,
    }
    await recordTaskStrict(manifestDir, `${sceneId}.png`, {
      provider: 'genstudio-image',
      task_id: job.genstudio_jobs![0]!.id,
      submitted_at: new Date().toISOString(),
      input_hash: 'sha256:stable-scene-fixture',
      request_scope: 'missing',
      idempotency_key: idempotencyKey,
      operation: 'image',
      last_state: job.genstudio_jobs![0]!.state,
    })
    job.output_dir = manifestDir
    job.params.genstudio_recovery = {
      version: 1,
      route: 'genstudio',
      assets: {
        [`${sceneId}.png`]: {
          operation: 'image',
          idempotency_key: idempotencyKey,
          job_id: job.genstudio_jobs![0]!.id,
          output_path: path.join(manifestDir, `${sceneId}.png`),
          state: job.genstudio_jobs![0]!.state,
          updated_at: new Date().toISOString(),
        },
      },
    }
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
    return { jobsFile, manifestDir }
  }

  function registerManifestReclaimer(
    executions: string[],
    service?: Awaited<ReturnType<typeof startMockGenStudioService>>,
  ): void {
    jq.registerExecutor('continuity_render', async job => {
      executions.push(job.job_id)
      const manifest = await readManifest(job.output_dir!)
      const taskId = manifest.tasks[`${sceneId}.png`]?.task_id
      assert.equal(taskId, job.genstudio_jobs?.[0]?.id)
      if (service) {
        const provider = await fetch(`${service.baseUrl}/v1/images/${taskId}`, {
          headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}` },
        }).then(response => response.json()) as { id: string; state: string }
        assert.equal(provider.id, taskId)
        assert.equal(provider.state, 'succeeded')
      }
    })
  }

  async function seedProductionContinuityRender(
    service: Awaited<ReturnType<typeof startMockGenStudioService>>,
    name: string,
  ) {
    const { setGenStudioUrl } = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    const ideas = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await import('../providers/image/genstudio.js')
    await setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    clearGenStudioCatalogCache()

    const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: name,
      logline: 'Stable recovery fixture.',
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
    const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
    await fs.writeFile(planPath, JSON.stringify({
      scenes: [{ id: sceneId, scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' }],
    }))
    await fs.mkdir(paths.subtitles_dir, { recursive: true })
    const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
    await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nRecovery fixture\n')
    await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))

    const params = { episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K' }
    service.queueScenario('image', { states: ['succeeded'] })
    const seedJob = stalledRender(`seed-${name}`, project.slug, 'not-yet-submitted', {
      episode_id: episodeId,
      status: 'running',
      pause_origin: undefined,
      local_execution_complete: false,
      params,
      genstudio_jobs: [],
    })
    await runContinuityRenderJob(seedJob)
    const outputDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outputDir, `${sceneId}.png`)
    const entry = (await readManifest(outputDir)).tasks[`${sceneId}.png`]!
    assert.ok(entry.task_id)
    assert.ok(entry.idempotency_key)
    await fs.rm(outputPath)
    return {
      project,
      episodeId,
      params: { ...params, scene_ids: [sceneId] },
      planPath,
      outputDir,
      outputPath,
      entry,
      runContinuityRenderJob,
    }
  }

  test('the production Continuity executor reclaims the exact succeeded manifest task once', async () => {
    const service = await startMockGenStudioService()
    try {
      const seeded = await seedProductionContinuityRender(service, 'Safe terminal stall recovery')
      const job = stalledRender('stall-terminal-same-job', seeded.project.slug, seeded.entry.task_id, {
        episode_id: seeded.episodeId,
        params: seeded.params,
        output_dir: seeded.outputDir,
        genstudio_jobs: [providerEvidence(seeded.entry.task_id, 'succeeded', {
          request: {
            method: 'POST', path: '/v1/images/generations', captured_at: new Date().toISOString(),
            idempotency_key: seeded.entry.idempotency_key,
          },
        })],
      })
      const jobsFile = path.join(tempDir, 'projects', seeded.project.slug, 'jobs.json')
      await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
      jq.registerExecutor('continuity_render', seeded.runContinuityRenderJob)
      service.requests.length = 0

      await jq.getJobs(seeded.project.slug)
      await waitForDone(job.job_id, jobsFile)

      assert.equal(jq.getJob(job.job_id)?.job_id, job.job_id)
      assert.equal(jq.getJob(job.job_id)?.genstudio_jobs?.[0]?.id, seeded.entry.task_id)
      assert.equal(jq.getJob(job.job_id)?.genstudio_jobs?.[0]?.request?.idempotency_key, seeded.entry.idempotency_key)
      assert.equal((await readManifest(seeded.outputDir)).tasks[`${sceneId}.png`]?.task_id, seeded.entry.task_id)
      assert.ok((await fs.stat(seeded.outputPath)).size > 0)
      assert.equal(service.providerSubmissionCount('image'), 1)
      assert.equal(service.requests.some(request => request.method === 'POST'), false)
    } finally {
      await service.close()
    }
  })

  test('project load finalizes a verified complete stall row without invoking the generator', async () => {
    const service = await startMockGenStudioService()
    let executorStarts = 0
    try {
      const seeded = await seedProductionContinuityRender(service, 'Completed stall load repair')
      await fs.writeFile(seeded.outputPath, ONE_PIXEL_PNG)
      const params = structuredClone(seeded.params)
      delete (params as any).scene_ids
      const job = stalledRender('stall-complete-on-load', seeded.project.slug, seeded.entry.task_id, {
        episode_id: seeded.episodeId,
        params,
        output_dir: seeded.outputDir,
        result: {
          complete: true,
          completion: {
            label: 'Scene image generation', expected: 1, completed: 1,
            missing: [], invalid: [], issues: [], complete: true,
          },
        },
        // Older durable entries did not always copy the manifest key into the
        // provider evidence. Exact manifest + checkpoint ownership still does.
        genstudio_jobs: [providerEvidence(seeded.entry.task_id, 'succeeded')],
      })
      const jobsFile = path.join(tempDir, 'projects', seeded.project.slug, 'jobs.json')
      await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
      jq.registerExecutor('continuity_render', async () => { executorStarts++ })
      const submissionsBeforeLoad = service.providerSubmissionCount('image')
      service.requests.length = 0

      await jq.getJobs(seeded.project.slug)

      const completed = jq.getJob(job.job_id)!
      assert.equal(completed.status, 'done')
      assert.equal(completed.pause_origin, undefined)
      assert.ok(completed.finished_at)
      assert.equal(executorStarts, 0)
      assert.equal(service.providerSubmissionCount('image'), submissionsBeforeLoad)
      assert.equal(service.requests.length, 0)
      assert.match(completed.output_lines.join('\n'), /verified this render was complete while paused/i)
    } finally {
      await service.close()
    }
  })

  test('a queue hold that arrives during the completion audit keeps the persisted row paused', async t => {
    const service = await startMockGenStudioService()
    let releaseAudit!: () => void
    const auditBlocked = new Promise<void>(resolve => { releaseAudit = resolve })
    let auditStarted!: () => void
    const started = new Promise<void>(resolve => { auditStarted = resolve })
    let executorStarts = 0
    try {
      const seeded = await seedProductionContinuityRender(service, 'Completed stall audit race')
      await fs.writeFile(seeded.outputPath, ONE_PIXEL_PNG)
      const params = structuredClone(seeded.params)
      delete (params as any).scene_ids
      const job = stalledRender('stall-complete-audit-race', seeded.project.slug, seeded.entry.task_id, {
        episode_id: seeded.episodeId,
        params,
        output_dir: seeded.outputDir,
        result: {
          complete: true,
          completion: {
            label: 'Scene image generation', expected: 1, completed: 1,
            missing: [], invalid: [], issues: [], complete: true,
          },
        },
        genstudio_jobs: [providerEvidence(seeded.entry.task_id, 'succeeded')],
      })
      const jobsFile = path.join(tempDir, 'projects', seeded.project.slug, 'jobs.json')
      await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
      jq.registerExecutor('continuity_render', async () => { executorStarts++ })
      const originalReadFile = fs.readFile.bind(fs)
      let blocked = false
      t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
        if (!blocked && path.resolve(String(args[0])) === path.resolve(seeded.planPath)) {
          blocked = true
          auditStarted()
          await auditBlocked
        }
        return originalReadFile(...args as [any, any])
      })

      const loading = jq.getJobs(seeded.project.slug)
      await started
      await jq.setQueuePaused(true)
      releaseAudit()
      await loading

      assert.equal(jq.getJob(job.job_id)?.status, 'paused')
      assert.equal(jq.getJob(job.job_id)?.pause_origin, 'stall')
      assert.equal(executorStarts, 0)
    } finally {
      releaseAudit()
      if (jq.isQueuePaused()) await jq.setQueuePaused(false)
      await service.close()
    }
  })

  for (const invalidation of ['missing-plan-row', 'corrupt-output', 'foreign-manifest-owner'] as const) {
    test(`project load keeps a stale complete declaration paused after ${invalidation}`, async () => {
      const service = await startMockGenStudioService()
      let executorStarts = 0
      try {
        const seeded = await seedProductionContinuityRender(service, `Rejected completed stall ${invalidation}`)
        await fs.writeFile(seeded.outputPath, ONE_PIXEL_PNG)
        if (invalidation === 'missing-plan-row') {
          await fs.writeFile(seeded.planPath, JSON.stringify({ scenes: [] }))
        } else if (invalidation === 'corrupt-output') {
          await fs.writeFile(seeded.outputPath, Buffer.from('not an image'))
        } else {
          await recordTaskStrict(seeded.outputDir, `${sceneId}.png`, {
            ...seeded.entry,
            task_id: 'foreign-provider-task',
          })
        }
        const params = structuredClone(seeded.params)
        delete (params as any).scene_ids
        const job = stalledRender(`stall-complete-${invalidation}`, seeded.project.slug, seeded.entry.task_id, {
          episode_id: seeded.episodeId,
          params,
          output_dir: seeded.outputDir,
          result: {
            complete: true,
            completion: {
              label: 'Scene image generation', expected: 1, completed: 1,
              missing: [], invalid: [], issues: [], complete: true,
            },
          },
          genstudio_jobs: [providerEvidence(seeded.entry.task_id, 'succeeded')],
        })
        const jobsFile = path.join(tempDir, 'projects', seeded.project.slug, 'jobs.json')
        await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
        jq.registerExecutor('continuity_render', async () => { executorStarts++ })
        const submissionsBeforeLoad = service.providerSubmissionCount('image')
        service.requests.length = 0

        await jq.getJobs(seeded.project.slug)

        assert.equal(jq.getJob(job.job_id)?.status, 'paused')
        assert.equal(executorStarts, 0)
        assert.equal(service.providerSubmissionCount('image'), submissionsBeforeLoad)
        assert.equal(service.requests.length, 0)
      } finally {
        await service.close()
      }
    })
  }

  for (const damagedManifest of ['missing', 'corrupt', 'wrong-file', 'wrong-task', 'wrong-request', 'missing-request', 'wrong-output-path'] as const) {
    test(`automatic production recovery fails closed for a ${damagedManifest} Continuity manifest`, async () => {
      const service = await startMockGenStudioService()
      let executorStarts = 0
      try {
        const seeded = await seedProductionContinuityRender(service, `Unsafe ${damagedManifest} recovery`)
        const manifestPath = path.join(seeded.outputDir, '.task-manifest.json')
        if (damagedManifest === 'missing') await fs.rm(manifestPath)
        else if (damagedManifest === 'corrupt') await fs.writeFile(manifestPath, '{not-json')
        else if (damagedManifest === 'wrong-file') {
          await fs.rm(manifestPath)
          await recordTaskStrict(seeded.outputDir, 'different-scene.png', seeded.entry)
        } else if (damagedManifest === 'wrong-task') {
          await recordTaskStrict(seeded.outputDir, `${sceneId}.png`, { ...seeded.entry, task_id: 'foreign-provider-task' })
        } else if (damagedManifest === 'wrong-request') {
          await recordTaskStrict(seeded.outputDir, `${sceneId}.png`, { ...seeded.entry, idempotency_key: 'foreign-request-key' })
        }

        const params: Job['params'] = structuredClone(seeded.params)
        if (damagedManifest === 'wrong-output-path') {
          params.genstudio_recovery.assets[`${sceneId}.png`].output_path = path.join(tempDir, 'foreign', `${sceneId}.png`)
        }
        const job = stalledRender(`stall-${damagedManifest}-manifest`, seeded.project.slug, seeded.entry.task_id, {
          episode_id: seeded.episodeId,
          params,
          output_dir: seeded.outputDir,
          genstudio_jobs: [providerEvidence(seeded.entry.task_id, 'succeeded', {
            request: damagedManifest === 'missing-request' ? undefined : {
              method: 'POST', path: '/v1/images/generations', captured_at: new Date().toISOString(),
              idempotency_key: seeded.entry.idempotency_key,
            },
          })],
        })
        const jobsFile = path.join(tempDir, 'projects', seeded.project.slug, 'jobs.json')
        await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
        jq.registerExecutor('continuity_render', async queuedJob => {
          executorStarts++
          await seeded.runContinuityRenderJob(queuedJob)
        })
        service.queueScenario('image', { states: ['succeeded'] })
        const submissionsBeforeRecovery = service.providerSubmissionCount('image')
        service.requests.length = 0

        await jq.getJobs(seeded.project.slug)
        await waitFor(() => {
          const status = jq.getJob(job.job_id)?.status
          return status === 'paused' || status === 'done' || status === 'error'
        }, `${damagedManifest} manifest recovery did not settle`)

        assert.equal(jq.getJob(job.job_id)?.status, 'paused')
        assert.equal(jq.getJob(job.job_id)?.pause_origin, 'stall')
        assert.equal(executorStarts, 0)
        assert.equal(service.providerSubmissionCount('image'), submissionsBeforeRecovery)
        assert.equal(service.requests.some(request => (
          request.method === 'POST' && request.path === '/v1/images/generations'
        )), false)
      } finally {
        await service.close()
      }
    })
  }

  test('automatic production recovery rejects a valid manifest owned by a stale output directory', async () => {
    const service = await startMockGenStudioService()
    let executorStarts = 0
    try {
      const seeded = await seedProductionContinuityRender(service, 'Stale output directory recovery')
      const authoritativeManifest = path.join(seeded.outputDir, '.task-manifest.json')
      const foreignDir = path.join(tempDir, 'foreign-scene-images')
      await fs.rm(authoritativeManifest)
      await recordTaskStrict(foreignDir, `${sceneId}.png`, seeded.entry)

      const params: Job['params'] = structuredClone(seeded.params)
      params.genstudio_recovery.assets[`${sceneId}.png`].output_path = path.join(foreignDir, `${sceneId}.png`)
      const job = stalledRender('stall-stale-output-dir', seeded.project.slug, seeded.entry.task_id, {
        episode_id: seeded.episodeId,
        params,
        output_dir: foreignDir,
        genstudio_jobs: [providerEvidence(seeded.entry.task_id, 'succeeded', {
          request: {
            method: 'POST', path: '/v1/images/generations', captured_at: new Date().toISOString(),
            idempotency_key: seeded.entry.idempotency_key,
          },
        })],
      })
      const originalEvidence = structuredClone(job.genstudio_jobs)
      const jobsFile = path.join(tempDir, 'projects', seeded.project.slug, 'jobs.json')
      await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
      jq.registerExecutor('continuity_render', async queuedJob => {
        executorStarts++
        await seeded.runContinuityRenderJob(queuedJob)
      })
      service.queueScenario('image', { states: ['succeeded'] })
      const submissionsBeforeRecovery = service.providerSubmissionCount('image')
      service.requests.length = 0

      await jq.getJobs(seeded.project.slug)
      await waitFor(() => {
        const status = jq.getJob(job.job_id)?.status
        return status === 'paused' || status === 'done' || status === 'error'
      }, 'stale output-directory recovery did not settle')

      const retained = jq.getJob(job.job_id)!
      assert.equal(retained.status, 'paused')
      assert.equal(retained.pause_origin, 'stall')
      assert.equal(executorStarts, 0)
      assert.equal(service.providerSubmissionCount('image'), submissionsBeforeRecovery)
      assert.equal(service.requests.some(request => (
        request.method === 'POST' && request.path === '/v1/images/generations'
      )), false)
      assert.deepEqual(retained.genstudio_jobs, originalEvidence)
    } finally {
      await service.close()
    }
  })

  test('the production executor alone retries a fully released fleet refusal under a derived identity', async () => {
    const service = await startMockGenStudioService()
    const originalFetch = globalThis.fetch
    let executorStarts = 0
    try {
      const seeded = await seedProductionContinuityRender(service, 'Fully released stall recovery')
      await recordTaskStrict(seeded.outputDir, `${sceneId}.png`, {
        ...seeded.entry,
        last_state: 'failed',
      })
      service.queueScenario('image', { states: ['succeeded'] })
      const job = stalledRender('stall-fully-released-fleet', seeded.project.slug, seeded.entry.task_id, {
        episode_id: seeded.episodeId,
        params: seeded.params,
        output_dir: seeded.outputDir,
        genstudio_jobs: [providerEvidence(seeded.entry.task_id, 'failed', {
          failure_code: 'SITE_PLACEMENT_EXHAUSTED',
          reserved_credits: 7,
          settled_credits: 0,
          released_credits: 7,
          request: {
            method: 'POST', path: '/v1/images/generations', captured_at: new Date().toISOString(),
            idempotency_key: seeded.entry.idempotency_key,
          },
        })],
      })
      const jobsFile = path.join(tempDir, 'projects', seeded.project.slug, 'jobs.json')
      await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
      jq.registerExecutor('continuity_render', async queuedJob => {
        executorStarts++
        await seeded.runContinuityRenderJob(queuedJob)
      })
      service.requests.length = 0
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input))
        if (url.origin === service.baseUrl && url.pathname === '/v1/images/generations'
          && (init?.method || 'GET').toUpperCase() === 'POST') {
          assert.equal(executorStarts, 1, 'the recovery controller must not submit before normal executor admission')
          assert.equal(
            jq.getJob(job.job_id)?.local_execution_complete,
            false,
            'a resumed executor must establish its own local execution boundary',
          )
        }
        return originalFetch(input, init)
      }

      await jq.getJobs(seeded.project.slug)
      await waitForDone(job.job_id, jobsFile)

      const retried = (await readManifest(seeded.outputDir)).tasks[`${sceneId}.png`]!
      const generationPosts = service.requests.filter(request => (
        request.method === 'POST' && request.path === '/v1/images/generations'
      ))
      assert.equal(executorStarts, 1)
      assert.equal(service.providerSubmissionCount('image'), 2, 'one original task plus one executor-owned safe retry')
      assert.equal(generationPosts.length, 1, 'the only new POST occurs under normal production executor admission')
      assert.notEqual(retried.task_id, seeded.entry.task_id)
      assert.notEqual(retried.idempotency_key, seeded.entry.idempotency_key)
      assert.equal(jq.getJob(job.job_id)?.genstudio_jobs?.[0]?.id, seeded.entry.task_id)
      assert.equal(jq.getJob(job.job_id)?.genstudio_jobs?.[0]?.request?.idempotency_key, seeded.entry.idempotency_key)
      assert.ok((await fs.stat(seeded.outputPath)).size > 0)
    } finally {
      globalThis.fetch = originalFetch
      await service.close()
    }
  })

  test('accepted evidence stays paused until authoritative reconciliation reports terminal', async () => {
    const service = await startMockGenStudioService()
    const { setGenStudioUrl } = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const originalFetch = globalThis.fetch
    let releaseStatus!: () => void
    const statusReleased = new Promise<void>(resolve => { releaseStatus = resolve })
    let statusStarted = false
    try {
      await setGenStudioUrl(service.baseUrl)
      await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
      const taskId = await submitImage(service, 'story-stall-reconcile', ['accepted', 'succeeded'])
      const project = await pm.createProject({ name: 'Unsettled stall reconciliation' })
      const job = stalledRender('stall-awaits-terminal', project.slug, taskId, {
        genstudio_jobs: [providerEvidence(taskId, 'accepted')],
      })
      const { jobsFile } = await writeFixture(job)
      const executions: string[] = []
      registerManifestReclaimer(executions, service)
      service.requests.length = 0
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input))
        if (url.origin === service.baseUrl && url.pathname === `/v1/images/${taskId}`) {
          statusStarted = true
          await statusReleased
        }
        return originalFetch(input, init)
      }

      await jq.getJobs(project.slug)
      await waitFor(() => statusStarted, 'reconciliation never checked the accepted task')
      assert.equal(jq.getJob(job.job_id)?.status, 'paused')
      assert.equal(executions.length, 0)
      assert.equal(service.providerSubmissionCount('image'), 1)

      releaseStatus()
      await waitForDone(job.job_id, jobsFile)
      assert.deepEqual(executions, [job.job_id])
      assert.equal(jq.getJob(job.job_id)?.genstudio_jobs?.[0]?.id, taskId)
      assert.equal(service.providerSubmissionCount('image'), 1)
      assert.equal(service.requests.some(request => request.method === 'POST'), false)
      assert.equal(
        service.requests.filter(request => request.path === `/v1/images/${taskId}`).length,
        2,
        'one reconciliation read plus one manifest reclaim read; no duplicate admission',
      )
    } finally {
      globalThis.fetch = originalFetch
      releaseStatus?.()
      await service.close()
    }
  })

  test('unreachable reconciliation leaves the stall hold paused and never admits its executor', async () => {
    const service = await startMockGenStudioService()
    const { setGenStudioUrl } = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const originalFetch = globalThis.fetch
    let statusChecks = 0
    try {
      await setGenStudioUrl(service.baseUrl)
      await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
      const taskId = await submitImage(service, 'story-stall-unreachable', ['accepted', 'succeeded'])
      const project = await pm.createProject({ name: 'Unreachable stall reconciliation' })
      const job = stalledRender('stall-reconciliation-unreachable', project.slug, taskId, {
        genstudio_jobs: [providerEvidence(taskId, 'accepted')],
      })
      await writeFixture(job)
      const executions: string[] = []
      registerManifestReclaimer(executions)
      service.requests.length = 0
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input))
        if (url.origin === service.baseUrl && url.pathname === `/v1/images/${taskId}`) {
          statusChecks++
          throw new TypeError('fixture cannot reach GenStudio')
        }
        return originalFetch(input, init)
      }

      await jq.getJobs(project.slug)
      await waitFor(() => statusChecks === 1 && Boolean(jq.getJob(job.job_id)?.reconciliation_error), 'unreachable evidence was not retained')
      assert.equal(jq.getJob(job.job_id)?.status, 'paused')
      assert.equal(executions.length, 0)
      assert.equal(service.providerSubmissionCount('image'), 1)
      assert.equal(service.requests.some(request => request.method === 'POST'), false)
    } finally {
      globalThis.fetch = originalFetch
      await service.close()
    }
  })

  test('accepted evidence cannot manufacture a missing cooperative local boundary', async () => {
    const service = await startMockGenStudioService()
    const { setGenStudioUrl } = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    try {
      await setGenStudioUrl(service.baseUrl)
      await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
      const taskId = await submitImage(service, 'story-stall-no-local-boundary', ['accepted', 'succeeded'])
      const project = await pm.createProject({ name: 'Unproven local stall boundary' })
      const job = stalledRender('stall-unproven-local-boundary', project.slug, taskId, {
        local_execution_complete: false,
        genstudio_jobs: [providerEvidence(taskId, 'accepted')],
      })
      await writeFixture(job)
      const executions: string[] = []
      registerManifestReclaimer(executions)
      service.requests.length = 0

      await jq.getJobs(project.slug)
      await waitFor(
        () => jq.getJob(job.job_id)?.genstudio_jobs?.[0]?.state === 'succeeded',
        'accepted provider evidence never reconciled to terminal',
      )

      const retained = jq.getJob(job.job_id)!
      assert.equal(retained.status, 'paused')
      assert.equal(retained.pause_origin, 'stall')
      assert.equal(retained.local_execution_complete, false)
      assert.deepEqual(executions, [])
      assert.equal(service.providerSubmissionCount('image'), 1)
      assert.equal(service.requests.some(request => request.method === 'POST'), false)
    } finally {
      await service.close()
    }
  })

  test('two direct eligible stall-recovery triggers enqueue and execute one durable job', async () => {
    const service = await startMockGenStudioService()
    const { setGenStudioUrl } = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    try {
      await setGenStudioUrl(service.baseUrl)
      await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
      const taskId = await submitImage(service, 'story-stall-repeat-eligible', ['succeeded'])
      const project = await pm.createProject({ name: 'Repeated eligible stall triggers' })
      const job = stalledRender('stall-repeat-eligible', project.slug, taskId)
      const { jobsFile } = await writeFixture(job)
      const executions: string[] = []
      registerManifestReclaimer(executions, service)
      service.requests.length = 0

      await jq.setQueuePaused(true)
      await jq.getJobs(project.slug)
      assert.equal(jq.getJob(job.job_id)?.status, 'paused')
      await jq.setQueuePaused(false)
      let eligibilityChecks = 0
      const afterEligibility = async (eligibleJobIds: string[]) => {
        assert.deepEqual(eligibleJobIds, [job.job_id])
        eligibilityChecks++
        await Promise.resolve()
      }
      await Promise.all([
        jq._recoverStallJobForTesting(job.job_id, afterEligibility),
        jq._recoverStallJobForTesting(job.job_id, afterEligibility),
      ])
      await waitForDone(job.job_id, jobsFile)

      assert.equal(eligibilityChecks, 2, 'both triggers must pass the terminal-evidence gate before admission mutates state')
      assert.deepEqual(executions, [job.job_id])
      assert.equal(service.providerSubmissionCount('image'), 1)
      assert.equal(service.requests.some(request => request.method === 'POST'), false)
    } finally {
      if (jq.isQueuePaused()) await jq.setQueuePaused(false)
      await service.close()
    }
  })

  test('one project load pumps a mixed queue and stall lane once', async () => {
    const project = await pm.createProject({ name: 'Mixed queue and stall lane load' })
    const queueJob = stalledRender('mixed-load-queue', project.slug, 'mixed-queue-task', {
      pause_origin: 'queue',
    })
    const stallJob = stalledRender('mixed-load-stall', project.slug, 'mixed-stall-task')
    const { jobsFile } = await writeFixture(queueJob)
    await writeFixture(stallJob)
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [queueJob, stallJob] }))

    let releaseExecutors!: () => void
    const held = new Promise<void>(resolve => { releaseExecutors = resolve })
    const executions: string[] = []
    jq.registerExecutor('continuity_render', async job => {
      executions.push(job.job_id)
      await held
    })
    await jq.setQueuePaused(false)
    let lanePumps = 0
    const stopObserving = jq._observeQueuePumpsForTesting(type => {
      if (type === 'continuity_render') lanePumps++
    })
    try {
      await jq.getJobs(project.slug)
    } finally {
      stopObserving()
      releaseExecutors()
    }
    await Promise.all([
      waitForDone(queueJob.job_id, jobsFile),
      waitForDone(stallJob.job_id, jobsFile),
    ])
    assert.equal(lanePumps, 1)
    assert.deepEqual(new Set(executions), new Set([queueJob.job_id, stallJob.job_id]))
  })

  test('unstable identity, cancellation context, and unsafe settlement all fail closed', async () => {
    const executions: string[] = []
    registerManifestReclaimer(executions)
    jq.registerExecutor('image_pool_generate', async job => { executions.push(job.job_id) })

    const fixtures: Job[] = []
    const unstableProject = await pm.createProject({ name: 'Unstable output identity stall' })
    fixtures.push(stalledRender('stall-unstable-output', unstableProject.slug, 'task-unstable', {
      type: 'image_pool_generate',
      params: {},
    }))
    const cancelledProject = await pm.createProject({ name: 'Cancellation context stall' })
    fixtures.push(stalledRender('stall-cancellation-context', cancelledProject.slug, 'task-cancel-context', {
      remote_cancellations: {
        'image.generation:task-cancel-context': {
          status: 'confirmed', operation: 'image.generation', provider_job_id: 'task-cancel-context',
          requested_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
    }))
    const unsafeBoundaryProject = await pm.createProject({ name: 'Incomplete local stall boundary' })
    fixtures.push(stalledRender('stall-before-safe-boundary', unsafeBoundaryProject.slug, 'task-before-boundary', {
      local_execution_complete: false,
    }))
    for (const unsafe of [
      { id: 'stall-charged-unknown', failure_code: 'SITE_PLACEMENT_EXHAUSTED', reserved_credits: 9, settled_credits: 9, released_credits: 0 },
      { id: 'stall-content-refused', failure_code: 'CONTENT_BLOCKED', reserved_credits: 9, settled_credits: 0, released_credits: 9 },
      { id: 'stall-unknown-settlement', failure_code: 'SITE_CAPACITY_UNAVAILABLE' },
    ]) {
      const project = await pm.createProject({ name: unsafe.id })
      fixtures.push(stalledRender(unsafe.id, project.slug, `task-${unsafe.id}`, {
        genstudio_jobs: [providerEvidence(`task-${unsafe.id}`, 'failed', unsafe)],
      }))
    }

    for (const job of fixtures) {
      await writeFixture(job)
      await jq.getJobs(job.project_slug)
      assert.equal(jq.getJob(job.job_id)?.status, 'paused', job.job_id)
    }
    assert.deepEqual(executions, [])
  })

  test('manual and originless holds stay manual while queue-origin release remains independent', async () => {
    const executions: string[] = []
    registerManifestReclaimer(executions)
    for (const origin of ['manual', undefined] as const) {
      const label = origin || 'originless'
      const project = await pm.createProject({ name: `${label} hold is not a stall` })
      const job = stalledRender(`${label}-origin-terminal`, project.slug, `${label}-task`, { pause_origin: origin })
      await writeFixture(job)
      await jq.getJobs(project.slug)
      assert.equal(jq.getJob(job.job_id)?.status, 'paused')
    }

    const queueProject = await pm.createProject({ name: 'Queue hold uses the queue invariant' })
    const queueJob = stalledRender('queue-origin-independent', queueProject.slug, 'queue-task', {
      pause_origin: 'queue',
      local_execution_complete: false,
      genstudio_jobs: [providerEvidence('queue-task', 'failed', {
        failure_code: 'CONTENT_BLOCKED', reserved_credits: 9, settled_credits: 9, released_credits: 0,
      })],
    })
    const { jobsFile } = await writeFixture(queueJob)
    await jq.getJobs(queueProject.slug)
    await waitForDone(queueJob.job_id, jobsFile)
    assert.deepEqual(executions, [queueJob.job_id])
  })
})
