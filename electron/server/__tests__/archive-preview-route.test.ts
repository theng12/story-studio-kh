import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitForValue } from './_timing.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: express.Express

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  const { router } = await import('../routes/library.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})

after(async () => { await cleanup() })

async function waitForPreview(done: (status: any) => boolean): Promise<any> {
  return waitForValue(async () => {
    const response = await request(app).get('/api/library/archive/status')
    assert.equal(response.status, 200)
    return done(response.body) ? response.body : undefined
  }, { label: 'archive preview state' })
}

test('archive preview acknowledges immediately, reports scan state, and returns failures and stops through status', async () => {
  const source = path.join(tempDir, 'slow-preview')
  await fs.mkdir(source, { recursive: true })
  await Promise.all(Array.from({ length: 1_000 }, (_, index) => (
    fs.writeFile(path.join(source, `CL0001_${index}.mp4`), 'x')
  )))

  const acknowledged = await request(app)
    .post('/api/library/archive/preview')
    .send({ source_root: source })
  assert.equal(acknowledged.status, 200)
  assert.deepEqual(acknowledged.body, { started: true })

  const checking = await waitForPreview(status => status.phase === 'preview' && status.checked > 0)
  assert.equal(checking.stage, 'checking')
  assert.equal(checking.result, null)

  const stopping = await request(app).post('/api/library/archive/stop').send({})
  assert.equal(stopping.status, 200)
  const stopped = await waitForPreview(status => status.running === false && status.phase === 'preview')
  assert.equal(stopped.error, '')
  assert.equal(stopped.result.complete, false)
  assert.equal(stopped.result.cancelled, true)

  const unreadableSource = path.join(tempDir, 'not-a-folder.mp4')
  await fs.writeFile(unreadableSource, 'not a folder')
  const retry = await request(app)
    .post('/api/library/archive/preview')
    .send({ source_root: unreadableSource })
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.body, { started: true })

  const failed = await waitForPreview(status => status.running === false && status.phase === 'preview')
  assert.match(failed.error, /Could not read archive source folder/i)
  assert.equal(failed.result, null)
})
