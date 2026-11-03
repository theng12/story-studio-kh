/**
 * 1.4.281 — two answers an agent can trust from one request.
 *
 * Paid replacements: the owner's rule is that the only paid use is LLM API calls. All four switches
 * are off unless this install saved them on; one route returns all four, and run-batch / preflight
 * say when any is on. Settings config: a PUT names what it saved and what it did not save, and why.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let app: any
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let wasQueuePaused = false

before(async () => {
  ;({ cleanup } = await useTempDataDir())
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;({ app } = await import('../app.js'))
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  wasQueuePaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
})

after(async () => {
  for (const project of await pm.listProjects()) {
    for (const job of await jq.getJobs(project.slug)) {
      if (!['done', 'error', 'cancelled'].includes(job.status)) await jq.requestJobCancellation(project.slug, job.job_id)
      jq.removeTerminalJob(project.slug, job.job_id)
    }
  }
  await jq._waitForJobPersistenceForTesting()
  if (!wasQueuePaused) await jq.setQueuePaused(false)
  assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true)
  await cleanup()
})

const off = { enabled: false }

test('every paid replacement is off until saved on, and one route returns all four', async () => {
  await request(app).get('/api/app-settings/paid-replacements')
    .expect(200, { image: off, subtitle: off, audio: off, writing: off })
  await request(app).put('/api/app-settings/paid-audio-replacement').send({ enabled: true, additional_credit_ceiling: 20 }).expect(200)
  await request(app).get('/api/app-settings/paid-replacements')
    .expect(200, { image: off, subtitle: off, audio: { enabled: true }, writing: off })
  await request(app).put('/api/app-settings/paid-audio-replacement').send(off).expect(200)
})

test('preflight and run-batch say when a paid replacement is on', async () => {
  const project = await pm.createProject({ name: 'Paid fallbacks warning' })
  const body = { episode_ids: ['EP0001'], steps: ['metadata'] }
  const preflight = () => request(app).post(`/api/projects/${project.slug}/pipeline/preflight`).send(body)
  const runBatch = () => request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body)

  const quiet = await preflight()
  assert.ok([200, 422].includes(quiet.status), JSON.stringify(quiet.body))
  assert.equal(quiet.body.paid_fallbacks_enabled, undefined)

  await request(app).put('/api/app-settings/paid-audio-replacement').send({ enabled: true, additional_credit_ceiling: 20 }).expect(200)
  await request(app).put('/api/app-settings/paid-writing-replacement').send({ enabled: true, additional_credit_ceiling: 5 }).expect(200)
  try {
    const warned = await preflight()
    assert.deepEqual(warned.body.paid_fallbacks_enabled, ['audio', 'writing'], JSON.stringify(warned.body))
    // Refused here (no accepted episode); a started batch (201) carries the same field.
    const batch = await runBatch()
    assert.equal(batch.status, 400, JSON.stringify(batch.body))
    assert.deepEqual(batch.body.paid_fallbacks_enabled, ['audio', 'writing'])
  } finally {
    await request(app).put('/api/app-settings/paid-audio-replacement').send(off).expect(200)
    await request(app).put('/api/app-settings/paid-writing-replacement').send(off).expect(200)
  }
})

test('a settings save names what it applied and what it ignored, and why', async () => {
  const project = await pm.createProject({ name: 'Config response' })
  const res = await request(app).put(`/api/projects/${project.slug}/settings/config`).send({
    metadata_last_preset: 'kept',
    image_models: { a: { name: 'A' } },
    audio_models: { tts: {} },
    models: [{ id: 'old' }],
    image_concurrency: 4,
  }).expect(200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.applied, ['metadata_last_preset', 'image_models'])
  assert.deepEqual(res.body.ignored, [
    { key: 'audio_models', reason: 'retired: GenStudio is the only voice catalog; choose voices in Audio' },
    { key: 'models', reason: 'retired: custom model storage was removed; models come from GenStudio' },
    { key: 'image_concurrency', reason: 'use PUT /app-settings/concurrency' },
  ])
  const config = await pm.getConfig(project.slug) as Record<string, unknown>
  assert.equal(config.metadata_last_preset, 'kept')
  assert.equal(config.models, undefined)
  assert.notDeepEqual(config.audio_models, { tts: {} })
})

test('a style selection saves the other keys of the same body too, and says so', async () => {
  const project = await pm.createProject({ name: 'Config response with a style' })
  const res = await request(app).put(`/api/projects/${project.slug}/settings/config`).send({
    style_presets: [{ id: 'my-look', name: 'My look', description: 'Soft gouache, warm light.', created_at: '2026-08-25T00:00:00Z' }],
    active_style_preset_id: 'my-look',
    metadata_last_preset: 'kept-with-style',
    models: [],
  }).expect(200)
  assert.deepEqual(res.body.applied, ['style_presets', 'active_style_preset_id', 'metadata_last_preset'])
  assert.deepEqual(res.body.ignored.map((i: { key: string }) => i.key), ['models'])
  const config = await pm.getConfig(project.slug) as Record<string, unknown>
  assert.equal(config.active_style_preset_id, 'my-look')
  assert.equal(config.metadata_last_preset, 'kept-with-style')
})
