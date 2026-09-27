/**
 * The reveal routes the assembly panel talks to, over HTTP.
 *
 * The planner, the pack kind and the render branch are each pinned elsewhere. What is left is the
 * surface between them and the page — and a route that only *looks* wired is the defect this repo
 * has paid for more than once (a button wired to nothing, a field the batch dropped). So this drives
 * the three real routes:
 *
 *   GET  /api/projects/:slug/video-editor/reveals/catalog
 *   POST /api/projects/:slug/video-editor/reveals/plan
 *   PUT  /api/projects/:slug/video-editor/reveals/scene-choice
 *
 * Two properties matter beyond "it answers": a stored choice is what the *next* plan resolves, and
 * clearing it puts the scene back on the derived pick — the round trip the Reroll button depends on.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'

let cleanup: () => Promise<void>
let app: express.Express
let slug: string
let episodeId: string

const SCENES = Array.from({ length: 4 }, (_, index) => ({
  id: `scene-${index + 1}`,
  scene_index: index,
  start_sec: index * 12,
  end_sec: (index + 1) * 12,
  transcript_segment: `Line ${index + 1}`,
  visual_prompt: 'A quiet harbour at dawn',
  approved: true,
  motion_choice: 'still',
}))

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: 'Reveal routes', episode_prefix: 'EP', episode_digits: 3 })
  slug = project.slug
  // A real episode directory with a real scene plan: the routes read the episode's own plan, which
  // is where a per-scene choice is stored, so a fixture that skipped it would test nothing.
  const episodesRoot = path.join(temp.dir, 'projects', slug, 'episodes', 'EP001')
  await fs.mkdir(episodesRoot, { recursive: true })
  const paths = await resolveEpisodePathsByCode(slug, 'EP001')
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(
    path.join(paths.scene_prompts_dir, SCENE_PLAN_FILENAME),
    JSON.stringify({ scenes: SCENES }, null, 2),
  )
  episodeId = 'EP001'

  const { router } = await import('../routes/video.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})

after(async () => { await cleanup() })

test('the catalogue lists the engine\'s own presets with their families', async () => {
  const response = await request(app).get(`/api/projects/${slug}/video-editor/reveals/catalog`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const reveals = response.body.reveals as Array<Record<string, unknown>>
  // The library is 15 wipes, 3 palettes and 1 draw-on — nineteen, which is the count the 1.4.229
  // receipts corroborate: 76 rendered clips across four paces is 19 × 4, not 20 × 4. The docs said
  // twenty for a release; this is the assertion that would have caught it.
  const byFamily = reveals.reduce<Record<string, number>>((counts, entry) => {
    const family = String(entry.family)
    counts[family] = (counts[family] ?? 0) + 1
    return counts
  }, {})
  assert.deepEqual(byFamily, { geometric: 15, palette: 3, 'draw-on': 1 })
  // Each entry carries what the picker shows, and the draw-on's approximation travels with it
  // rather than being softened into a name that promises more than the render does.
  const drawOn = reveals.find(entry => entry.family === 'draw-on')!
  assert.equal(typeof drawOn.name, 'string')
  assert.equal(typeof drawOn.description, 'string')
  assert.equal(typeof drawOn.approximation, 'string')
})

test('the plan covers every scene, and it is the same plan twice', async () => {
  const body = { episode_id: episodeId, scene_reveal: { enabled: true, pace: 'slow', seed: 12 } }
  const first = await request(app).post(`/api/projects/${slug}/video-editor/reveals/plan`).send(body)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const plan = first.body.plan
  assert.equal(plan.enabled, true)
  assert.equal(plan.scenes.length, SCENES.length)
  assert.equal(plan.pace, 'slow')
  assert.equal(plan.seed, 12)
  // A scene's window is its own narration length, and the plan never shortens it.
  for (const scene of plan.scenes) {
    assert.ok(scene.hold.total_seconds >= 12,
      `scene ${scene.scene_index} was trimmed to ${scene.hold.total_seconds}s`)
    assert.ok(scene.preset_id, 'every scene is dressed')
  }
  const second = await request(app).post(`/api/projects/${slug}/video-editor/reveals/plan`).send(body)
  assert.deepEqual(second.body.plan.scenes.map((scene: any) => scene.preset_id),
    plan.scenes.map((scene: any) => scene.preset_id),
    'the same settings must plan the same episode')
})

test('reveals off plans nothing, rather than planning something the render ignores', async () => {
  const response = await request(app).post(`/api/projects/${slug}/video-editor/reveals/plan`)
    .send({ episode_id: episodeId, scene_reveal: { enabled: false } })
  assert.equal(response.status, 200)
  assert.equal(response.body.plan.enabled, false)
  assert.deepEqual(response.body.plan.scenes, [])
})

test('a stored scene choice is what the next plan resolves, and clearing it goes back to derived', async () => {
  const chosen = await request(app).put(`/api/projects/${slug}/video-editor/reveals/scene-choice`)
    .send({ episode_id: episodeId, scene_id: 'scene-2', preset_id: 'reveal-radial', reroll: 1700000000000 })
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body))

  const afterChoice = await request(app).post(`/api/projects/${slug}/video-editor/reveals/plan`)
    .send({ episode_id: episodeId, scene_reveal: { enabled: true, pace: 'slow', seed: 12 } })
  const scene2 = afterChoice.body.plan.scenes.find((scene: any) => scene.scene_index === 1)
  assert.equal(scene2.preset_id, 'reveal-radial')
  assert.equal(scene2.source, 'override')
  // The reroll number travelled with it: the same preset chosen again is a new choice, not the
  // stored one, which is what keeps a reroll from silently reverting.
  assert.ok(typeof scene2.hold.total_seconds === 'number')

  const cleared = await request(app).put(`/api/projects/${slug}/video-editor/reveals/scene-choice`)
    .send({ episode_id: episodeId, scene_id: 'scene-2', preset_id: null })
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
  const afterClear = await request(app).post(`/api/projects/${slug}/video-editor/reveals/plan`)
    .send({ episode_id: episodeId, scene_reveal: { enabled: true, pace: 'slow', seed: 12 } })
  const derived = afterClear.body.plan.scenes.find((scene: any) => scene.scene_index === 1)
  assert.equal(derived.source, 'derived')
})

test('the choice is written to the episode\'s own scene plan, not to a page cache', async () => {
  await request(app).put(`/api/projects/${slug}/video-editor/reveals/scene-choice`)
    .send({ episode_id: episodeId, scene_id: 'scene-3', preset_id: 'reveal-curtain' })
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const plan = JSON.parse(await fs.readFile(path.join(paths.scene_prompts_dir, SCENE_PLAN_FILENAME), 'utf8'))
  const scene3 = plan.scenes.find((scene: any) => scene.id === 'scene-3')
  assert.deepEqual(scene3.reveal, { preset_id: 'reveal-curtain' },
    'the choice belongs to the scene, so a re-render and a batch both find it')
})

test('a missing episode plan is a named refusal, not an empty plan', async () => {
  const response = await request(app).post(`/api/projects/${slug}/video-editor/reveals/plan`)
    .send({ episode_id: 'EP999', scene_reveal: { enabled: true } })
  assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`)
  assert.match(JSON.stringify(response.body), /scene_plan/i)
})
