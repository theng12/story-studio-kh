/**
 * The finished-video range route is authenticated (owner, 2026-10-29).
 *
 * The Review page plays each final through Story's OWN final-video route, so a
 * phone outside the house must need the session server mode already issues —
 * no key, no bearer and no open range endpoint. This pins the whole path the
 * phone uses: no cookie → 401 (never a byte of the file), the signed cookie →
 * 206 with the requested `Content-Range`, and a HEAD that is refused the same
 * way.
 *
 * The gate is wired exactly as electron/server/app.ts wires it; the first
 * middleware sets the socket peer so the requests are not loopback (loopback
 * bypasses auth by design for the Mac's own window).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const isolated = await useTempDataDir()
process.env.STORY_STUDIO_SERVER_MODE = '1'

const pm = await import('../services/project-manager.js')
const utils = await import('../services/utils.js')
const settings = await import('../services/app-settings.js')
const { buildRequireSession } = await import('../lib/auth-session.js')
const { getServerModeConfig } = await import('../lib/server-mode.js')
const { router: authRouter } = await import('../routes/auth.js')
const { router: videoRouter } = await import('../routes/video.js')
const { router: reviewRouter } = await import('../routes/final-review.js')

const USERNAME = 'owner'
const PASSWORD = 'correct horse battery staple'

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  Object.defineProperty(req, 'ip', { value: String(req.headers['x-test-peer'] || '100.64.0.9') })
  next()
})
app.use('/api', authRouter)
app.use('/api', buildRequireSession(() => getServerModeConfig()?.auth, {
  getKeys: () => getServerModeConfig()?.automation_keys || [],
  onKeyUsed: settings.recordAutomationKeyUse,
}))
app.use('/api', videoRouter)
app.use('/api', reviewRouter)

const PEER = '100.64.0.40'

let fixture: { slug: string; code: string; finalPath: string; size: number }

before(async () => {
  await settings.setAppSetting('library_root', process.env.STORY_STUDIO_DATA_DIR!)
  await settings.setServerModeCredentials({ username: USERNAME, password: PASSWORD })

  const project = await pm.createProject({ name: 'Range Channel', episode_prefix: 'EP' })
  const projectDir = pm.getProjectDir(project.slug)!
  const code = 'EP0001'
  const title = 'Range Story'
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'idea-range',
      title,
      logline: '',
      themes: [],
      suggested_chapters: 1,
      suggested_length: 'short',
      mood: 'calm',
      status: 'accepted',
      episode_code: code,
      generated_at: '2026-01-01T00:00:00.000Z',
      accepted_at: '2026-01-01T00:00:00.000Z',
      batch_id: 'test',
      model_used: 'test',
    }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const paths = await utils.resolveEpisodePaths(project.slug, code, title)
  await fs.mkdir(paths.video_dir, { recursive: true })
  const finalPath = path.join(paths.video_dir, `${code}_final_video.mp4`)
  const bytes = Buffer.alloc(1024, 5)
  await fs.writeFile(finalPath, bytes)
  fixture = { slug: project.slug, code, finalPath, size: bytes.length }
})

after(async () => {
  delete process.env.STORY_STUDIO_SERVER_MODE
  await isolated.cleanup()
})

async function sessionCookie(): Promise<string> {
  const login = await request(app)
    .post('/api/auth/login')
    .set('x-test-peer', PEER)
    .send({ username: USERNAME, password: PASSWORD })
    .expect(200)
  const setCookie = ([] as string[]).concat(login.headers['set-cookie'] || [])
  const cookie = setCookie.find(value => value.startsWith('ssk_session='))
  assert.ok(cookie, 'login must set the session cookie')
  assert.match(cookie!, /HttpOnly/i, 'the session cookie must stay out of reach of page scripts')
  return cookie!.split(';')[0]!
}

function finalUrl(): string {
  return `/api/projects/${encodeURIComponent(fixture.slug)}/video-editor/final-video/${encodeURIComponent(fixture.code)}`
}

test('without a session the final never streams, even with a Range header', async () => {
  const res = await request(app).get(finalUrl()).set('x-test-peer', PEER).set('Range', 'bytes=0-9')
  assert.equal(res.status, 401)
  assert.equal(res.headers['content-range'], undefined)
  assert.equal(res.headers['accept-ranges'], undefined)
})

test('HEAD is refused without a session too', async () => {
  await request(app).head(finalUrl()).set('x-test-peer', PEER).expect(401)
})

test('the signed-in session gets a 206 with exactly the requested bytes', async () => {
  const cookie = await sessionCookie()
  const res = await request(app)
    .get(finalUrl())
    .set('x-test-peer', PEER)
    .set('Cookie', cookie)
    .set('Range', 'bytes=0-9')
    .expect(206)
  assert.equal(res.headers['content-range'], `bytes 0-9/${fixture.size}`)
  assert.equal(res.headers['content-length'], '10')
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal((res.body as Buffer).length, 10)
})

test('a tampered cookie is not a session', async () => {
  const cookie = await sessionCookie()
  const tampered = `${cookie.slice(0, -2)}xx`
  await request(app).get(finalUrl()).set('x-test-peer', PEER).set('Cookie', tampered).expect(401)
})

test('the review list is behind the same session gate', async () => {
  await request(app).get('/api/review/finals').set('x-test-peer', PEER).expect(401)
  const cookie = await sessionCookie()
  const ok = await request(app).get('/api/review/finals').set('x-test-peer', PEER).set('Cookie', cookie).expect(200)
  assert.ok(Array.isArray(ok.body.finals), 'a signed-in session lists finals (empty here)')
})
