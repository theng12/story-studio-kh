import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
const app = express()
app.use(express.json())

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  const { requireProject } = await import('../routes/middleware.js')
  const { router } = await import('../routes/chapter-background-pool.js')
  app.use('/api/projects/:slug', requireProject)
  app.use('/api', router)
})
after(async () => { await cleanup() })

test('chapter pool routes preserve the saved pool on malformed or foreign input', async () => {
  const project = await pm.createProject({ name: 'Chapter route' })
  const foreign = await pm.createProject({ name: 'Other chapter route' })
  const dir = pm.getProjectDir(project.slug)!
  const otherDir = pm.getProjectDir(foreign.slug)!
  await fs.mkdir(path.join(dir, 'backgrounds'), { recursive: true })
  await fs.mkdir(path.join(otherDir, 'backgrounds'), { recursive: true })
  await fs.writeFile(path.join(dir, 'backgrounds', 'own.webp'), 'fixture')
  await fs.writeFile(path.join(otherDir, 'backgrounds', 'other.webp'), 'foreign fixture')
  const endpoint = `/api/projects/${project.slug}/chapter-background-pool`
  const item = { id: 'own', name: 'Own background', reference: 'own.webp', enabled: true }
  const saved = await request(app).patch(endpoint).send({ items: [item] })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.deepEqual(saved.body.pool.items, [item])
  const beforeBytes = await fs.readFile(path.join(dir, 'config.json'))

  for (const items of [null, [{}], [item, item], [{ ...item, enabled: 'yes' }],
    [{ ...item, reference: path.join(otherDir, 'backgrounds', 'other.webp') }],
    [{ ...item, reference: '${CHANNEL}/backgrounds/../../config.json' }]]) {
    const response = await request(app).patch(endpoint).send({ items })
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.deepEqual(await fs.readFile(path.join(dir, 'config.json')), beforeBytes)
  }
  const read = await request(app).get(endpoint)
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.pool.items, [item])
  assert.deepEqual(await fs.readFile(path.join(dir, 'config.json')), beforeBytes)
  assert.equal((await request(app).post(`${endpoint}/reset-cursor`).send({})).status, 200)
  assert.equal((await request(app).get('/api/projects/missing-channel/chapter-background-pool')).status, 404)
})
