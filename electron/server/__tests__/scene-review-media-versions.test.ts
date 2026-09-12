/**
 * Scene Review media freshness (v1.4.152).
 *
 * The page used one page-wide cache-buster that changed on every 3.5 s poll,
 * so every visible thumbnail was destroyed, re-keyed and re-fetched — 71 times
 * per image in one measured session. The review payload now names each asset's
 * own `size-mtime` version; the media routes treat a versioned URL as
 * immutable and an unversioned one as uncacheable, exactly as before.
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

// A real, fully decodable PNG: the review only counts an image it can decode.
let PNG: Buffer

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const sharp = (await import('sharp')).default
  PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer()
  pm = await import('../services/project-manager.js')
  ;({ resolveEpisodePathsByCode, resolveEpisodePathsByCodeWithSidecar } = await import('../services/utils.js'))
  ;({ resolveSceneImagesDir } = await import('../generators/scene-image.js'))
  const { router } = await import('../routes/scene-review.js')
  app = express()
  app.use('/api', router)
})
after(async () => { await cleanup() })

async function seedEpisode(name: string, sceneCount: number) {
  const project = await pm.createProject({ name })
  const episodeId = 'EP007'
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const scenes = Array.from({ length: sceneCount }, (_, i) => ({
    id: `scene-${String(i + 1).padStart(3, '0')}`, scene_index: i + 1, start_sec: i, end_sec: i + 1,
    transcript_segment: 'words', visual_prompt: `Prompt ${i + 1}`, approved: false,
  }))
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes }))
  const routePaths = await resolveEpisodePathsByCodeWithSidecar(project.slug, episodeId, 'scene_plan.json')
  const imagesDir = await resolveSceneImagesDir(project.slug, episodeId, routePaths.episode_dir)
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.mkdir(routePaths.merged_audio_dir, { recursive: true })
  return { project, episodeId, imagesDir, routePaths }
}

describe('Scene Review media versions', () => {
  test('each scene carries its own image version; only a replaced image changes it', async () => {
    const { project, episodeId, imagesDir, routePaths } = await seedEpisode('Media versions', 3)
    await fs.writeFile(path.join(imagesDir, 'scene-001.png'), PNG)
    await fs.writeFile(path.join(imagesDir, 'scene-002.png'), Buffer.from('not a png'))
    await fs.writeFile(path.join(routePaths.merged_audio_dir, 'EP007_merged_audio.mp3'), Buffer.from('audio bytes'))

    const first = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}`).expect(200)
    const [one, two, three] = first.body.scenes
    assert.match(one.image_version, /^\d+-\d+$/)
    assert.equal(one.image_filename, 'scene-001.png')
    assert.equal(two.image_version, null, 'an undecodable file is not an image and has no version')
    assert.equal(two.image_filename, null)
    assert.equal(three.image_version, null)
    assert.equal(one.clip_version, null)
    assert.match(first.body.audio_version, /^\d+-\d+$/)
    assert.equal(first.body.stats.with_image, 1)

    // Unchanged on disk: a second read reports the same versions.
    const second = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}`).expect(200)
    assert.equal(second.body.scenes[0].image_version, one.image_version)
    assert.equal(second.body.audio_version, first.body.audio_version)

    // Replaced (same bytes, later mtime): the version moves.
    const later = new Date(Date.now() + 10_000)
    await fs.utimes(path.join(imagesDir, 'scene-001.png'), later, later)
    const third = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}`).expect(200)
    assert.notEqual(third.body.scenes[0].image_version, one.image_version)
  })

  test('a corrupt named copy still falls back to a good legacy copy', async () => {
    const { project, episodeId, imagesDir, routePaths } = await seedEpisode('Legacy fallback', 2)
    const legacyDir = path.join(routePaths.episode_dir, 'scene_images')
    await fs.mkdir(legacyDir, { recursive: true })
    // scene-001: truncated in the named folder, intact in the legacy folder.
    await fs.writeFile(path.join(imagesDir, 'scene-001.png'), PNG.subarray(0, 24))
    await fs.writeFile(path.join(legacyDir, 'scene-001.png'), PNG)
    // scene-002: only a legacy copy.
    await fs.writeFile(path.join(legacyDir, 'scene-002.png'), PNG)
    for (let pass = 0; pass < 2; pass++) {
      const review = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeId}`).expect(200)
      assert.equal(review.body.scenes[0].image_filename, 'scene-001.png', `pass ${pass}: legacy twin counts`)
      assert.match(review.body.scenes[0].image_version, /^\d+-\d+$/)
      assert.equal(review.body.scenes[1].image_filename, 'scene-002.png')
      assert.equal(review.body.stats.with_image, 2)
    }
  })

  test('a versioned media URL is immutable; an unversioned one is never cached', async () => {
    const { project, episodeId, imagesDir, routePaths } = await seedEpisode('Media caching', 1)
    await fs.writeFile(path.join(imagesDir, 'scene-001.png'), PNG)
    await fs.writeFile(path.join(routePaths.merged_audio_dir, 'EP007_merged_audio.mp3'), Buffer.from('audio bytes'))
    const base = `/api/projects/${project.slug}/scene-review/${episodeId}`

    const versioned = await request(app).get(`${base}/image/scene-001?v=1-2`).expect(200)
    assert.equal(versioned.headers['cache-control'], 'private, max-age=31536000, immutable')
    assert.equal(versioned.headers['content-length'], undefined, 'chunked: a mid-render replacement must not abort the response')
    const plain = await request(app).get(`${base}/image/scene-001`).expect(200)
    assert.equal(plain.headers['cache-control'], 'no-store')

    const audioVersioned = await request(app).get(`${base}/audio?v=3-4`).expect(200)
    assert.equal(audioVersioned.headers['cache-control'], 'private, max-age=31536000, immutable')
    const audioPlain = await request(app).get(`${base}/audio`).expect(200)
    assert.equal(audioPlain.headers['cache-control'], 'no-store')
  })

  test('scene probes run in parallel, not one awaited file check after another', async () => {
    const source = await fs.readFile(new URL('../routes/scene-review.ts', import.meta.url), 'utf8')
    const start = source.indexOf("router.get('/projects/:slug/scene-review/:episodeId'")
    const end = source.indexOf('router.post(', start)
    const handler = source.slice(start, end)
    assert.match(handler, /mapWithConcurrency\(plan\.scenes, SCENE_STAT_CONCURRENCY/)
    assert.match(handler, /SCENE_DECODE_CONCURRENCY,/)
    assert.match(source, /const SCENE_DECODE_CONCURRENCY = 4\n/, 'full pixel decodes stay narrow in the main process')
    assert.doesNotMatch(handler, /for \(const s of plan\.scenes\) \{\s*\n\s*const filename[\s\S]*?await isDecodableImage/)
  })
})
