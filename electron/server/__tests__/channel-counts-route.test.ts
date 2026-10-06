import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

const idea = (n: number, status: string) => ({
  id: `idea-${n}`, title: `Idea ${n}`, logline: '', themes: [], suggested_chapters: 3, suggested_length: '10', mood: '',
  status, episode_code: status === 'accepted' ? `EP${String(n).padStart(4, '0')}` : null,
  generated_at: '2026-10-01T00:00:00Z', accepted_at: null, batch_id: 'b', model_used: 'm',
})

const link = { channel_id: 'c1', video_id: 'v1', linked_at: '2026-10-01T00:00:00Z', source: 'upload' }

async function seed(slug: string, opts: { statuses: string[]; links?: string[]; stateFile?: string }) {
  const dir = pm.getProjectDir(slug)!
  await fs.writeFile(path.join(dir, 'ideas.json'), JSON.stringify({
    ideas: opts.statuses.map((s, i) => idea(i + 1, s)), next_episode_number: 99, recycled_numbers: [],
  }))
  await fs.mkdir(path.join(dir, 'youtube'), { recursive: true })
  await fs.writeFile(path.join(dir, 'youtube', 'project-state.json'), opts.stateFile ?? JSON.stringify({
    schema_version: 1, revision: 1, project_slug: slug,
    episode_video_links: Object.fromEntries((opts.links || []).map(code => [code, link])),
    reconciliation_history: [],
  }))
}

async function writeJobs(slug: string, rows: Array<{ type: string; status: string; ep: string; at: string }>) {
  await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'jobs.json'), JSON.stringify({
    jobs: rows.map((r, i) => ({
      job_id: `${slug}-job-${i}`, project_slug: slug, type: r.type, episode_id: r.ep, title: 't', status: r.status,
      created_at: r.at, started_at: r.at, finished_at: r.status === 'done' || r.status === 'error' ? r.at : null,
      error: r.status === 'error' ? 'No credits left' : null, output_lines: [], params: {},
    })),
  }))
}

const counts = (slug: string) => request(app).get(`/api/projects/${slug}/channel-counts`)

describe('GET /api/projects/:slug/channel-counts', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    jq = await import('../services/job-queue.js')
    const { router } = await import('../routes/projects.js')
    app = express()
    app.use('/api', router)
  })
  after(async () => { await tmp.cleanup() })

  test('an unknown project is a 404, not an empty channel', async () => {
    await counts('no-such-channel').expect(404)
  })

  test('counts only accepted ideas and only accepted episodes with a YouTube link', async () => {
    const { slug } = await pm.createProject({ name: 'Counts Basic' })
    // EP0001, EP0002, EP0004 accepted; a link on EP0003 (not accepted) must not count.
    await seed(slug, { statuses: ['accepted', 'accepted', 'new', 'accepted', 'dismissed'], links: ['EP0001', 'EP0003'] })
    const body = (await counts(slug).expect(200)).body
    assert.deepEqual(body, { episodes: 3, on_youtube: 1, in_progress: 0, needs_attention: 0 })
  })

  test('a channel with no ideas and no link file really is zero, and on_youtube is 0 not null', async () => {
    const { slug } = await pm.createProject({ name: 'Counts Empty' })
    const body = (await counts(slug).expect(200)).body
    assert.deepEqual(body, { episodes: 0, on_youtube: 0, in_progress: 0, needs_attention: 0 })
  })

  test('unreadable publishing state makes on_youtube null while the other counts stay true', async () => {
    const { slug } = await pm.createProject({ name: 'Counts Corrupt' })
    await seed(slug, { statuses: ['accepted', 'accepted'], stateFile: '{not json' })
    const body = (await counts(slug).expect(200)).body
    assert.equal(body.on_youtube, null)
    assert.equal(body.episodes, 2)
  })

  test('failed-latest counts as needs attention; failed-then-succeeded does not; a queued job is being made', async () => {
    const { slug } = await pm.createProject({ name: 'Counts Jobs' })
    await seed(slug, { statuses: ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'] })
    await writeJobs(slug, [
      // EP0001: latest audio attempt failed.
      { type: 'audio', status: 'error', ep: 'EP0001', at: '2026-10-01T01:00:00Z' },
      // EP0002: failed, then retried successfully -> fine.
      { type: 'audio_merge', status: 'error', ep: 'EP0002', at: '2026-10-01T01:00:00Z' },
      { type: 'audio_merge', status: 'done', ep: 'EP0002', at: '2026-10-01T02:00:00Z' },
      // EP0003: two steps failed -> still ONE episode needing attention.
      { type: 'audio', status: 'error', ep: 'EP0003', at: '2026-10-01T01:00:00Z' },
      { type: 'thumb_images', status: 'error', ep: 'EP0003', at: '2026-10-01T01:00:00Z' },
      // EP0099 is not an accepted episode of this channel: ignored.
      { type: 'audio', status: 'error', ep: 'EP0099', at: '2026-10-01T01:00:00Z' },
    ])
    await jq.getJobs(slug) // hydrate persisted history before adding a live job
    jq.enqueuePreparedForTest({ project_slug: slug, type: 'audio', episode_id: 'EP0004', title: 'live' })
    const body = (await counts(slug).expect(200)).body
    assert.deepEqual(body, { episodes: 5, on_youtube: 0, in_progress: 1, needs_attention: 2 })
  })

  test('counts serialise only step jobs, never the rest of the history', async () => {
    const { slug } = await pm.createProject({ name: 'Counts History' })
    await seed(slug, { statuses: ['accepted'] })
    await writeJobs(slug, [
      { type: 'audio', status: 'error', ep: 'EP0001', at: '2026-10-01T01:00:00Z' },
      ...Array.from({ length: 30 }, () => ({ type: 'youtube_upload', status: 'done', ep: 'EP0001', at: '2026-10-01T00:00:00Z' })),
    ])
    jq._resetJobPersistenceCountersForTesting()
    assert.deepEqual((await counts(slug).expect(200)).body, { episodes: 1, on_youtube: 0, in_progress: 0, needs_attention: 1 })
    assert.equal(jq._getJobPersistenceCountersForTesting().public_serializations, 1, 'only the one step job is copied')
  })

  test('counts do not leak between channels', async () => {
    const a = await pm.createProject({ name: 'Counts A' })
    const b = await pm.createProject({ name: 'Counts B' })
    await seed(a.slug, { statuses: ['accepted'], links: ['EP0001'] })
    await seed(b.slug, { statuses: ['accepted', 'accepted'] })
    assert.deepEqual((await counts(a.slug)).body, { episodes: 1, on_youtube: 1, in_progress: 0, needs_attention: 0 })
    assert.deepEqual((await counts(b.slug)).body, { episodes: 2, on_youtube: 0, in_progress: 0, needs_attention: 0 })
  })
})
