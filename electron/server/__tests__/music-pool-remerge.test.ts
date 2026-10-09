/**
 * Re-merging an episode keeps its music track (Dreamlands E2E 2026-10-03: the
 * EP0002 re-merge took EP0001's track because every merge advanced the cursor).
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let mp: typeof import('../services/music-pool.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  mp = await import('../services/music-pool.js')
})
after(async () => { await cleanup() })

test('a re-merge gets the episode\'s own track and does not move the cursor', async () => {
  const proj = await pm.createProject({ name: 'MusicPoolRemerge' })
  const dir = path.join(pm.getProjectDir(proj.slug)!, 'music')
  await fs.mkdir(dir, { recursive: true })
  for (const name of ['a.mp3', 'b.mp3', 'c.mp3']) await fs.writeFile(path.join(dir, name), 'x')

  assert.equal((await mp.peekNext(proj.slug, 'EP0001'))?.track.filename, 'a.mp3')
  await mp.recordPick(proj.slug, 'EP0001', 'a.mp3')
  assert.equal((await mp.peekNext(proj.slug, 'EP0002'))?.track.filename, 'b.mp3')
  await mp.recordPick(proj.slug, 'EP0002', 'b.mp3')

  // Re-merge EP0002: same track, cursor unchanged.
  assert.equal((await mp.peekNext(proj.slug, 'EP0002'))?.track.filename, 'b.mp3')
  await mp.recordPick(proj.slug, 'EP0002', 'b.mp3')
  assert.equal((await mp.getPoolState(proj.slug))?.cursor, 2)
  // Re-merge EP0001 still keeps a.mp3; the next new episode gets the next track.
  assert.equal((await mp.peekNext(proj.slug, 'EP0001'))?.track.filename, 'a.mp3')
  assert.equal((await mp.peekNext(proj.slug, 'EP0003'))?.track.filename, 'c.mp3')
})

// 1.4.270 — a Pipeline merge with Background Music set to "Music Pool" and no file used to merge
// with no music at all (Night Atlas Mythology EP0001). It now gets the page's pick.
test('a Pool music setting without a file gets the pool pick, with the track\'s own levels', async () => {
  const proj = await pm.createProject({ name: 'MusicPoolPipeline' })
  const dir = path.join(pm.getProjectDir(proj.slug)!, 'music')
  await fs.mkdir(dir, { recursive: true })
  for (const name of ['a.mp3', 'b.mp3']) await fs.writeFile(path.join(dir, name), 'x')
  const base = { enabled: true, files: [] as string[], volume: 0.11, post_narration_volume: 0.4, fade_in: 3, fade_out: 5 }
  const pick = await mp.pickPoolMusic(proj.slug, 'EP0001', { ...base, source: 'pool' })
  assert.equal(pick?.track.filename, 'a.mp3')
  assert.deepEqual(pick?.music.files, [path.join(dir, 'a.mp3')])
  assert.equal(pick?.music.volume, 0.11)
  // Older presets carry no source: an empty list means the pool, as on the page.
  assert.equal((await mp.pickPoolMusic(proj.slug, 'EP0001', base))?.track.filename, 'a.mp3')
  // Named files (the page's own pick, or a hand-picked list) and music off are left alone.
  assert.equal(await mp.pickPoolMusic(proj.slug, 'EP0001', { ...base, files: ['/x.mp3'] }), null)
  assert.equal(await mp.pickPoolMusic(proj.slug, 'EP0001', { ...base, source: 'manual' }), null)
  assert.equal(await mp.pickPoolMusic(proj.slug, 'EP0001', { ...base, enabled: false, source: 'pool' }), null)
})

test('random-no-repeat picks the same track for the same episode every time (page preview = merge)', async () => {
  const proj = await pm.createProject({ name: 'MusicPoolRandom' })
  const dir = path.join(pm.getProjectDir(proj.slug)!, 'music')
  await fs.mkdir(dir, { recursive: true })
  for (const name of ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3']) await fs.writeFile(path.join(dir, name), 'x')
  await pm.updateConfig(proj.slug, { music_pool_strategy: 'random-no-repeat' } as any)
  const picks = await Promise.all(Array.from({ length: 5 }, () => mp.peekNext(proj.slug, 'EP0042')))
  assert.equal(new Set(picks.map(p => p?.track.filename)).size, 1)
})
