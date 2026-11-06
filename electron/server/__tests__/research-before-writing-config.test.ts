import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

test('research before writing defaults by formula, persists independently and never backfills files', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const pm = await import('../services/project-manager.js')
  const niches = await import('../services/niche-loader.js')
  const { researchBeforeWritingEnabled } = await import('../lib/research-before-writing.js')
  const { router } = await import('../routes/settings.js')
  const app = express().use(express.json()).use('/api', router)
  const channel = await pm.createProject({ name: 'Research channel', episode_prefix: 'RC', episode_digits: 4 } as any)
  const configPath = path.join(pm.getProjectDir(channel.slug)!, 'config.json')
  const original = await fs.readFile(configPath, 'utf8')
  assert.equal(await researchBeforeWritingEnabled(channel.slug, {}), true)
  assert.equal((await pm.getSafeConfig(channel.slug)).research_before_writing, true)
  assert.equal(await fs.readFile(configPath, 'utf8'), original)

  const endpoint = `/api/projects/${channel.slug}/settings/config`
  for (const value of ['false', null, 0, {}]) {
    assert.equal((await request(app).put(endpoint).send({ research_before_writing: value })).status, 400)
  }
  await pm.updateConfig(channel.slug, { pipeline_last_steps: ['script-only'] } as any)
  for (const enabled of [false, true]) {
    const response = await request(app).put(endpoint).send({ research_before_writing: enabled })
    assert.equal(response.status, 200)
    assert.ok(response.body.applied.includes('research_before_writing'))
    const config = await pm.getConfig(channel.slug)
    assert.equal(config!.research_before_writing, enabled)
    assert.deepEqual((config as any).pipeline_last_steps, ['script-only'])
    assert.equal((await pm.getSafeConfig(channel.slug)).research_before_writing, enabled)
  }

  const legacyId = 'user:9388c497-e3a1-4faa-9334-f86deead2efe'
  const source = JSON.parse(await fs.readFile(new URL('../niches/music-mix.json', import.meta.url), 'utf8'))
  await niches.ensureNichesDir()
  await fs.writeFile(niches.nicheFilePath(legacyId), JSON.stringify({ ...source, id: legacyId }))
  const music = await pm.createProject({ name: 'A renamed music channel', episode_prefix: 'MU', episode_digits: 4 } as any)
  const musicDir = pm.getProjectDir(music.slug)!
  const metaPath = path.join(musicDir, 'project.json')
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
  await fs.writeFile(metaPath, JSON.stringify({ ...meta, niche_id: legacyId }))
  const musicConfigPath = path.join(musicDir, 'config.json')
  const originalMusic = await fs.readFile(musicConfigPath, 'utf8')
  assert.equal(await researchBeforeWritingEnabled(music.slug, {}), false)
  assert.equal((await pm.getSafeConfig(music.slug)).research_before_writing, false)
  assert.equal(await fs.readFile(musicConfigPath, 'utf8'), originalMusic)
  assert.equal(await researchBeforeWritingEnabled(music.slug, { research_before_writing: true }), true)
})
