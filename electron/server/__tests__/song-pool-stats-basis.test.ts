/**
 * Song Pool readiness must be measured on the Episode Builder's own basis (1.4.402 production):
 *
 *   - the channel's EFFECTIVE settings (`music_episode_target_length_s`, 150 min), never the
 *     formula's narrower legacy 65-minute defaults;
 *   - the builder's own no-repeat window: RENDERED uses plus saved DRAFTS, deduped and ordered by
 *     time (the CJ shape: CJ0001–5 rendered + CJ0027–50 drafted = 29 codes);
 *   - songs held by a draft are blocked exactly like rendered ones, so the page row and the KPI
 *     agree with what the next draw will actually skip.
 *
 * Production shape, scaled to this fixture: 500 drawable, average 284 s, 490 held (147 rendered
 * + 343 drafted), 10 free. With the effective 150-minute target: window need 951, stock missing
 * 451, single-episode need 32, next-episode missing 22. The derived reference (rendered-only,
 * legacy 65-minute) is asserted to differ, so the test fails if either basis regresses.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { before, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const TARGET_S = 9_000
const LEGACY_S = 3_900
const AVG_S = 284
const SONGS = 500

let app: import('express').Express
let slug = ''
let poolId = ''

async function makeProject(pm: any, sp: any, name: string, count: number, target?: number): Promise<{ slug: string; poolId: string }> {
  const project = await pm.createProject({ name })
  const created = project.slug
  if (target) await pm.updateConfig(created, { music_episode_target_length_s: target })
  const dir = sp.poolDir(created)!
  await mkdir(dir, { recursive: true })
  const songs: any[] = []
  for (let i = 0; i < count; i++) {
    const file = `s${i}.mp3`
    await writeFile(path.join(dir, file), '')
    songs.push({
      id: `s${i}`, file, status: 'ready' as const, enabled: true, title: `Song ${i}`,
      tags: [], source: 'folder' as const, created_at: '2026-10-01T00:00:00Z',
      duration_s: AVG_S, rating: null, episodes: [] as Array<{ code: string; project_slug: string; used_at: string }>,
    })
  }
  const { pool } = await sp.updatePool(created, (value: any) => { value.songs.push(...songs) })
  return { slug: created, poolId: pool.pool_id }
}

async function writeHistory(pm: any, project: string, episodes: Record<string, { songs: string[]; at: string }>): Promise<void> {
  await writeFile(path.join(pm.getProjectDir(project)!, 'music-episodes.json'), JSON.stringify({ episodes }))
}

before(async () => {
  await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const sp = await import('../services/song-pool.js')
  const base = await makeProject(pm, sp, 'Song pool stats basis', SONGS, TARGET_S)
  slug = base.slug
  poolId = base.poolId

  // Rendered CJ0001–5 hold s0–s146 (30/30/30/30/27), dated 1–5 Sep.
  const pool = await sp.readPool(slug)
  const renderedCounts = [30, 30, 30, 30, 27]
  let index = 0
  renderedCounts.forEach((take, n) => {
    const code = `CJ000${n + 1}`
    for (let k = 0; k < take; k++, index++) {
      pool.songs[index]!.episodes.push({ code, project_slug: slug, used_at: `2026-09-0${n + 1}T00:00:00Z` })
    }
  })
  await sp.updatePool(slug, value => { value.songs = pool.songs })

  // Drafts CJ0027–50 hold the rest of the block, s147–s489 (343 songs), all newer than renders.
  const history: Record<string, { songs: string[]; at: string }> = {}
  let cursor = 147
  for (let n = 0; n < 24; n++) {
    const code = `CJ${String(27 + n).padStart(4, '0')}`
    const take = n < 7 ? 15 : 14
    const keys: string[] = []
    for (let k = 0; k < take; k++, cursor++) keys.push(`${poolId}/s${cursor}`)
    history[code] = { songs: keys, at: `2026-10-${String(9 + Math.floor(n / 3)).padStart(2, '0')}T${String(n % 3).padStart(2, '0')}:00:00Z` }
  }
  await writeHistory(pm, slug, history)

  const { app: localApp } = await import('../app.js')
  app = localApp
})

async function stats(project = slug): Promise<any> {
  const response = await request(app).get(`/api/projects/${project}/song-pool`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body
}

test('the route reports the effective 150-minute estimate, not the legacy 65-minute default', async () => {
  const body = await stats()
  assert.equal(body.stats.readiness_scope, 'channel_default_estimate')
  assert.equal(body.stats.target_length_s, TARGET_S)
  assert.equal(body.episode_defaults.target_length_s, TARGET_S)
  assert.equal(body.stats.needed, Math.ceil((TARGET_S / AVG_S) * 30))
  assert.equal(body.stats.single_episode_needed, 32, '150 min ÷ 284 s')
  assert.equal(body.stats.next_episode_missing, 22, '32 needed − 10 free')
  assert.notEqual(body.stats.single_episode_needed, Math.ceil(LEGACY_S / AVG_S),
    'the legacy 65-minute figure (14) would hide the real shortage')
})

test('the window and blocked set are the rendered + drafts union, with no episode doc', async () => {
  const body = await stats()
  assert.equal(body.window.length, 29, '5 rendered + 24 drafts')
  assert.ok(body.window.includes('CJ0001') && body.window.includes('CJ0050'))
  const blocked = body.blocked as Record<string, string>
  assert.equal(Object.keys(blocked).length, 490)
  assert.equal(blocked[`${poolId}/s0`], 'CJ0001')
  assert.equal(blocked[`${poolId}/s147`], 'CJ0027', 'a drafted song is blocked exactly like a rendered one')
  assert.equal(body.stats.free_next, 10, 's490–s499 are free for the next episode')
})

test('the generic page is the same answer the Episode Builder gets for this channel', async () => {
  const store = await import('../services/music-episode-store.js')
  const { songKey } = await import('../services/music-episode.js')
  const sp = await import('../services/song-pool.js')
  const { settings } = await store.channelStartingSettings(slug)
  const ctx = await store.loadEpisodeContext(slug, 'CJ0051', settings)
  const builderFree = ctx.songs.filter(s => s.drawable && !ctx.blocked.has(songKey(s))).length
  const body = await stats()
  assert.equal(body.stats.free_next, builderFree)
  assert.equal(body.window.length, ctx.window_codes.length)

  // The old basis — rendered uses only — would have called 353 songs free.
  const renderedOnly = sp.episodeWindow([await sp.readPool(slug)], slug, 30)
  const oldFree = (await sp.readPool(slug)).songs
    .filter(s => s.status === 'ready' && sp.isDrawable(s) && !sp.inWindow(s, renderedOnly, slug)).length
  assert.equal(oldFree, 353)
  assert.notEqual(body.stats.free_next, oldFree, 'drafts are reservations and must be counted')
})

test('stock deficit and next-episode availability stay separate', async () => {
  const body = await stats()
  assert.equal(body.stats.missing, Math.ceil((TARGET_S / AVG_S) * 30) - SONGS)
  assert.equal(body.stats.free_next, 10)
  assert.equal(body.stats.next_episode_missing, 22)
})

test('without saved channel settings the estimate is the 65-minute default, labelled as such', async () => {
  const pm = await import('../services/project-manager.js')
  const sp = await import('../services/song-pool.js')
  const base = await makeProject(pm, sp, 'Song pool generic default', 20)
  // One draft holds 10 of the 20 songs, so this episode needs 14 and has 10.
  const history: Record<string, { songs: string[]; at: string }> = {}
  history.CJ0027 = { songs: Array.from({ length: 10 }, (_, i) => `${base.poolId}/s${i}`), at: '2026-10-09T00:00:00Z' }
  await writeHistory(pm, base.slug, history)
  const body = await stats(base.slug)
  assert.equal(body.stats.target_length_s, LEGACY_S)
  assert.equal(body.stats.readiness_scope, 'channel_default_estimate')
  assert.equal(body.stats.single_episode_needed, 14)
  assert.equal(body.stats.free_next, 10)
  assert.equal(body.stats.next_episode_missing, 4)
})

test('songs without a measured duration are unknown: excluded from the average and never free', async () => {
  const pm = await import('../services/project-manager.js')
  const sp = await import('../services/song-pool.js')
  const base = await makeProject(pm, sp, 'Song pool unmeasured', 4)
  const pool = await sp.readPool(base.slug)
  pool.songs[0]!.duration_s = 0
  await sp.updatePool(base.slug, value => { value.songs = pool.songs })
  const body = await stats(base.slug)
  assert.equal(body.stats.average_song_s, AVG_S, 'only the three measured songs count')
  assert.equal(body.stats.free_next, 3, 'the unmeasured song is not availability')
})

test('an empty pool answers unknown, never an implied zero-length readiness', async () => {
  const pm = await import('../services/project-manager.js')
  const sp = await import('../services/song-pool.js')
  const project = await pm.createProject({ name: 'Song pool empty' })
  const body = await stats(project.slug)
  assert.equal(body.stats.average_song_s, null)
  assert.equal(body.stats.single_episode_needed, null)
  assert.equal(body.stats.next_episode_missing, null)
  assert.equal(body.stats.missing, null)
  assert.equal(body.stats.free_next, 0, 'no songs is zero free, which is true, not unknown')
})

test('an unreadable pool fails loudly instead of reporting readiness', async () => {
  const pm = await import('../services/project-manager.js')
  const sp = await import('../services/song-pool.js')
  const project = await pm.createProject({ name: 'Song pool unreadable' })
  const dir = sp.poolDir(project.slug)!
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'library.json'), '{not json')
  const response = await request(app).get(`/api/projects/${project.slug}/song-pool`)
  assert.equal(response.status, 500)
  assert.ok(!('free_next' in (response.body?.stats || {})), 'no readiness numbers on a failed read')
})

test('duplicate uses of one episode collapse, and the window keeps the newest N in time order', async () => {
  const pm = await import('../services/project-manager.js')
  const sp = await import('../services/song-pool.js')
  const base = await makeProject(pm, sp, 'Song pool window order', 40)
  const pool = await sp.readPool(base.slug)
  for (const song of pool.songs) song.episodes.push({ code: 'CJ0001', project_slug: base.slug, used_at: '2026-09-01T00:00:00Z' })
  for (let n = 2; n <= 36; n++) {
    pool.songs[n]!.episodes = [{
      code: `CJ${String(n).padStart(4, '0')}`, project_slug: base.slug,
      used_at: `2026-09-${String(Math.min(28, n)).padStart(2, '0')}T${String(n % 24).padStart(2, '0')}:00:00Z`,
    }]
  }
  await sp.updatePool(base.slug, value => { value.songs = pool.songs })

  const response = await request(app).get(`/api/projects/${base.slug}/song-pool`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const body = response.body
  assert.equal(body.window.length, 30, 'the window is the newest 30 distinct episodes')
  assert.equal(new Set(body.window).size, 30, 'CJ0001 used by 40 songs is one entry, not forty')
  assert.ok(!body.window.includes('CJ0001'), 'the oldest episode falls out first')
  assert.equal(body.window.at(-1), 'CJ0036', 'the newest is kept last, by its use time')
})
