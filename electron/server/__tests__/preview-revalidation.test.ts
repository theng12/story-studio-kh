/**
 * Audio / media previews keyed by path must revalidate, so a file re-merged at the same path is not
 * replayed stale.
 *
 * Both audio preview routes answered `Cache-Control: public, max-age=3600` (media: 300 s) for a URL
 * that names only the path. Re-merging narration overwrites `{code}_merged_audio.mp3` in place, and
 * the in-app player could keep the old bytes for up to an hour. Chromium's own cache behaviour is not
 * reproduced here; this pins the server side: no max-age, a validator that changes with the file, and a
 * 304 only while the file is unchanged.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express
let slug = ''
let dir = ''

before(async () => {
  tmp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Preview Revalidation' })
  slug = project.slug
  dir = path.join(tmp.dir, 'projects', slug, 'episodes')
  await fs.mkdir(dir, { recursive: true })
  app = express()
  app.use('/api', (await import('../routes/audio-merge.js')).router)
  app.use('/api', (await import('../routes/video.js')).router)
})
after(async () => { await tmp.cleanup() })

const routes = [
  ['audio-editor/preview-audio', 'merged.mp3'],
  ['video-editor/preview-audio', 'bed.mp3'],
  ['video-editor/preview-media', 'clip.mp4'],
] as const

for (const [route, file] of routes) {
  test(`${route}: validator changes when the file is rewritten, 304 only while unchanged`, async () => {
    const full = path.join(dir, file)
    await fs.writeFile(full, Buffer.alloc(2048, 1))
    const url = `/api/projects/${slug}/${route}?path=${encodeURIComponent(full)}`
    const first = await request(app).get(url)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.doesNotMatch(String(first.headers['cache-control']), /max-age=[1-9]/)
    assert.match(String(first.headers['cache-control']), /no-cache/)
    const etag = String(first.headers.etag)
    assert.ok(etag)

    const again = await request(app).get(url).set('If-None-Match', etag)
    assert.equal(again.status, 304)

    await fs.writeFile(full, Buffer.alloc(4096, 2)) // re-merged at the same path
    const changed = await request(app).get(url).set('If-None-Match', etag)
    assert.equal(changed.status, 200, 'a changed file must not be answered 304')
    assert.notEqual(String(changed.headers.etag), etag)
    assert.equal(changed.body.length, 4096)
  })
}
