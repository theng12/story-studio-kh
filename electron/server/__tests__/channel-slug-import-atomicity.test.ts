/**
 * Two Production defects reported on the mini (running 1.4.366), 2026-10-28:
 *
 *   1. A Khmer-only channel name produced the literal slug `project`, so a
 *      second such channel collided with it or got a meaningless folder. The
 *      fallback is now `channel-<8 hex digits of a hash of the name>` and an
 *      explicit `slug` may be sent on create.
 *
 *   2. A failed import-script left an unregistered episode folder
 *      (`EP0000 - Chris Khmer Audition`) behind. An import now refuses a code
 *      this channel does not own, and a folder it does have to create is staged
 *      and renamed into place only on success — a partial one goes to the
 *      channel's Trash and the error says where.
 *
 * Every fixture lives in its own temp data dir; nothing touches a real Library.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { fallbackChannelSlug } from '../contracts/project-slug.js'

let cleanup: () => Promise<void>
let app: any

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
})

after(async () => { await cleanup() })

const KHMER_NAME = 'ពិភពទេវកថា'
const OTHER_KHMER_NAME = 'រឿងព្រេងខ្មែរ'

async function createChannel(body: Record<string, unknown>) {
  return request(app).post('/api/projects').send(body)
}

describe('channel slug at creation', () => {
  test('a Khmer-only name gets a unique channel-<short id> slug, never the literal "project"', async () => {
    const first = await createChannel({ name: KHMER_NAME })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.notEqual(first.body.slug, 'project')
    assert.match(first.body.slug, /^channel-[0-9a-f]{8}$/)
    // The same rule the creation form previews: one shared module, not a copy.
    assert.equal(first.body.slug, fallbackChannelSlug(KHMER_NAME))

    const second = await createChannel({ name: OTHER_KHMER_NAME })
    assert.equal(second.status, 201, JSON.stringify(second.body))
    assert.notEqual(second.body.slug, first.body.slug, 'two different Khmer names must not share a folder')
  })

  test('the second channel with the same Khmer-only name is made unique, not dropped onto the first', async () => {
    // Its own name: `KHMER_NAME` was already taken by the test above, so the
    // first channel here is not necessarily the unsuffixed base.
    const NAME = 'ព្រៃដ៏អាថ៌កំបាំង'
    const first = await createChannel({ name: NAME })
    const second = await createChannel({ name: NAME })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(second.status, 201, JSON.stringify(second.body))
    assert.equal(second.body.slug, `${first.body.slug}-2`)
  })

  test('an explicit slug is used exactly as sent', async () => {
    const res = await createChannel({ name: 'Explicit Slug Channel', slug: 'phnom-penh-stories' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.slug, 'phnom-penh-stories')
    const pm = await import('../services/project-manager.js')
    assert.ok(existsSync(pm.getProjectDir('phnom-penh-stories')!))
  })

  test('a clashing explicit slug is refused with a plain message and creates nothing', async () => {
    const taken = await createChannel({ name: 'Taken Slug', slug: 'night-market-tales' })
    assert.equal(taken.status, 201, JSON.stringify(taken.body))

    const clash = await createChannel({ name: 'Another Channel', slug: 'night-market-tales' })
    assert.equal(clash.status, 400)
    assert.match(clash.body.detail, /already used by another channel/)
    assert.match(clash.body.detail, /night-market-tales/)

    // Case-only differences are the same folder on APFS/NTFS — still a clash.
    const cased = await createChannel({ name: 'Another Channel', slug: 'Night-Market-Tales' })
    assert.equal(cased.status, 400)
  })

  test('an unsafe explicit slug is refused rather than quietly rewritten', async () => {
    for (const slug of ['not a slug', 'trailing-', 'con', 'under_score', '']) {
      const res = await createChannel({ name: 'Bad Slug Channel', slug })
      if (!slug) {
        // Empty means "not given" — the derived slug is used.
        assert.equal(res.status, 201, JSON.stringify(res.body))
        continue
      }
      assert.equal(res.status, 400, `${slug} must be refused`)
      assert.match(res.body.detail, /not a usable channel slug/)
    }
  })
})

describe('import-script leaves no unregistered episode folder', () => {
  let slug = ''
  let projectDir = ''

  async function acceptEpisode(code: string, title: string) {
    const im = await import('../services/idea-manager.js')
    const [idea] = await im.addIdeas(slug, [{
      title, logline: '', themes: [],
      suggested_chapters: 10, suggested_length: '45 min', mood: '',
    }], 'manual')
    await im.acceptIdea(slug, idea!.id, false, { override_code: code })
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    return (await resolveEpisodePathsByCode(slug, code)).episode_dir.replace(/\/$/, '')
  }

  before(async () => {
    const res = await createChannel({ name: 'Import Atomicity Channel', episode_prefix: 'EP', episode_digits: 4 })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    slug = res.body.slug
    const pm = await import('../services/project-manager.js')
    projectDir = pm.getProjectDir(slug)!
  })

  /** Every directory under the channel's episodes tree, as relative paths. */
  async function episodeDirs(): Promise<string[]> {
    const root = path.join(projectDir, 'episodes')
    if (!existsSync(root)) return []
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => String(entry.name))
  }

  async function stagingDirs(): Promise<string[]> {
    const root = path.join(projectDir, '.import-staging')
    return existsSync(root) ? (await fs.readdir(root)).map(String) : []
  }

  test('a code this channel does not own is refused, and no folder is created', async () => {
    const before = await episodeDirs()
    const res = await request(app).post(`/api/projects/${slug}/episodes/EP9999/import-script`)
      .send({ title: 'Chris Khmer Audition', text: '## Chapter 1: One\nHello.' })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.match(res.body.detail, /is not an episode in this channel/)
    assert.match(res.body.detail, /Accept the idea first/)

    assert.deepEqual(await episodeDirs(), before, 'no episode folder may appear')
    assert.deepEqual(await stagingDirs(), [], 'nothing may be left in staging')
  })

  test('a code with no episode number (EP0000) is refused and names the reason', async () => {
    const res = await request(app).post(`/api/projects/${slug}/episodes/EP0000/import-script`)
      .send({ title: 'Chris Khmer Audition', text: '## Chapter 1: One\nHello.' })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.match(res.body.detail, /has no episode number/)
    assert.ok(!(await episodeDirs()).some(dir => dir.startsWith('EP0000')))
  })

  test('a failed import leaves nothing unregistered, and the error says where the partial folder went', async () => {
    const episodeDir = await acceptEpisode('EP0001', 'Atomic Import')
    // A registered episode whose folder is missing (deleted outside the app) is
    // exactly the case that has to be rebuilt by the import. It is moved out of
    // the Library, never deleted.
    await fs.rename(episodeDir, path.join(path.dirname(projectDir), 'moved-away-EP0001'))
    // Occupy the canonical path with a FILE so the final rename cannot land.
    await fs.mkdir(path.dirname(episodeDir), { recursive: true })
    await fs.writeFile(episodeDir, 'not a folder\n')

    const res = await request(app).post(`/api/projects/${slug}/episodes/EP0001/import-script`)
      .send({ title: 'Atomic Import', text: '## Chapter 1: One\nHello.' })
    assert.equal(res.status, 500, JSON.stringify(res.body))
    assert.match(res.body.detail, /Nothing was left behind/)
    assert.match(res.body.detail, /_trash/)
    assert.match(res.body.detail, /import-failures/)

    assert.ok(!(await episodeDirs()).some(dir => dir.startsWith('EP0001')), 'no episode folder may remain')
    assert.deepEqual(await stagingDirs(), [], 'staging must be emptied by the move to Trash')

    const trashRoot = path.join(path.dirname(projectDir), '_trash', path.basename(projectDir), 'import-failures')
    assert.ok(existsSync(trashRoot), 'the partial folder is kept, restorable, in the channel Trash')
    assert.ok((await fs.readdir(trashRoot)).length > 0)
  })

  test('a successful import still creates and registers the episode', async () => {
    const episodeDir = await acceptEpisode('EP0002', 'Successful Import')
    await fs.rename(episodeDir, path.join(path.dirname(projectDir), 'moved-away-EP0002'))

    const res = await request(app).post(`/api/projects/${slug}/episodes/EP0002/import-script`)
      .send({ title: 'Successful Import', text: '## Chapter 1: One\nHello.' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.chapters, 1)
    assert.ok(existsSync(episodeDir), 'the episode folder lands at its canonical path')

    const im = await import('../services/idea-manager.js')
    const ideas = await im.getIdeas(slug, 'accepted')
    assert.ok(ideas.some(idea => idea.episode_code === 'EP0002'), 'the episode stays registered')
    assert.deepEqual(await stagingDirs(), [], 'staging is emptied on success too')
  })
})
