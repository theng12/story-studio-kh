import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import request from 'supertest'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js')['resolveEpisodePathsByCode']
let deactivateSceneRenderStatus: typeof import('../services/scene-render-status.js')['deactivateSceneRenderStatus']
let writeSceneRenderStatus: typeof import('../services/scene-render-status.js')['writeSceneRenderStatus']

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
  ;({ deactivateSceneRenderStatus, writeSceneRenderStatus } = await import('../services/scene-render-status.js'))
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

const processFixture = fileURLToPath(new URL('./fixtures/scene-render-status-process.ts', import.meta.url))

function runStatusProcess(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', processFixture, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`scene status worker exited ${code}: ${output}`)))
  })
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fs.access(filePath).then(() => true, () => false)) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
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

  test('serializes an old cleanup behind its ownership check so it cannot overwrite a newer marker', async () => {
    const project = await pm.createProject({ name: 'Serialized render marker' })
    const episodeId = 'EP007'
    const { statusFile } = await writeActiveRenderStatus(project.slug, episodeId)
    await fs.writeFile(statusFile, JSON.stringify({ active: true, job_id: 'old-render-batch', in_flight: [2] }, null, 2))

    let releaseRead!: () => void
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve })
    let observedOldRead!: () => void
    const oldReadObserved = new Promise<void>(resolve => { observedOldRead = resolve })
    const realReadFile = fs.readFile.bind(fs)
    let holdOldRead = true
    const readMock = mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
      if (holdOldRead && String(file) === statusFile) {
        holdOldRead = false
        observedOldRead()
        await readReleased
      }
      return realReadFile(file, ...args as [])
    })
    try {
      const staleCleanup = deactivateSceneRenderStatus(project.slug, episodeId, 'old-render-batch')
      await oldReadObserved
      const newerWriter = writeSceneRenderStatus(statusFile, {
        active: true,
        job_id: 'new-render-batch',
        in_flight: [3],
      })
      releaseRead()
      await Promise.all([staleCleanup, newerWriter])
    } finally {
      readMock.mock.restore()
    }

    const status = JSON.parse(await fs.readFile(statusFile, 'utf-8'))
    assert.equal(status.active, true)
    assert.equal(status.job_id, 'new-render-batch')
    assert.deepEqual(status.in_flight, [3])
  })

  test('coordinates cleanup and a newer marker across independent processes', async () => {
    const project = await pm.createProject({ name: 'Cross-process render marker' })
    const episodeId = 'EP009'
    const { statusFile } = await writeActiveRenderStatus(project.slug, episodeId)
    await fs.writeFile(statusFile, JSON.stringify({ active: true, job_id: 'old-render-batch', in_flight: [2] }, null, 2))
    const readyFile = `${statusFile}.old-read`
    const releaseFile = `${statusFile}.release`
    const writerStartedFile = `${statusFile}.writer-started`
    const writerDoneFile = `${statusFile}.writer-done`

    const cleanup = runStatusProcess(['cleanup', project.slug, episodeId, 'old-render-batch', readyFile, releaseFile])
    assert.equal(await waitForFile(readyFile), true, 'cleanup worker must hold its old read')
    const writer = runStatusProcess(['write', statusFile, writerStartedFile, writerDoneFile])
    assert.equal(await waitForFile(writerStartedFile), true, 'new writer must begin before cleanup is released')
    const writerFinishedBeforeRelease = await waitForFile(writerDoneFile, 250)
    await fs.writeFile(releaseFile, 'release')
    await Promise.all([cleanup, writer])

    const status = JSON.parse(await fs.readFile(statusFile, 'utf-8'))
    assert.equal(writerFinishedBeforeRelease, false, 'the new writer must wait for the cross-process ownership check')
    assert.equal(status.active, true)
    assert.equal(status.job_id, 'new-render-batch')
    assert.deepEqual(status.in_flight, [3])
  })

  test('reclaims a stale cross-process lock without leaving a successor lock behind', async () => {
    const project = await pm.createProject({ name: 'Stale render marker lock' })
    const episodeId = 'EP010'
    const { statusFile } = await writeActiveRenderStatus(project.slug, episodeId)
    const lockPath = `${statusFile}.lock`
    await fs.mkdir(lockPath)
    await fs.writeFile(path.join(lockPath, 'owner'), 'crashed-owner')
    const staleAt = new Date(Date.now() - 31_000)
    await fs.utimes(lockPath, staleAt, staleAt)

    await writeSceneRenderStatus(statusFile, { active: true, job_id: 'recovered-render-batch', in_flight: [4] })

    const status = JSON.parse(await fs.readFile(statusFile, 'utf-8'))
    assert.equal(status.job_id, 'recovered-render-batch')
    assert.equal(await fs.access(lockPath).then(() => true, () => false), false)
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

  test('Scene Review keeps a paused render owner visible while its live marker is inactive', async () => {
    const project = await pm.createProject({ name: 'Paused Scene Review owner' })
    const episodeId = 'EP008'
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      scenes: [{ id: 'scene-001', scene_index: 1, visual_prompt: 'A paused scene.' }],
    }))
    const paused = renderJob(project.slug, episodeId, 'paused')
    await jq.checkpointJobState(paused)
    const { router } = await import('../routes/scene-review.js')
    const app = express()
    app.use('/api', router)

    const review = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}`).expect(200)
    assert.equal(review.body.active_render_job?.job_id, paused.job_id)
    assert.equal(review.body.active_render_job?.status, 'paused')
    assert.equal(review.body.render_status, null)
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
