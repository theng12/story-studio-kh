/**
 * A NEW channel starts on the owner's standard tiered scene rhythm (owner
 * decision, 2026-10-19): 0–180 s a new scene every 5–10 s, 180–360 s every
 * 10–20 s, after 360 s every 20–30 s.
 *
 * Seeded once, at creation, into the channel's own settings — `config.json`
 * `default_scene_pacing` (the pacing an episode starts with until it saves its
 * own; what Scene Plan plans on and what the Visual timing & motion panel shows
 * it) plus a Scene Plan preset of the same rhythm named "Owner standard pacing"
 * and marked last-used.
 *
 * What this file pins:
 *   - a new channel starts on the tiers, and its first episode reads them back;
 *   - the seeded preset is what the product's own resolver treats as active;
 *   - an existing channel is NEVER rewritten — creating a channel leaves another
 *     channel's config byte-identical, and a channel that predates the seed
 *     keeps the one app-wide default;
 *   - an episode still overrides the channel's rhythm, through the same
 *     `claim_pacing` save boundary every other rhythm change goes through.
 *
 * The shape asserted here is the EXISTING `variable` one (ordered periods over
 * the narration timeline, contracts/pacing.ts) — nothing new is invented.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

/** The owner's standard tiers, exactly as the seeded channel stores them. */
const TIERED = {
  mode: 'variable',
  min_sec: 5,
  max_sec: 10,
  periods: [
    { start_sec: 0, end_sec: 180, min_sec: 5, max_sec: 10 },
    { start_sec: 180, end_sec: 360, min_sec: 10, max_sec: 20 },
    { start_sec: 360, end_sec: null, min_sec: 20, max_sec: 30 },
  ],
}

/** The whole continuity config a page sends on a plain save. */
function wholeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    motion_scope: { mode: 'off' },
    motion_level: 2,
    references: { prev_render: false, sheet: false, characters: false, style: false, composition: false },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
    ...overrides,
  }
}

const readJsonFile = async (file: string) => JSON.parse(await fs.readFile(file, 'utf-8'))
const configPathOf = (slug: string) => path.join(projectsRoot(), slug, 'config.json')

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let defaults: typeof import('../services/formula-starting-defaults.js')
let scenePlanPacing: typeof import('../services/scene-plan-pacing.js')
let projectsRoot: () => string

const FLAT_FORMAT = { visualSource: 'continuity-chain', script: {} } as any

/** The channel created for this file, and its first episode's sidecar. */
const EP = 'EP001'
let slug: string
let episodeDir: string
let sidecar: string

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  defaults = await import('../services/formula-starting-defaults.js')
  scenePlanPacing = await import('../services/scene-plan-pacing.js')
  projectsRoot = pm.projectsRoot

  const created = await request(app).post('/api/projects').send({
    name: 'New Channel Pacing', episode_prefix: 'EP', episode_digits: 3,
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  slug = created.body.slug

  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  episodeDir = (await resolveEpisodePathsByCode(slug, EP)).episode_dir
  sidecar = path.join(episodeDir, 'continuity.json')
  await fs.mkdir(episodeDir, { recursive: true })
})

after(async () => { await cleanup() })

describe('a new channel starts on the owner standard tiered rhythm', () => {
  test('the channel stores the tiers as its starting pacing and as a last-used Scene Plan preset', async () => {
    const config = await pm.getConfig(slug) as any
    assert.deepEqual(config.default_scene_pacing, TIERED,
      'the channel starting pacing is the tiered rhythm, in the existing variable-periods shape')

    const presets = config.scene_plan_presets
    assert.equal(presets.length, 1, 'exactly the one seeded preset')
    assert.equal(presets[0].name, 'Owner standard pacing')
    assert.equal(presets[0].type, 'scene-plan')
    assert.deepEqual(presets[0].data.pacing, TIERED, 'the preset carries the same tiers')
    assert.equal(config['scene_plan_last_preset_scene-plan'], presets[0].id, 'marked last-used')
  })

  test('the product\'s own resolver treats that preset as the active Scene Plan preset', async () => {
    const { findActivePreset } = await import('../routes/pipeline.js')
    const active = findActivePreset(await pm.getConfig(slug), 'scene_plan')
    assert.equal(active.missingReason, null)
    assert.equal(active.preset?.name, 'Owner standard pacing')
    assert.equal(active.preset?.id, (await pm.getConfig(slug) as any)['scene_plan_last_preset_scene-plan'])
    // A model is a live GenStudio choice (AGENTS.md §1): the seed must not bake
    // one in. The owner picks it in Scene Plan, as with a hand-saved preset.
    assert.equal('model' in (active.preset?.data ?? {}), false,
      'the seeded preset must not carry a writing model')
  })

  test('the channel\'s first episode reads the tiers back, before it has a rhythm of its own', async () => {
    // What Scene Plan plans on.
    assert.deepEqual((await scenePlanPacing.resolveScenePlanPacing(slug, episodeDir, FLAT_FORMAT)).pacing, TIERED)
    // What the Visual timing & motion panel shows for an episode with no
    // continuity.json of its own.
    const shown = await request(app).get(`/api/projects/${slug}/continuity/${EP}`)
    assert.equal(shown.status, 200, JSON.stringify(shown.body))
    assert.equal(shown.body.exists, false)
    assert.deepEqual(shown.body.config.pacing, TIERED)
  })

  // Komsan KOM0001/2 (2026-10-25): the first save of an episode with no rhythm of its own wrote the
  // 1–3s default instead of the starting rhythm the panel had just shown.
  test('the first save of an episode with no rhythm of its own keeps the channel\'s starting rhythm', async () => {
    const scope = await request(app).put(`/api/projects/${slug}/scene-review/${EP}/motion-scope`).send({ motion_scope: { mode: 'off' } })
    assert.equal(scope.status, 200, JSON.stringify(scope.body))
    assert.deepEqual((await readJsonFile(sidecar)).pacing, TIERED, 'a motion-scope save that creates the file')

    await fs.rename(sidecar, `${sidecar}.first-save`)
    const saved = await request(app).put(`/api/projects/${slug}/continuity/${EP}`).send(wholeConfig())
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.deepEqual((await readJsonFile(sidecar)).pacing, TIERED, 'a whole-config save that omits pacing')
  })
})

describe('an existing channel is never rewritten', () => {
  test('creating a channel leaves another channel\'s stored rhythm and presets byte-identical', async () => {
    const existing = await pm.createProject({ name: 'Existing Channel' })
    const existingConfigPath = configPathOf(existing.slug)
    // What a channel created before this decision looks like: its own rhythm,
    // its own preset, nothing seeded.
    await fs.writeFile(existingConfigPath, JSON.stringify({
      ...await readJsonFile(existingConfigPath),
      default_scene_pacing: { min_sec: 12, max_sec: 20 },
      scene_plan_presets: [{
        id: 'preset-theirs', name: 'Their own', type: 'scene-plan',
        data: { pacing: { min_sec: 12, max_sec: 20 } },
      }],
      'scene_plan_last_preset_scene-plan': 'preset-theirs',
    }, null, 2), 'utf-8')
    const before = await fs.readFile(existingConfigPath, 'utf-8')

    const fresh = await pm.createProject({ name: 'Another New Channel' })

    assert.equal(await fs.readFile(existingConfigPath, 'utf-8'), before,
      'creating a channel must not touch another channel\'s config')
    const existingConfig = await pm.getConfig(existing.slug) as any
    assert.deepEqual(existingConfig.default_scene_pacing, { min_sec: 12, max_sec: 20 })
    assert.equal(existingConfig['scene_plan_last_preset_scene-plan'], 'preset-theirs')
    // …while the channel created now did get the tiers.
    assert.deepEqual((await pm.getConfig(fresh.slug) as any).default_scene_pacing, TIERED)
  })

  test('a channel that predates the seed and sets no rhythm keeps the one app-wide default', async () => {
    const bare = await pm.createProject({ name: 'Bare Legacy Channel' })
    const barePath = configPathOf(bare.slug)
    const bareConfig = await readJsonFile(barePath)
    delete bareConfig.default_scene_pacing
    delete bareConfig.scene_plan_presets
    delete bareConfig['scene_plan_last_preset_scene-plan']
    await fs.writeFile(barePath, JSON.stringify(bareConfig, null, 2), 'utf-8')

    assert.equal(await defaults.readProjectStartingPacing(bare.slug), undefined)
    const bareEpisode = path.join(path.dirname(episodeDir), 'bare-ep')
    await fs.mkdir(bareEpisode, { recursive: true })
    assert.deepEqual(
      (await scenePlanPacing.resolveScenePlanPacing(bare.slug, bareEpisode, FLAT_FORMAT)).pacing,
      { min_sec: 1, max_sec: 3, mode: 'live' },
      'the seeded tiers must not become the app-wide default for a channel that has none',
    )
  })
})

describe('an episode can still change its own rhythm', () => {
  const EPISODE_RHYTHM = { min_sec: 3, max_sec: 6 }

  test('the timing panel moves it, a stale whole-config save does not, and Scene Plan uses the episode\'s', async () => {
    // Scene Plan's Visual timing & motion panel is the only writer that claims
    // the rhythm (PACING_AUTHORITY_CLAIM in routes/continuity.ts).
    const claimed = await request(app)
      .put(`/api/projects/${slug}/continuity/${EP}`)
      .send(wholeConfig({ pacing: EPISODE_RHYTHM, claim_pacing: true }))
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
    assert.deepEqual((await readJsonFile(sidecar)).pacing, EPISODE_RHYTHM)

    // A stale Character Sheet save still carrying the channel's tiers cannot
    // move the rhythm back.
    const stale = await request(app)
      .put(`/api/projects/${slug}/continuity/${EP}`)
      .send(wholeConfig({ pacing: TIERED }))
    assert.equal(stale.status, 200, JSON.stringify(stale.body))
    assert.deepEqual((await readJsonFile(sidecar)).pacing, EPISODE_RHYTHM,
      'a save that does not claim authority cannot move the rhythm')

    // The episode is planned on its own rhythm, not the channel's.
    assert.deepEqual(
      (await scenePlanPacing.resolveScenePlanPacing(slug, episodeDir, FLAT_FORMAT)).pacing,
      { min_sec: 3, max_sec: 6, mode: 'live' },
    )
    // …and the channel's own starting pacing is untouched by the episode save.
    assert.deepEqual((await pm.getConfig(slug) as any).default_scene_pacing, TIERED)
  })
})
