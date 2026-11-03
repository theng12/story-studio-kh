/**
 * Scene import in server mode and over the API (owner 2026-11-02).
 *
 * Proves:
 * 1. Server-mode auth: all four scene import routes refuse (401) without sign-in
 *    and work (200) with a session cookie.
 * 2. Browser-harness drop and upload: files are sent as raw HTTP body streams from
 *    the browser File object (no local file path on server disk).
 * 3. Size limits: 8s 1080p clip, 60s 1080p clip, and >10 MB images (PNG & WebP)
 *    upload and save properly without being blocked by 10 MB JSON limits.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

process.env.STORY_STUDIO_SERVER_MODE = '1'

const pm = await import('../services/project-manager.js')
const ideas = await import('../services/idea-manager.js')
const utils = await import('../services/utils.js')
const settings = await import('../services/app-settings.js')
const { buildRequireSession } = await import('../lib/auth-session.js')
const { getServerModeConfig } = await import('../lib/server-mode.js')
const { router: authRouter } = await import('../routes/auth.js')
const { router: sceneReviewRouter } = await import('../routes/scene-review.js')
const { requireProject } = await import('../routes/middleware.js')
const { errorBoundary } = await import('../lib/error-boundary.js')
const { getFFmpegPath } = await import('../services/ffmpeg-manager.js')
const { resolveVideoAssetsDir } = await import('../generators/scene-clip.js')
const { resolveSceneImagesDir } = await import('../generators/scene-image.js')

const USERNAME = 'owner'
const PASSWORD = 'correct horse battery staple'
const PEER = '100.64.0.40'

let isolated: { cleanup: () => Promise<void> }
let app: express.Express
let server: http.Server
let serverBaseUrl: string
let workDir: string
let ffmpeg: string

let fixture: {
  slug: string
  episodeId: string
  paths: any
  planPath: string
}

before(async () => {
  isolated = await useTempDataDir()
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-import-server-mode-'))
  ffmpeg = await getFFmpegPath()

  await settings.setAppSetting('library_root', process.env.STORY_STUDIO_DATA_DIR!)
  await settings.setServerModeCredentials({ username: USERNAME, password: PASSWORD })

  app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: String(req.headers['x-test-peer'] || PEER) })
    next()
  })
  app.use('/api', authRouter)
  app.use('/api', buildRequireSession(() => getServerModeConfig()?.auth, {
    getKeys: () => getServerModeConfig()?.automation_keys || [],
    onKeyUsed: settings.recordAutomationKeyUse,
    allowLocalBypass: false,
  }))
  app.use('/api/projects/:slug', requireProject)
  app.use('/api', sceneReviewRouter)
  app.use(errorBoundary)

  server = http.createServer(app)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      serverBaseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })

  // Create test project and episode with a 2-scene plan
  const project = await pm.createProject({ name: 'Server Mode Import Channel', episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Server Mode Import Episode', logline: 'Testing server mode scene import.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await utils.resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    scenes: [
      { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8, approved: true, visual_prompt: 'Archive hall.', motion_prompt: 'Slow drift forward.' },
      { id: 'scene-b', scene_index: 2, start_sec: 8, end_sec: 68, approved: true, visual_prompt: 'Grand gallery.', motion_prompt: 'Slow pan across gallery.' },
    ],
  }))

  fixture = { slug: project.slug, episodeId: accepted.episode_code, paths, planPath }
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  delete process.env.STORY_STUDIO_SERVER_MODE
  await isolated.cleanup()
  const trashWork = path.join(process.env.STORY_STUDIO_DATA_DIR ?? os.tmpdir(), '_trash', 'scene-import-server-mode-work')
  await fs.mkdir(path.dirname(trashWork), { recursive: true }).catch(() => {})
  await fs.rename(workDir, trashWork).catch(() => {})
})

async function getSessionCookie(): Promise<string> {
  const login = await request(app)
    .post('/api/auth/login')
    .set('x-test-peer', PEER)
    .send({ username: USERNAME, password: PASSWORD })
    .expect(200)
  const setCookie = ([] as string[]).concat(login.headers['set-cookie'] || [])
  const cookie = setCookie.find(value => value.startsWith('ssk_session='))
  assert.ok(cookie, 'login must set ssk_session cookie')
  return cookie.split(';')[0]!
}

describe('1. Server-mode authentication on scene import routes', () => {
  test('all four scene import routes refuse unauthenticated requests with 401', async () => {
    const handoffRes = await request(app)
      .get(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/import-handoff`)
      .set('x-test-peer', PEER)
    assert.equal(handoffRes.status, 401)
    assert.equal(handoffRes.body.detail, 'Authentication required')

    const matchRes = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/match-import-files`)
      .set('x-test-peer', PEER)
      .send({ files: [{ name: 'clip_01.mp4' }] })
    assert.equal(matchRes.status, 401)
    assert.equal(matchRes.body.detail, 'Authentication required')

    const uploadClipRes = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-clip/scene-a`)
      .set('x-test-peer', PEER)
      .set('Content-Type', 'video/mp4')
      .send(Buffer.from('fake-video-bytes'))
    assert.equal(uploadClipRes.status, 401)
    assert.equal(uploadClipRes.body.detail, 'Authentication required')

    const uploadImageRes = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-image/scene-a`)
      .set('x-test-peer', PEER)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fake-image-bytes'))
    assert.equal(uploadImageRes.status, 401)
    assert.equal(uploadImageRes.body.detail, 'Authentication required')
  })

  test('all four scene import routes succeed with a valid session cookie', async () => {
    const cookie = await getSessionCookie()

    // 1. GET import-handoff
    const handoffRes = await request(app)
      .get(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/import-handoff`)
      .set('x-test-peer', PEER)
      .set('Cookie', cookie)
      .expect(200)
    assert.ok(Array.isArray(handoffRes.body.scenes_needing_clips))
    assert.ok(Array.isArray(handoffRes.body.scenes_needing_images))

    // 2. POST match-import-files
    const matchRes = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/match-import-files`)
      .set('x-test-peer', PEER)
      .set('Cookie', cookie)
      .send({ files: [{ name: 'clip_01.mp4' }, { name: 'scene-b.png' }] })
      .expect(200)
    assert.equal(matchRes.body.matched.length, 2)
    assert.equal(matchRes.body.matched[0].scene_id, 'scene-a')
    assert.equal(matchRes.body.matched[1].scene_id, 'scene-b')

    // 3. POST upload-clip
    const testClipPath = path.join(workDir, 'auth-test-clip.mp4')
    await promisify(execFile)(ffmpeg, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x48:r=10:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', testClipPath,
    ])
    const clipBytes = await fs.readFile(testClipPath)
    const uploadClipRes = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-clip/scene-a`)
      .set('x-test-peer', PEER)
      .set('Cookie', cookie)
      .set('Content-Type', 'video/mp4')
      .set('X-File-Name', 'auth-test-clip.mp4')
      .send(clipBytes)
      .expect(200)
    assert.equal(uploadClipRes.body.ok, true)
    assert.equal(uploadClipRes.body.scene_id, 'scene-a')

    // 4. POST upload-image (raw bytes)
    const testImgPath = path.join(workDir, 'auth-test-image.png')
    await promisify(execFile)(ffmpeg, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=green:s=64x48:d=1',
      '-frames:v', '1', testImgPath,
    ])
    const imgBytes = await fs.readFile(testImgPath)
    const uploadImageRes = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-image/scene-a`)
      .set('x-test-peer', PEER)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .set('X-File-Name', 'auth-test-image.png')
      .send(imgBytes)
      .expect(200)
    assert.equal(uploadImageRes.body.ok, true)
    assert.equal(uploadImageRes.body.scene_id, 'scene-a')
  })
})

describe('2. Browser-harness drop and upload against server mode over HTTP', () => {
  test('browser File objects stream raw bytes over HTTP without server disk paths', async () => {
    const cookie = await getSessionCookie()

    // Generate real media files simulating files selected in the user's remote browser
    const clientClipPath = path.join(workDir, 'browser-drop-clip.mp4')
    await promisify(execFile)(ffmpeg, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=purple:s=160x120:r=15:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clientClipPath,
    ])
    const clipBytes = await fs.readFile(clientClipPath)

    const clientImgPath = path.join(workDir, 'browser-drop-image.png')
    await promisify(execFile)(ffmpeg, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=yellow:s=160x120:d=1',
      '-frames:v', '1', clientImgPath,
    ])
    const imgBytes = await fs.readFile(clientImgPath)

    // In a browser, File objects contain only filename, size, type, and binary data.
    // They have NO knowledge of server disk paths.
    const browserFiles = [
      new File([clipBytes], 'scene-a.mp4', { type: 'video/mp4' }),
      new File([imgBytes], 'scene-b.png', { type: 'image/png' }),
    ]

    // Step 1: Match files via API over HTTP
    const matchResponse = await fetch(`${serverBaseUrl}/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/match-import-files`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: browserFiles.map(f => ({ name: f.name })) }),
    })
    assert.equal(matchResponse.status, 200)
    const matchResult = await matchResponse.json()
    assert.equal(matchResult.matched.length, 2)
    assert.equal(matchResult.matched[0].scene_id, 'scene-a')
    assert.equal(matchResult.matched[1].scene_id, 'scene-b')

    // Step 2: Upload clip over HTTP with raw bytes stream (matching confirmImport in scene-import.vue)
    const clipFile = browserFiles[0]!
    const clipUploadUrl = `${serverBaseUrl}/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-clip/${matchResult.matched[0].scene_id}`
    const clipUploadResponse = await fetch(clipUploadUrl, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': clipFile.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(clipFile.name),
      },
      body: clipFile,
    })
    assert.equal(clipUploadResponse.status, 200)
    const clipJson = await clipUploadResponse.json()
    assert.equal(clipJson.ok, true)
    assert.equal(clipJson.scene_id, 'scene-a')

    // Verify clip was saved in the episode's Video Assets folder on server
    const clipsDir = await resolveVideoAssetsDir(fixture.slug, fixture.episodeId, fixture.paths.episode_dir)
    const savedClipPath = path.join(clipsDir, 'scene-a.mp4')
    const savedClipStat = await fs.stat(savedClipPath)
    assert.ok(savedClipStat.isFile() && savedClipStat.size > 0, 'clip must be saved to disk')

    // Step 3: Upload image over HTTP with raw bytes stream (matching confirmImport in scene-import.vue)
    const imgFile = browserFiles[1]!
    const imgUploadUrl = `${serverBaseUrl}/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-image/${matchResult.matched[1].scene_id}`
    const imgUploadResponse = await fetch(imgUploadUrl, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': imgFile.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(imgFile.name),
      },
      body: imgFile,
    })
    assert.equal(imgUploadResponse.status, 200)
    const imgJson = await imgUploadResponse.json()
    assert.equal(imgJson.ok, true)
    assert.equal(imgJson.scene_id, 'scene-b')

    // Verify image was saved in the episode's scene-images folder as scene-b.png
    const imagesDir = await resolveSceneImagesDir(fixture.slug, fixture.episodeId, fixture.paths.episode_dir)
    const savedImgPath = path.join(imagesDir, 'scene-b.png')
    const savedImgStat = await fs.stat(savedImgPath)
    assert.ok(savedImgStat.isFile() && savedImgStat.size > 0, 'image must be saved to disk')

    // Confirm that nothing in the page or routes sends a local file path for the server to read
    const rootDir = path.resolve(import.meta.dirname, '../../../')
    const pageSource = await fs.readFile(
      path.join(rootDir, 'frontend/pages/projects/[slug]/scene-import.vue'),
      'utf-8',
    )
    assert.doesNotMatch(pageSource, /file\.path|local_path|server_path|filePath/i, 'scene-import.vue must never send local file paths')
  })
})

describe('3. Size limits: 8s 1080p clip, 60s 1080p clip, and >10 MB images', () => {
  test('an 8 s 1080p clip at realistic bitrate uploads and saves', async () => {
    const cookie = await getSessionCookie()
    const clip8sPath = path.join(workDir, 'clip-8s-1080p.mp4')
    await promisify(execFile)(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30',
      '-t', '8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '4M',
      clip8sPath,
    ])
    const bytes = await fs.readFile(clip8sPath)
    assert.ok(bytes.length > 1024 * 1024, `8s 1080p clip must be substantial: ${bytes.length} bytes`)

    const res = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-clip/scene-a`)
      .set('x-test-peer', PEER)
      .set('Cookie', cookie)
      .set('Content-Type', 'video/mp4')
      .set('X-File-Name', 'clip-8s-1080p.mp4')
      .send(bytes)
      .expect(200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.scene_id, 'scene-a')
    assert.ok(res.body.duration_seconds >= 7.9 && res.body.duration_seconds <= 8.1)
  })

  test('a 60 s 1080p clip at realistic bitrate uploads and saves', async () => {
    const cookie = await getSessionCookie()
    const clip60sPath = path.join(workDir, 'clip-60s-1080p.mp4')
    await promisify(execFile)(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30',
      '-t', '60',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '4M',
      clip60sPath,
    ])
    const bytes = await fs.readFile(clip60sPath)
    assert.ok(bytes.length > 5 * 1024 * 1024, `60s 1080p clip must be substantial: ${bytes.length} bytes`)

    const res = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-clip/scene-b`)
      .set('x-test-peer', PEER)
      .set('Cookie', cookie)
      .set('Content-Type', 'video/mp4')
      .set('X-File-Name', 'clip-60s-1080p.mp4')
      .send(bytes)
      .expect(200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.scene_id, 'scene-b')
    assert.ok(res.body.duration_seconds >= 59.9 && res.body.duration_seconds <= 60.1)
  })

  test('a PNG image over 10 MB uploads and saves as <scene_id>.png', async () => {
    const cookie = await getSessionCookie()
    const largePngPath = path.join(workDir, 'large-noise-image.png')
    // Generate high-entropy noise image exceeding 10 MB
    await promisify(execFile)(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'nullsrc=s=2500x2000,geq=random(1)*255:random(2)*255:random(3)*255',
      '-frames:v', '1',
      largePngPath,
    ])
    const bytes = await fs.readFile(largePngPath)
    assert.ok(bytes.length > 10 * 1024 * 1024, `image must exceed 10 MB: ${bytes.length} bytes`)

    const res = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-image/scene-a`)
      .set('x-test-peer', PEER)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .set('X-File-Name', 'large-noise-image.png')
      .send(bytes)
      .expect(200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.scene_id, 'scene-a')

    const imagesDir = await resolveSceneImagesDir(fixture.slug, fixture.episodeId, fixture.paths.episode_dir)
    const savedPath = path.join(imagesDir, 'scene-a.png')
    const savedBytes = await fs.readFile(savedPath)
    assert.equal(savedBytes.length, bytes.length, 'saved bytes on server must match uploaded bytes exactly')
  })

  test('a WebP image over 10 MB uploads and saves as <scene_id>.png', async () => {
    const cookie = await getSessionCookie()
    // Construct a valid WebP container exceeding 10 MB (11 MB)
    const largeWebp = Buffer.alloc(11 * 1024 * 1024)
    largeWebp.write('RIFF', 0, 'ascii')
    largeWebp.writeUInt32LE(largeWebp.length - 8, 4)
    largeWebp.write('WEBPVP8 ', 8, 'ascii')
    largeWebp.writeUInt32LE(largeWebp.length - 20, 12)
    // Keyframe header
    largeWebp[16] = 0x9d
    largeWebp[17] = 0x01
    largeWebp[18] = 0x2a

    assert.ok(largeWebp.length > 10 * 1024 * 1024, `WebP must exceed 10 MB: ${largeWebp.length} bytes`)

    const res = await request(app)
      .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-image/scene-b`)
      .set('x-test-peer', PEER)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/webp')
      .set('X-File-Name', 'large-asset.webp')
      .send(largeWebp)
      .expect(200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.scene_id, 'scene-b')

    const imagesDir = await resolveSceneImagesDir(fixture.slug, fixture.episodeId, fixture.paths.episode_dir)
    const savedPath = path.join(imagesDir, 'scene-b.png')
    const savedBytes = await fs.readFile(savedPath)
    assert.equal(savedBytes.length, largeWebp.length, 'saved WebP bytes on server must match uploaded bytes')
  })

  test('an image over 10 MB uploads in browser harness over HTTP fetch', async () => {
    const cookie = await getSessionCookie()
    const largePngPath = path.join(workDir, 'large-noise-image.png')
    const bytes = await fs.readFile(largePngPath)
    assert.ok(bytes.length > 10 * 1024 * 1024)

    const file = new File([bytes], 'large-browser-image.png', { type: 'image/png' })
    const url = `${serverBaseUrl}/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-image/scene-a`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': file.type,
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    })
    assert.equal(response.status, 200)
    const json = await response.json()
    assert.equal(json.ok, true)
    assert.equal(json.scene_id, 'scene-a')
  })
})
