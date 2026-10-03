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
