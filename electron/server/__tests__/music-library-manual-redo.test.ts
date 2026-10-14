import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { buildGenStudioMusicIdempotencyKey, clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import { siblingGroupForJob } from '../services/music-library.js'

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let service: MockGenStudioService
let app: any
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

const MODEL = 'mock-music-v1'
const PRICE_VERSION = 'mock-music-price-v1'

before(async () => {
  isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  service = await startMockGenStudioService()
  app = (await import('../app.js')).app
  ;[jq, pm] = await Promise.all([
    import('../services/job-queue.js'),
    import('../services/project-manager.js'),
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

function receipt(options: {
  slug: string
  briefId: string
  itemKey: string
  taskId?: string
  title?: string
  prompt?: string
  lyrics?: string
  retryFromTaskId?: string
}) {
  const index = Number(options.itemKey.slice('track-'.length))
  const taskId = options.taskId || `music-${options.itemKey}`
  const plan = {
    title: options.title || 'Rain on Cedar',
    prompt: options.prompt || 'Warm felt piano, rain, 80bpm',
    tags: ['rain', 'piano'],
    ...(options.lyrics ? { lyrics: options.lyrics } : {}),
  }
  const normalizedRequest = {
    title: plan.title,
    prompt: plan.prompt,
    ...(options.lyrics ? { lyrics: options.lyrics } : {}),
    instrumental: !options.lyrics,
    duration_seconds: 180,
    model_id: MODEL,
  }
  const requestIdentity = `${options.slug}:music:${options.briefId}:${index}`
    + (options.retryFromTaskId ? `:${siblingGroupForJob(options.retryFromTaskId)}` : '')
  return {
    item_key: options.itemKey,
    index,
    plan,
    request: normalizedRequest,
    request_identity: requestIdentity,
    idempotency_key: buildGenStudioMusicIdempotencyKey({
      title: normalizedRequest.title,
      prompt: normalizedRequest.prompt,
      lyrics: normalizedRequest.lyrics,
      instrumental: normalizedRequest.instrumental,
      durationSeconds: normalizedRequest.duration_seconds,
      modelId: normalizedRequest.model_id,
      requestIdentity,
    }),
    accepted_task_id: taskId,
    state: 'running',
  }
}

async function stoppedSource(options: {
  slug: string
  itemKey?: string
  evidenceKey?: string
  songPool?: boolean
  title?: string
  prompt?: string
  lyrics?: string
  retryFromTaskId?: string
  mutateReceipt?: (value: ReturnType<typeof receipt>) => void
  conflictingEvidenceTaskId?: string
}) {
  const itemKey = options.itemKey || 'track-0'
  const briefId = `brief-${itemKey}`
  const taskId = `music-${itemKey}`
  const savedReceipt = receipt({
    slug: options.slug,
    briefId,
    itemKey,
    taskId,
    title: options.title,
    prompt: options.prompt,
    lyrics: options.lyrics,
    retryFromTaskId: options.retryFromTaskId,
  })
  options.mutateReceipt?.(savedReceipt)
  const restore = jq._setExecutorForTesting('music_generate', async () => {
    throw new Error('intentional unresolved music source')
  })
  try {
    const source = jq.enqueuePreparedForTest({
      project_slug: options.slug,
      type: 'music_generate',
      episode_id: '',
      title: 'Stopped Music Library top-up',
      params: {
        brief: 'rainy piano', brief_id: briefId, model: MODEL,
        instrumental: !options.lyrics, duration_seconds: 180, auto_retry: false,
        ...(options.songPool ? { song_pool: true } : {}),
        music_library_items: { version: 1, items: [savedReceipt] },
      },
    })
    await waitFor(() => jq.getJob(source.job_id)?.status === 'error', { label: 'music source to stop' })
    await waitFor(() => !jq._isJobWorkerActiveForTesting(source.job_id), { label: 'music source executor to unwind' })
    await jq.recordGenStudioJob(source.job_id, {
      request_key: options.evidenceKey || savedReceipt.idempotency_key,
      id: taskId,
      operation: 'music.generation',
      state: 'running',
      dispatch_state: 'dispatched',
      model_id: MODEL,
      updated_at: new Date().toISOString(),
    })
    if (options.conflictingEvidenceTaskId) {
      await jq.recordGenStudioJob(source.job_id, {
        request_key: savedReceipt.idempotency_key,
        id: options.conflictingEvidenceTaskId,
        operation: 'music.generation',
        state: 'running',
        dispatch_state: 'dispatched',
        model_id: MODEL,
        updated_at: new Date().toISOString(),
      })
    }
    await jq._waitForJobPersistenceForTesting()
    return jq.getJob(source.job_id)!
  } finally {
    restore()
  }
}

async function stoppedSourceWithTwoItems(slug: string) {
  const briefId = 'brief-two-items'
  const first = receipt({ slug, briefId, itemKey: 'track-0' })
  const second = receipt({ slug, briefId, itemKey: 'track-1' })
  const restore = jq._setExecutorForTesting('music_generate', async () => {
    throw new Error('intentional unresolved multi-item music source')
  })
  try {
    const source = jq.enqueuePreparedForTest({
      project_slug: slug,
      type: 'music_generate',
      episode_id: '',
      title: 'Stopped multi-item Music Library top-up',
      params: {
        brief: 'rainy piano', brief_id: 'brief-two-items', model: MODEL,
        instrumental: true, duration_seconds: 180, auto_retry: false,
        music_library_items: {
          version: 1,
          items: [first, second],
        },
      },
    })
    await waitFor(() => jq.getJob(source.job_id)?.status === 'error', { label: 'multi-item music source to stop' })
    await waitFor(() => !jq._isJobWorkerActiveForTesting(source.job_id), { label: 'multi-item music source to unwind' })
    for (const [key, taskId] of [[first.idempotency_key, 'music-track-0'], [second.idempotency_key, 'music-track-1']] as const) {
      await jq.recordGenStudioJob(source.job_id, {
        request_key: key,
        id: taskId,
        operation: 'music.generation',
        state: 'running',
        dispatch_state: 'dispatched',
        model_id: MODEL,
        updated_at: new Date().toISOString(),
      })
    }
    await jq._waitForJobPersistenceForTesting()
    return jq.getJob(source.job_id)!
  } finally {
    restore()
  }
}

function publishedMusicModel(overrides: Record<string, unknown> = {}) {
  return {
    id: MODEL,
    display_name: 'Mock Music',
    provider_name: 'Gateway mock',
    description: 'Published test music model.',
    coming_soon: false,
    credits_per_request: 13,
    minimum_credits: 13,
    price_version: PRICE_VERSION,
    standard_credits: 13,
    sale_credits: null,
    sale_ends_at: null,
    sale_disclaimer: null,
    supports_instrumental: true,
    supports_vocals: true,
    requires_lyrics: false,
    max_prompt_characters: 500,
    max_prompt_without_lyrics_characters: 500,
    min_prompt_characters: 1,
    max_lyrics_characters: 5_000,
    min_lyrics_characters: 0,
    max_title_characters: 80,
    outputs_per_request: 1,
    ...overrides,
  }
}

async function withPublishedMusicModels<T>(rows: Record<string, unknown>[], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  clearGenStudioCatalogCache()
  globalThis.fetch = async (input, init) => String(input).endsWith('/v1/music/models')
    ? Response.json(rows)
    : originalFetch(input, init)
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
}

function manualBody(sourceJobId: string, itemKey: string, operationId: string) {
  return {
    operation_id: operationId,
    model: MODEL,
    instrumental: true,
    duration_seconds: 180,
    source_item_key: itemKey,
    manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
    manual_music_payment: {
      version: 1,
      model_id: MODEL,
      price_version: PRICE_VERSION,
      confirmed_paid_music: true,
    },
  }
}

async function cleanupJobs(slug: string, ...jobIds: string[]) {
  for (const jobId of jobIds) {
    if (!jobId) continue
    const job = jq.getJob(jobId)
    if (job?.status === 'queued' || job?.status === 'paused') await jq.requestJobCancellation(slug, jobId)
    const terminal = jq.getJob(jobId)
    if (terminal && ['done', 'error', 'cancelled'].includes(terminal.status)) jq.removeTerminalJob(slug, jobId)
  }
}

test('safe source summaries require one exact Library receipt and matching unresolved music evidence', async () => {
  const project = await pm.createProject({ name: 'Music source summaries' })
  const exact = await stoppedSource({ slug: project.slug, retryFromTaskId: 'settled-fleet-task' })
  const wrongEvidence = await stoppedSource({ slug: project.slug, evidenceKey: 'another-key' })
  const pool = await stoppedSource({ slug: project.slug, songPool: true })
  try {
    const response = await request(app).get(`/api/projects/${project.slug}/music-library/manual-redo-sources`)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(Object.keys(response.body.sources[0]).sort(),
      ['eligible', 'label', 'reason', 'source_item_key', 'source_job_id'])
    const byJob = new Map(response.body.sources.map((row: any) => [row.source_job_id, row]))
    assert.equal((byJob.get(exact.job_id) as any)?.eligible, true)
    assert.equal((byJob.get(wrongEvidence.job_id) as any)?.eligible, false)
    assert.match(String((byJob.get(wrongEvidence.job_id) as any)?.reason), /evidence/i)
    assert.equal((byJob.get(pool.job_id) as any)?.eligible, false)
    assert.match(String((byJob.get(pool.job_id) as any)?.reason), /Song Pool/i)
    assert.equal(JSON.stringify(response.body).includes('story-music-source'), false, 'request keys stay server-side')
    assert.equal(JSON.stringify(response.body).includes('music-track'), false, 'provider task ids stay server-side')
  } finally {
    await cleanupJobs(project.slug, exact.job_id, wrongEvidence.job_id, pool.job_id)
  }
})

test('corrupt or contradictory saved receipts are never eligible and cannot abandon their source', async () => {
  const wasPaused = jq.isQueuePaused()
  const cases: Array<{
    name: string
    mutateReceipt?: (value: ReturnType<typeof receipt>) => void
    conflictingEvidenceTaskId?: string
  }> = [
    { name: 'changed plan prompt', mutateReceipt: value => { value.plan.prompt = 'A different paid prompt' } },
    { name: 'changed plan lyrics', mutateReceipt: value => { value.plan.lyrics = '[Verse]\nContradictory words' } },
    { name: 'changed normalized request', mutateReceipt: value => { value.request.prompt = 'A request that no longer owns this key' } },
    { name: 'changed provider key', mutateReceipt: value => { value.idempotency_key = 'story-music-fabricated-key' } },
    { name: 'foreign request namespace', mutateReceipt: value => { value.request_identity = 'another-project:music:foreign-brief:0' } },
    { name: 'same key owned by another task', conflictingEvidenceTaskId: 'music-conflicting-owner' },
  ]
  try {
    for (const [index, example] of cases.entries()) {
      await jq.setQueuePaused(false)
      const project = await pm.createProject({ name: `Music receipt refusal ${index}` })
      const source = await stoppedSource({
        slug: project.slug,
        mutateReceipt: example.mutateReceipt,
        conflictingEvidenceTaskId: example.conflictingEvidenceTaskId,
      })
      const beforeEvidence = structuredClone(source.genstudio_jobs)
      let replacementId = ''
      try {
        await jq.setQueuePaused(true)
        const summaries = await request(app).get(`/api/projects/${project.slug}/music-library/manual-redo-sources`)
        const row = summaries.body.sources.find((candidate: any) => candidate.source_job_id === source.job_id)
        const response = await request(app)
          .post(`/api/projects/${project.slug}/music-library/generate`)
          .send(manualBody(source.job_id, 'track-0', `56000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`))
        replacementId = response.body?.job_id || ''

        assert.notEqual(row?.eligible, true, `${example.name}: ${JSON.stringify(summaries.body)}`)
        assert.equal(response.status, 409, `${example.name}: ${JSON.stringify(response.body)}`)
        assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined, example.name)
        assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, beforeEvidence, example.name)
        assert.equal(service.submissions.filter(entry => entry.operation === 'music').length, 0, example.name)
      } finally {
        await cleanupJobs(project.slug, replacementId, source.job_id)
      }
    }
  } finally {
    await jq.setQueuePaused(wasPaused)
  }
})

test('new admission refuses a known lyrics-required model before abandoning a lyric-less source', async () => {
  const project = await pm.createProject({ name: 'Music incompatible manual model' })
  const source = await stoppedSource({ slug: project.slug })
  const beforeEvidence = structuredClone(source.genstudio_jobs)
  const wasPaused = jq.isQueuePaused()
  let replacementId = ''
  try {
    await jq.setQueuePaused(true)
    await withPublishedMusicModels([
      publishedMusicModel({ requires_lyrics: true, supports_instrumental: true, supports_vocals: true }),
    ], async () => {
      const body = manualBody(source.job_id, 'track-0', '57000000-0000-4000-8000-000000000057')
      body.instrumental = false
      const response = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body)
      replacementId = response.body?.job_id || ''
      assert.equal(response.status, 409, JSON.stringify(response.body))
      assert.match(String(response.body?.detail), /lyrics|cannot make/i)
      assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
      assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, beforeEvidence)
      assert.equal(service.submissions.filter(entry => entry.operation === 'music').length, 0)
    })
  } finally {
    await cleanupJobs(project.slug, replacementId, source.job_id)
    await jq.setQueuePaused(wasPaused)
  }
})

test('new admission refuses copied source text beyond the selected model published limits before abandonment', async () => {
  const wasPaused = jq.isQueuePaused()
  const cases = [
    {
      name: 'prompt',
      source: { prompt: 'p'.repeat(21) },
      catalog: { max_prompt_characters: 20, max_prompt_without_lyrics_characters: 20 },
      instrumental: true,
      actual: 21,
      limit: 20,
    },
    {
      name: 'title',
      source: { title: 't'.repeat(11) },
      catalog: { max_title_characters: 10 },
      instrumental: true,
      actual: 11,
      limit: 10,
    },
    {
      name: 'lyrics',
      source: { lyrics: 'l'.repeat(21) },
      catalog: { max_lyrics_characters: 20, supports_vocals: true },
      instrumental: false,
      actual: 21,
      limit: 20,
    },
  ]
  try {
    for (const [index, example] of cases.entries()) {
      await jq.setQueuePaused(false)
      const project = await pm.createProject({ name: `Music selected model ${example.name} limit` })
      const source = await stoppedSource({ slug: project.slug, ...example.source })
      const beforeEvidence = structuredClone(source.genstudio_jobs)
      let replacementId = ''
      try {
        await jq.setQueuePaused(true)
        await withPublishedMusicModels([publishedMusicModel(example.catalog)], async () => {
          const body = manualBody(
            source.job_id,
            'track-0',
            `5a000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          )
          body.instrumental = example.instrumental
          const response = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body)
          replacementId = response.body?.job_id || ''
          assert.equal(response.status, 409, `${example.name}: ${JSON.stringify(response.body)}`)
          assert.match(String(response.body?.detail), new RegExp(example.name, 'i'))
          assert.match(String(response.body?.detail), new RegExp(`\\b${example.actual}\\b`))
          assert.match(String(response.body?.detail), new RegExp(`\\b${example.limit}\\b`))
          assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined, example.name)
          assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, beforeEvidence, example.name)
          assert.equal(service.submissions.filter(entry => entry.operation === 'music').length, 0, example.name)
        })
      } finally {
        await cleanupJobs(project.slug, replacementId, source.job_id)
      }
    }
  } finally {
    await jq.setQueuePaused(wasPaused)
  }
})

for (const example of [
  {
    name: 'prompt',
    source: { prompt: 'short' },
    catalog: { min_prompt_characters: 6 },
    instrumental: true,
    actual: 5,
    limit: 6,
    operationId: '5b000000-0000-4000-8000-000000000001',
  },
  {
    name: 'lyrics',
    source: { lyrics: 'la' },
    catalog: { min_lyrics_characters: 3, requires_lyrics: false, supports_vocals: true },
    instrumental: false,
    actual: 2,
    limit: 3,
    operationId: '5b000000-0000-4000-8000-000000000002',
  },
] as const) {
  test(`new admission refuses copied ${example.name} below the selected model published minimum`, async () => {
    const project = await pm.createProject({ name: `Music selected model ${example.name} minimum` })
    const source = await stoppedSource({ slug: project.slug, ...example.source })
    const beforeEvidence = structuredClone(source.genstudio_jobs)
    const wasPaused = jq.isQueuePaused()
    let replacementId = ''
    try {
      await jq.setQueuePaused(true)
      await withPublishedMusicModels([publishedMusicModel(example.catalog)], async () => {
        const body = manualBody(source.job_id, 'track-0', example.operationId)
        body.instrumental = example.instrumental
        const response = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body)
        replacementId = response.body?.job_id || ''
        assert.equal(response.status, 409, JSON.stringify(response.body))
        assert.match(String(response.body?.detail), new RegExp(example.name, 'i'))
        assert.match(String(response.body?.detail), new RegExp(`\\b${example.actual}\\b`))
        assert.match(String(response.body?.detail), new RegExp(`\\b${example.limit}\\b`))
        assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
        assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, beforeEvidence)
        assert.equal(service.submissions.filter(entry => entry.operation === 'music').length, 0)
      })
    } finally {
      await cleanupJobs(project.slug, replacementId, source.job_id)
      await jq.setQueuePaused(wasPaused)
    }
  })
}

for (const example of [
  {
    name: 'instrumental',
    catalog: { supports_instrumental: false, supports_vocals: true },
    instrumental: true,
    operationId: '5c000000-0000-4000-8000-000000000001',
  },
  {
    name: 'vocal',
    catalog: { supports_instrumental: true, supports_vocals: false },
    instrumental: false,
    operationId: '5c000000-0000-4000-8000-000000000002',
  },
] as const) {
  test(`new admission refuses a model explicitly forbidding the requested ${example.name} mode`, async () => {
    const project = await pm.createProject({ name: `Music explicit ${example.name} refusal` })
    const source = await stoppedSource({ slug: project.slug, lyrics: '[Verse]\nRain remembers' })
    const beforeEvidence = structuredClone(source.genstudio_jobs)
    const wasPaused = jq.isQueuePaused()
    let replacementId = ''
    try {
      await jq.setQueuePaused(true)
      await withPublishedMusicModels([publishedMusicModel(example.catalog)], async () => {
        const body = manualBody(source.job_id, 'track-0', example.operationId)
        body.instrumental = example.instrumental
        const response = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body)
        replacementId = response.body?.job_id || ''
        assert.equal(response.status, 409, JSON.stringify(response.body))
        assert.match(String(response.body?.detail), /cannot make/i)
        assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
        assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, beforeEvidence)
        assert.equal(service.submissions.filter(entry => entry.operation === 'music').length, 0)
      })
    } finally {
      await cleanupJobs(project.slug, replacementId, source.job_id)
      await jq.setQueuePaused(wasPaused)
    }
  })
}

test('new admission accepts a compatible vocal plan with published required-lyrics capability', async () => {
  const project = await pm.createProject({ name: 'Music compatible manual model' })
  const source = await stoppedSource({ slug: project.slug, lyrics: '[Verse]\nRain falls softly\n[Chorus]\nCedar remembers' })
  const wasPaused = jq.isQueuePaused()
  let replacementId = ''
  try {
    await jq.setQueuePaused(true)
    await withPublishedMusicModels([
      publishedMusicModel({ requires_lyrics: true, supports_instrumental: false, supports_vocals: true }),
    ], async () => {
      const body = manualBody(source.job_id, 'track-0', '58000000-0000-4000-8000-000000000058')
      body.instrumental = false
      const response = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body)
      assert.equal(response.status, 201, JSON.stringify(response.body))
      replacementId = response.body.job_id
      assert.equal(jq.getJob(replacementId)?.params?.music_library_manual_item?.plan?.lyrics,
        '[Verse]\nRain falls softly\n[Chorus]\nCedar remembers')
    })
  } finally {
    await cleanupJobs(project.slug, replacementId, source.job_id)
    await jq.setQueuePaused(wasPaused)
  }
})

test('raw published chargeable truth requires separate paid confirmation even with a local zero rate', async () => {
  const project = await pm.createProject({ name: 'Music chargeable truth' })
  const source = await stoppedSource({ slug: project.slug })
  const beforeEvidence = structuredClone(source.genstudio_jobs)
  const wasPaused = jq.isQueuePaused()
  let replacementId = ''
  try {
    await jq.setQueuePaused(true)
    await withPublishedMusicModels([
      publishedMusicModel({
        chargeable: true,
        price_source: 'local',
        price_usd: {},
        credits_per_request: 0,
        minimum_credits: 0,
        standard_credits: 0,
        sale_credits: null,
      }),
    ], async () => {
      const body = manualBody(source.job_id, 'track-0', '59000000-0000-4000-8000-000000000059')
      body.manual_music_payment.confirmed_paid_music = false
      const response = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body)
      replacementId = response.body?.job_id || ''
      assert.equal(response.status, 409, JSON.stringify(response.body))
      assert.match(String(response.body?.detail), /paid music/i)
      assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
      assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, beforeEvidence)
      assert.equal(service.submissions.filter(entry => entry.operation === 'music').length, 0)
    })
  } finally {
    await cleanupJobs(project.slug, replacementId, source.job_id)
    await jq.setQueuePaused(wasPaused)
  }
})

test('one paid exact-item action wins concurrent admission and immutable replay survives source removal', async () => {
  const project = await pm.createProject({ name: 'Music exact-item redo' })
  const source = await stoppedSource({ slug: project.slug })
  const sourceEvidence = structuredClone(source.genstudio_jobs)
  const wasPaused = jq.isQueuePaused()
  const operationId = '51000000-0000-4000-8000-000000000051'
  const body = manualBody(source.job_id, 'track-0', operationId)
  let replacementId = ''
  try {
    await jq.setQueuePaused(true)
    const [left, right] = await withPublishedMusicModels([
      publishedMusicModel({ min_lyrics_characters: 5_000 }),
    ], async () => Promise.all([
      request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body),
      request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body),
    ]))
    assert.deepEqual([left.status, right.status].sort(), [200, 201], `${JSON.stringify(left.body)}\n${JSON.stringify(right.body)}`)
    assert.equal(left.body.job_id, right.body.job_id)
    replacementId = left.body.job_id
    const replacement = jq.getJob(replacementId)!
    assert.equal(replacement.params.brief_id, operationId)
    assert.equal(replacement.params.count, 1)
    assert.equal(replacement.params.model, MODEL)
    assert.equal(replacement.params.music_library_manual_item.source_item_key, 'track-0')
    assert.equal(replacement.params.music_library_manual_item.plan.title, 'Rain on Cedar')
    assert.equal(replacement.params.manual_redo.lane, 'music-library')
    assert.ok(jq.getJob(source.job_id)?.force_abandoned)
    assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, sourceEvidence)
    assert.equal(service.submissions.filter(row => row.operation === 'music').length, 0)

    const changed = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send({
      ...body,
      duration_seconds: 240,
    })
    assert.equal(changed.status, 409, JSON.stringify(changed.body))

    assert.equal(jq.removeTerminalJob(project.slug, source.job_id), true)
    await withPublishedMusicModels([
      publishedMusicModel({
        min_prompt_characters: 5_000,
        max_prompt_characters: 5_000,
        max_prompt_without_lyrics_characters: 5_000,
        max_title_characters: 1,
      }),
    ], async () => {
      const replay = await request(app).post(`/api/projects/${project.slug}/music-library/generate`).send(body)
      assert.equal(replay.status, 200, JSON.stringify(replay.body))
      assert.equal(replay.body.job_id, replacementId)
    })
    const actionJobs = await jq.findJobs(project.slug, job => job.params?.generation_action?.id === operationId)
    assert.equal(actionJobs.length, 1)
    await jq.setQueuePaused(false)
    await waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(replacementId)?.status || ''), {
      label: 'the one accepted manual music action to finish',
    })
    assert.equal(jq.getJob(replacementId)?.status, 'done', jq.getJob(replacementId)?.error || '')
    assert.equal(service.submissions.filter(row => row.operation === 'music').length, 1,
      'concurrent admission and same-body replay still buy only one provider request')
  } finally {
    await cleanupJobs(project.slug, replacementId, source.job_id)
    await jq.setQueuePaused(wasPaused)
  }
})

test('missing paid confirmation and mismatched evidence cannot abandon the selected source', async () => {
  const project = await pm.createProject({ name: 'Music redo refusal' })
  const source = await stoppedSource({ slug: project.slug, evidenceKey: 'wrong-evidence-key' })
  const before = structuredClone(jq.getJob(source.job_id))
  try {
    const missingConfirmation = manualBody(source.job_id, 'track-0', '52000000-0000-4000-8000-000000000052')
    missingConfirmation.manual_music_payment.confirmed_paid_music = false
    const refusedPayment = await request(app)
      .post(`/api/projects/${project.slug}/music-library/generate`)
      .send(missingConfirmation)
    assert.equal(refusedPayment.status, 409, JSON.stringify(refusedPayment.body))

    const refusedEvidence = await request(app)
      .post(`/api/projects/${project.slug}/music-library/generate`)
      .send(manualBody(source.job_id, 'track-0', '53000000-0000-4000-8000-000000000053'))
    assert.equal(refusedEvidence.status, 409, JSON.stringify(refusedEvidence.body))
    assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
    assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, before?.genstudio_jobs)
    assert.equal(service.submissions.filter(row => row.operation === 'music').length, 0)
  } finally {
    await cleanupJobs(project.slug, source.job_id)
  }
})

test('an active replacement conflicts, then its selected item and siblings are eligible again after settlement', async () => {
  const project = await pm.createProject({ name: 'Music sibling redo' })
  const source = await stoppedSourceWithTwoItems(project.slug)
  const wasPaused = jq.isQueuePaused()
  let replacementId = ''
  try {
    await jq.setQueuePaused(true)
    const response = await request(app)
      .post(`/api/projects/${project.slug}/music-library/generate`)
      .send(manualBody(source.job_id, 'track-0', '54000000-0000-4000-8000-000000000054'))
    assert.equal(response.status, 201, JSON.stringify(response.body))
    replacementId = response.body.job_id
    assert.ok(jq.getJob(source.job_id)?.force_abandoned)

    const activeConflict = await request(app)
      .post(`/api/projects/${project.slug}/music-library/generate`)
      .send(manualBody(source.job_id, 'track-0', '55000000-0000-4000-8000-000000000055'))
    assert.equal(activeConflict.status, 409, JSON.stringify(activeConflict.body))
    assert.deepEqual(jq.getJob(source.job_id)?.genstudio_jobs, source.genstudio_jobs)

    await jq.setQueuePaused(false)
    await waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(replacementId)?.status || ''), {
      label: 'the first selected-item replacement to settle',
    })
    assert.equal(jq.getJob(replacementId)?.status, 'done', jq.getJob(replacementId)?.error || '')

    const summaries = await request(app).get(`/api/projects/${project.slug}/music-library/manual-redo-sources`)
    assert.equal(summaries.status, 200, JSON.stringify(summaries.body))
    const selected = summaries.body.sources.find((row: any) =>
      row.source_job_id === source.job_id && row.source_item_key === 'track-0')
    const sibling = summaries.body.sources.find((row: any) =>
      row.source_job_id === source.job_id && row.source_item_key === 'track-1')
    assert.equal(selected?.eligible, true, JSON.stringify(summaries.body))
    assert.equal(sibling?.eligible, true, JSON.stringify(summaries.body))
    assert.equal(service.submissions.filter(row => row.operation === 'music').length, 1)
  } finally {
    await cleanupJobs(project.slug, replacementId, source.job_id)
    await jq.setQueuePaused(wasPaused)
  }
})
