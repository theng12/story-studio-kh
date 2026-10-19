/**
 * The retired LLM lineup (owner, 2026-10-03): once, on load, every step whose saved
 * preset has no writing model of its own gets the lineup's choice — the Gateway pool
 * with the same members in the same order, otherwise the lineup's FIRST model. The
 * saved lineup itself is never deleted, and a project without one is left alone.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let tempDir: string
let pm: typeof import('../services/project-manager.js')
let migration: typeof import('../services/llm-lineup-migration.js')

const POOLS = [
  { id: 'pool::gemini-free-all', members: ['gemini-a', 'gemini-b'] },
  { id: 'pool::other', members: ['gemini-b', 'gemini-a'] },
]

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  pm = await import('../services/project-manager.js')
  migration = await import('../services/llm-lineup-migration.js')
})

after(async () => { await cleanup() })

async function projectWith(name: string, lineup: unknown) {
  const project = await pm.createProject({ name })
  await pm.updateConfig(project.slug, {
    ...(lineup === undefined ? {} : { llm_lineup: lineup }),
    research_presets: [{ id: 'r1', name: 'Research', type: 'research', data: { form: { research_mode: 'model-knowledge', source_model: '' } } }],
    research_last_preset_research: 'r1',
    script_presets: [{ id: 's1', name: 'Script', type: 'script', data: { form: { model: 'my-script-model' } } }],
    script_last_preset_script: 's1',
    metadata_presets: [{ id: 'm1', name: 'Metadata', data: { sections: [] } }],
    metadata_last_preset: 'm1',
  } as any)
  return project.slug
}

async function rawConfig(slug: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(tempDir, 'projects', slug, 'config.json'), 'utf8'))
}

test('a lineup matching a Gateway pool keeps that pool for every step without a model of its own', async () => {
  const slug = await projectWith('Pool match', { enabled: true, models: ['gemini-a', 'genstudio-chat:gemini-b'], prefer_savings: true })
  const record = await migration.migrateRetiredLlmLineup(slug, async () => POOLS)
  assert.equal(record?.model, 'pool::gemini-free-all')
  assert.equal(record?.pool, true)
  // A new channel is seeded with the model-less "Owner standard pacing" Scene Plan preset
  // (1.4.327), so Scene Plan is a step without a model of its own too.
  assert.deepEqual(record?.steps, ['Research', 'YouTube Finalizer', 'Scene Plan'])
  const config = await rawConfig(slug)
  assert.equal(config.research_presets[0].data.form.source_model, 'pool::gemini-free-all')
  assert.equal(config.metadata_presets[0].data.model, 'pool::gemini-free-all')
  assert.equal(config.script_presets[0].data.form.model, 'my-script-model', 'a step with its own model keeps it')
  assert.deepEqual(config.llm_lineup.models, ['gemini-a', 'genstudio-chat:gemini-b'], 'the saved lineup stays on disk')
})

test('a lineup with no matching pool keeps its FIRST model', async () => {
  const slug = await projectWith('First model', { enabled: true, models: ['gemini-a', 'gemini-c'], prefer_savings: true })
  const record = await migration.migrateRetiredLlmLineup(slug, async () => POOLS)
  assert.equal(record?.model, 'gemini-a')
  assert.equal(record?.pool, false)
  assert.equal((await rawConfig(slug)).research_presets[0].data.form.source_model, 'gemini-a')
})

test('no lineup, or a switched-off one, changes nothing', async () => {
  for (const lineup of [undefined, { enabled: false, models: ['gemini-a'], prefer_savings: true }]) {
    const slug = await projectWith(`No lineup ${String(!!lineup)}`, lineup)
    const before = await rawConfig(slug)
    let asked = false
    assert.equal(await migration.migrateRetiredLlmLineup(slug, async () => { asked = true; return POOLS }), null)
    assert.equal(asked, false, 'the Gateway is not even asked')
    assert.deepEqual(await rawConfig(slug), before)
  }
})

test('it runs once: the record is kept, and an unreachable Gateway is retried later instead of guessed', async () => {
  const slug = await projectWith('Once', { enabled: true, models: ['gemini-a', 'gemini-b'], prefer_savings: true })
  assert.equal(await migration.migrateRetiredLlmLineup(slug, async () => null), null)
  assert.equal((await rawConfig(slug)).llm_lineup_migration, undefined)

  const other = await projectWith('Once reachable', { enabled: true, models: ['gemini-a', 'gemini-b'], prefer_savings: true })
  const first = await migration.migrateRetiredLlmLineup(other, async () => POOLS)
  const second = await migration.migrateRetiredLlmLineup(other, async () => { throw new Error('must not ask again') })
  assert.deepEqual(second, first)
})

test('opening the project runs the migration, and closing the notice keeps it closed', async () => {
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const app = (await import('../app.js')).app
  // No Gateway API Key in this sandbox, so no pools are visible: the first model is kept.
  const slug = await projectWith('Opened', { enabled: true, models: ['gemini-a', 'gemini-b'], prefer_savings: true })
  const opened = await request(app).get(`/api/projects/${slug}/settings/config`)
  assert.equal(opened.status, 200)
  assert.equal(opened.body.llm_lineup, undefined, 'the lineup is never served again')
  assert.equal(opened.body.llm_lineup_migration.model, 'gemini-a')
  assert.equal(opened.body.llm_lineup_migration.notice_dismissed_at, undefined)

  // An older client cannot write the lineup or the record back.
  await request(app).put(`/api/projects/${slug}/settings/config`).send({ llm_lineup: { enabled: true, models: ['x'] }, llm_lineup_migration: null })
  assert.deepEqual((await rawConfig(slug)).llm_lineup.models, ['gemini-a', 'gemini-b'])

  const dismissed = await request(app).post(`/api/projects/${slug}/settings/llm-lineup-notice/dismiss`)
  assert.equal(dismissed.status, 200)
  const reopened = await request(app).get(`/api/projects/${slug}/settings/config`)
  assert.match(reopened.body.llm_lineup_migration.notice_dismissed_at, /^\d{4}-/)
  assert.equal(reopened.body.llm_lineup_migration.model, 'gemini-a')
})
