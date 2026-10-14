import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { buildGenStudioMusicIdempotencyKey, clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import { freshActionFingerprint } from '../lib/fresh-generation-action.js'

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let service: MockGenStudioService
let app: any
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let sp: typeof import('../services/song-pool.js')

before(async () => {
  isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  service = await startMockGenStudioService()
  app = (await import('../app.js')).app
  ;[jq, pm, sp] = await Promise.all([
    import('../services/job-queue.js'), import('../services/project-manager.js'), import('../services/song-pool.js'),
  ])
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)
})

after(async () => {
  await jq?._waitForJobPersistenceForTesting()
  await service?.close()
  await isolated?.cleanup()
})

beforeEach(() => {
  service.reset()
  clearGenStudioCatalogCache()
})

function brief(seed = 41) {
  return {
    ensemble: 'Cello quartet', mood: 'calm', tempo_band: 'slow', tempo_bpm: 72, key: 'D minor',
    structure: 'AABA', texture: 'warm', theme: 'Rain', length_s: 60, energy: 2,
    combo_key: `cello-calm-${seed}`, seed, title: `Cedar ${seed}`,
    line: 'Rain rests on cedar', scene_idea: 'A quiet window', prompt: 'Warm cello quartet, calm rain, 72 BPM',
  }
}

async function stoppedSource(slug: string, options: { corruptKey?: boolean; mixedOnly?: boolean; pendingOnly?: boolean } = {}) {
  const batchId = `b_source_${Math.random().toString(36).slice(2, 10)}`
  const itemBrief = brief()
  const requestIdentity = `${slug}:song-pool:${batchId}:song-0:${itemBrief.seed}`
  const musicRequest = {
    title: itemBrief.title, prompt: itemBrief.prompt, instrumental: true,
    duration_seconds: 60, model_id: 'mock-music-v1', seed: itemBrief.seed,
    request_identity: requestIdentity,
  }
  const key = buildGenStudioMusicIdempotencyKey({
    title: musicRequest.title, prompt: musicRequest.prompt, instrumental: true,
    durationSeconds: 60, modelId: musicRequest.model_id, seed: musicRequest.seed,
    requestIdentity,
  })
  const attempt = {
    version: 1,
    planned_item_fingerprint: freshActionFingerprint({ item_key: 'song-0', brief: itemBrief }),
    request: musicRequest,
    idempotency_key: options.corruptKey ? `${key}-wrong` : key,
    ...(options.pendingOnly ? {} : { accepted_task_id: 'music-source-task' }),
    state: 'running',
  }
  const batch = {
    batch_id: batchId, mode: 'new', writer_model: 'mock-chat-v1', created_at: new Date().toISOString(),
    items: [
      { item_key: 'song-0', cell: itemBrief, brief: itemBrief, music_attempts: [attempt] },
      { item_key: 'song-1', cell: brief(42), brief: brief(42), song_id: 'saved-song', file: 'saved.m4a' },
    ],
  }
  const dir = sp.poolDir(slug)!
  await fs.mkdir(path.join(dir, 'batches'), { recursive: true })
  const file = path.join(dir, 'batches', `${batchId}.json`)
  await fs.writeFile(file, `${JSON.stringify(batch, null, 2)}\n`)
  const restore = jq._setExecutorForTesting('music_generate', async () => { throw new Error('intentional unresolved Song Pool source') })
  try {
    const source = jq.enqueuePreparedForTest({
      project_slug: slug, type: 'music_generate', episode_id: '', title: 'Stopped Song Pool batch',
      params: { song_pool: true, mode: 'new', count: 2, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', batch_id: batchId },
    })
    await waitFor(() => jq.getJob(source.job_id)?.status === 'error', { label: 'Song Pool source to stop' })
    await waitFor(() => !jq._isJobWorkerActiveForTesting(source.job_id), { label: 'Song Pool source to unwind' })
    await jq.recordGenStudioJob(source.job_id, {
      request_key: key, id: 'chat-source-task', operation: 'chat.response', state: 'running', dispatch_state: 'dispatched',
      model_id: 'mock-chat-v1', updated_at: new Date().toISOString(),
    })
    await jq.recordGenStudioJob(source.job_id, {
      request_key: key, id: 'transcription-source-task', operation: 'audio.transcription', state: 'running', dispatch_state: 'dispatched',
      model_id: 'mock-stt-v1', updated_at: new Date().toISOString(),
    })
    if (!options.mixedOnly) {
      await jq.recordGenStudioJob(source.job_id, {
        request_key: key, id: options.pendingOnly ? `pending:${key}` : 'music-source-task', operation: 'music.generation',
        state: options.pendingOnly ? 'submitting' : 'running', dispatch_state: 'dispatched',
        ...(options.pendingOnly ? { recovery_required: true, request: {
          method: 'POST', path: '/v1/music/jobs', captured_at: new Date().toISOString(), idempotency_key: key,
        } } : {}),
        model_id: 'mock-music-v1', updated_at: new Date().toISOString(),
      })
    }
    await jq._waitForJobPersistenceForTesting()
    return { source: jq.getJob(source.job_id)!, batch, file, key }
  } finally {
    restore()
  }
}

function manualBody(sourceJobId: string, operationId: string) {
  return {
    operation_id: operationId,
    music_model: 'mock-music-v1',
    source_item_key: 'song-0',
    manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
    manual_music_payment: {
      version: 1, model_id: 'mock-music-v1', price_version: 'mock-music-price-v1', confirmed_paid_music: true,
    },
  }
}

async function cleanupJobs(slug: string, ...ids: string[]) {
  for (const id of ids) {
    if (!id) continue
    const job = jq.getJob(id)
    if (job?.status === 'queued' || job?.status === 'paused') await jq.requestJobCancellation(slug, id)
    const stopped = jq.getJob(id)
    if (stopped && ['done', 'error', 'cancelled'].includes(stopped.status)) jq.removeTerminalJob(slug, id)
  }
}

test('safe source summaries expose only exact unresolved Song Pool music items', async () => {
  const project = await pm.createProject({ name: 'Song Pool source summaries' })
  const exact = await stoppedSource(project.slug)
  const corrupt = await stoppedSource(project.slug, { corruptKey: true })
  const mixed = await stoppedSource(project.slug, { mixedOnly: true })
  try {
    const response = await request(app).get(`/api/projects/${project.slug}/song-pool/manual-redo-sources`)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.ok(response.body.sources.every((row: any) => Object.keys(row).sort().join(',') === 'eligible,label,reason,source_item_key,source_job_id'))
    const exactRows = response.body.sources.filter((row: any) => row.source_job_id === exact.source.job_id)
    assert.equal(exactRows.find((row: any) => row.source_item_key === 'song-0')?.eligible, true)
    assert.equal(exactRows.find((row: any) => row.source_item_key === 'song-1')?.eligible, false)
    assert.equal(response.body.sources.find((row: any) => row.source_job_id === corrupt.source.job_id)?.eligible, false)
    assert.equal(response.body.sources.find((row: any) => row.source_job_id === mixed.source.job_id)?.eligible, false)
    assert.equal(JSON.stringify(response.body).includes(exact.key), false)
    assert.equal(JSON.stringify(response.body).includes('music-source-task'), false)
  } finally {
    await cleanupJobs(project.slug, exact.source.job_id, corrupt.source.job_id, mixed.source.job_id)
  }
})

test('a durable pre-submit receipt plus exact pending key is eligible without a fabricated task id', async () => {
  const project = await pm.createProject({ name: 'Song Pool pending receipt source' })
  const pending = await stoppedSource(project.slug, { pendingOnly: true })
  try {
    const response = await request(app).get(`/api/projects/${project.slug}/song-pool/manual-redo-sources`)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.sources.find((row: any) => row.source_job_id === pending.source.job_id)?.eligible, true)
  } finally {
    await cleanupJobs(project.slug, pending.source.job_id)
  }
})

test('one exact item wins concurrent admission, preserves the source batch, and replays after source removal', async () => {
  const project = await pm.createProject({ name: 'Song Pool exact music replacement' })
  const source = await stoppedSource(project.slug)
  const sourceBytes = await fs.readFile(source.file)
  const sourceEvidence = structuredClone(source.source.genstudio_jobs)
  const wasPaused = jq.isQueuePaused()
  const operationId = '73000000-0000-4000-8000-000000000073'
  const body = manualBody(source.source.job_id, operationId)
  let replacementId = ''
  try {
    await jq.setQueuePaused(true)
    const [left, right] = await Promise.all([
      request(app).post(`/api/projects/${project.slug}/song-pool/generate`).send(body),
      request(app).post(`/api/projects/${project.slug}/song-pool/generate`).send(body),
    ])
    assert.deepEqual([left.status, right.status].sort(), [200, 201], `${JSON.stringify(left.body)}\n${JSON.stringify(right.body)}`)
    assert.equal(left.body.job_id, right.body.job_id)
    replacementId = left.body.job_id
    const replacement = jq.getJob(replacementId)!
    assert.equal(replacement.params.mode, 'manual-redo')
    assert.equal(replacement.params.count, 1)
    assert.equal(replacement.params.manual_song_pool_item.source_item_key, 'song-0')
    assert.equal(replacement.params.manual_song_pool_item.brief.title, 'Cedar 41')
    assert.equal(replacement.params.manual_redo.lane, 'song-pool')
    assert.ok(jq.getJob(source.source.job_id)?.force_abandoned)
    assert.deepEqual(jq.getJob(source.source.job_id)?.genstudio_jobs, sourceEvidence)
    assert.deepEqual(await fs.readFile(source.file), sourceBytes)
    assert.equal(service.providerSubmissionCount(), 0)

    const changed = await request(app).post(`/api/projects/${project.slug}/song-pool/generate`).send({
      ...body, music_model: 'another-music-model',
      manual_music_payment: { ...body.manual_music_payment, model_id: 'another-music-model' },
    })
    assert.equal(changed.status, 409, JSON.stringify(changed.body))
    assert.equal(jq.removeTerminalJob(project.slug, source.source.job_id), true)
    const replay = await request(app).post(`/api/projects/${project.slug}/song-pool/generate`).send(body)
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.job_id, replacementId)
    const jobs = await jq.findJobs(project.slug, job => job.params?.generation_action?.id === operationId)
    assert.equal(jobs.length, 1)
  } finally {
    await cleanupJobs(project.slug, replacementId, source.source.job_id)
    await jq.setQueuePaused(wasPaused)
  }
})

test('missing paid acknowledgement and forged exact evidence refuse without source mutation', async () => {
  const project = await pm.createProject({ name: 'Song Pool exact music refusals' })
  const exact = await stoppedSource(project.slug)
  const corrupt = await stoppedSource(project.slug, { corruptKey: true })
  const beforeExact = structuredClone(exact.source)
  const beforeCorrupt = structuredClone(corrupt.source)
  try {
    const unpaid = manualBody(exact.source.job_id, '74000000-0000-4000-8000-000000000074')
    unpaid.manual_music_payment.confirmed_paid_music = false
    const unpaidResponse = await request(app).post(`/api/projects/${project.slug}/song-pool/generate`).send(unpaid)
    assert.equal(unpaidResponse.status, 409, JSON.stringify(unpaidResponse.body))
    const forgedResponse = await request(app).post(`/api/projects/${project.slug}/song-pool/generate`)
      .send(manualBody(corrupt.source.job_id, '75000000-0000-4000-8000-000000000075'))
    assert.equal(forgedResponse.status, 409, JSON.stringify(forgedResponse.body))
    assert.equal(jq.getJob(exact.source.job_id)?.force_abandoned, undefined)
    assert.equal(jq.getJob(corrupt.source.job_id)?.force_abandoned, undefined)
    assert.deepEqual(jq.getJob(exact.source.job_id)?.genstudio_jobs, beforeExact.genstudio_jobs)
    assert.deepEqual(jq.getJob(corrupt.source.job_id)?.genstudio_jobs, beforeCorrupt.genstudio_jobs)
    assert.equal(service.providerSubmissionCount(), 0)
  } finally {
    await cleanupJobs(project.slug, exact.source.job_id, corrupt.source.job_id)
  }
})
