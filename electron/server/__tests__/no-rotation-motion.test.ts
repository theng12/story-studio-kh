/**
 * 1.4.280 — owner rule 2026-10-11: "we don't want no rotation at all. it's bad."
 *
 * Rotation camera moves stay in the registry so old saved presets still load, but no scene is ever
 * rendered with one and the Video Assembly picker never offers one.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { BUILT_IN_SCENE_MOTIONS, isRotationMotion } from '../contracts/scene-effect-presets.js'
import { DEFAULT_STILL_CAMERA_MOVE, resolveVideoAssemblySceneAnimation } from '../generators/video.js'

let cleanup: () => Promise<void>
let app: any
let slug = ''

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  const pm = await import('../services/project-manager.js')
  slug = (await pm.createProject({ name: 'No Rotation' })).slug
})

after(async () => { await cleanup?.() })

const ROTATIONS = BUILT_IN_SCENE_MOTIONS.filter(m => isRotationMotion(m)).map(m => m.id)

test('rotate-cw and rotate-ccw are the rotation moves; zooms, pans and b-roll modes are not', () => {
  assert.deepEqual(ROTATIONS.sort(), ['rotate-ccw', 'rotate-cw'])
  for (const id of ['ken-burns', 'pan-left', 'breathe', 'none', 'static', 'zoom-in']) assert.equal(isRotationMotion(id), false, id)
  assert.equal(isRotationMotion('com.example.pack.rotate-slow'), true)
})

test('a random pool that still lists a rotation never picks one', () => {
  for (const mode of ['single', 'per-scene'] as const) {
    for (let seed = 1; seed <= 40; seed++) {
      const resolved = resolveVideoAssemblySceneAnimation({
        scene_animation: { type: 'ken-burns' },
        animation_pool: ['rotate-cw', 'pan-left', 'rotate-ccw', 'breathe'],
        animation_randomize: mode,
        animation_seed: seed,
      } as any, 12)
      assert.equal(resolved.picks.some(id => isRotationMotion(id)), false, `${mode} seed ${seed}: ${resolved.picks}`)
    }
  }
})

test('an old preset whose camera move or whole pool is a rotation renders the slow zoom', () => {
  const primary = resolveVideoAssemblySceneAnimation({ scene_animation: { type: 'rotate-cw' } } as any, 3)
  assert.deepEqual(primary.picks, [DEFAULT_STILL_CAMERA_MOVE, DEFAULT_STILL_CAMERA_MOVE, DEFAULT_STILL_CAMERA_MOVE])
  const pool = resolveVideoAssemblySceneAnimation({
    scene_animation: { type: 'pan-left' }, animation_pool: ['rotate-cw', 'rotate-ccw'], animation_randomize: 'per-scene',
  } as any, 2)
  assert.deepEqual(pool.picks, ['pan-left', 'pan-left'])
})

test('the Video Assembly motion picker does not offer rotation', async () => {
  const res = await request(app).get(`/api/projects/${slug}/video-editor/animations/catalog`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const ids = res.body.animations.map((a: any) => a.id)
  assert.ok(ids.includes('ken-burns'))
  assert.equal(ids.some((id: string) => isRotationMotion(id)), false, ids.join(','))
})
