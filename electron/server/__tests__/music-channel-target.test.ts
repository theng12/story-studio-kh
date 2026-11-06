import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

test('Coffee Jazz legacy formula resolves as music; channel targets affect future mixes only', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const pm = await import('../services/project-manager.js')
  const niches = await import('../services/niche-loader.js')
  const music = await import('../services/music-episode-store.js')
  const { router } = await import('../routes/music-episode.js')
  const app = express().use(express.json()).use('/api', router)
  const legacyId = 'user:9388c497-e3a1-4faa-9334-f86deead2efe'
  const source = JSON.parse(await fs.readFile(new URL('../niches/music-mix.json', import.meta.url), 'utf8'))
  await niches.ensureNichesDir()
  await fs.writeFile(niches.nicheFilePath(legacyId), JSON.stringify({ ...source, id: legacyId }))
  const project = await pm.createProject({ name: 'Coffee Jazz', episode_prefix: 'CJ', episode_digits: 4 } as any)
  const dir = pm.getProjectDir(project.slug)!
  const metaPath = path.join(dir, 'project.json')
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
  await fs.writeFile(metaPath, JSON.stringify({ ...meta, niche_id: legacyId }))
  const originalMeta = await fs.readFile(metaPath, 'utf8')
  assert.equal((await niches.loadLegacyNiche(legacyId))?.source, 'legacy-user-fork')
  assert.equal(await niches.loadLegacyNiche(`${legacyId}/../../config`), null)
  assert.equal(await niches.loadLegacyNiche('user:../config'), null)
  assert.equal(await niches.loadLegacyNiche('user:not-a-uuid'), null)
  assert.equal((await music.channelStartingSettings(project.slug)).music_channel, true)
  assert.equal(await fs.readFile(metaPath, 'utf8'), originalMeta)

  await fs.writeFile(path.join(dir, 'ideas.json'), JSON.stringify({ ideas: [{ id: 'old-mix', title: 'Saved mix', status: 'accepted', episode_code: 'CJ0001' }], next_episode_number: 2, recycled_numbers: [] }))
  const oldDoc = await music.newEpisodeDoc(project.slug, 'CJ0001')
  oldDoc.settings.target_length_s = 3900
  oldDoc.songs = [{ pool_id: 'saved-pool', song_id: 'saved-song' }]
  const episodeDir = await music.episodeDirFor(project.slug, 'CJ0001')
  await fs.mkdir(episodeDir, { recursive: true })
  const savedPath = path.join(episodeDir, music.MUSIC_EPISODE_FILENAME)
  await fs.writeFile(savedPath, JSON.stringify(oldDoc))
  const originalEpisode = await fs.readFile(savedPath, 'utf8')
  const endpoint = `/api/projects/${project.slug}/music-episodes/channel-settings`
  for (const target_length_s of [0, 21_601, 90.5, '9000', null]) {
    assert.equal((await request(app).put(endpoint).send({ target_length_s })).status, 400)
  }
  const saved = await request(app).put(endpoint).send({ target_length_s: 9000 })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.music_channel, true)
  assert.equal(saved.body.channel_settings.target_length_s, 9000)
  assert.equal((await pm.getConfig(project.slug))?.music_episode_target_length_s, 9000)
  assert.equal((await pm.getSafeConfig(project.slug))?.music_episode_target_length_s, 9000)
  assert.equal((await music.newEpisodeDoc(project.slug, 'CJ0002')).settings.target_length_s, 9000)
  const existing = await music.readEpisodeDoc(project.slug, 'CJ0001')
  assert.equal(existing?.settings.target_length_s, 3900)
  assert.deepEqual(existing?.songs, oldDoc.songs)
  assert.equal(await fs.readFile(savedPath, 'utf8'), originalEpisode)
  const list = await request(app).get(`/api/projects/${project.slug}/music-episodes`)
  assert.equal(list.status, 200)
  assert.equal(list.body.channel_settings.target_length_s, 9000)
  assert.equal((await request(app).put(endpoint).send({ target_length_s: 7200 })).status, 200)
  assert.equal((await music.newEpisodeDoc(project.slug, 'CJ0002')).settings.target_length_s, 7200)
  assert.equal(await fs.readFile(savedPath, 'utf8'), originalEpisode)
})
