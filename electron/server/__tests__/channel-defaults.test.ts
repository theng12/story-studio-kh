/**
 * SAVED STARTING POINTS (2026-10-31) — the owner's "several defaults to choose
 * from" when setting up a new channel.
 *
 * What this file pins:
 *   - a channel is one by having a NAME in its own config, and clearing the
 *     name makes it not one;
 *   - the LIST is live from the channels: it carries the source's Formula and
 *     art style as they are now, and a source that was deleted, hidden or lost
 *     its project.json is simply not offered;
 *   - the MARKER does not cross a copy — a channel started from a starting
 *     point is not itself a starting point, or the list would grow on its own;
 *   - episodes and episode-tied state still stay behind (AGENTS §4 / §5);
 *   - a channel name another channel uses is still refused (already was), and
 *     the copy's rollback still unregisters a channel whose settings could not
 *     be carried over rather than leaving a half-copy behind.
 */
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

/** A name the source channel would give its own starting point. */
const STARTING_POINT_NAME = 'Warm History'
/** The source channel's own name on the start page. */
const SOURCE_NAME = 'Settled Look'

let cleanup: () => Promise<void>
let api: any
let pm: typeof import('../services/project-manager.js')
let copy: typeof import('../services/channel-settings-copy.js')
let defaults: typeof import('../services/channel-defaults.js')
let sourceSlug: string
let sourceDir: string
let sourceConfigBytes: string

async function app() {
  const { router: projectsRouter } = await import('../routes/projects.js')
  const instance = express()
  instance.use(express.json())
  instance.use('/api', projectsRouter)
  return instance
}

const readFile = (file: string) => fs.readFile(file, 'utf-8')
const readJson = async (file: string) => JSON.parse(await readFile(file))

/** The list, as the create screen reads it. */
async function listDefaults(): Promise<any[]> {
  const res = await request(api).get('/api/channel-defaults').expect(200)
  return res.body.defaults
}

/**
 * Mark (or clear) a starting point. Returns the supertest chain itself, so a
 * caller can either `.expect()` it or `await` it and assert on the status —
 * which is what the refusal cases need.
 */
function mark(slug: string, name: string) {
  return request(api).put(`/api/projects/${slug}/channel-default`).send({ name })
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  api = await app()
  pm = await import('../services/project-manager.js')
  copy = await import('../services/channel-settings-copy.js')
  defaults = await import('../services/channel-defaults.js')

  const created = await request(api).post('/api/projects').send({
    name: SOURCE_NAME,
    niche_id: 'history-narration',
    formula_choice: 'selected',
    topic_pack_ids: ['topic-origins'],
  }).expect(201)
  sourceSlug = created.body.slug
  sourceDir = pm.getProjectDir(sourceSlug)!

  // The look the first episode settled: preset families, an art style, and the
  // episode-tied state that must never travel.
  await pm.updateConfig(sourceSlug, {
    script_presets: [{ id: 'preset-script-1', name: 'Settled script', data: { model: 'w::one' } }],
    style_presets: [{
      id: 'style-settled',
      name: 'Settled look',
      description: 'Warm archival',
      preview_filename: 'settled-hero.png',
    }],
    active_style_preset_id: 'style-settled',
    default_scene_pacing: { min_sec: 12, max_sec: 20 },
    recency_log: [{ episode_code: 'EP0001', used_at: '2026-10-30', kind: 'topic', item: 'Psalm 91' }],
  } as any)

  // An episode and its ideas live on the source and must not travel.
  await fs.mkdir(path.join(sourceDir, 'episodes', 'EP0001'), { recursive: true })
  await fs.writeFile(path.join(sourceDir, 'ideas.json'), JSON.stringify({ ideas: [{ id: 'idea-1' }] }), 'utf-8')

  sourceConfigBytes = await readFile(path.join(sourceDir, 'config.json'))
})

after(async () => { await cleanup() })

// ── Marking and unmarking ──────────────────────────────────────────────────
describe('marking a starting point', () => {
  test('an empty or missing name means the config is not one', () => {
    assert.equal(defaults.readChannelDefaultName(undefined), '')
    assert.equal(defaults.readChannelDefaultName({}), '')
    assert.equal(defaults.readChannelDefaultName({ channel_default_name: '' }), '')
    assert.equal(defaults.readChannelDefaultName({ channel_default_name: '   ' }), '')
    assert.equal(defaults.isChannelDefault({}), false)
    assert.equal(defaults.readChannelDefaultName({ channel_default_name: STARTING_POINT_NAME }), STARTING_POINT_NAME)
    assert.equal(defaults.isChannelDefault({ channel_default_name: STARTING_POINT_NAME }), true)
  })

  test('a normalised name is trimmed, and an over-long one is refused', () => {
    assert.deepEqual(defaults.normaliseChannelDefaultName(`  ${STARTING_POINT_NAME}  `), { ok: true, name: STARTING_POINT_NAME })
    // Clearing is a real request, not a missing value — it must not be refused.
    assert.deepEqual(defaults.normaliseChannelDefaultName(''), { ok: true, name: '' })
    assert.deepEqual(defaults.normaliseChannelDefaultName(undefined), { ok: true, name: '' })
    const tooLong = defaults.normaliseChannelDefaultName('x'.repeat(defaults.CHANNEL_DEFAULT_NAME_MAX + 1))
    assert.equal(tooLong.ok, false)
    assert.equal(defaults.normaliseChannelDefaultName(42).ok, false)
  })

  test('naming it stores the key and the list offers it', async () => {
    const res = await mark(sourceSlug, `  ${STARTING_POINT_NAME}  `)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body, { ok: true, name: STARTING_POINT_NAME, is_starting_point: true })

    const config = await readJson(path.join(sourceDir, 'config.json'))
    assert.equal(config.channel_default_name, STARTING_POINT_NAME)

    const rows = await listDefaults()
    assert.equal(rows.length, 1, JSON.stringify(rows))
    assert.equal(rows[0]!.name, STARTING_POINT_NAME)
    assert.equal(rows[0]!.source_slug, sourceSlug)
    assert.equal(rows[0]!.source_name, SOURCE_NAME)
  })

  test('an unmarked channel is not offered', async () => {
    const other = await request(api).post('/api/projects').send({ name: 'Plain Channel' }).expect(201)
    const rows = await listDefaults()
    assert.equal(rows.some(row => row.source_slug === other.body.slug), false,
      'a channel nobody marked must not appear as a starting point')
  })

  test('clearing the name makes it not one, and it leaves the list', async () => {
    const cleared = await mark(sourceSlug, '')
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
    assert.deepEqual(cleared.body, { ok: true, name: '', is_starting_point: false })
    assert.equal((await listDefaults()).length, 0, 'a cleared channel must not be offered')

    // Put it back — later tests in this file depend on it being marked.
    await mark(sourceSlug, STARTING_POINT_NAME).expect(200)
    assert.equal((await listDefaults()).length, 1)
  })

  test('an over-long name is refused and stores nothing', async () => {
    const res = await mark(sourceSlug, 'x'.repeat(defaults.CHANNEL_DEFAULT_NAME_MAX + 1))
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.match(String(res.body.detail), /up to 80 characters/)
    // The refusal left the stored marker alone.
    assert.equal((await listDefaults())[0]?.name, STARTING_POINT_NAME)
  })

  test('an unknown channel is a 404', async () => {
    const res = await mark('no-such-channel', 'Anywhere')
    assert.equal(res.status, 404)
  })
})

// ── The list reads the source as it is NOW ─────────────────────────────────
describe('the list is live from the channels', () => {
  test('it carries the Series Formula by the name installed here', async () => {
    const rows = await listDefaults()
    assert.equal(rows.length, 1)
    assert.ok(rows[0]!.formula_name, 'a Formula-backed channel must name its Formula')
    assert.notEqual(rows[0]!.formula_name, 'history-narration', 'a raw id is not a name')
  })

  test('it carries the art style and its picture', async () => {
    const rows = await listDefaults()
    assert.equal(rows[0]!.art_style_name, 'Settled look')
    // A channel style with a stored picture is served by the style-preset route.
    assert.ok(
      String(rows[0]!.art_style_preview).startsWith(`/api/projects/${sourceSlug}/style-presets/style-settled/preview`),
      `expected the preset preview URL, got ${rows[0]!.art_style_preview}`,
    )
  })

  test('a source renamed after being marked shows its current name', async () => {
    await request(api).put(`/api/projects/${sourceSlug}`).send({ name: 'Renamed Since' }).expect(200)
    assert.equal((await listDefaults())[0]!.source_name, 'Renamed Since')
    // Back for the tests that follow.
    await request(api).put(`/api/projects/${sourceSlug}`).send({ name: SOURCE_NAME }).expect(200)
    assert.equal((await listDefaults())[0]!.source_name, SOURCE_NAME)
  })

  test('a source whose art style changed after being marked shows the new one', async () => {
    await pm.updateConfig(sourceSlug, {
      style_presets: [
        { id: 'style-settled', name: 'Settled look', description: 'Warm archival', preview_filename: 'settled-hero.png' },
        { id: 'style-other', name: 'Cold Blueprint', description: 'Blueprint cyan' },
      ],
      active_style_preset_id: 'style-other',
    } as any)
    const row = (await listDefaults())[0]!
    assert.equal(row.art_style_name, 'Cold Blueprint', 'the card must show the style the channel uses NOW')

    await pm.updateConfig(sourceSlug, { active_style_preset_id: 'style-settled' } as any)
    assert.equal((await listDefaults())[0]!.art_style_name, 'Settled look')
  })
})

// ── A source that is gone ──────────────────────────────────────────────────
describe('a starting point whose source has gone', () => {
  test('a hidden (soft-deleted) source is not offered', async () => {
    const doomed = await request(api).post('/api/projects').send({ name: 'Doomed Look' }).expect(201)
    const doomedSlug = doomed.body.slug
    await mark(doomedSlug, 'Temporarily Saved').expect(200)
    assert.ok((await listDefaults()).some(row => row.source_slug === doomedSlug), 'set up: it IS offered')

    const { softDeleteProjectAfterGuard } = await import('../services/soft-delete.js')
    await softDeleteProjectAfterGuard(doomedSlug)
    const afterDelete = await listDefaults()
    assert.equal(afterDelete.some(row => row.source_slug === doomedSlug), false,
      'a deleted channel must stop being offered — nothing cleans this up, it is simply not read')
  })

  test('a channel that lost its project.json is not offered', async () => {
    // The folder keeps its config (so the marker is still readable on disk),
    // but without project.json it is no longer a channel at all.
    const ghostSlug = 'ghost-lost-project'
    const ghostDir = path.join(pm.projectsRoot(), ghostSlug)
    await fs.mkdir(ghostDir, { recursive: true })
    await fs.writeFile(path.join(ghostDir, 'config.json'), JSON.stringify({ channel_default_name: 'Orphaned' }), 'utf-8')
    try {
      assert.equal((await listDefaults()).some(row => row.source_slug === ghostSlug), false,
        'a folder with no project.json is not a channel, so it is not a starting point')

      // …and the marker route refuses it too, rather than marking a ghost.
      const res = await mark(ghostSlug, 'Anything')
      assert.equal(res.status, 404)
    } finally {
      await fs.rm(ghostDir, { recursive: true, force: true })
    }
  })

  test('copying from a source that no longer exists is a 404', async () => {
    const res = await request(api)
      .post('/api/projects/no-such-channel/duplicate-settings')
      .send({ name: 'From Nothing' })
    assert.equal(res.status, 404)
  })
})

// ── The marker does not cross ──────────────────────────────────────────────
describe('the marker does not cross a copy', () => {
  let childSlug: string

  before(async () => {
    // Snapshotted here, right before the copy: every earlier test in this file
    // MARKS the source, so a snapshot taken at suite setup would be stale.
    sourceConfigBytes = await readFile(path.join(sourceDir, 'config.json'))
    const res = await request(api)
      .post(`/api/projects/${sourceSlug}/duplicate-settings`)
      .send({ name: 'Child Of Default' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    childSlug = res.body.slug
  })

  test('the copy is not itself a starting point', async () => {
    const config = await readJson(path.join(pm.getProjectDir(childSlug)!, 'config.json'))
    assert.equal(config.channel_default_name, undefined,
      'a channel STARTED FROM a default must not become one — the list would grow on its own')
    const offered = (await listDefaults()).map(row => row.source_slug)
    assert.equal(offered.includes(childSlug), false, 'and the copy must not be offered')
  })

  test('the allow list drops the marker even when the config carries one', () => {
    const patch = copy.copyableConfigSettings({
      channel_default_name: STARTING_POINT_NAME,
      script_presets: [1],
      idea_upgrades: { on: true },
      active_style_preset_id: 'style-settled',
      default_scene_pacing: { min_sec: 12, max_sec: 20 },
    })
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'channel_default_name'), false,
      'the marker must not be on the copy allow list')
    assert.deepEqual(patch, {
      script_presets: [1],
      idea_upgrades: { on: true },
      active_style_preset_id: 'style-settled',
    })
  })

  test('the source keeps its own marker after the copy', async () => {
    const config = await readJson(path.join(sourceDir, 'config.json'))
    assert.equal(config.channel_default_name, STARTING_POINT_NAME)
  })
})

// ── What still stays behind ────────────────────────────────────────────────
describe('what stays behind', () => {
  test('no episode, idea or file came with the copy', async () => {
    const slug = (await pm.listProjects()).find(p => p.name === 'Child Of Default')?.slug
    assert.ok(slug, 'the copy exists')
    const childDir = pm.getProjectDir(slug!)!
    const episodes = await fs.readdir(path.join(childDir, 'episodes')).catch(() => [])
    assert.deepEqual(episodes, [], 'the new channel starts with no episodes')
    await assert.rejects(fs.access(path.join(childDir, 'ideas.json')),
      'the source\'s ideas must not travel')
  })

  test('episode-tied state is never inherited', async () => {
    const source = await pm.getConfig(sourceSlug) as any
    assert.ok(Array.isArray(source.recency_log) && source.recency_log.length === 1,
      'the source really does carry episode-tied state, or this asserts nothing')
    const child = (await pm.listProjects()).find(p => p.name === 'Child Of Default')
    const childConfig = await pm.getConfig(child!.slug) as any
    assert.equal(childConfig.recency_log, undefined)
    assert.notDeepEqual(childConfig.default_scene_pacing, { min_sec: 12, max_sec: 20 })
    // …while the source keeps its own.
    assert.deepEqual((await pm.getConfig(sourceSlug) as any).default_scene_pacing, { min_sec: 12, max_sec: 20 })
  })

  test('the source is byte-for-byte untouched by a copy', async () => {
    assert.equal(await readFile(path.join(sourceDir, 'config.json')), sourceConfigBytes,
      'copying settings out of a channel must not write to it')
    const episodes = await fs.readdir(path.join(sourceDir, 'episodes'))
    assert.deepEqual(episodes, ['EP0001'])
  })
})

// ── A name another channel uses ────────────────────────────────────────────
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
})

// ── Rollback ───────────────────────────────────────────────────────────────
describe('the rollback is unchanged', () => {
  test('a settings carry that fails removes the channel it just made', async () => {
    // A style id the copy cannot resolve: the signed-selection write refuses,
    // so the route must unregister what it created rather than leave a channel
    // that claims to be a copy and is not.
    const marked = await request(api).post('/api/projects').send({ name: 'Broken Style Host' }).expect(201)
    await pm.updateConfig(marked.body.slug, {
      style_presets: [{ id: 'style-real', name: 'Real', description: 'A real description' }],
      active_style_preset_id: 'style-unresolvable',
    } as any)

    const before = (await pm.listProjects()).length
    const res = await request(api)
      .post(`/api/projects/${marked.body.slug}/duplicate-settings`)
      .send({ name: 'Rolled Back' })
    assert.ok(res.status >= 400 && res.status < 500, `expected a refusal, got ${res.status}`)
    const after = await pm.listProjects()
    assert.equal(after.some(p => p.name === 'Rolled Back'), false,
      'the half-made channel must be gone from the list')
    assert.equal(after.length, before, 'the rollback must leave the channel count exactly as it found it')

    // The source of the failed copy is untouched by its own failed rollback.
    const source = await readJson(path.join(pm.getProjectDir(marked.body.slug)!, 'config.json'))
    assert.equal(source.active_style_preset_id, 'style-unresolvable')
  })

  test('the naming fields the create form sends reach the copy', async () => {
    const res = await request(api)
      .post(`/api/projects/${sourceSlug}/duplicate-settings`)
      .send({
        name: 'Named Copy',
        episode_prefix: 'KH',
        season_prefix: 'Season',
        season_size: 7,
        content_language: 'km',
      })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const meta = await pm.getProject(res.body.slug)
    assert.equal(meta?.episode_prefix, 'KH')
    assert.equal(meta?.season_prefix, 'Season')
    assert.equal(meta?.season_size, 7)
    assert.equal(meta?.content_language, 'km')
    // …and nothing else about the source crossed.
    assert.equal(meta?.niche_id, 'history-narration', 'the Formula still comes from the source')
  })
})
