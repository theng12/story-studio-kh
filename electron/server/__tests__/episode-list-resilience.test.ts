/**
 * One bad episode must never 500 the whole channel list.
 *
 * Production, 2026-10-28, mini on 1.4.366: `GET /api/projects/project/episodes`
 * answered 500 `{detail:'Internal server error'}` for a channel that had
 *   (a) an unregistered folder `Season 000/EP0000 - Chris Khmer Audition`,
 *   (b) an accepted idea whose code `AU0001` no longer matches the channel's
 *       episode prefix (it was accepted while the prefix was briefly `AU`),
 *   (c) the slug `project`,
 * while `/ideas` and `/jobs/all` worked.
 *
 * Each state is rebuilt here on its own and then all together, through the
 * real route. A state that breaks one episode must surface as a named problem
 * for that episode, never as a failed list (AGENTS §6/§8).
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

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

async function createChannel(body: Record<string, unknown>) {
  const res = await request(app).post('/api/projects').send(body)
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.slug as string
}

async function addIdea(slug: string, title: string): Promise<string> {
  const im = await import('../services/idea-manager.js')
  const [idea] = await im.addIdeas(slug, [{
    title, logline: '', themes: [],
    suggested_chapters: 10, suggested_length: '45 min', mood: '',
  }], 'manual')
  return idea!.id
}

async function accept(slug: string, ideaId: string, code: string) {
  const im = await import('../services/idea-manager.js')
  await im.acceptIdea(slug, ideaId, false, { override_code: code })
}

async function setPrefix(slug: string, prefix: string) {
  const pm = await import('../services/project-manager.js')
  await pm.updateProject(slug, { episode_prefix: prefix } as any)
}

/** An accepted code that no longer matches the channel's prefix, made the way
 *  Production made it: the prefix was briefly `AU` when the idea was accepted. */
async function mismatchedPrefixEpisode(slug: string, title: string): Promise<string> {
  await setPrefix(slug, 'AU')
  const ideaId = await addIdea(slug, title)
  await accept(slug, ideaId, 'AU0001')
  await setPrefix(slug, 'EP')
  return 'AU0001'
}

/** The unregistered folder the failed import left on the mini. */
async function orphanFolder(slug: string, title: string): Promise<string> {
  const pm = await import('../services/project-manager.js')
  const projectDir = pm.getProjectDir(slug)!
  const dir = path.join(projectDir, 'episodes', 'Season 000', `EP0000 - ${title}`, '02 Script')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function episodeList(slug: string) {
  return request(app).get(`/api/projects/${slug}/episodes`)
}

describe('GET /projects/:slug/episodes survives one bad episode', () => {
  test('a healthy channel still lists its episode', async () => {
    const slug = await createChannel({ name: 'Healthy Channel', episode_prefix: 'EP', episode_digits: 4 })
    const ideaId = await addIdea(slug, 'Healthy Episode')
    await accept(slug, ideaId, 'EP0001')

    const res = await episodeList(slug)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.length, 1)
    assert.equal(res.body[0].episode_code, 'EP0001')
    assert.equal(res.body[0].episode_error, undefined)
  })

  test('(a) an unregistered EP0000 folder alone does not fail the list', async () => {
    const slug = await createChannel({ name: 'Orphan Folder Channel', episode_prefix: 'EP', episode_digits: 4 })
    const ideaId = await addIdea(slug, 'Good Episode')
    await accept(slug, ideaId, 'EP0001')
    await orphanFolder(slug, 'Chris Khmer Audition')

    const res = await episodeList(slug)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(res.body.some((row: any) => row.episode_code === 'EP0001'))
  })

  test('(b) an accepted code whose prefix differs from the channel prefix does not fail the list', async () => {
    const slug = await createChannel({ name: 'Prefix Change Channel', episode_prefix: 'EP', episode_digits: 4 })
    await mismatchedPrefixEpisode(slug, 'Chris Khmer Audition')

    const res = await episodeList(slug)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.length, 1)
    const row = res.body[0]
    assert.equal(row.episode_code, 'AU0001')
    // The root cause: the stored code is read for its number, so its folder and
    // status resolve normally instead of throwing "expected prefix: EP".
    assert.equal(row.episode_error, undefined)
    assert.ok(Object.keys(row.status).length > 0, 'the row is really computed')
  })

  test('her exact state: an accepted code with no number at all is a named problem, not a failed list', async () => {
    const slug = await createChannel({ name: 'Numberless Code Channel', episode_prefix: 'EP', episode_digits: 4 })
    const im = await import('../services/idea-manager.js')
    const bad = await addIdea(slug, 'Numberless Code Episode')
    await im.promoteToAccepted(slug, bad, { episode_code: 'AUDITION' })
    const good = await addIdea(slug, 'Good Episode')
    await accept(slug, good, 'EP0001')

    const res = await episodeList(slug)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const codes = res.body.map((row: any) => row.episode_code).sort()
    assert.deepEqual(codes, ['AUDITION', 'EP0001'], 'neither episode is dropped from the list')

    const badRow = res.body.find((row: any) => row.episode_code === 'AUDITION')
    assert.match(badRow.episode_error, /could not be read/i)
    assert.match(badRow.episode_error, /episode code/i, 'the reason names the real failure')
    assert.deepEqual(badRow.status, {}, 'every step is "not checked", never a pretend done')
    assert.equal(badRow.scene_images.complete, false)

    const goodRow = res.body.find((row: any) => row.episode_code === 'EP0001')
    assert.equal(goodRow.episode_error, undefined, 'the healthy episode is unaffected')
    assert.ok(Object.keys(goodRow.status).length > 0)
  })

  // The mini has exactly one channel with the slug `project`, so the two
  // `project` tests share it — the combined case is the same channel plus the
  // two other states.
  let projectSlugChannel = ''

  test('(c) the slug "project" alone is not the cause', async () => {
    projectSlugChannel = await createChannel({ name: 'Project Slug Channel', slug: 'project', episode_prefix: 'EP', episode_digits: 4 })
    assert.equal(projectSlugChannel, 'project')
    const ideaId = await addIdea(projectSlugChannel, 'Ordinary Episode')
    await accept(projectSlugChannel, ideaId, 'EP0001')

    const res = await episodeList(projectSlugChannel)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body[0].episode_code, 'EP0001')
  })

  test('(a)+(b)+(c) together — the mini\'s exact state — still lists every episode', async () => {
    const slug = projectSlugChannel
    await mismatchedPrefixEpisode(slug, 'Chris Khmer Audition')
    await orphanFolder(slug, 'Chris Khmer Audition')
    const good = await addIdea(slug, 'A Good Episode')
    await accept(slug, good, 'EP0002')

    const res = await episodeList(slug)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const codes = res.body.map((row: any) => row.episode_code).sort()
    assert.deepEqual(codes, ['AU0001', 'EP0001', 'EP0002'])
    const goodRow = res.body.find((row: any) => row.episode_code === 'EP0002')
    assert.equal(goodRow.episode_error, undefined, 'the healthy episode keeps its real status')
    assert.ok(goodRow.status, 'the healthy episode still carries a status object')
  })
})
