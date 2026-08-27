/**
 * Regression: a preview that asks for an episode by CODE alone must not
 * be told the episode is empty.
 *
 * An episode's folder name embeds its title (`{code} - {title}`), so
 * `resolveEpisodePaths(slug, code, '')` yields `.../DK0061 - /` — a
 * directory that does not exist. Before the fix, `script-content`
 * resolved that path, found no narration file, and answered
 * `{script: null, introduction: null}`. The Introduction page
 * (v1.4.73+) tracks only an episode code and passes no `?title=`, so its
 * preview rendered "No introduction generated yet for this episode."
 * over three finished, on-disk introductions.
 *
 * The write side already refuses to trust a caller-supplied title
 * (see `/generate/introduction-only` in routes/scripts.ts). These tests
 * pin that readers agree.
 *
 * What is pinned:
 *   - script-content with NO title returns both the chapters and the
 *     introduction (the owner-visible defect).
 *   - a CORRECT title still resolves the same content (no regression to
 *     the path callers such as scripts.vue already use).
 *   - a STALE title — the episode folder was renamed after its idea was
 *     written — still resolves, via the on-disk code-prefix scan.
 *   - an episode that genuinely has nothing still reads as nothing, so
 *     the fallback cannot invent content for an absent episode.
 *   - chapter-list, which shares the same resolver, is title-optional too.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const SLUG = 'title-optional-project'
const CODE = 'EP0061'
const TITLE = 'The Lantern in the Snowbound Boat'
const RENAMED_CODE = 'EP0062'
const RENAMED_IDEA_TITLE = 'Working Title'
const RENAMED_DISK_TITLE = 'The Title He Renamed It To'
const EMPTY_CODE = 'EP0063'

const INTRO_TEXT = 'Hello, and welcome back. It is good to have you here tonight.'
const CHAPTER_ONE = 'The snow had been falling for most of the day, soft and unhurried.'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express

/** Build one episode on disk exactly as the generator leaves it. */
async function makeEpisode(code: string, folderTitle: string) {
  const projDir = path.join(tmp.dir, 'projects', SLUG)
  const episodeDir = path.join(projDir, 'episodes', 'Season 004', `${code} - ${folderTitle}`)
  const scriptDir = path.join(episodeDir, `${code} - 01 Script`)
  await fs.mkdir(scriptDir, { recursive: true })

  const {
    splitNarrationIntoChapters, writeChapterFiles, assembleUnifiedNarration,
  } = await import('../lib/narration-assembly.js')

  const bulk = [
    '# Introduction', '', INTRO_TEXT, '',
    '## Chapter 01: The Quiet Shore', '', CHAPTER_ONE, '',
  ].join('\n')

  const parts = splitNarrationIntoChapters(bulk)
  await writeChapterFiles(scriptDir, code, folderTitle, parts)
  const assembled = await assembleUnifiedNarration(scriptDir, code, folderTitle)
  assert.equal(assembled.introduction_present, true, 'fixture must carry an introduction')

  return { episodeDir, scriptDir }
}

before(async () => {
  tmp = await useTempDataDir()

  const projDir = path.join(tmp.dir, 'projects', SLUG)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Title Optional Project',
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }, null, 2))

  // The idea index is the title the server falls back to. For the renamed
  // episode it deliberately disagrees with the folder on disk.
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [
      { id: 'idea-61', episode_code: CODE, title: TITLE, status: 'accepted' },
      { id: 'idea-62', episode_code: RENAMED_CODE, title: RENAMED_IDEA_TITLE, status: 'accepted' },
      { id: 'idea-63', episode_code: EMPTY_CODE, title: 'Never Written', status: 'accepted' },
    ],
    next_episode_number: 64,
    recycled_numbers: [],
  }, null, 2))

  await makeEpisode(CODE, TITLE)
  await makeEpisode(RENAMED_CODE, RENAMED_DISK_TITLE)
  // EMPTY_CODE gets no folder at all.

  const { router } = await import('../routes/scripts.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})

after(async () => {
  await tmp.cleanup()
})

function scriptContent(code: string, query: Record<string, string> = {}) {
  return request(app).get(`/api/projects/${SLUG}/episodes/${code}/script-content`).query(query)
}

describe('script-content resolves an episode without being told its title', () => {
  test('no title at all — the Introduction page\'s request — still finds the introduction', async () => {
    const res = await scriptContent(CODE)

    assert.equal(res.status, 200)
    assert.ok(res.body.introduction, 'introduction must not be null when one exists on disk')
    assert.match(res.body.introduction.content, /welcome back/)
    assert.ok(res.body.introduction.wordCount > 0)
    // The chapters travel with it — the same silent-empty answer hid both.
    assert.ok(res.body.script, 'script must not be null either')
    assert.match(res.body.script.content, /snow had been falling/)
  })

  test('a correct title resolves identically — no regression for callers that send one', async () => {
    const withTitle = await scriptContent(CODE, { title: TITLE })
    const without = await scriptContent(CODE)

    assert.equal(withTitle.status, 200)
    assert.equal(withTitle.body.introduction.content, without.body.introduction.content)
    assert.equal(withTitle.body.script.content, without.body.script.content)
  })

  test('a stale title — folder renamed on disk since the idea was written — still resolves', async () => {
    // Neither the supplied title nor the idea index names this folder;
    // only the on-disk code-prefix scan can find it.
    const res = await scriptContent(RENAMED_CODE, { title: 'A Title That Was Never On Disk' })

    assert.equal(res.status, 200)
    assert.ok(res.body.introduction, 'a renamed episode must still surface its introduction')
    assert.match(res.body.introduction.content, /welcome back/)
  })

  test('an episode with no folder still reads as empty — the fallback invents nothing', async () => {
    const res = await scriptContent(EMPTY_CODE)

    assert.equal(res.status, 200)
    assert.equal(res.body.script, null)
    assert.equal(res.body.introduction, null)
  })
})

describe('chapter-list shares the resolver, so it is title-optional too', () => {
  test('lists chapters when asked by code alone', async () => {
    const res = await request(app)
      .get(`/api/projects/${SLUG}/episodes/${CODE}/chapter-list`)

    assert.equal(res.status, 200)
    const chapters = res.body.chapters ?? res.body
    assert.ok(Array.isArray(chapters) && chapters.length > 0, 'chapters must not be empty')
  })
})
