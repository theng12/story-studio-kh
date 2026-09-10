import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: express.Express
let pools: typeof import('../services/broll-pool-manager.js')
let queue: typeof import('../services/job-queue.js')
let imagePoolId: string
let audioPoolId: string

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const [poolManager, jobQueue, route] = await Promise.all([
    import('../services/broll-pool-manager.js'),
    import('../services/job-queue.js'),
    import('../routes/broll-pools.js'),
  ])
  pools = poolManager
  queue = jobQueue

  const imageDir = path.join(temp.dir, 'images')
  const audioDir = path.join(temp.dir, 'audio')
  await Promise.all([
    fs.mkdir(imageDir, { recursive: true }),
    fs.mkdir(audioDir, { recursive: true }),
  ])
  imagePoolId = (await pools.createPool({ name: 'Image normalize guard', folder_path: imageDir, media: 'image' })).id
  audioPoolId = (await pools.createPool({ name: 'Audio normalize guard', folder_path: audioDir, media: 'audio' })).id

  await queue.setQueuePaused(true)
  app = express()
  app.use(express.json())
  app.use('/api', route.router)
})

after(async () => {
  await queue.setQueuePaused(false)
  await cleanup()
})

async function assertNoNewNormalizeJob(beforeIds: Set<string>): Promise<void> {
  const afterJobs = await queue.getJobs('_app_')
  assert.deepEqual(
    afterJobs.filter(job => job.type === 'broll_normalize').map(job => job.job_id),
    [...beforeIds],
    'rejecting a non-video pool must happen before enqueueing a normalize job',
  )
}

test('normalize-one rejects image and audio pools before enqueueing', async () => {
  for (const poolId of [imagePoolId, audioPoolId]) {
    const beforeJobs = await queue.getJobs('_app_')
    const beforeIds = new Set(beforeJobs.filter(job => job.type === 'broll_normalize').map(job => job.job_id))
    const response = await request(app)
      .post(`/api/broll-pools/${poolId}/clips/example.png/normalize`)
      .send({})

    assert.equal(response.status, 400)
    assert.equal(response.body.detail, `Pool '${poolId}' is not a video pool.`)
    await assertNoNewNormalizeJob(beforeIds)
  }
})

test('normalize-all rejects image and audio pools before enqueueing', async () => {
  for (const poolId of [imagePoolId, audioPoolId]) {
    const beforeJobs = await queue.getJobs('_app_')
    const beforeIds = new Set(beforeJobs.filter(job => job.type === 'broll_normalize').map(job => job.job_id))
    const response = await request(app)
      .post(`/api/broll-pools/${poolId}/normalize-all`)
      .send({})

    assert.equal(response.status, 400)
    assert.equal(response.body.detail, `Pool '${poolId}' is not a video pool.`)
    await assertNoNewNormalizeJob(beforeIds)
  }
})
