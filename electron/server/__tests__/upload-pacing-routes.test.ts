import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let cadence: typeof import('../services/publish-cadence.js')
let app: express.Express
const policy = { tier: 'gentle', daily_limit: 4, timezone: 'Asia/Phnom_Penh', window: { start: '09:00', end: '17:00' } }
before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  cadence = await import('../services/publish-cadence.js')
  app = express().use(express.json())
  app.use('/api/projects/:slug', (await import('../routes/middleware.js')).requireProject)
  app.use('/api', (await import('../routes/youtube-upload-pacing.js')).router)
})
after(async () => { await cleanup() })

test('missing pacing and quota stay unknown until explicitly configured', async () => {
  const project = await pm.createProject({ name: 'Pacing Route Unknown' })
  const result = await request(app).get(`/api/projects/${project.slug}/youtube/upload-pacing`).expect(200)
  assert.equal(result.body.policy, null)
  assert.equal(result.body.quota, null)
  assert.equal(result.body.configured, false)
  assert.equal(result.body.unconfigured_reason, 'missing_window')
  assert.equal((await cadence.readChannelSchedule(project.slug)).upload_pacing, null)
})

test('editable pacing round-trips through both scheduling readers and safe config', async () => {
  const project = await pm.createProject({ name: 'Pacing Route Save' })
  const endpoint = `/api/projects/${project.slug}/youtube/upload-pacing`
  await request(app).put(endpoint).send({ policy }).expect(200)
  assert.deepEqual((await request(app).get(endpoint).expect(200)).body.policy, policy)
  assert.deepEqual((await pm.getSafeConfig(project.slug)).upload_pacing, policy)
  assert.deepEqual((await cadence.readChannelSchedule(project.slug)).upload_pacing, policy)
  const changed = { ...policy, daily_limit: 5 }
  assert.deepEqual((await cadence.saveChannelSchedule(project.slug, { upload_pacing: changed as any })).upload_pacing, changed)
  assert.deepEqual((await request(app).get(endpoint).expect(200)).body.policy, changed)
})

test('invalid policy is refused and a corrupt saved policy is never called unconfigured', async () => {
  const project = await pm.createProject({ name: 'Pacing Route Invalid' })
  const endpoint = `/api/projects/${project.slug}/youtube/upload-pacing`
  await request(app).put(endpoint).send({ policy: { ...policy, window: null } }).expect(400)
  assert.equal((await pm.getConfig(project.slug) as any).upload_pacing, undefined)
  for (const invalid of [{ ...policy, daily_limit: 0 }, false, 0, '']) {
    await pm.updateConfig(project.slug, { upload_pacing: invalid } as any)
    const result = await request(app).get(endpoint).expect(409)
    assert.match(result.body.detail, /invalid/i)
    await assert.rejects(cadence.readChannelSchedule(project.slug), /invalid/i)
  }
  await request(app).get('/api/projects/not-a-real-project/youtube/upload-pacing').expect(404)
})

test('preview refuses malformed rows instead of silently omitting episodes', async () => {
  const project = await pm.createProject({ name: 'Pacing Preview Rows' })
  const endpoint = `/api/projects/${project.slug}/youtube/upload-pacing`
  await request(app).put(endpoint).send({ policy }).expect(200)
  for (const items of [[], [{ episode_code: '' }], [{ episode_code: 'EP1', earliest_upload_on: 'bad-date' }]]) {
    await request(app).post(`${endpoint}/preview`).send({ items }).expect(400)
  }
})
