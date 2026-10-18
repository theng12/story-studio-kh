import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: express.Express
let projectSlug: string
let queue: typeof import('../services/job-queue.js')
const jobIds: string[] = []
const poolIds: string[] = []

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup

  const [projectManager, poolManager, jobQueue, route] = await Promise.all([
    import('../services/project-manager.js'),
    import('../services/broll-pool-manager.js'),
    import('../services/job-queue.js'),
    import('../routes/broll-project.js'),
  ])
  queue = jobQueue
  projectSlug = (await projectManager.createProject({ name: 'Image Pool Resolution Route' })).slug

  for (const name of ['Published resolution', 'Omitted resolution', 'Invalid resolution', 'Omitted ratio', 'Blank ratio']) {
    const folder = path.join(temp.dir, name.toLowerCase().replaceAll(' ', '-'))
    await fs.mkdir(folder, { recursive: true })
    poolIds.push((await poolManager.createPool({ name, folder_path: folder, media: 'image' })).id)
  }

  await queue.setQueuePaused(true)
  app = express()
  app.use(express.json())
  app.use('/api', route.router)
})

after(async () => {
  for (const jobId of jobIds) await queue.pauseJob(jobId)
  await queue.setQueuePaused(false)
  await cleanup()
})

async function enqueue(poolId: string, extra: Record<string, unknown> = {}) {
  const response = await request(app)
    .post(`/api/projects/${projectSlug}/image-pool/generate`)
    .send({
      pool_id: poolId,
      model: 'published-image-model',
      prompts: ['A lantern on a quiet desk.'],
      aspect_ratio: '16:9',
      ...extra,
    })
  assert.equal(response.status, 201)
  jobIds.push(response.body.job_id)
  const job = queue.getJob(response.body.job_id)
  assert.ok(job, 'the mounted route must enqueue a durable job')
  return job
}

test('POST image-pool/generate preserves a published string resolution in the enqueued job', async () => {
  const job = await enqueue(poolIds[0]!, { resolution: '2K' })
  assert.equal(job.params.resolution, '2K')
})

test('POST image-pool/generate leaves resolution absent when the client omits it', async () => {
  const job = await enqueue(poolIds[1]!)
  assert.equal(Object.hasOwn(job.params, 'resolution'), false)
})

test('POST image-pool/generate does not forward a non-string resolution', async () => {
  const job = await enqueue(poolIds[2]!, { resolution: 2048 })
  assert.equal(Object.hasOwn(job.params, 'resolution'), false)
})

test('POST image-pool/generate omits a missing aspect ratio instead of writing 16:9', async () => {
  // The image resolver applies the shared Story default against the live
  // catalogue; the route must preserve "the caller named none".
  const job = await enqueue(poolIds[3]!, { aspect_ratio: undefined })
  assert.equal(Object.hasOwn(job.params, 'aspect_ratio'), false)
})

test('POST image-pool/generate omits a blank aspect ratio', async () => {
  const job = await enqueue(poolIds[4]!, { aspect_ratio: '   ' })
  assert.equal(Object.hasOwn(job.params, 'aspect_ratio'), false)
})
