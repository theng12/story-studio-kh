/**
 * The clip thumbnail route resolves filename → thumbnail through a cached
 * index that refreshes when the pool's index file changes (e.g. a rename).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let bp: typeof import('../services/broll-pool-manager.js')
let app: express.Express
let poolId = ''
let folder = ''
const SHA = 'f'.repeat(64)

const clip = (filename: string) => ({
  filename, duration: 4, width: 1920, height: 1080, fps: 24, size_bytes: 10, sha256: SHA,
  normalized: false, tags: [], indexed_at: new Date().toISOString(),
})

before(async () => {
  tmp = await useTempDataDir()
  bp = await import('../services/broll-pool-manager.js')
  const route = await import('../routes/broll-pools.js')
  folder = path.join(tmp.dir, 'pool')
  await fs.mkdir(folder, { recursive: true })
  poolId = (await bp.createPool({ name: 'Thumbs', folder_path: folder })).id
  await bp.saveSidecarForScan(folder, { schema_version: 1, pool_name: 'Thumbs', clips: { 'a.mp4': clip('a.mp4') } } as any)
  await fs.mkdir(path.dirname(bp.thumbnailPath(SHA)), { recursive: true })
  await fs.writeFile(bp.thumbnailPath(SHA), Buffer.from([0xff, 0xd8, 0xff]))
  app = express()
  app.use('/api', route.router)
})

after(async () => { await tmp?.cleanup() })

test('thumbnail is served by filename and follows a rename in the pool index', async () => {
  const first = await request(app).get(`/api/broll-pools/${poolId}/clips/a.mp4/thumbnail`)
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-type'], 'image/jpeg')

  // The rewritten index has a different size (longer filename), so the cache key changes without waiting.
  await bp.saveSidecarForScan(folder, { schema_version: 1, pool_name: 'Thumbs', clips: { 'renamed.mp4': clip('renamed.mp4') } } as any)
  assert.equal((await request(app).get(`/api/broll-pools/${poolId}/clips/renamed.mp4/thumbnail`)).status, 200)
  assert.equal((await request(app).get(`/api/broll-pools/${poolId}/clips/a.mp4/thumbnail`)).status, 404)
})
