/**
 * B-Roll repeat avoidance counts EPISODES, not log entries, and the picker page
 * can read an episode's saved pick back (so a reload or episode switch shows
 * what Assemble will render instead of the previous episode's sequence).
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import type { BrollUsageEntry } from '../models/types.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let sel: typeof import('../services/broll-selection.js')
let app: express.Express
let slug = ''

const entry = (ep: string, sha: string): BrollUsageEntry => ({ clip_sha: sha, clip_filename: `${sha}.mp4`, episode_code: ep, used_at: '' })

before(async () => {
  tmp = await useTempDataDir()
  sel = await import('../services/broll-selection.js')
  const projects = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const sidecars = await import('../services/broll-selection-sidecar.js')
  const route = await import('../routes/broll-project.js')
  slug = (await projects.createProject({ name: 'B-Roll saved selection' })).slug
  const added = await ideas.addIdeas(slug, ['One', 'Two'].map(title => ({
    title, logline: 'fixture', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  })), 'mock-chat-v1')
  await ideas.acceptIdea(slug, added[0]!.id, false)
  await ideas.acceptIdea(slug, added[1]!.id, false)
  await sidecars.saveSelectionSidecar(slug, 'EP0001', 'One', {
    schema_version: 1, episode_code: 'EP0001', pool_id: 'pool-a', selection_mode: 'tagged', pacing_mode: 'timed',
    segment_seconds: 6, tags: ['sea'], broll_volume: 15, target_duration: 90, generated_at: new Date().toISOString(),
    selection: [{ filename: 'wave.mp4', sha256: 'a'.repeat(64), target_duration: 6 }],
    motion_mode: 'fixed', motion_default: 'zoom-in', transition_id: 'crossfade', transition_duration: 0.5,
  })
  app = express()
  app.use(express.json())
  app.use('/api', route.router)
})

after(async () => { await tmp?.cleanup() })

test('lookback of 2 excludes every clip of the last 2 other episodes, not the last 2 log lines', () => {
  const log = [
    entry('EP1', 'old'),
    entry('EP2', 'b1'), entry('EP2', 'b2'), entry('EP2', 'b3'),
    entry('EP3', 'c1'), entry('EP3', 'c2'), entry('EP3', 'c3'),
    entry('EP4', 'mine'),
  ]
  const shas = sel.recentlyUsedClipShas(log, 2, 'EP4').sort()
  assert.deepEqual(shas, ['b1', 'b2', 'b3', 'c1', 'c2', 'c3'])
  assert.deepEqual(sel.recentlyUsedClipShas(log, 0, 'EP4'), [])
  assert.ok(sel.recentlyUsedClipShas(log, 1).includes('mine'), 'without a current episode the newest episode counts')
})

test('usage log is trimmed by episode count, keeping whole episodes', () => {
  const log = [entry('EP1', 'x'), entry('EP2', 'b1'), entry('EP2', 'b2'), entry('EP3', 'c1')]
  assert.deepEqual(sel.trimUsageLogToEpisodes(log, 2).map(e => e.clip_sha), ['b1', 'b2', 'c1'])
  assert.equal(sel.trimUsageLogToEpisodes(log, 10).length, 4)
})

test('GET saved selection returns the episode own pick with pool ids and settings', async () => {
  const res = await request(app).get(`/api/projects/${slug}/broll/selection/EP0001`)
  assert.equal(res.status, 200)
  assert.equal(res.body.episode_id, 'EP0001')
  assert.deepEqual(res.body.selection.map((s: any) => [s.filename, s.pool_id]), [['wave.mp4', 'pool-a']])
  assert.equal(res.body.target_duration, 90)
  assert.equal(res.body.segment_seconds, 6)
  assert.deepEqual(res.body.tags, ['sea'])
})

test('GET saved selection for an episode with no pick returns null, never another episode', async () => {
  const res = await request(app).get(`/api/projects/${slug}/broll/selection/EP0002`)
  assert.equal(res.status, 200)
  assert.equal(res.body.selection, null)
})
