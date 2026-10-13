import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor, waitForValue } from './_timing.js'

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

test('archive preview acknowledges immediately, reports scan state, and returns failures and stops through status', async (t) => {
  const source = path.join(tempDir, 'slow-preview')
  await fs.mkdir(source, { recursive: true })
  await Promise.all(Array.from({ length: 3 }, (_, index) => (
    fs.writeFile(path.join(source, `CL0001_${index}.mp4`), 'x')
  )))

  const realStat = fs.stat.bind(fs)
  let sourceStats = 0
  let secondStatHeld = false
  let releaseSecondStat!: () => void
  const secondStatBarrier = new Promise<void>(resolve => { releaseSecondStat = resolve })
  const statMock = t.mock.method(fs, 'stat', async (file: any, ...args: any[]) => {
    if (path.dirname(path.resolve(String(file))) === path.resolve(source)) {
      sourceStats += 1
      if (sourceStats === 2) {
        secondStatHeld = true
        await secondStatBarrier
      }
    }
    return realStat(file, ...args)
  })
  let previewStarted = false

  try {
    const acknowledged = await request(app)
      .post('/api/library/archive/preview')
      .send({ source_root: source })
    previewStarted = acknowledged.status === 200
    assert.equal(acknowledged.status, 200)
    assert.deepEqual(acknowledged.body, { started: true })

    await waitFor(() => secondStatHeld, { label: 'archive preview second candidate stat' })
    const checking = await request(app).get('/api/library/archive/status')
    assert.equal(checking.status, 200)
    assert.equal(checking.body.running, true)
    assert.equal(checking.body.phase, 'preview')
    assert.equal(checking.body.stage, 'checking')
    assert.ok(checking.body.checked > 0)
    assert.equal(checking.body.result, null)

    const stopping = await request(app).post('/api/library/archive/stop').send({})
    assert.equal(stopping.status, 200)
    assert.deepEqual(stopping.body, { stopping: true })
    releaseSecondStat()

    const stopped = await waitForPreview(status => status.running === false && status.phase === 'preview')
    assert.equal(stopped.error, '')
    assert.equal(stopped.result.complete, false)
    assert.equal(stopped.result.cancelled, true)
  } finally {
    releaseSecondStat()
    try {
      if (previewStarted) {
        await waitForPreview(status => status.running === false && status.phase === 'preview')
      }
    } finally {
      statMock.mock.restore()
    }
  }

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
