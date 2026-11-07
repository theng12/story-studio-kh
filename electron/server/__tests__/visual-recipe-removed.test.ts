/**
 * Visual Recipe is gone, and the projects that used it still work.
 *
 * The feature (per-episode `recipe` in continuity.json, the `prompt_director`
 * job that composed every scene prompt from it, and its apply/revert routes)
 * was removed at the owner's direction — it had already been half-orphaned:
 * the Character Sheet no longer offered the panel, yet every Save rewrote
 * `recipe.enabled` to false.
 *
 * NO MIGRATION WAS WRITTEN, DELIBERATELY. Episodes on disk still carry
 * `recipe` in continuity.json and `visual_prompt_raw` / `emotion` /
 * `emotion_locked` in scene_plan.json. Rewriting the customer's own episode
 * files to delete a key nothing reads is the larger and riskier action, so the
 * keys are simply ignored. That is only safe while neither sidecar is behind a
 * `.strict()` schema — both are `JSON.parse` + cast today, and this file is
 * what fails if that ever changes and turns a stale key into a 400.
 */

import { after, before, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const EPISODE_ID = 'EP001'

let cleanup: () => Promise<void>
let app: any
let slug: string
let episodeDir: string
let planPath: string

/** A continuity.json exactly as a pre-removal episode has it on disk. */
const LEGACY_CONTINUITY = {
  schema_version: 1,
  anchor_character_ids: ['char-guide'],
  use_episode_sheet: true,
  pacing: { min_sec: 3, max_sec: 6 },
  references: { prev_render: true, sheet: true, characters: true, style: true, composition: true },
  denoise_strength: 0.42,
  style_bible: 'Muted painterly gouache, warm dusk light.',
  negative_prompt: 'text, watermark',
  recipe: {
    enabled: true,
    mode: 'guide',
    directive: 'Frame the subject centre, guide at the left edge pointing at it.',
    guide_character_id: 'char-guide',
    emotion_mode: 'fixed',
    fixed_emotion: 'curiosity',
  },
  updated_at: '2026-01-01T00:00:00.000Z',
}

/** A scene_plan.json that a Visual Recipe run had already composed. */
const LEGACY_PLAN = {
  schema_version: 1,
  episode_id: EPISODE_ID,
  generated_at: '2026-01-01T00:00:00.000Z',
  total_duration_sec: 20,
  planning_stage: 'visual',
  scenes: [
    {
      id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 10,
      transcript_segment: 'A quiet harbour at dawn.',
      visual_prompt: 'COMPOSED: the harbour framed centre, guide at the left',
      visual_prompt_raw: 'a harbour at dawn',
      emotion: 'wonder',
      emotion_locked: true,
    },
    {
      id: 'scene-2', scene_index: 2, start_sec: 10, end_sec: 20,
      transcript_segment: 'The tide turns.',
      visual_prompt: 'COMPOSED: the turning tide framed centre',
      visual_prompt_raw: 'the tide turning',
      emotion: 'calm',
    },
  ],
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  const project = await request(app).post('/api/projects').send({
    name: 'Visual Recipe Removed',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(project.status, 201)
  slug = project.body.slug

  const ideasPath = path.join(temp.dir, 'projects', slug, 'ideas.json')
  await fs.writeFile(ideasPath, JSON.stringify({
    ideas: [{
      id: 'idea-1',
      title: 'Episode 1',
      status: 'accepted',
      episode_code: EPISODE_ID,
    }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))

  const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js')
  const paths = await resolveEpisodePathsByCode(slug, EPISODE_ID)
  episodeDir = paths.episode_dir
  await fs.mkdir(episodeDir, { recursive: true })
  planPath = await resolveScenePlanPath(slug, EPISODE_ID, episodeDir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
})

after(async () => { await cleanup() })

describe('an episode that still carries Visual Recipe data on disk', () => {
  test('continuity.json with a saved recipe loads, saves, and drops the dead key without error', async () => {
    await fs.writeFile(
      path.join(episodeDir, 'continuity.json'),
      JSON.stringify(LEGACY_CONTINUITY, null, 2),
    )

    // 1. It LOADS. The stale key is returned untouched rather than rejected —
    //    the sidecar is not behind a strict schema, so it cannot 400.
    const read = await request(app).get(`/api/projects/${slug}/continuity/${EPISODE_ID}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.exists, true)
    assert.equal(read.body.config.style_bible, LEGACY_CONTINUITY.style_bible)

    // 2. It SAVES. This is the exact body the Character Sheet page sends —
    //    `useContinuityConfig`'s shape, which has never carried `recipe`.
    const saved = await request(app)
      .put(`/api/projects/${slug}/continuity/${EPISODE_ID}`)
      .send({
        schema_version: 1,
        anchor_character_ids: ['char-guide'],
        use_episode_sheet: true,
        pacing: { min_sec: 3, max_sec: 6 },
        references: { prev_render: true, sheet: true, characters: true, style: true },
        denoise_strength: 0.42,
        style_bible: LEGACY_CONTINUITY.style_bible,
        negative_prompt: 'text, watermark',
      })
    assert.equal(saved.status, 200)

    // 3. The save no longer writes ANYTHING recipe-shaped — not a disabled
    //    flag, not an empty object. That silent `recipe.enabled = false`
    //    rewrite was the half-orphaned behaviour this removal ends.
    const onDisk = JSON.parse(await fs.readFile(path.join(episodeDir, 'continuity.json'), 'utf-8'))
    assert.equal('recipe' in onDisk, false, 'a Character Sheet save must not resurrect a recipe key')

    // 4. …and everything the Character Sheet DOES own survived that save. A
    //    removal that quietly took the style bible or the anchors with it
    //    would pass every assertion above.
    assert.equal(onDisk.style_bible, LEGACY_CONTINUITY.style_bible)
    assert.equal(onDisk.negative_prompt, 'text, watermark')
    assert.deepEqual(onDisk.anchor_character_ids, ['char-guide'])
    assert.equal(onDisk.use_episode_sheet, true)
    assert.deepEqual(onDisk.pacing, { min_sec: 3, max_sec: 6 })
    assert.equal(onDisk.denoise_strength, 0.42)
    assert.equal(onDisk.references.style, true)
  })

  test('a composed scene plan still loads and still takes a prompt edit', async () => {
    await fs.writeFile(planPath, JSON.stringify(LEGACY_PLAN, null, 2))

    const read = await request(app).get(`/api/projects/${slug}/scene-plan/${EPISODE_ID}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.scene_plan?.scenes?.length, 2)

    const edited = await request(app)
      .post(`/api/projects/${slug}/scene-plan/${EPISODE_ID}/set-prompt`)
      .send({ scene_id: 'scene-1', visual_prompt: 'a harbour at first light' })
    assert.equal(edited.status, 200)

    const after = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    const scene = after.scenes.find((s: any) => s.id === 'scene-1')
    assert.equal(scene.visual_prompt, 'a harbour at first light')
    // The dead composition fields are left exactly as found. Nothing reads
    // them; rewriting the customer's plan to strip them would be the bigger
    // action, and `visual_prompt` is now the single source the renderer uses.
    assert.equal(scene.visual_prompt_raw, 'a harbour at dawn')
    assert.equal(scene.emotion, 'wonder')
  })
})

describe('the Visual Recipe surface is gone', () => {
  test('apply-recipe and revert-recipe are no longer routed', async () => {
    for (const action of ['apply-recipe', 'revert-recipe']) {
      const res = await request(app)
        .post(`/api/projects/${slug}/continuity/${EPISODE_ID}/${action}`)
        .send({ model: 'anything' })
      assert.equal(res.status, 404, `${action} must be unroutable, got ${res.status}`)
    }
  })

  test('prompt_director is not a job type and has no queue lane', async () => {
    const { JOB_TYPES } = await import('../models/types.js')
    assert.equal((JOB_TYPES as readonly string[]).includes('prompt_director'), false)
    const jq = await import('../services/job-queue.js')
    assert.equal((jq.knownJobTypes() as string[]).includes('prompt_director'), false)
  })
})
