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
