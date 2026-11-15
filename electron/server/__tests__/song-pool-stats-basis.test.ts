/**
 * Song Pool readiness must be measured on the Episode Builder's own basis (1.4.402 production):
 *
 *   - the channel's EFFECTIVE settings (`music_episode_target_length_s`, e.g. 150 min), never the
 *     formula's narrower legacy 65-minute defaults;
 *   - the builder's own no-repeat window: RENDERED uses plus saved DRAFTS, deduped and ordered by
 *     time (CJ0001–5 rendered + CJ0027–50 drafted = the 29 codes the builder blocks);
 *   - songs held by a draft are blocked exactly like rendered ones, so the page row and the KPI
 *     agree with what the next draw will actually skip.
 *
 * The production shape: 500 drawable, 490 held (drafts reserve most of them), 10 free. This
 * fixture keeps the numbers small but the same: 100 drawable, 60 held, 40 free.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { before, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const TARGET_S = 9_000
const AVG_S = 284
const SONGS = 100

let app: import('express').Express
let slug = ''
let poolId = ''
const renderedCodes = ['CJ0001', 'CJ0002', 'CJ0003', 'CJ0004', 'CJ0005']
const draftCodes = Array.from({ length: 24 }, (_, i) => `CJ${String(27 + i).padStart(4, '0')}`)

before(async () => {
  await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const sp = await import('../services/song-pool.js')
  const project = await pm.createProject({ name: 'Song pool stats basis' })
  slug = project.slug
  await pm.updateConfig(slug, { music_episode_target_length_s: TARGET_S })

  const dir = sp.poolDir(slug)!
  await mkdir(dir, { recursive: true })
  const songs: any[] = []
  for (let i = 0; i < SONGS; i++) {
    const file = `s${i}.mp3`
    await writeFile(path.join(dir, file), '')
    songs.push({
      id: `s${i}`, file, status: 'ready' as const, enabled: true, title: `Song ${i}`,
      tags: [], source: 'folder' as const, created_at: '2026-10-01T00:00:00Z',
      duration_s: AVG_S, rating: null, episodes: [] as Array<{ code: string; project_slug: string; used_at: string }>,
    })
  }
  // Rendered CJ0001–5 hold s0–s9; drafts CJ0027–50 hold s10–s59.
  for (let i = 0; i < 10; i++) {
    songs[i]!.episodes.push({
      code: renderedCodes[Math.floor(i / 2)]!, project_slug: slug,
      used_at: `2026-09-0${Math.floor(i / 2) + 1}T00:00:00Z`,
    })
  }
  const { pool } = await sp.updatePool(slug, value => { value.songs.push(...songs as any) })
  poolId = pool.pool_id

  const history = { episodes: {} as Record<string, { songs: string[]; at: string }> }
  let next = 10
  draftCodes.forEach((code, index) => {
    const keys = []
    // Two songs per draft, three on the first two, so the 24 drafts hold exactly s10–s59.
    const take = index < 2 ? 3 : 2
    for (let k = 0; k < take; k++, next++) keys.push(`${poolId}/s${next}`)
    history.episodes[code] = { songs: keys, at: `2026-10-${String(9 + Math.floor(index / 3)).padStart(2, '0')}T0${index % 10}:00:00Z` }
  })
  await writeFile(path.join(pm.getProjectDir(slug)!, 'music-episodes.json'), JSON.stringify(history))

  const { app: localApp } = await import('../app.js')
  app = localApp
})

async function stats(): Promise<any> {
  const response = await request(app).get(`/api/projects/${slug}/song-pool`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body
}

test('readiness uses the channel\'s effective 150-minute target, not the legacy 65-minute default', async () => {
  const body = await stats()
  assert.equal(body.episode_defaults.target_length_s, TARGET_S)
  assert.equal(body.stats.needed, Math.ceil((TARGET_S / AVG_S) * 30), 'window stock target is one episode at 150 min × 30 episodes')
  assert.equal(body.stats.single_episode_needed, 32)
  assert.equal(body.stats.next_episode_missing, 0, '40 free songs cover one 32-song episode')
})

test('the window and the blocked set are the builder\'s rendered + drafts union, no music_episode.json needed', async () => {
  const body = await stats()
  // No episode doc exists for this channel: the doc-null fallback must still use channel settings.
  assert.equal(body.window.length, 29, '5 rendered + 24 drafts')
  assert.ok(body.window.includes('CJ0001') && body.window.includes('CJ0050'))
  const blocked = body.blocked as Record<string, string>
  assert.equal(Object.keys(blocked).length, 60, 's0–s59 are held by rendered episodes or drafts')
  assert.equal(blocked[`${poolId}/s0`], 'CJ0001')
  assert.equal(blocked[`${poolId}/s10`], 'CJ0027', 'a drafted song is blocked exactly like a rendered one')
  assert.equal(body.stats.free_next, 40, 's60–s99 are free for the next episode')
})

test('window stock deficit stays separate from next-episode availability', async () => {
  const body = await stats()
  const windowNeed = Math.ceil((TARGET_S / AVG_S) * 30)
  assert.equal(body.stats.missing, windowNeed - SONGS, 'the 30-episode stock target is far from filled')
  assert.equal(body.stats.free_next, 40)
  assert.equal(body.stats.next_episode_missing, 0, 'yet the next episode is fully covered')
})

test('duplicate uses of one episode collapse, and the window keeps the newest N in time order', async () => {
  const pm = await import('../services/project-manager.js')
  const sp = await import('../services/song-pool.js')
  const project = await pm.createProject({ name: 'Song pool window order' })
  const other = project.slug
  const dir = sp.poolDir(other)!
  await mkdir(dir, { recursive: true })
  const songs: any[] = []
  for (let i = 0; i < 40; i++) {
    const file = `s${i}.mp3`
    await writeFile(path.join(dir, file), '')
    songs.push({
      id: `s${i}`, file, status: 'ready' as const, enabled: true, title: `Song ${i}`,
      tags: [], source: 'folder' as const, created_at: '2026-10-01T00:00:00Z',
      duration_s: AVG_S, rating: null,
      episodes: [{ code: 'CJ0001', project_slug: other, used_at: '2026-09-01T00:00:00Z' }],
    })
  }
  // 35 later episodes: CJ0002 oldest … CJ0036 newest, each on its own song.
  for (let n = 2; n <= 36; n++) {
    songs[n]!.episodes = [{
      code: `CJ${String(n).padStart(4, '0')}`, project_slug: other,
      used_at: `2026-09-${String(Math.min(28, n)).padStart(2, '0')}T${String(n % 24).padStart(2, '0')}:00:00Z`,
    }]
  }
  await sp.updatePool(other, value => { value.songs.push(...songs as any) })

  const response = await request(app).get(`/api/projects/${other}/song-pool`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const body = response.body
  assert.equal(body.window.length, 30, 'the window is the newest 30 distinct episodes')
  assert.equal(new Set(body.window).size, 30, 'CJ0001 used by 40 songs is one entry, not forty')
  assert.ok(!body.window.includes('CJ0001'), 'the oldest episode falls out first')
  assert.equal(body.window.at(-1), 'CJ0036', 'the newest is kept last, by its use time')
})
