/**
 * Tests for /api/brands routes (routes/brands.ts).
 *
 * Covers happy paths + the "delete refuses with referencing-projects list"
 * contract that the UI's reassign-and-retry flow depends on.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup

  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
})

after(async () => { await cleanup() })

const validBrand = {
  id: 'demo-channel',
  name: 'Demo Channel',
  schemaVersion: 1,
  channel: { name: 'Demo Channel', youtube_url: 'https://youtube.com/@demo' },
  imagePrompts: { style_keywords: ['cinematic', 'moody'] },
}

describe('Brand routes', () => {
  let projectSlug: string

  test('GET /api/brands returns empty list initially', async () => {
    const res = await request(app).get('/api/brands')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.brands))
    assert.equal(res.body.brands.length, 0)
  })

  test('POST /api/brands creates a brand', async () => {
    const res = await request(app).post('/api/brands').send(validBrand)
    assert.equal(res.status, 201)
    assert.equal(res.body.id, 'demo-channel')
    assert.equal(res.body.name, 'Demo Channel')
  })

  test('POST /api/brands rejects duplicate id', async () => {
    const res = await request(app).post('/api/brands').send(validBrand)
    assert.equal(res.status, 409)
    assert.match(res.body.detail, /already exists/)
  })

  test('POST /api/brands rejects invalid id (non-slug)', async () => {
    const res = await request(app).post('/api/brands').send({ ...validBrand, id: 'Has Spaces!' })
    assert.equal(res.status, 400)
  })

  test('POST /api/brands rejects missing name', async () => {
    const res = await request(app).post('/api/brands').send({ id: 'no-name', schemaVersion: 1 })
    assert.equal(res.status, 400)
  })

  test('GET /api/brands/:id returns the brand', async () => {
    const res = await request(app).get('/api/brands/demo-channel')
    assert.equal(res.status, 200)
    assert.equal(res.body.id, 'demo-channel')
    assert.deepEqual(res.body.imagePrompts.style_keywords, ['cinematic', 'moody'])
  })

  test('GET /api/brands/:id returns 404 for unknown', async () => {
    const res = await request(app).get('/api/brands/nope')
    assert.equal(res.status, 404)
  })

  test('PUT /api/brands/:id updates the brand', async () => {
    const updated = { ...validBrand, name: 'Demo Channel (renamed)' }
    const res = await request(app).put('/api/brands/demo-channel').send(updated)
    assert.equal(res.status, 200)
    assert.equal(res.body.name, 'Demo Channel (renamed)')

    // Confirm round-trip
    const re = await request(app).get('/api/brands/demo-channel')
    assert.equal(re.body.name, 'Demo Channel (renamed)')
  })

  test('PUT /api/brands/:id rejects body whose id mismatches path', async () => {
    const mismatched = { ...validBrand, id: 'different-id' }
    const res = await request(app).put('/api/brands/demo-channel').send(mismatched)
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /id in path and body must match/)
  })

  test('PUT /api/brands/:id returns 404 for unknown', async () => {
    const res = await request(app).put('/api/brands/ghost').send({ ...validBrand, id: 'ghost' })
    assert.equal(res.status, 404)
  })

  // Set up a project + assign the brand for the delete-refuses tests below
  test('POST /api/projects + PUT /api/projects/:slug/brand sets the association', async () => {
    const create = await request(app).post('/api/projects').send({
      name: 'Brand Test Project',
      episode_prefix: 'BT',
      episode_digits: 3,
    })
    assert.equal(create.status, 201)
    projectSlug = create.body.slug

    const setBrand = await request(app)
      .put(`/api/projects/${projectSlug}/brand`)
      .send({ brand_id: 'demo-channel' })
    assert.equal(setBrand.status, 200)
    assert.equal(setBrand.body.brand_id, 'demo-channel')

    const meta = await request(app).get(`/api/projects/${projectSlug}`)
    assert.equal(meta.body.brand_id, 'demo-channel')
  })

  test('PUT /api/projects/:slug/brand rejects unknown brand_id', async () => {
    const res = await request(app)
      .put(`/api/projects/${projectSlug}/brand`)
      .send({ brand_id: 'no-such-brand' })
    assert.equal(res.status, 404)
  })

  test('GET /api/brands reports project_count after association', async () => {
    const res = await request(app).get('/api/brands')
    const demo = res.body.brands.find((b: any) => b.id === 'demo-channel')
    assert.ok(demo)
    assert.equal(demo.project_count, 1)
  })

  test('DELETE /api/brands/:id refuses while a project references it', async () => {
    const res = await request(app).delete('/api/brands/demo-channel')
    assert.equal(res.status, 409)
    assert.ok(Array.isArray(res.body.referencing_projects))
    assert.ok(res.body.referencing_projects.includes(projectSlug))
  })

  test('PUT /api/projects/:slug/brand with null clears association', async () => {
    const res = await request(app)
      .put(`/api/projects/${projectSlug}/brand`)
      .send({ brand_id: null })
    assert.equal(res.status, 200)
    assert.equal(res.body.brand_id, null)

    const meta = await request(app).get(`/api/projects/${projectSlug}`)
    assert.equal(meta.body.brand_id, undefined)
  })

  test('DELETE /api/brands/:id succeeds after reassignment', async () => {
    const res = await request(app).delete('/api/brands/demo-channel')
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)

    const re = await request(app).get('/api/brands/demo-channel')
    assert.equal(re.status, 404)
  })

  test('DELETE /api/brands/:id returns 404 for unknown', async () => {
    const res = await request(app).delete('/api/brands/ghost')
    assert.equal(res.status, 404)
  })
})
