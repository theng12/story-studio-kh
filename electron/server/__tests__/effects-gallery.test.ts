/**
 * 1.4.283 — the effects gallery inside Story (owner: "it's just there to see").
 *
 * Each effect and camera move has a 6-second clip, rendered once through the
 * preview cache and reused; Refresh drops exactly those clips; the "In use on
 * this channel" badges come from the channel's batch look.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const bundled = path.join(repoRoot, 'bundled', 'ffmpeg', 'ffmpeg')

let cleanup: () => Promise<void>
let app: any
before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const { setAppSetting } = await import('../services/app-settings.js')
  for (const binary of ['ffmpeg', 'ffprobe'] as const) {
    const file = path.join(repoRoot, 'bundled', 'ffmpeg', binary)
    if (existsSync(file)) await setAppSetting(`${binary}_path`, file)
  }
  ;({ app } = await import('../app.js'))
})
after(async () => { await cleanup() })

/** Read the whole body as bytes, whatever its content type. */
const binary = (res: any, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => done(null, Buffer.concat(chunks)))
}

describe('gallery clips', { skip: !existsSync(bundled) && 'no bundled FFmpeg' }, () => {
  test('an effect and a camera move each get a 6-second clip, rendered once and then reused', async () => {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Gallery clips' })
    const url = (kind: string, id: string) => `/api/projects/${project.slug}/effects-library/-/gallery/${kind}/${id}?v=1`

    const first = Date.now()
    const stars = await request(app).get(url('overlay', 'twinkling-stars')).buffer(true).parse(binary)
    const firstMs = Date.now() - first
    assert.equal(stars.status, 200, String(stars.body))
    assert.equal(stars.headers['content-type'], 'video/mp4')
    assert.ok(stars.body.length > 1000, 'a real clip')

    const again = Date.now()
    const cached = await request(app).get(url('overlay', 'twinkling-stars')).buffer(true).parse(binary)
    assert.ok(cached.body.equals(stars.body), 'the same file is served again')
    assert.ok(Date.now() - again < Math.max(firstMs, 200), 'and is not rendered again')

    const zoom = await request(app).get(url('motion', 'slow-push')).buffer(true).parse(binary)
    assert.equal(zoom.status, 200)
    assert.ok(zoom.body.length > 1000)

    const unknown = await request(app).get(url('overlay', 'no-such-effect'))
    assert.equal(unknown.status, 400)

    // Refresh drops exactly the clips that exist for this scene; the next view renders afresh.
    const refreshed = await request(app).post(`/api/projects/${project.slug}/effects-library/-/gallery/refresh`).send({})
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.body.dropped, 2)
  })
})

test('"In use on this channel" reads the batch look, classic checkboxes included', async () => {
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Gallery in use' })
  const none = await request(app).get(`/api/projects/${project.slug}/effects-library-in-use`)
  assert.deepEqual(none.body, { overlays: [], motions: [], source: null })

  await pm.updateConfig(project.slug, {
    video_bundle_presets: [{ id: 'va', name: 'Assembly', data: { fallback: {
      effects: {
        vignette: { enabled: true, strength: 0.2 },
        scene_effects: { enabled: true, overlays: [{ id: 'rain', enabled: true, params: {} }, { id: 'snow', enabled: false, params: {} }] },
      },
      timeline: { scene_animation: { type: 'ken-burns', pool: ['slow-push', 'pan-left'], randomize_mode: 'per-scene' } },
    } } }],
    video_bundle_last_preset: 'va',
  } as any)
  const res = await request(app).get(`/api/projects/${project.slug}/effects-library-in-use`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.overlays.sort(), ['rain', 'vignette-soft'])
  assert.deepEqual(res.body.motions, ['ken-burns', 'slow-push', 'pan-left'])
  assert.equal(res.body.source, 'Assembly')
})
