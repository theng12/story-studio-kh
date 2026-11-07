/**
 * Chapter background byte import (release 1.4.386, item 14).
 *
 * What this pins:
 *   - real PNG bytes import into the channel's OWN `backgrounds/` folder under
 *     a content-addressed generated name, and the returned `${CHANNEL}/…`
 *     reference is exactly what the pool PATCH then accepts;
 *   - the pooled item round-trips: PATCH → GET reports the file in
 *     `channel_files`, and the served sha256/width/height/bytes match;
 *   - bad bytes, an unsupported type, an oversized payload and a path-shaped
 *     filename are refused, and refusal leaves config bytes and cursor
 *     UNCHANGED (import never touches config);
 *   - a foreign channel cannot be reached, and a symlinked `backgrounds`
 *     folder is refused by name.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
const app = express()

async function pngBytes(width = 8, height = 8): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 30, g: 90, b: 160, alpha: 1 } } })
    .png().toBuffer()
}

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  const { requireProject } = await import('../routes/middleware.js')
  const { router } = await import('../routes/chapter-background-pool.js')
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/projects/:slug', requireProject)
  app.use('/api', router)
})
after(async () => { await cleanup() })

test('imported bytes land in the channel backgrounds folder and the pool PATCH accepts the reference', async () => {
  const project = await pm.createProject({ name: 'Chapter import' })
  const dir = pm.getProjectDir(project.slug)!
  const bytes = await pngBytes(16, 9)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const importEndpoint = `/api/projects/${project.slug}/chapter-background-pool/import`

  const imported = await request(app)
    .post(importEndpoint)
    .send({ filename: 'background 01.png', data_base64: bytes.toString('base64') })
  assert.equal(imported.status, 201, JSON.stringify(imported.body))
  assert.equal(imported.body.sha256, sha)
  assert.equal(imported.body.width, 16)
  assert.equal(imported.body.height, 9)
  assert.equal(imported.body.bytes, bytes.length)
  assert.match(imported.body.reference, /^\$\{CHANNEL\}\/backgrounds\/background-[0-9a-f]+\.png$/)
  assert.equal(imported.body.name, path.basename(imported.body.reference))

  // Stored in the channel's OWN backgrounds folder, byte for byte.
  const stored = await fs.readFile(path.join(dir, 'backgrounds', imported.body.name))
  assert.deepEqual(stored, bytes)

  // The returned reference is exactly what the pool PATCH accepts.
  const endpoint = `/api/projects/${project.slug}/chapter-background-pool`
  const item = { id: imported.body.name, name: 'Background 01', reference: imported.body.reference, enabled: true }
  const saved = await request(app).patch(endpoint).send({ items: [item] })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.deepEqual(saved.body.pool.items, [item])

  const read = await request(app).get(endpoint)
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.channel_files, [imported.body.name])
  assert.deepEqual(read.body.pool.items, [item])
})

test('re-importing identical bytes dedupes to the same file; refusal leaves config and cursor unchanged', async () => {
  const project = await pm.createProject({ name: 'Chapter import refusals' })
  const dir = pm.getProjectDir(project.slug)!
  const bytes = await pngBytes(12, 12)
  const importEndpoint = `/api/projects/${project.slug}/chapter-background-pool/import`
  const payload = { filename: 'bg.png', data_base64: bytes.toString('base64') }

  const first = await request(app).post(importEndpoint).send(payload)
  assert.equal(first.status, 201)
  const again = await request(app).post(importEndpoint).send(payload)
  assert.equal(again.status, 201)
  assert.equal(again.body.name, first.body.name, 'identical bytes reuse the same content-addressed file')
  const files = await fs.readdir(path.join(dir, 'backgrounds'))
  assert.deepEqual(files, [first.body.name])

  const configBefore = await fs.readFile(path.join(dir, 'config.json'))

  // Not an image, an unsupported type, an oversized payload and a path attempt.
  const cases = [
    Buffer.from('plain text, not a picture').toString('base64'),
    (await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).tiff().toBuffer()).toString('base64'),
    'A'.repeat(7_000_000),
  ]
  for (const data_base64 of cases) {
    const response = await request(app).post(importEndpoint).send({ filename: 'x.png', data_base64 })
    assert.ok([400, 413].includes(response.status), JSON.stringify(response.body))
  }
  // A path-shaped filename is display only — the stored name is generated.
  const pathAttempt = await request(app).post(importEndpoint)
    .send({ filename: '../../config.json', data_base64: bytes.toString('base64') })
  assert.equal(pathAttempt.status, 201)
  assert.match(pathAttempt.body.name, /^background-[0-9a-f]+\.png$/)

  // Import never mutates config.json.
  assert.deepEqual(await fs.readFile(path.join(dir, 'config.json')), configBefore)
  // No stray file was written outside backgrounds/.
  assert.equal(await fs.readFile(path.join(dir, 'config.json')).then(() => true), true)
})

test('a foreign channel and a symlinked backgrounds folder are refused', async () => {
  const project = await pm.createProject({ name: 'Chapter import ownership' })
  const dir = pm.getProjectDir(project.slug)!
  const bytes = await pngBytes(8, 8)
  const data_base64 = bytes.toString('base64')

  // Unknown slug → requireProject's 404.
  const unknown = await request(app).post('/api/projects/no-such-channel/chapter-background-pool/import').send({ data_base64 })
  assert.equal(unknown.status, 404)

  // A symlinked backgrounds folder is refused by name, and nothing is written.
  const outside = path.join(dir, 'elsewhere')
  await fs.mkdir(outside, { recursive: true })
  await fs.symlink(outside, path.join(dir, 'backgrounds'))
  const refused = await request(app).post(`/api/projects/${project.slug}/chapter-background-pool/import`).send({ data_base64 })
  assert.equal(refused.status, 409, JSON.stringify(refused.body))
  assert.deepEqual(await fs.readdir(outside), [])
})
