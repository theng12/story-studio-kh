/**
 * "Start a new channel from this one" (owner, 2026-10-30) — the template half
 * of a finished first episode: *"i also want it to be saved as like a
 * template … then in the future i can just 1 click the pipeline."*
 *
 * What this file pins:
 *   - the reusable settings cross — every preset family and its last-used
 *     pointer, the Series Formula and Topic Packs, the art style, the idea
 *     upgrades;
 *   - an ALLOW list, not a deny list: a key this code has never heard of stays
 *     behind, and the scene rhythm episodes settled into never crosses
 *     (AGENTS.md §4 and §5);
 *   - a name another channel already uses is refused, plainly, and creates
 *     nothing;
 *   - the source channel is byte-for-byte untouched, and brings no episode,
 *     idea or file with it.
 */
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

const SOURCE_NAME = 'Settled Look'

/** Rhythm the source's episodes settled into — must never cross (AGENTS §5). */
const SOURCE_RHYTHM = { min_sec: 12, max_sec: 20 }

let cleanup: () => Promise<void>
let api: any
let pm: typeof import('../services/project-manager.js')
let copy: typeof import('../services/channel-settings-copy.js')
let sourceSlug: string
let sourceDir: string
let sourceConfigBytes: string
let sourceProjectBytes: string

async function app() {
  const { router: projectsRouter } = await import('../routes/projects.js')
  const instance = express()
  instance.use(express.json())
  instance.use('/api', projectsRouter)
  return instance
}

const readFile = (file: string) => fs.readFile(file, 'utf-8')
const readJson = async (file: string) => JSON.parse(await readFile(file))

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  api = await app()
  pm = await import('../services/project-manager.js')
  copy = await import('../services/channel-settings-copy.js')

  const created = await request(api).post('/api/projects').send({
    name: SOURCE_NAME,
    niche_id: 'history-narration',
    formula_choice: 'selected',
    topic_pack_ids: ['topic-origins'],
  }).expect(201)
  sourceSlug = created.body.slug
  sourceDir = pm.getProjectDir(sourceSlug)!

  // The look the first episode settled: preset families, last-used pointers,
  // the art style, the idea upgrades.
  await pm.updateConfig(sourceSlug, {
    script_presets: [{ id: 'preset-script-1', name: 'Settled script', data: { model: 'w::one' } }],
    script_last_preset_script: 'preset-script-1',
    transition_presets: [{ id: 'preset-trans-1', name: 'Soft dissolve', data: { transition: 'crossfade' } }],
    transition_last_preset: 'preset-trans-1',
    audio_generator_presets: [{ id: 'preset-audio-1', name: 'Narrated low', data: { voice: 'voice-deep' } }],
    audio_generator_last_preset: 'preset-audio-1',
    thumbnail_prompts_presets: [{ id: 'preset-thumb-1', name: 'Three up', data: { thumb_count: 3 } }],
    'thumbnail_prompts_last_preset': 'preset-thumb-1',
    idea_upgrades: { semantic_dedupe: 'on', embedding_model: 'emb::test' },
    style_presets: [{ id: 'style-settled', name: 'Settled look', description: 'Warm archival' }],
    active_style_preset_id: 'style-settled',
    // Episode-tied state that must stay behind.
    default_scene_pacing: SOURCE_RHYTHM,
    recency_log: [{ episode_code: 'EP0001', used_at: '2026-10-30', kind: 'topic', item: 'Psalm 91' }],
    broll_usage_log: [{ episode_code: 'EP0001', filename: 'clip.mp4', clip_sha: 'abc', used_at: '2026-10-30' }],
  } as any)

  // An episode and its ideas live on the source and must not travel.
  await fs.mkdir(path.join(sourceDir, 'episodes', 'EP0001'), { recursive: true })
  await fs.writeFile(path.join(sourceDir, 'ideas.json'), JSON.stringify({ ideas: [{ id: 'idea-1' }] }), 'utf-8')

  sourceConfigBytes = await readFile(path.join(sourceDir, 'config.json'))
  sourceProjectBytes = await readFile(path.join(sourceDir, 'project.json'))
})

after(async () => { await cleanup() })

describe('the reusable settings cross', () => {
  let newSlug: string

  before(async () => {
    const res = await request(api)
      .post(`/api/projects/${sourceSlug}/duplicate-settings`)
      .send({ name: 'Template Child' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    newSlug = res.body.slug
    assert.ok(newSlug && newSlug !== sourceSlug, 'a NEW channel, not the source')
  })

  test('every preset family and its last-used pointer arrive intact', async () => {
    const config = await pm.getConfig(newSlug) as any
    for (const [key, value] of Object.entries({
      script_presets: [{ id: 'preset-script-1', name: 'Settled script', data: { model: 'w::one' } }],
      script_last_preset_script: 'preset-script-1',
      transition_presets: [{ id: 'preset-trans-1', name: 'Soft dissolve', data: { transition: 'crossfade' } }],
      transition_last_preset: 'preset-trans-1',
      audio_generator_presets: [{ id: 'preset-audio-1', name: 'Narrated low', data: { voice: 'voice-deep' } }],
      audio_generator_last_preset: 'preset-audio-1',
      thumbnail_prompts_presets: [{ id: 'preset-thumb-1', name: 'Three up', data: { thumb_count: 3 } }],
      thumbnail_prompts_last_preset: 'preset-thumb-1',
      idea_upgrades: { semantic_dedupe: 'on', embedding_model: 'emb::test' },
      style_presets: [{ id: 'style-settled', name: 'Settled look', description: 'Warm archival' }],
    })) {
      assert.deepEqual(config[key], value, `${key} must cross unchanged`)
    }
  })

  test('the Series Formula, its Topic Packs and the art style arrive', async () => {
    const meta = await pm.getProject(newSlug)
    assert.equal(meta?.niche_id, 'history-narration')
    assert.equal(meta?.formula_choice, 'selected')
    assert.deepEqual(meta?.topic_pack_ids, ['topic-origins'])
    // The art style is mirrored into project.json by the same path Settings uses.
    assert.equal(meta?.active_style_preset_id, 'style-settled')
    assert.equal((await pm.getConfig(newSlug) as any).active_style_preset_id, 'style-settled')
  })

  test('no episode, idea or file came with it', async () => {
    const newDir = pm.getProjectDir(newSlug)!
    const episodes = await fs.readdir(path.join(newDir, 'episodes')).catch(() => [])
    assert.deepEqual(episodes, [], 'the new channel starts with no episodes')
    await assert.rejects(fs.access(path.join(newDir, 'ideas.json')),
      'the source\'s ideas must not travel')
  })
})

describe('what stays behind', () => {
  test('the scene rhythm episodes settled into is never inherited', async () => {
    const res = await request(api)
      .post(`/api/projects/${sourceSlug}/duplicate-settings`)
      .send({ name: 'No Rhythm Child' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const config = await pm.getConfig(res.body.slug) as any
    assert.notDeepEqual(config.default_scene_pacing, SOURCE_RHYTHM,
      'the source\'s rhythm must not decide the new channel\'s starting rhythm')
    // …while the source keeps its own.
    assert.deepEqual((await pm.getConfig(sourceSlug) as any).default_scene_pacing, SOURCE_RHYTHM)
  })

  test('episode-tied logs are not copied', async () => {
    const config = await pm.getConfig(sourceSlug) as any
    assert.ok(Array.isArray(config.recency_log) && config.recency_log.length === 1,
      'the source really does carry episode-tied state, or this asserts nothing')
    const res = await request(api)
      .post(`/api/projects/${sourceSlug}/duplicate-settings`)
      .send({ name: 'No Logs Child' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const fresh = await pm.getConfig(res.body.slug) as any
    assert.equal(fresh.recency_log, undefined)
    assert.equal(fresh.broll_usage_log, undefined)
  })

  test('the allow list drops a key it has never heard of', () => {
    // The whole safety property: an episode-specific key added later, or one
    // this code deliberately refuses, cannot reach a new channel.
    const patch = copy.copyableConfigSettings({
      script_presets: [1],
      idea_upgrades: { on: true },
      active_style_preset_id: 'style-settled',
      default_scene_pacing: SOURCE_RHYTHM,
      voice_presets: [{ name: 'Deep', voice_id: 'v1', providers: [] }],
      voice_favourites: ['v1'],
      // A key that does not exist yet and describes one episode.
      episode_anchor_state: { anchor: 'scene-3' },
      // Retired model storage must never be resurrected (AGENTS §7).
      models: { anything: true },
    })
    assert.deepEqual(patch, {
      script_presets: [1],
      idea_upgrades: { on: true },
      active_style_preset_id: 'style-settled',
    })
  })

  test('a Formula-less source copies no Formula either', () => {
    assert.deepEqual(copy.copyableCreateRequest('Plain', { name: 'Plain', slug: 'plain' } as any), { name: 'Plain' })
    assert.deepEqual(
      copy.copyableCreateRequest('Plain', { name: 'Plain', niche_id: 'sleep-story', topic_pack_ids: ['a'] } as any),
      { name: 'Plain', niche_id: 'sleep-story', topic_pack_ids: ['a'] },
    )
  })
})

describe('a name another channel uses is refused', () => {
  test('the clash answers plainly and creates nothing', async () => {
    const before = (await pm.listProjects()).length
    const res = await request(api)
      .post(`/api/projects/${sourceSlug}/duplicate-settings`)
      .send({ name: SOURCE_NAME })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.match(String(res.body.detail), /already exists/)
    assert.equal((await pm.listProjects()).length, before, 'a refused name must create no channel')
  })

  test('an empty name is refused', async () => {
    const before = (await pm.listProjects()).length
    const res = await request(api)
      .post(`/api/projects/${sourceSlug}/duplicate-settings`)
      .send({ name: '   ' })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.equal((await pm.listProjects()).length, before)
  })

  test('an unknown channel is a 404', async () => {
    const res = await request(api).post('/api/projects/no-such-channel/duplicate-settings').send({ name: 'x' })
    assert.equal(res.status, 404)
  })
})

describe('the source channel is untouched', () => {
  test('its config.json and project.json are byte-for-byte identical afterwards', async () => {
    const res = await request(api)
      .post(`/api/projects/${sourceSlug}/duplicate-settings`)
      .send({ name: 'Another Child' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.notEqual(res.body.slug, sourceSlug)

    assert.equal(await readFile(path.join(sourceDir, 'config.json')), sourceConfigBytes,
      'copying settings out of a channel must not write to it')
    assert.equal(await readFile(path.join(sourceDir, 'project.json')), sourceProjectBytes,
      'copying settings out of a channel must not write to it')
    // …and the episode and ideas it still owns are still there.
    const episodes = await fs.readdir(path.join(sourceDir, 'episodes'))
    assert.deepEqual(episodes, ['EP0001'])
    assert.deepEqual((await readJson(path.join(sourceDir, 'ideas.json'))).ideas, [{ id: 'idea-1' }])
  })
})
