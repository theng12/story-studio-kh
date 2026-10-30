/**
 * Two things the channels page shows that the backend has to answer for.
 *
 * ── 1. Each channel's Series Formula, by name ──
 *
 * The card shows the Formula's NAME, not its id, and the name comes from the
 * Catalogue of Formulas installed on THIS machine, resolved once for the whole
 * list. The five states are pinned here, because four of them must not collapse
 * into each other (AGENTS §6):
 *
 *   selected + installed        → the Formula's name
 *   selected + legacy alias     → the name of the store Formula it reads as
 *   selected + pack missing     → the STORED id, plainly (never an invented name)
 *   deliberate Generic          → "Generic — no Formula"
 *   never chose                 → "No Formula chosen"
 *
 * ── 2. "Recently worked on" is real ──
 *
 * It used to be a proxy: the newest of the channel folder's own files. A script
 * or scene plan saved inside an episode folder moved none of them, so a channel
 * someone had just worked on stayed where it was in the list. The measure now
 * walks into the episodes, and these tests pin both halves of that: an edit deep
 * inside an episode moves the channel, and housekeeping (caches, _trash, lock
 * files) does not.
 *
 * What these tests cannot see: the folder watcher's events (they need a real
 * FSEvents stream). The cache is invalidated through `forgetChannelRecency`,
 * which is exactly what the watcher calls.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express
let pm: typeof import('../services/project-manager.js')
let niches: typeof import('../services/niche-loader.js')
let recency: typeof import('../services/channel-recency.js')

const list = () => request(app).get('/api/projects')
const rowFor = async (slug: string) => (await list().expect(200)).body.find((row: any) => row.slug === slug)

/** Old enough that anything written now is unmistakably newer. */
const LONG_AGO = new Date('2024-01-01T00:00:00Z')

async function touch(target: string, when: Date | number): Promise<void> {
  const at = when instanceof Date ? when : new Date(when)
  await fs.utimes(target, at, at)
}

/**
 * Give every file and folder in `root` the same old time, bottom-up, so the
 * folder mtimes do not out-vote the files afterwards.
 */
async function backdateTree(root: string, when: Date): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) await backdateTree(full, when)
    await touch(full, when)
  }
  await touch(root, when)
}

/** A channel with one episode folder shaped like the real thing. */
async function makeEpisode(
  channelDir: string,
  code: string,
  title: string,
  { ignored = false }: { ignored?: boolean } = {},
): Promise<{ episodeDir: string; scriptFile: string }> {
  const episodeDir = path.join(channelDir, 'episodes', 'Season 001', `${code} - ${title}`)
  const scriptDir = path.join(episodeDir, `${code} - 01 Script`)
  await fs.mkdir(scriptDir, { recursive: true })
  const scriptFile = path.join(scriptDir, `${code}_Script_Narration.md`)
  await fs.writeFile(scriptFile, '# narration\n')
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), '{}\n')
  if (ignored) {
    const trash = path.join(episodeDir, '_trash')
    await fs.mkdir(trash, { recursive: true })
    await fs.writeFile(path.join(trash, 'old-script.md'), 'recycled\n')
    const cache = path.join(episodeDir, '.cache')
    await fs.mkdir(cache, { recursive: true })
    await fs.writeFile(path.join(cache, 'status.json'), '{}\n')
    await fs.writeFile(path.join(episodeDir, 'scene_plan.json.lock'), '{"owner":"x"}\n')
  }
  return { episodeDir, scriptFile }
}

describe('channel Formula names and real recency', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    niches = await import('../services/niche-loader.js')
    recency = await import('../services/channel-recency.js')
    const { router } = await import('../routes/projects.js')
    app = express()
    app.use(express.json())
    app.use('/api', router)
  })
  after(async () => { await tmp.cleanup() })
  beforeEach(() => { recency._clearChannelRecencyCache() })

  describe('the Formula label on a channel row', () => {
    const installed = new Map([
      ['com.storystudio.formula.sleep-story', 'Sleep Story'],
      ['com.storystudio.formula.pastoral-scripture', 'Pastoral Scripture'],
    ])

    test('a selected Formula shows the installed name, not its id', () => {
      assert.equal(
        niches.formulaCardLabel({ niche_id: 'com.storystudio.formula.pastoral-scripture', formula_choice: 'selected' }, installed),
        'Pastoral Scripture',
      )
    })

    test('a legacy id reads as the store Formula it aliases, by that Formula name', () => {
      // 'sleep' is a legacy id; it reads as com.storystudio.formula.sleep-story.
      assert.equal(
        niches.formulaCardLabel({ niche_id: 'sleep', formula_choice: 'selected' }, installed),
        'Sleep Story',
      )
      assert.equal(
        niches.formulaResolvedId({ niche_id: 'sleep', formula_choice: 'selected' }),
        'com.storystudio.formula.sleep-story',
      )
    })

    test('a Formula whose name cannot be read says "Custom Formula", never a raw id (owner, 2026-10-30)', () => {
      assert.equal(
        niches.formulaCardLabel({ niche_id: 'prayer', formula_choice: 'selected' }, new Map()),
        'Custom Formula',
      )
      // The two shapes the owner saw on his own cards.
      assert.equal(
        niches.formulaCardLabel({ niche_id: 'user:c0293626-1111-2222-3333-444455556666', formula_choice: 'selected' }, new Map()),
        'Custom Formula',
      )
      assert.equal(
        niches.formulaCardLabel({ niche_id: 'kh.owner.formula.illustrated-history-for-sleep', formula_choice: 'selected' }, new Map()),
        'Custom Formula',
      )
      // A name that IS readable still wins.
      assert.equal(
        niches.formulaCardLabel({ niche_id: 'sleep', formula_choice: 'selected' }, installed),
        'Sleep Story',
      )
    })

    test('Generic and never-chose are two different answers (AGENTS §6)', () => {
      assert.equal(niches.formulaCardLabel({ formula_choice: 'generic' }, installed), 'Generic — no Formula')
      assert.equal(niches.formulaCardLabel({}, installed), 'No Formula chosen')
      assert.equal(niches.formulaCardLabel(null, installed), 'No Formula chosen')
      assert.notEqual(
        niches.formulaCardLabel({ formula_choice: 'generic' }, installed),
        niches.formulaCardLabel({}, installed),
      )
    })

    test('the catalogue map lists installed packs only, and a built-in is still named from its own source', async () => {
      // Owner, 2026-10-29: "no custom, no built in, all from packs." No pack is
      // installed in this data dir, so the picker's map carries nothing — but a
      // channel that stored the id still reads the shipped profile's name.
      const names = await niches.formulaDisplayNames()
      assert.equal(names.has('history-narration'), false, 'a built-in with no installed pack is not offered')
      const [row] = await niches.withFormulaLabels([{ niche_id: 'history-narration', formula_choice: 'selected' }])
      assert.equal(row?.formula_name, 'History, Explained', 'the card names it from its own source')
    })

    test('an installed user Formula is named by the same lookup, through the channel list route', async () => {
      // A Formula written on this Mac (the legacy user-fork store) is a real
      // installed Formula; it needs no signing to exist.
      const source = JSON.parse(await fs.readFile(
        path.join(import.meta.dirname, '..', 'niches', 'prayer.json'), 'utf8',
      ))
      const userDir = path.join(pm.projectsRoot(), '.niches')
      await fs.mkdir(userDir, { recursive: true })
      await fs.writeFile(
        path.join(userDir, 'my-fork.json'),
        JSON.stringify({ ...source, id: 'my-fork', name: 'My Forked Formula', catalogName: undefined }),
      )

      const { slug } = await pm.createProject({ name: 'Named by the fork', niche_id: 'my-fork' })
      assert.equal((await rowFor(slug)).formula_name, 'My Forked Formula')
    })

    test('a row whose folder could not be read claims no Formula at all', async () => {
      // The READ_TIMEOUT row has no metadata to read, so it must not be
      // labelled "No Formula chosen" — that would be an answer invented from an
      // absence (AGENTS §6).
      const [unreadable] = await niches.withFormulaLabels([{ slug: 'slow', status: 'downloading' }])
      assert.equal(unreadable.formula_name, undefined)
      assert.equal(unreadable.formula_id, undefined)
    })

    test('the channel list carries the three states it can show', async () => {
      const selected = (await pm.createProject({ name: 'Selected', niche_id: 'history-narration' })).slug
      const generic = (await pm.createProject({ name: 'Generic', formula_choice: 'generic' })).slug
      const never = (await pm.createProject({ name: 'Never chose' })).slug

      // 'history-narration' aliases a store Formula that is not installed in
      // this throwaway data dir, so the card reads the shipped profile's name
      // while the id it resolves to is still reported beside it.
      const selectedRow = await rowFor(selected)
      assert.equal(selectedRow.formula_name, 'History, Explained')
      assert.equal(selectedRow.formula_id, 'com.storystudio.formula.history-explained')

      assert.equal((await rowFor(generic)).formula_name, 'Generic — no Formula')
      assert.equal((await rowFor(generic)).formula_id, undefined)
      assert.equal((await rowFor(never)).formula_name, 'No Formula chosen')
      assert.equal((await rowFor(never)).formula_id, undefined)
    })
  })

  describe('recently worked on', () => {
    test('an edit deep inside an episode moves the channel, and leaves its neighbour alone', async () => {
      const edited = await pm.createProject({ name: 'Deep Edit' })
      const quiet = await pm.createProject({ name: 'Quiet Neighbour' })
      const editedDir = pm.getProjectDir(edited.slug)!
      const quietDir = pm.getProjectDir(quiet.slug)!

      const one = await makeEpisode(editedDir, 'EP001', 'First')
      const two = await makeEpisode(quietDir, 'EP001', 'First')
      // Everything starts equally old, INCLUDING the channel's own markers.
      await backdateTree(editedDir, LONG_AGO)
      await backdateTree(quietDir, LONG_AGO)

      assert.equal(
        (await rowFor(edited.slug)).last_worked_at,
        (await rowFor(quiet.slug)).last_worked_at,
        'the two channels start level',
      )

      // A script saved over itself: the FILE changes, no folder mtime moves and
      // nothing at the channel's top level is touched. This is the case the old
      // measure could not see.
      const later = Date.now() + 120_000
      await touch(one.scriptFile, later)
      await touch(two.scriptFile, LONG_AGO)
      recency.forgetChannelRecency(edited.slug)

      const editedRow = await rowFor(edited.slug)
      const quietRow = await rowFor(quiet.slug)
      assert.equal(Date.parse(editedRow.last_worked_at), later, 'the deep edit is the newest work')
      assert.equal(Date.parse(quietRow.last_worked_at), LONG_AGO.getTime(), 'the neighbour did not move')
      assert.ok(Date.parse(editedRow.last_worked_at) > Date.parse(quietRow.last_worked_at))
    })

    test('ignored paths — _trash, caches, lock files — are not work', async () => {
      const { slug } = await pm.createProject({ name: 'Housekeeping' })
      const dir = pm.getProjectDir(slug)!
      const episode = await makeEpisode(dir, 'EP001', 'First', { ignored: true })
      await backdateTree(dir, LONG_AGO)

      const before = (await rowFor(slug)).last_worked_at
      assert.equal(Date.parse(before), LONG_AGO.getTime())

      const later = Date.now() + 120_000
      await touch(path.join(episode.episodeDir, '_trash', 'old-script.md'), later)
      await touch(path.join(episode.episodeDir, '.cache', 'status.json'), later)
      await touch(path.join(episode.episodeDir, 'scene_plan.json.lock'), later)
      recency.forgetChannelRecency(slug)

      assert.equal(
        Date.parse((await rowFor(slug)).last_worked_at),
        LONG_AGO.getTime(),
        'trash, a cache file and a lock moved nothing',
      )
    })

    test('a new file in a media folder counts — the set of images in an episode changed', async () => {
      const { slug } = await pm.createProject({ name: 'Media Work' })
      const dir = pm.getProjectDir(slug)!
      const episode = await makeEpisode(dir, 'EP001', 'First')
      const images = path.join(episode.episodeDir, 'EP001 - 05 Scene Images')
      await fs.mkdir(images, { recursive: true })
      await backdateTree(dir, LONG_AGO)

      const later = Date.now() + 120_000
      await fs.writeFile(path.join(images, 'scene-01.png'), 'x')
      await touch(path.join(images, 'scene-01.png'), later)
      await touch(images, later)
      recency.forgetChannelRecency(slug)

      assert.equal(Date.parse((await rowFor(slug)).last_worked_at), later)
    })

    test('a cached answer is served until the channel is told it changed', async () => {
      const { slug } = await pm.createProject({ name: 'Cached' })
      const dir = pm.getProjectDir(slug)!
      const episode = await makeEpisode(dir, 'EP001', 'First')
      await backdateTree(dir, LONG_AGO)
      const first = (await rowFor(slug)).last_worked_at

      const later = Date.now() + 120_000
      await touch(episode.scriptFile, later)
      assert.equal(
        (await rowFor(slug)).last_worked_at,
        first,
        'without an invalidation the cached answer stands (the TTL is the backstop)',
      )

      recency.forgetChannelRecency(slug)
      assert.equal(Date.parse((await rowFor(slug)).last_worked_at), later)
    })

    test('an unreadable channel folder is UNKNOWN, never a zero', async () => {
      const { slug } = await pm.createProject({ name: 'Vanished' })
      const dir = pm.getProjectDir(slug)!
      // A folder with no readable project.json is not a channel at all, so the
      // per-row measure is what is pinned here: no markers → null, not 0.
      recency._clearChannelRecencyCache()
      const unknown = await recency.channelLastWorkedAt({ slug, channelDir: path.join(dir, 'not-a-folder') })
      assert.equal(unknown, null)
    })
  })
})
