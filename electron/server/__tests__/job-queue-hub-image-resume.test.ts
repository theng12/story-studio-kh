import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
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

describe('startup recovery for accepted Studio Hub images', () => {
  test('requeues an interrupted image batch instead of marking it failed', async () => {
    const project = await pm.createProject({ name: 'Hub Image Resume' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    let executions = 0
    jq.registerExecutor('scene_images_batch', async (job) => {
      executions++
      assert.equal((job.params as any).hub_image_recovery.batch_id, 'batch-survived-restart')
    })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [{
      job_id: 'hub-interrupted', project_slug: project.slug, type: 'scene_images_batch',
      episode_id: 'EP0001', title: 'Hub images', status: 'running',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: null, error: null, output_lines: [],
      params: {
        hub_image_recovery: {
          version: 1, logical_id: 'scene-images:p:EP0001', root_id: 'root', attempt: 1,
          client_request_id: 'storystudio-image-test', request_hash: 'hash',
          target_ids: ['scene-1'], hub_url: 'http://hub:47873',
          batch_id: 'batch-survived-restart', state: 'accepted',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
    }] }))

    await jq.getJobs(project.slug)
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob('hub-interrupted')?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const resumed = jq.getJob('hub-interrupted')!
    assert.equal(executions, 1)
    assert.equal(resumed.status, 'done')
    assert.match(resumed.output_lines.join('\n'), /reconnecting the saved Studio Hub image batch/i)
  })
})
