import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js')['resolveEpisodePathsByCode']

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
})

after(async () => { await cleanup() })

function renderJob(projectSlug: string, episodeId: string, status: Job['status']): Job {
  const now = new Date().toISOString()
  return {
    job_id: `render-status-${projectSlug}-${episodeId}-${status}`,
    project_slug: projectSlug,
    type: 'continuity_render',
    episode_id: episodeId,
    title: 'Scene render',
    status,
    created_at: now,
    started_at: now,
    finished_at: ['done', 'error', 'cancelled'].includes(status) ? now : null,
    error: status === 'error' ? 'Interrupted by app restart' : null,
    output_lines: [],
    params: {},
  }
}

async function writeActiveRenderStatus(projectSlug: string, episodeId: string): Promise<{ statusFile: string, imageFile: string }> {
  const paths = await resolveEpisodePathsByCode(projectSlug, episodeId)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  const statusFile = path.join(paths.episode_dir, '.render_status.json')
  const imageFile = path.join(paths.episode_dir, 'preserved-scene.png')
  await fs.writeFile(statusFile, JSON.stringify({
    active: true,
    mode: 'batch',
    total: 3,
    rendered_so_far: 1,
    in_flight: [2, 3],
  }, null, 2))
  await fs.writeFile(imageFile, 'valid-image-bytes')
  return { statusFile, imageFile }
}

async function waitForInactive(statusFile: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const status = JSON.parse(await fs.readFile(statusFile, 'utf-8')) as Record<string, unknown>
    if (status.active === false) return status
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`render status remained active: ${await fs.readFile(statusFile, 'utf-8')}`)
}

describe('Scene render status lifecycle', () => {
  test('Scene Review only surfaces a marker tied to its active batch', async () => {
    const project = await pm.createProject({ name: 'Scene Review render ownership' })
    const episodeId = 'EP005'
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      scenes: [{ id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in an archive.' }],
    }))
    const { resolveEpisodePathsByCodeWithSidecar } = await import('../services/utils.js')
    const routePaths = await resolveEpisodePathsByCodeWithSidecar(project.slug, episodeId, 'scene_plan.json')
    const statusFile = path.join(routePaths.episode_dir, '.render_status.json')
    await fs.writeFile(statusFile, JSON.stringify({ active: true, in_flight: [2, 3] }, null, 2))
    const { router } = await import('../routes/scene-review.js')
    const app = express()
    app.use('/api', router)

    const orphan = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}`).expect(200)
    assert.equal(orphan.body.render_status, null)

    await jq.setQueuePaused(true)
    try {
      const job = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'continuity_render',
        episode_id: episodeId,
        title: 'Active scene render',
        params: {},
      })
      await fs.writeFile(statusFile, JSON.stringify({
        active: true,
        job_id: job.job_id,
        mode: 'batch',
        total: 3,
        rendered_so_far: 1,
        in_flight: [2, 3],
      }, null, 2))

      const active = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}`).expect(200)
      assert.equal(active.body.render_status?.job_id, job.job_id, JSON.stringify(active.body))
      await jq.requestJobCancellation(project.slug, job.job_id)
    } finally {
      await jq.setQueuePaused(false)
    }
  })

  test('terminal scene render checkpoints deactivate the marker without touching saved images', async () => {
    const project = await pm.createProject({ name: 'Terminal render marker' })
    const episodeId = 'EP001'
    const { statusFile, imageFile } = await writeActiveRenderStatus(project.slug, episodeId)

    await jq.checkpointJobState(renderJob(project.slug, episodeId, 'error'))

    const status = await waitForInactive(statusFile)
    assert.deepEqual(status.in_flight, [])
    assert.equal(await fs.readFile(imageFile, 'utf-8'), 'valid-image-bytes')
  })

  test('a live scene render checkpoint leaves its active marker intact', async () => {
    const project = await pm.createProject({ name: 'Live render marker' })
    const episodeId = 'EP002'
    const { statusFile } = await writeActiveRenderStatus(project.slug, episodeId)

    await jq.checkpointJobState(renderJob(project.slug, episodeId, 'running'))

    const status = JSON.parse(await fs.readFile(statusFile, 'utf-8'))
    assert.equal(status.active, true)
    assert.deepEqual(status.in_flight, [2, 3])
  })

  test('an older terminal batch cannot deactivate a newer batch marker', async () => {
    const project = await pm.createProject({ name: 'Newer render marker' })
    const episodeId = 'EP006'
    const { statusFile } = await writeActiveRenderStatus(project.slug, episodeId)
    await fs.writeFile(statusFile, JSON.stringify({
      active: true,
      job_id: 'newer-render-batch',
      in_flight: [2, 3],
    }, null, 2))

    await jq.checkpointJobState(renderJob(project.slug, episodeId, 'error'))

    const status = JSON.parse(await fs.readFile(statusFile, 'utf-8'))
    assert.equal(status.active, true)
    assert.equal(status.job_id, 'newer-render-batch')
  })

  test('restart terminalization deactivates an interrupted render marker', async () => {
    const project = await pm.createProject({ name: 'Restarted render marker' })
    const episodeId = 'EP003'
    const { statusFile } = await writeActiveRenderStatus(project.slug, episodeId)
    const jobsFile = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', project.slug, 'jobs.json')
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [renderJob(project.slug, episodeId, 'running')] }, null, 2))

    const restored = await jq.getJobs(project.slug)

    assert.equal(restored.find(job => job.episode_id === episodeId)?.status, 'error')
    assert.equal((await waitForInactive(statusFile)).active, false)
  })

  test('removing terminal render history deactivates a leftover marker', async () => {
    const project = await pm.createProject({ name: 'Removed render marker' })
    const episodeId = 'EP004'
    const job = renderJob(project.slug, episodeId, 'done')
    await jq.checkpointJobState(job)
    await jq.getJobs(project.slug)
    const { statusFile } = await writeActiveRenderStatus(project.slug, episodeId)

    assert.equal(jq.removeTerminalJob(project.slug, job.job_id), true)
    assert.equal((await waitForInactive(statusFile)).active, false)
  })
})
