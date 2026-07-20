import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

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
})
