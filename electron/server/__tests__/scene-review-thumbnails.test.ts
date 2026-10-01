/**
 * Review grids get a small cached JPEG instead of the full-resolution still.
 *
 * Scene Review / Motion Review fetched and decoded the original (3-5 MB, ~6 MB decoded) for each card.
 * `?thumb=1` serves a 480 px JPEG from `<project>/.cache/thumbs`, keyed by the source's size and mtime
 * (one file per scene), counted by the storage audit, and falling back to the original on any failure.
 * The original is never modified. What this cannot show: Chromium's decode memory, only the bytes served.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js')['resolveEpisodePathsByCode']
let resolveEpisodePathsByCodeWithSidecar: typeof import('../services/utils.js')['resolveEpisodePathsByCodeWithSidecar']
let resolveSceneImagesDir: typeof import('../generators/scene-image.js')['resolveSceneImagesDir']
let app: express.Express
let projectsApp: express.Express

// A real, fully decodable PNG: the review only counts an image it can decode.
let PNG: Buffer
let BIG: Buffer

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const sharp = (await import('sharp')).default
  PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer()
  BIG = await sharp((await import('node:crypto')).randomBytes(1672 * 941 * 3), { raw: { width: 1672, height: 941, channels: 3 } }).png().toBuffer()
  pm = await import('../services/project-manager.js')
  ;({ resolveEpisodePathsByCode, resolveEpisodePathsByCodeWithSidecar } = await import('../services/utils.js'))
  ;({ resolveSceneImagesDir } = await import('../generators/scene-image.js'))
  const { router } = await import('../routes/scene-review.js')
  app = express()
  app.use('/api', router)
  projectsApp = express()
  projectsApp.use(express.json())
  projectsApp.use('/api', (await import('../routes/projects.js')).router)
})
after(async () => { await cleanup() })

async function seed(name: string) {
  const project = await pm.createProject({ name })
  const episodeId = 'EP007'
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [{
    id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 1, transcript_segment: 'w', visual_prompt: 'p', approved: false,
  }] }))
  const routePaths = await resolveEpisodePathsByCodeWithSidecar(project.slug, episodeId, 'scene_plan.json')
  const imagesDir = await resolveSceneImagesDir(project.slug, episodeId, routePaths.episode_dir)
  await fs.mkdir(imagesDir, { recursive: true })
  return { project, episodeId, imagesDir, projectDir: path.join(path.dirname(path.dirname(paths.episode_dir)), '..') }
}

describe('scene image thumbnails', () => {
  test('?thumb=1 serves a small JPEG, caches it, leaves the original alone, and re-makes it when the image changes', async () => {
    const { project, episodeId, imagesDir } = await seed('Thumbs')
    const source = path.join(imagesDir, 'scene-001.png')
    await fs.writeFile(source, BIG)
    const base = `/api/projects/${project.slug}/scene-review/${episodeId}/image/scene-001`
    const projectDir = pm.getProjectDir(project.slug)!

    const thumb = await request(app).get(`${base}?thumb=1`).expect(200)
    assert.equal(thumb.headers['content-type'], 'image/jpeg')
    assert.ok(thumb.body.length < BIG.length / 5, `thumbnail ${thumb.body.length} B vs original ${BIG.length} B`)
    const sharp = (await import('sharp')).default
    assert.equal((await sharp(thumb.body).metadata()).width, 480)
    assert.deepEqual(await fs.readFile(source), BIG, 'the original is untouched')

    const cacheDir = path.join(projectDir, '.cache', 'thumbs', episodeId)
    const first = await fs.readdir(cacheDir)
    assert.equal(first.length, 1)
    // A second request is a validator hit and makes nothing new.
    const again = await request(app).get(`${base}?thumb=1`).set('If-None-Match', String(thumb.headers.etag)).expect(304)
    assert.equal(again.status, 304)
    assert.deepEqual(await fs.readdir(cacheDir), first)

    // The scene is re-rendered: a new derivative replaces the old one (still one file per scene).
    await fs.writeFile(source, await sharp({ create: { width: 1672, height: 941, channels: 3, background: '#336699' } }).png().toBuffer())
    const later = new Date(Date.now() + 10_000)
    await fs.utimes(source, later, later)
    const fresh = await request(app).get(`${base}?thumb=1`).expect(200)
    assert.notEqual(String(fresh.headers.etag), String(thumb.headers.etag))
    const second = await fs.readdir(cacheDir)
    assert.equal(second.length, 1)
    assert.notEqual(second[0], first[0])

    // The plain URL is still the full-resolution file.
    const full = await request(app).get(base).expect(200)
    assert.equal(full.headers['content-type'], 'image/png')
  })

  test('a cache that cannot be written falls back to the original image', async () => {
    const { project, episodeId, imagesDir } = await seed('Thumb fallback')
    await fs.writeFile(path.join(imagesDir, 'scene-001.png'), BIG)
    const projectDir = pm.getProjectDir(project.slug)!
    await fs.mkdir(path.join(projectDir, '.cache'), { recursive: true })
    await fs.writeFile(path.join(projectDir, '.cache', 'thumbs'), 'a file where the folder should be')
    const res = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}/image/scene-001?thumb=1`).expect(200)
    assert.equal(res.headers['content-type'], 'image/png')
    assert.equal(res.body.length, BIG.length)
  })

  test('the storage audit counts the cache', async () => {
    const { project, episodeId, imagesDir } = await seed('Thumb audit')
    await fs.writeFile(path.join(imagesDir, 'scene-001.png'), BIG)
    const { auditProjectStorage } = await import('../services/storage-audit.js')
    assert.equal((await auditProjectStorage(project.slug)).project_bytes_thumbnail_cache, 0)
    await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}/image/scene-001?thumb=1`).expect(200)
    const audit = await auditProjectStorage(project.slug)
    assert.ok(audit.project_bytes_thumbnail_cache > 1000, `counted ${audit.project_bytes_thumbnail_cache}`)
  })
  test('Clear preview cache moves the folder to the project _trash (never deletes), reports its size, and the grid rebuilds it', async () => {
    const { project, episodeId, imagesDir } = await seed('Thumb clear')
    await fs.writeFile(path.join(imagesDir, 'scene-001.png'), BIG)
    const projectDir = pm.getProjectDir(project.slug)!
    const url = `/api/projects/${project.slug}/scene-review/${episodeId}/image/scene-001?thumb=1`
    const clear = `/api/projects/${project.slug}/storage/clear-preview-cache`

    // Nothing cached yet: a harmless no-op.
    const none = await request(projectsApp).post(clear).expect(200)
    assert.deepEqual(none.body, { bytes: 0, moved: false, trash_path: null })

    await request(app).get(url).expect(200)
    const { thumbCacheBytes, thumbCacheRoot } = await import('../lib/thumbnail-cache.js')
    const before = await thumbCacheBytes(projectDir)
    assert.ok(before > 1000)

    const res = await request(projectsApp).post(clear).expect(200)
    assert.equal(res.body.moved, true)
    assert.equal(res.body.bytes, before)
    assert.equal(await thumbCacheBytes(projectDir), 0)
    assert.equal(await fs.stat(thumbCacheRoot(projectDir)).catch(() => null), null)
    // Moved, not removed: the same bytes are under <project>/_trash.
    assert.ok(res.body.trash_path.startsWith(path.join(projectDir, '_trash')), res.body.trash_path)
    const trashed: string[] = []
    const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { e.isDirectory() ? await walk(path.join(d, e.name)) : trashed.push(path.join(d, e.name)) } }
    await walk(res.body.trash_path)
    assert.equal(trashed.length, 1)
    assert.equal((await fs.stat(trashed[0]!)).size, before)
    assert.equal((await fs.stat(path.join(imagesDir, 'scene-001.png'))).size, BIG.length, 'the original is untouched')

    // Rebuilds on demand, and a second clear never overwrites the first trashed copy.
    await request(app).get(url).expect(200)
    assert.ok(await thumbCacheBytes(projectDir) > 1000)
    const again = await request(projectsApp).post(clear).expect(200)
    assert.notEqual(again.body.trash_path, res.body.trash_path)
    assert.ok((await fs.stat(res.body.trash_path)).isDirectory())
  })

  test('Clear preview cache on an unknown project is a 404', async () => {
    await request(projectsApp).post('/api/projects/no-such-project/storage/clear-preview-cache').expect(404)
  })
})
