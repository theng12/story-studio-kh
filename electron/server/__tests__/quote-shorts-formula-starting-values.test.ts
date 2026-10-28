/**
 * The Quote Shorts Formula's OWN length and scene rhythm reach the script
 * generator and the Scene Plan timeline (Production defect, 2026-10-29).
 *
 * Observed on the mini (1.4.366), channel "Quiet Longing":
 *   1. the outline job targeted "1 chapters × ~550 words" although the Formula
 *      asks for one 1-minute chapter at 120 wpm (a ~120-word Short) — the
 *      long-form 550 default leaked in because the headless request carried no
 *      `words_per_chapter`;
 *   2. the timeline defaulted to the owner-standard long-form tiers
 *      (5–10 / 10–20 / 20–30 s) instead of the Formula's `visualPacingProfile`
 *      (2–4 s for the first 6 s, then 3–6 s) — Scene Plan builds on the active
 *      preset's pacing, and the only seeded preset was the owner-standard one.
 *
 * What this file pins:
 *   - the Formula's length × pace is the per-chapter target, not 550;
 *   - a long-form Formula keeps its own target (the Shorts rule is data, not a
 *     constant — AGENTS.md §1);
 *   - a new Quote Shorts channel seeds the Formula's two-phase pacing as its
 *     starting value AND as the last-used Scene Plan preset, so a fresh
 *     episode's Timeline build carries it;
 *   - an episode that saved its own rhythm keeps it, and a non-Shorts Formula
 *     with its own tiers is unchanged.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { formulaWordsPerChapter } from '../lib/script-sizing.js'
import { startingDefaultsFromFormula } from '../services/formula-starting-defaults.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const readJson = async (rel: string) => JSON.parse(await fs.readFile(path.join(root, rel), 'utf-8'))

/** The Formula's `visualPacingProfile` as the `variable` pacing shape Scene Plan stores. */
const SHORTS_PACING = {
  mode: 'variable',
  min_sec: 2,
  max_sec: 4,
  periods: [
    { start_sec: 0, end_sec: 6, min_sec: 2, max_sec: 4 },
    { start_sec: 6, end_sec: null, min_sec: 3, max_sec: 6 },
  ],
}

/** The Sleep tiers, to prove a Formula with explicit tiers is unchanged. */
const SLEEP_TIERS = {
  mode: 'variable',
  min_sec: 5,
  max_sec: 10,
  periods: [
    { start_sec: 0, end_sec: 180, min_sec: 5, max_sec: 10 },
    { start_sec: 180, end_sec: 300, min_sec: 10, max_sec: 20 },
    { start_sec: 300, end_sec: 600, min_sec: 20, max_sec: 30 },
    { start_sec: 600, end_sec: null, min_sec: 50, max_sec: 60 },
  ],
}

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: any
let pm: typeof import('../services/project-manager.js')
let slug: string

before(async () => {
  tmp = await useTempDataDir()
  await fs.mkdir(path.join(tmp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  const created = (await request(app).post('/api/projects').send({
    name: 'Quote Shorts Starting Values',
    niche_id: 'quote-shorts',
    formula_choice: 'selected',
    content_language: 'en',
    episode_prefix: 'EP',
    episode_digits: 3,
  }).expect(201)).body
  slug = created.slug
})

after(async () => { await tmp.cleanup() })

describe('the script target comes from the Formula', () => {
  test('Quote Shorts asks for a one-minute, 120-wpm Short', async () => {
    const formula = await readJson('electron/server/niches/quote-shorts.json')
    assert.equal(formula.scriptStructure.defaultChapterCount, 1)
    assert.equal(formula.scriptStructure.defaultLengthMinutes, 1)
    assert.equal(formula.scriptStructure.defaultWordsPerMinute, 120)
    assert.deepEqual(formula.scriptStructure.visualPacingProfile, {
      opening_duration_sec: 6,
      opening: { min_sec: 2, max_sec: 4 },
      settled: { min_sec: 3, max_sec: 6 },
    })
  })

  test('the effective format the generator reads carries the Shorts target, not 550', async () => {
    const { getEffectiveFormat } = await import('../services/format-loader.js')
    const format = await getEffectiveFormat(slug)
    const words = formulaWordsPerChapter({
      minutes: format.script.defaultLengthMinutes,
      wordsPerMinute: format.script.defaultWordsPerMinute,
      chapters: format.script.defaultChapterCount,
    })
    assert.equal(words, 120, '1 minute × 120 wpm ÷ 1 chapter = 120 words')
    assert.notEqual(words, 550, 'the long-form neutral default must not be the Shorts target')
  })

  test('a long-form Formula keeps its own per-chapter target', async () => {
    const formula = await readJson('electron/server/niches/motivation.json')
    const words = formulaWordsPerChapter({
      minutes: formula.scriptStructure.defaultLengthMinutes,
      wordsPerMinute: formula.scriptStructure.defaultWordsPerMinute,
      chapters: formula.scriptStructure.defaultChapterCount,
    })
    assert.equal(words, 625, '25 minutes × 150 wpm ÷ 6 chapters')
  })

  test('a Formula publishing no pace says "unmeasurable" rather than inventing one', () => {
    assert.equal(formulaWordsPerChapter({ minutes: 10, wordsPerMinute: undefined, chapters: 5 }), null)
    assert.equal(formulaWordsPerChapter({ minutes: undefined, wordsPerMinute: 150, chapters: 5 }), null)
    assert.equal(formulaWordsPerChapter({ minutes: 10, wordsPerMinute: 150, chapters: 0 }), null)
  })
})

describe('the scene rhythm starts on the Formula profile', () => {
  test('the Formula profile becomes the channel starting pacing and its own Scene Plan preset', async () => {
    const config = await pm.getConfig(slug) as any
    assert.deepEqual(config.default_scene_pacing, SHORTS_PACING,
      'the channel starts on the 2–4 s opening / 3–6 s settled profile')

    assert.equal(config['scene_plan_last_preset_scene-plan'], 'preset-quote-shorts-pacing',
      'Scene Plan builds on the Formula preset, not the owner-standard long-form tiers')
    const preset = config.scene_plan_presets.find((entry: any) => entry.id === 'preset-quote-shorts-pacing')
    assert.ok(preset, 'the Formula preset is seeded')
    assert.equal(preset.name, 'Quote Shorts formula pacing')
    assert.equal(preset.type, 'scene-plan')
    assert.deepEqual(preset.data.pacing, SHORTS_PACING)
    assert.equal('model' in preset.data, false, 'a model is a live GenStudio choice (§1)')

    // The owner-standard preset stays available by name; nothing was rewritten.
    assert.ok(config.scene_plan_presets.some((entry: any) => entry.name === 'Owner standard pacing'))
  })

  test('a fresh episode planned by Scene Plan resolves the Formula profile', async () => {
    const { resolveScenePlanPacing } = await import('../services/scene-plan-pacing.js')
    const episodeDir = path.join(tmp.dir, 'fresh-episode')
    await fs.mkdir(episodeDir, { recursive: true })
    assert.deepEqual((await resolveScenePlanPacing(slug, episodeDir)).pacing, SHORTS_PACING)
  })

  test('a Timeline build on a fresh episode carries the Formula profile', async () => {
    const im = await import('../services/idea-manager.js')
    const jq = await import('../services/job-queue.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')

    const [idea] = await im.addIdeas(slug, [{
      title: 'The chair by the window', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'test')
    const accepted = await im.acceptIdea(slug, idea!.id, false)
    const code = accepted.episode_code
    const dirs = await resolveEpisodePathsByCode(slug, code)
    await fs.mkdir(dirs.episode_dir, { recursive: true })

    const operationId = '00000000-0000-4000-8000-000000000036'
    let job: any = null
    await jq.setQueuePaused(true)
    try {
      const response = await request(app)
        .post(`/api/projects/${slug}/scene-plan/${code}/run`)
        .send({ stage: 'timeline', operation_id: operationId })
        .expect(201)
      job = response.body
      assert.equal(job.params.resolved_preset?.id, 'preset-quote-shorts-pacing')
      assert.deepEqual(job.params.pacing, SHORTS_PACING,
        'the Timeline job the generator runs carries the Formula pacing, not 5–10/10–20/20–30 s')
    } finally {
      if (job) {
        await jq.requestJobCancellation(slug, job.job_id)
        jq.removeTerminalJob(slug, job.job_id)
      }
      await jq.drainJobPersistenceForShutdown(1_000)
      await jq.setQueuePaused(false)
      await jq.drainJobPersistenceForShutdown(1_000)
    }
  })
})

describe('other Formulas and saved episodes keep their own behaviour', () => {
  test('a non-Shorts Formula with its own tiers is unchanged', async () => {
    const sleep = await readJson('electron/server/niches/sleep.json')
    assert.deepEqual(startingDefaultsFromFormula(sleep).default_scene_pacing, SLEEP_TIERS)
    // A Formula that declares no rhythm still contributes no pacing at all.
    assert.deepEqual(startingDefaultsFromFormula({} as any), {})
  })

  test('an episode that saved its own rhythm keeps it', async () => {
    const { resolveScenePlanPacing } = await import('../services/scene-plan-pacing.js')
    const episodeDir = path.join(tmp.dir, 'episode-own-rhythm')
    await fs.mkdir(episodeDir, { recursive: true })
    await fs.writeFile(path.join(episodeDir, 'continuity.json'), JSON.stringify({
      pacing: { min_sec: 7, max_sec: 11 },
    }))
    assert.deepEqual((await resolveScenePlanPacing(slug, episodeDir)).pacing,
      { min_sec: 7, max_sec: 11, mode: 'live' })
    // …and the channel's starting profile is untouched.
    assert.deepEqual((await pm.getConfig(slug) as any).default_scene_pacing, SHORTS_PACING)
  })
})
