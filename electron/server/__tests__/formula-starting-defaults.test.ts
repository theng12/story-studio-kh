/**
 * A NEW channel starts with its Series Formula's look and scene length
 * (Dreamlands test, 2026-10-02: a Sleep channel opened on "Cohesive, grounded"
 * at 1–3 s = thousands of images for a 2-hour episode). The values are copied
 * into the channel's own settings once; an existing channel is never touched.
 *
 * STORY_STUDIO_DATA_DIR must be set (useTempDataDir) before project-manager is
 * imported, same as style-bible-project-default.test.ts.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const readJson = async (rel: string) => JSON.parse(await fs.readFile(path.join(root, rel), 'utf-8'))
const flatFormat = { visualSource: 'continuity-chain', script: {} } as any

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let defaults: typeof import('../services/formula-starting-defaults.js')

describe('formula starting defaults', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    defaults = await import('../services/formula-starting-defaults.js')
  })
  after(async () => { await tmp.cleanup() })

  test('the Sleep formulas carry a soft look and 20–30 s scenes', async () => {
    const legacy = await readJson('electron/server/niches/sleep.json')
    assert.deepEqual(legacy.startingSceneSeconds, [20, 30])
    assert.match(legacy.visualStyleHint, /soft, dreamlike/)
    for (const rel of [
      'content-packs/free-starters/formula/sleep-story-v1.0.1/content/series-formula.json',
      'content-packs/sleep-history/formula/sleep-history-compilation-v1.0.1/content/series-formula.json',
    ]) {
      const doc = await readJson(rel)
      assert.deepEqual(doc.starting_scene_seconds, [20, 30], rel)
      assert.ok(doc.visual_style_hint, rel)
    }
  })

  test('only formulas that set them contribute defaults', async () => {
    assert.deepEqual(defaults.startingDefaultsFromFormula(null), {})
    assert.deepEqual(defaults.startingDefaultsFromFormula({} as any), {})
    const sleep = defaults.startingDefaultsFromFormula(await readJson('electron/server/niches/sleep.json'))
    assert.match(String(sleep.default_style_bible), /soft, dreamlike/)
    assert.deepEqual(sleep.default_scene_pacing, { min_sec: 20, max_sec: 30 })
  })

  test('a new channel gets its Formula\'s pacing, or the owner standard tiers without one', async () => {
    const { resolveScenePlanPacing } = await import('../services/scene-plan-pacing.js')
    const { defaultContinuityConfig } = await import('../routes/continuity.js')

    const fresh = await pm.createProject({ name: 'Dreamlands New', niche_id: 'sleep' } as any)
    await defaults.seedFormulaStartingDefaults(fresh.slug, await readJson('electron/server/niches/sleep.json'))
    const old = await pm.createProject({ name: 'Old Channel' } as any)

    const startingPacing = await defaults.readProjectStartingPacing(fresh.slug)
    assert.deepEqual(startingPacing, { min_sec: 20, max_sec: 30 })
    assert.equal((await pm.getConfig(fresh.slug) as any).default_style_bible.startsWith('soft, dreamlike'), true)
    // A channel with NO Formula is not left on the app-wide default any more:
    // since 2026-10-19 a new channel starts on the owner's standard tiers
    // (project-manager.ts `createProject`). The Formula is the more specific
    // choice and still wins above.
    assert.deepEqual(await defaults.readProjectStartingPacing(old.slug), {
      mode: 'variable',
      min_sec: 5,
      max_sec: 10,
      periods: [
        { start_sec: 0, end_sec: 180, min_sec: 5, max_sec: 10 },
        { start_sec: 180, end_sec: 360, min_sec: 10, max_sec: 20 },
        { start_sec: 360, end_sec: null, min_sec: 20, max_sec: 30 },
      ],
    })
    assert.equal((await pm.getConfig(old.slug) as any).default_style_bible, undefined)

    // What the Scene Plan page shows ("Next build") and what the planner uses.
    assert.deepEqual(defaultContinuityConfig('independent-stills', startingPacing).pacing, { min_sec: 20, max_sec: 30 })
    // An episode with nothing at all still gets the one app-wide default.
    assert.deepEqual(defaultContinuityConfig('independent-stills').pacing, { min_sec: 1, max_sec: 3 })
    const ep = path.join(tmp.dir, 'ep')
    await fs.mkdir(ep, { recursive: true })
    assert.deepEqual((await resolveScenePlanPacing(fresh.slug, ep, flatFormat)).pacing, { min_sec: 20, max_sec: 30, mode: 'live' })
    assert.deepEqual((await resolveScenePlanPacing(old.slug, ep, flatFormat)).pacing, {
      min_sec: 5,
      max_sec: 10,
      mode: 'variable',
      periods: [
        { start_sec: 0, end_sec: 180, min_sec: 5, max_sec: 10 },
        { start_sec: 180, end_sec: 360, min_sec: 10, max_sec: 20 },
        { start_sec: 360, end_sec: null, min_sec: 20, max_sec: 30 },
      ],
    })

    // An episode's own saved pacing still wins.
    await fs.writeFile(path.join(ep, 'continuity.json'), JSON.stringify({ pacing: { min_sec: 5, max_sec: 9 } }))
    assert.deepEqual((await resolveScenePlanPacing(fresh.slug, ep, flatFormat)).pacing, { min_sec: 5, max_sec: 9, mode: 'live' })
  })

  test('creating a channel through the app takes the Formula\'s look and pacing', async () => {
    const { router } = await import('../routes/projects.js')
    const app = express()
    app.use(express.json())
    app.use('/api', router)
    const made = (await request(app).post('/api/projects').send({ name: 'Dreamlands Route', niche_id: 'sleep' }).expect(201)).body
    const config = await pm.getConfig(made.slug) as any
    assert.match(config.default_style_bible, /soft, dreamlike/)
    assert.deepEqual(config.default_scene_pacing, { min_sec: 20, max_sec: 30 })
    // No Formula at all: the owner's standard tiers (2026-10-19), not 1–3 s.
    const plain = (await request(app).post('/api/projects').send({ name: 'No Formula Route' }).expect(201)).body
    assert.deepEqual((await pm.getConfig(plain.slug) as any).default_scene_pacing, {
      mode: 'variable',
      min_sec: 5,
      max_sec: 10,
      periods: [
        { start_sec: 0, end_sec: 180, min_sec: 5, max_sec: 10 },
        { start_sec: 180, end_sec: 360, min_sec: 10, max_sec: 20 },
        { start_sec: 360, end_sec: null, min_sec: 20, max_sec: 30 },
      ],
    })
  })

  test('the content-pack schema accepts the range and rejects a backwards one', async () => {
    const { ContentPackDocumentSchema } = await import('../content-packs/schemas.js')
    const doc = await readJson('content-packs/free-starters/formula/sleep-story-v1.0.1/content/series-formula.json')
    assert.doesNotThrow(() => ContentPackDocumentSchema.parse(doc))
    assert.throws(() => ContentPackDocumentSchema.parse({ ...doc, starting_scene_seconds: [30, 20] }))
  })
})
