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

describe('startup recovery for accepted Studio Hub renders', () => {
  test('requeues the original remote batch instead of submitting a duplicate render', async () => {
    const project = await pm.createProject({ name: 'Hub Render Resume' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')
    let executions = 0
    jq.registerExecutor('video_assembly', async (job) => {
      executions++
      assert.equal((job.params as any).remote_render.batch_id, 'batch-survived-restart')
    })
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [{
      job_id: 'render-interrupted', project_slug: project.slug, type: 'video_assembly',
      episode_id: 'EP0045', title: 'Video Assembly', status: 'running',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: null, error: null, output_lines: [],
      params: {
        render_target: 'remote',
        remote_render: {
          batch_id: 'batch-survived-restart',
          submitted_at: new Date().toISOString(),
          hub_url: 'http://hub:47873',
        },
      },
    }] }))

    await jq.getJobs(project.slug)
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && jq.getJob('render-interrupted')?.status !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    let persistedStatus = ''
    while (Date.now() < deadline && persistedStatus !== 'done') {
      const persisted = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
      persistedStatus = persisted.jobs.find((item: any) => item.job_id === 'render-interrupted')?.status || ''
      if (persistedStatus !== 'done') await new Promise(resolve => setTimeout(resolve, 10))
    }
    const resumed = jq.getJob('render-interrupted')!
    assert.equal(executions, 1)
    assert.equal(resumed.status, 'done')
    assert.equal(persistedStatus, 'done')
    assert.match(resumed.output_lines.join('\n'), /reconnecting the original remote render batch/i)
  })
})
