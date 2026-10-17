import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'

// Must be set before ../app.js is imported so the throwaway server does not listen.
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

/**
 * Scene images are legitimately JPEG bytes under `{scene_id}.png`: the gateway
 * relays the provider's own format (an older node ignores `output_format`), and
 * the owner's "smaller files" choice re-encodes PNG to JPEG in place under the
 * same name. Reported 2026-10-17 from production: PR0007/DM0002
 * `05 Scene Images/*-scene-0001.png` began `ff d8 ff e0` and the preview route
 * served them as `image/png` because it took the type from the extension.
 *
 * These pin the bytes-first rule where the app speaks about the format, and pin
 * that valid bytes are served unchanged.
 */

let cleanup: () => Promise<void>
let app: unknown
let pm: typeof import('../services/project-manager.js')
let slug = ''
let root = ''
let outsideDir = ''

async function imageBytes(format: 'jpeg' | 'png' | 'webp'): Promise<Buffer> {
  const pipeline = sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 34, b: 56 } } })
  if (format === 'jpeg') return pipeline.jpeg({ quality: 80 }).toBuffer()
  if (format === 'webp') return pipeline.webp().toBuffer()
  return pipeline.png().toBuffer()
}

// The canonical 43-byte 1x1 GIF: the byte sniffer does not know GIF, so this is
// the extension-fallback path.
const GIF_1X1 = Buffer.from(
  '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b',
  'hex',
)

async function fixture(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(root, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
  return file
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  ;({ app } = await import('../app.js'))
  const project = await pm.createProject({ name: 'Image content format' })
  slug = project.slug
  root = (await pm.getProjectOutputRoot(slug)) || path.join(pm.projectsRoot(), String(slug))
  await fs.mkdir(root, { recursive: true })
  // Deliberately OUTSIDE the temp data dir (the Library) — the R1 containment case.
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-image-format-outside-'))
})

after(async () => {
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {})
  await cleanup()
})

test('preview-image serves a JPEG saved under a .png name as image/jpeg, byte for byte', async () => {
  const jpeg = await imageBytes('jpeg')
  const file = await fixture('scene_images/scene-0001.png', jpeg)
  assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'fixture is a real JPEG')

  const response = await request(app as any)
    .get(`/api/projects/${slug}/video-editor/preview-image`)
    .query({ path: file })

  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.headers['content-type'], 'image/jpeg',
    'the bytes are JPEG, so the declared type must be JPEG even though the name says .png')
  assert.ok(Buffer.from(response.body).equals(jpeg), 'the served bytes are unchanged')
})

test('preview-image still serves a real PNG as image/png', async () => {
  const png = await imageBytes('png')
  const file = await fixture('scene_images/scene-0002.png', png)

  const response = await request(app as any)
    .get(`/api/projects/${slug}/video-editor/preview-image`)
    .query({ path: file })

  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'image/png')
  assert.ok(Buffer.from(response.body).equals(png))
})

test('preview-image keeps a GIF served as image/gif (the sniffer does not know GIF)', async () => {
  const file = await fixture('scene_images/scene-0003.gif', GIF_1X1)

  const response = await request(app as any)
    .get(`/api/projects/${slug}/video-editor/preview-image`)
    .query({ path: file })

  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'image/gif', 'the extension fallback still answers for GIF')
  assert.ok(Buffer.from(response.body).equals(GIF_1X1))
})

test('preview-image refuses an extension that is not an image, before reading it', async () => {
  const jpeg = await imageBytes('jpeg')
  const file = await fixture('scene_images/probe.bin', jpeg)

  const response = await request(app as any)
    .get(`/api/projects/${slug}/video-editor/preview-image`)
    .query({ path: file })

  assert.equal(response.status, 403, 'real JPEG bytes under a non-image name are still not previewable')
})

test('imageMediaTypeForFile reads the header, not the name', async () => {
  const { imageMediaTypeForFile, imageMediaTypeForFilename } = await import('../lib/image-media-type.js')
  const jpeg = await imageBytes('jpeg')
  const png = await imageBytes('png')
  const named = await fixture('scene_images/scene-0004.png', jpeg)

  assert.equal(await imageMediaTypeForFile(named), 'image/jpeg')
  assert.equal(await imageMediaTypeForFile(await fixture('scene_images/scene-0005.png', png)), 'image/png')
  assert.equal(await imageMediaTypeForFile(await fixture('scene_images/scene-0006.gif', GIF_1X1)), 'image/gif')
  assert.equal(await imageMediaTypeForFile(await fixture('scene_images/scene-0007.png', Buffer.from('not an image'))), 'image/png',
    'unknown bytes fall back to the name, as before')
  assert.equal(imageMediaTypeForFilename('scene_images/probe.bin'), '')
})

// ── R1: containment runs before the media-type read (2026-10-17 review) ─────

test('thumbnail-reference/analyze refuses an out-of-scope path before reading it (R1)', async () => {
  const jpeg = await imageBytes('jpeg')
  const outside = path.join(outsideDir, 'private-scene.png')
  await fs.writeFile(outside, jpeg)

  const response = await request(app as any)
    .post(`/api/projects/${slug}/thumbnail-reference/analyze`)
    .send({ source_path: outside, model_id: 'any-model' })

  assert.equal(response.status, 403,
    'an out-of-scope source_path is refused before any header read, gateway call or type oracle')
})

// ── R2: preview-media uses the shared helper for images, keeps the video map ─

test('preview-media serves a JPEG saved under a .png name as image/jpeg (R2)', async () => {
  const jpeg = await imageBytes('jpeg')
  const file = await fixture('scene_images/scene-0010.png', jpeg)

  const response = await request(app as any)
    .get(`/api/projects/${slug}/video-editor/preview-media`)
    .query({ path: file })

  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.headers['content-type'], 'image/jpeg',
    'preview-media must read the bytes for image types, not the .png name')
  assert.ok(Buffer.from(response.body).equals(jpeg), 'the streamed bytes are unchanged')
})

test('preview-media still serves an .mp4 as video/mp4 (R2: the video map is kept)', async () => {
  const file = await fixture('scene_images/clip-0001.mp4', Buffer.from('not a real mp4'))

  const response = await request(app as any)
    .get(`/api/projects/${slug}/video-editor/preview-media`)
    .query({ path: file })

  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'video/mp4',
    'video types keep their extension map and are not routed through the image helper')
})

// ── R3: the declared upload type sniffs the bytes for every format ──────────

test('videoSourceMediaType reads the bytes first: WebP under a .png name declares image/webp (R3)', async () => {
  const { videoSourceMediaType } = await import('../lib/genstudio-client.js')
  const webp = await imageBytes('webp')
  const png = await imageBytes('png')
  const jpeg = await imageBytes('jpeg')

  assert.equal(videoSourceMediaType('scene-0011.png', webp), 'image/webp',
    'a WebP saved under .png must declare WebP, matching the accepted-types check and the stored record')
  assert.equal(videoSourceMediaType('scene-0012.png', jpeg), 'image/jpeg')
  assert.equal(videoSourceMediaType('scene-0013.png', png), 'image/png')
  assert.equal(videoSourceMediaType('scene-0014.png', GIF_1X1), 'image/png',
    'the sniffer does not know GIF, so the name still answers')
  assert.equal(videoSourceMediaType('scene-0015.png'), 'image/png', 'no bytes: the name answers, as before')
})

// ── sibling: the image-preview cache serves the provider's real format ───────

test('image-preview-cache serves the provider format, not a hardcoded image/png (sibling)', async () => {
  const { savePreview } = await import('../services/image-preview-cache.js')
  const jpeg = await imageBytes('jpeg')
  const saved = await savePreview({ prompt: 'sibling format', modelId: 'm', aspectRatio: '1:1', imageBytes: jpeg })

  const response = await request(app as any).get(`/api/image-preview-cache/${saved.hash}`)

  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.headers['content-type'], 'image/jpeg',
    'the cached bytes are JPEG, so the declared type must be JPEG even though the file is named .png')
  assert.ok(Buffer.from(response.body).equals(jpeg), 'the cached bytes are unchanged')
})
