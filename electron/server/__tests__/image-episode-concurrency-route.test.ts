import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: any

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const { router } = await import('../routes/app-settings.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})

after(async () => {
  const jq = await import('../services/job-queue.js')
  jq.setImageEpisodeConcurrency(2)
  await cleanup()
})

test('the concurrency route saves Custom scene-image values and leaves rejected values untouched', async () => {
  for (const value of [2, 1, 50]) {
    const saved = await request(app)
      .put('/api/app-settings/concurrency')
      .send({ image_episode_concurrency: value })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.image_episode_concurrency, value)
  }

  for (const value of [0, 51]) {
    // The route's error presenter logs expected 400s. The response is the
    // contract under test; keep an intentional validation refusal from making
    // this focused test's output look like an infrastructure failure.
    const priorError = console.error
    let rejected: request.Response
    try {
      console.error = () => undefined
      rejected = await request(app)
        .put('/api/app-settings/concurrency')
        .send({ image_episode_concurrency: value })
    } finally {
      console.error = priorError
    }
    assert.equal(rejected.status, 400)
    assert.match(rejected.body.detail, /whole number between 1 and 50/)
  }

  const current = await request(app).get('/api/app-settings/concurrency')
  assert.equal(current.status, 200)
  assert.equal(current.body.image_episode_concurrency, 50, 'rejected values never overwrite the last accepted setting')
})
