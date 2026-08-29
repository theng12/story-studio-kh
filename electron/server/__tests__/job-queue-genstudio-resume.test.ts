import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

async function waitForDone(jobId: string, jobsFile: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && jq.getJob(jobId)?.status !== 'done') {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  let persistedStatus = ''
  while (Date.now() < deadline && persistedStatus !== 'done') {
    const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
    persistedStatus = persisted.jobs.find((item: any) => item.job_id === jobId)?.status || ''
    if (persistedStatus !== 'done') await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(persistedStatus, 'done')
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
