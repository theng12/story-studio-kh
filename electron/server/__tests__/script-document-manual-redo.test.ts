import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

type ScriptItem = 'outline' | 'introduction' | `chapter:${number}`
type Receipt = { item: ScriptItem; request_key: string }

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let app: any
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let projectSlug = ''
const fixtureJobIds = new Set<string>()

before(async () => {
  isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;[jq, pm] = await Promise.all([
    import('../services/job-queue.js'),
    import('../services/project-manager.js'),
  ])
  const secrets = await import('../services/app-secrets-store.js')
  await secrets.setApiKey('genstudio', 'gs-script-document-manual-redo-test')
  app = (await import('../app.js')).app
  await jq.setQueuePaused(true)
  projectSlug = (await pm.createProject({ name: 'Script document manual redo receipts' })).slug
})

after(async () => {
  assert.ok([...fixtureJobIds].every(jobId => !jq?._isJobWorkerActiveForTesting(jobId)),
    'the paused admission fixture never starts a worker')
  await jq?._waitForJobPersistenceForTesting()
  await isolated?.cleanup()
})

function evidence(
  id: string,
  key: string,
  state: 'accepted' | 'running' | 'succeeded' | 'failed' = 'accepted',
  requestKey = key,
) {
  return {
    id,
    request_key: key,
    operation: 'chat.response' as const,
    state,
    dispatch_state: 'dispatched' as const,
    request: {
      method: 'POST', path: '/v1/chat/responses', model_id: 'mock-chat-v1',
      idempotency_key: requestKey, captured_at: '2026-10-14T01:00:00.000Z', messages: [],
    },
    updated_at: '2026-10-14T01:00:01.000Z',
  }
}

async function stoppedChapterSource(options: {
  episodeId: string
  chapter: number
  receipts?: Receipt[]
  evidence: ReturnType<typeof evidence>[]
}) {
  const queued = jq.enqueuePreparedForTest({
    project_slug: projectSlug,
    type: 'chapter-only',
    episode_id: options.episodeId,
    title: 'Historical chapter request',
    params: {
      episode_id: options.episodeId,
      title: 'Historical chapter request',
      chapter_number: options.chapter,
      model: 'mock-chat-v1',
      words_per_chapter: 5,
      ...(options.receipts ? {
        script_document_requests: {
          version: 1,
          requests: options.receipts.map(receipt => ({ ...structuredClone(receipt), episode_id: options.episodeId })),
        },
      } : {}),
    },
  })
  fixtureJobIds.add(queued.job_id)
  const durable = await jq.mutateAuthoritativeJob(projectSlug, queued.job_id, current => {
    current.status = 'error'
    current.error = 'Earlier script request did not settle locally.'
    current.finished_at = '2026-10-14T01:01:00.000Z'
    current.genstudio_jobs = structuredClone(options.evidence)
    return current
  })
  assert.ok(durable)
  return durable
}

async function stoppedScriptSource(options: {
  episodeId: string
  type: 'outline_only' | 'introduction-only'
  item: 'outline' | 'introduction'
  key: string
}) {
  const queued = jq.enqueuePreparedForTest({
    project_slug: projectSlug,
    type: options.type,
    episode_id: options.episodeId,
    title: 'Historical script request',
    params: {
      episode_id: options.episodeId,
      title: 'Historical script request',
      model: 'mock-chat-v1',
      script_document_requests: {
        version: 1,
        requests: [{ episode_id: options.episodeId, item: options.item, request_key: options.key }],
      },
    },
  })
  fixtureJobIds.add(queued.job_id)
  const durable = await jq.mutateAuthoritativeJob(projectSlug, queued.job_id, current => {
    current.status = 'error'
    current.error = 'Earlier script request did not settle locally.'
    current.finished_at = '2026-10-14T01:01:00.000Z'
    current.genstudio_jobs = [evidence(`provider-${options.item}`, options.key)]
    return current
  })
  assert.ok(durable)
  return durable
}

function body(sourceJobId: string, episodeId: string, chapter: number, operationId: string) {
  return {
    episode_id: episodeId,
    title: 'Replacement chapter request',
    chapter_number: chapter,
    model: 'mock-chat-v1',
    words_per_chapter: 5,
    operation_id: operationId,
    manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
  }
}

async function postManualChapter(sourceJobId: string, episodeId: string, chapter: number, operationId: string) {
  const response = await request(app)
    .post(`/api/projects/${projectSlug}/generate/chapter-only`)
    .send(body(sourceJobId, episodeId, chapter, operationId))
  if (response.body?.job_id) fixtureJobIds.add(response.body.job_id)
  return response
}

test('a mutable chapter parameter cannot relabel the request key prepared for another chapter', async () => {
  const episodeId = 'EP7101'
  const key = 'story-chat-chapter-five-original'
  const source = await stoppedChapterSource({
    episodeId,
    chapter: 5,
    receipts: [{ item: 'chapter:5', request_key: key }],
    evidence: [evidence('provider-chapter-five', key)],
  })

  await jq.mutateAuthoritativeJob(projectSlug, source.job_id, current => {
    current.params.chapter_number = 6
    return current
  })

  const response = await postManualChapter(
    source.job_id, episodeId, 6, '71010000-0000-4000-8000-000000000001',
  )
  assert.equal(response.status, 409, JSON.stringify(response.body))
  assert.match(response.body.detail, /original|receipt|chapter|source/i)
  assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined,
    'a relabelled source is refused before its evidence is abandoned')
})

test('two prepared keys for one item select only the one unresolved provider entry', async () => {
  const episodeId = 'EP7102'
  const oldKey = 'story-chat-chapter-seven-settled'
  const currentKey = 'story-chat-chapter-seven-unresolved'
  const source = await stoppedChapterSource({
    episodeId,
    chapter: 7,
    receipts: [
      { item: 'chapter:7', request_key: oldKey },
      { item: 'chapter:7', request_key: currentKey },
    ],
    evidence: [
      evidence('provider-chapter-seven-old', oldKey, 'succeeded'),
      evidence('provider-chapter-seven-current', currentKey, 'accepted'),
    ],
  })

  const response = await postManualChapter(
    source.job_id, episodeId, 7, '71020000-0000-4000-8000-000000000002',
  )
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const destination = jq.getJob(response.body.job_id)!
  assert.equal(destination.params?.manual_redo?.source_item_key, 'chapter:7')
  assert.equal(destination.params?.manual_redo?.source_job_id, source.job_id)
  assert.match(destination.params?.manual_redo?.source_request_fingerprint || '', /^[0-9a-f]{64}$/)
  assert.ok(jq.getJob(source.job_id)?.force_abandoned,
    'the exact source changes only after its destination wins admission')
})

test('duplicate receipt ownership and contradictory evidence keys fail closed', async t => {
  await t.test('one provider key cannot own two logical items', async () => {
    const episodeId = 'EP7103'
    const key = 'story-chat-duplicate-item-owner'
    const source = await stoppedChapterSource({
      episodeId,
      chapter: 8,
      receipts: [
        { item: 'chapter:8', request_key: key },
        { item: 'chapter:9', request_key: key },
      ],
      evidence: [evidence('provider-duplicate-owner', key)],
    })
    const response = await postManualChapter(
      source.job_id, episodeId, 8, '71030000-0000-4000-8000-000000000003',
    )
    assert.equal(response.status, 409, JSON.stringify(response.body))
    assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
  })

  await t.test('request_key and retained request preview must not disagree', async () => {
    const episodeId = 'EP7104'
    const canonical = 'story-chat-canonical-key'
    const contradictory = 'story-chat-contradictory-preview-key'
    const source = await stoppedChapterSource({
      episodeId,
      chapter: 10,
      receipts: [{ item: 'chapter:10', request_key: canonical }],
      evidence: [evidence('provider-contradictory-key', canonical, 'accepted', contradictory)],
    })
    const response = await postManualChapter(
      source.job_id, episodeId, 10, '71040000-0000-4000-8000-000000000004',
    )
    assert.equal(response.status, 409, JSON.stringify(response.body))
    assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
  })
})

test('a reused task id cannot cross from another request key and item', async () => {
  const episodeId = 'EP7105'
  const chapterElevenKey = 'story-chat-chapter-eleven'
  const chapterTwelveKey = 'story-chat-chapter-twelve'
  const sharedTaskId = 'provider-task-reused-by-bad-history'
  const source = await stoppedChapterSource({
    episodeId,
    chapter: 11,
    receipts: [
      { item: 'chapter:11', request_key: chapterElevenKey },
      { item: 'chapter:12', request_key: chapterTwelveKey },
    ],
    evidence: [
      evidence(sharedTaskId, chapterElevenKey, 'succeeded'),
      evidence(sharedTaskId, chapterTwelveKey, 'accepted'),
    ],
  })

  const response = await postManualChapter(
    source.job_id, episodeId, 11, '71050000-0000-4000-8000-000000000005',
  )
  assert.equal(response.status, 409, JSON.stringify(response.body))
  assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined,
    'task-id coincidence never substitutes for the selected request-key receipt')
})

test('legacy unresolved chat evidence without a pre-submit item receipt is ineligible', async () => {
  const episodeId = 'EP7106'
  const key = 'story-chat-legacy-without-item'
  const source = await stoppedChapterSource({
    episodeId,
    chapter: 13,
    evidence: [evidence('provider-legacy-no-item', key)],
  })
  const response = await postManualChapter(
    source.job_id, episodeId, 13, '71060000-0000-4000-8000-000000000006',
  )
  assert.equal(response.status, 409, JSON.stringify(response.body))
  assert.equal(jq.getJob(source.job_id)?.force_abandoned, undefined)
})

test('outline and introduction admissions bind their own exact source item and expose no retained request secrets', async () => {
  const outlineEpisode = 'EP7110'
  const outline = await stoppedScriptSource({
    episodeId: outlineEpisode,
    type: 'outline_only',
    item: 'outline',
    key: 'private-outline-request-key',
  })
  const outlineResponse = await request(app)
    .post(`/api/projects/${projectSlug}/generate/outline-only`)
    .send({
      episode_id: outlineEpisode,
      title: 'New outline version',
      model: 'mock-chat-v1',
      operation_id: '71100000-0000-4000-8000-000000000010',
      manual_redo: { intent: 'replace_unresolved', source_job_id: outline.job_id },
    })
  assert.equal(outlineResponse.status, 201, JSON.stringify(outlineResponse.body))
  fixtureJobIds.add(outlineResponse.body.job_id)
  assert.equal(outlineResponse.body.params.manual_redo.source_item_key, 'outline')

  const introductionEpisode = 'EP7111'
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { writeChapterFiles } = await import('../lib/narration-assembly.js')
  const paths = await resolveEpisodePaths(projectSlug, introductionEpisode, 'New introduction version')
  await writeChapterFiles(paths.script_dir, introductionEpisode, 'New introduction version', {
    chapters: [{ number: 1, title: 'Existing', text: 'An existing chapter for the opening.' }],
  })
  const introduction = await stoppedScriptSource({
    episodeId: introductionEpisode,
    type: 'introduction-only',
    item: 'introduction',
    key: 'private-introduction-request-key',
  })
  const introResponse = await request(app)
    .post(`/api/projects/${projectSlug}/generate/introduction-only`)
    .send({
      episode_id: introductionEpisode,
      title: 'New introduction version',
      model: 'mock-chat-v1',
      operation_id: '71110000-0000-4000-8000-000000000011',
      manual_redo: { intent: 'replace_unresolved', source_job_id: introduction.job_id },
    })
  assert.equal(introResponse.status, 201, JSON.stringify(introResponse.body))
  fixtureJobIds.add(introResponse.body.job_id)
  assert.equal(introResponse.body.params.manual_redo.source_item_key, 'introduction')
  assert.equal(introResponse.body.params.resolved_introduction?.title, 'New introduction version')

  const summary = await request(app)
    .get(`/api/projects/${projectSlug}/scripts/manual-redo-sources?episode_id=${introductionEpisode}`)
    .expect(200)
  assert.deepEqual(summary.body.sources.map((source: any) => source.item_key), ['introduction'])
  assert.doesNotMatch(JSON.stringify(summary.body), /private-introduction-request-key|provider-introduction/)
})

test('an admitted outline writer blocks a chapter replacement for the same episode before source abandonment', async () => {
  const episodeId = 'EP7112'
  const outline = await stoppedScriptSource({
    episodeId,
    type: 'outline_only',
    item: 'outline',
    key: 'outline-writer-matrix-key',
  })
  const chapter = await stoppedChapterSource({
    episodeId,
    chapter: 2,
    receipts: [{ item: 'chapter:2', request_key: 'chapter-writer-matrix-key' }],
    evidence: [evidence('provider-chapter-writer-matrix', 'chapter-writer-matrix-key')],
  })
  const outlineResponse = await request(app)
    .post(`/api/projects/${projectSlug}/generate/outline-only`)
    .send({
      episode_id: episodeId,
      title: 'Writer matrix outline',
      model: 'mock-chat-v1',
      operation_id: '71120000-0000-4000-8000-000000000012',
      manual_redo: { intent: 'replace_unresolved', source_job_id: outline.job_id },
    })
  assert.equal(outlineResponse.status, 201, JSON.stringify(outlineResponse.body))
  fixtureJobIds.add(outlineResponse.body.job_id)

  const chapterResponse = await postManualChapter(
    chapter.job_id, episodeId, 2, '71120000-0000-4000-8000-000000000013',
  )
  assert.equal(chapterResponse.status, 409, JSON.stringify(chapterResponse.body))
  assert.equal(jq.getJob(chapter.job_id)?.force_abandoned, undefined,
    'the losing source remains untouched when another script writer owns the episode')
})

test('ordinary and manual admissions strip server-owned script document fields before fingerprinting', async t => {
  await t.test('ordinary request cannot install a producer receipt, write owner, or resolved introduction', async () => {
    const response = await request(app)
      .post(`/api/projects/${projectSlug}/generate/chapter-only`)
      .send({
        episode_id: 'EP7113', title: 'Ordinary injection', chapter_number: 2,
        model: 'mock-chat-v1', words_per_chapter: 5,
        operation_id: '71130000-0000-4000-8000-000000000013',
        script_document_requests: { version: 1, requests: [{ episode_id: 'EP7113', item: 'chapter:2', request_key: 'attacker-key' }] },
        script_document_write: { version: 1, item: 'chapter:2', expected_revision: 'missing', owner_action_id: 'attacker' },
        resolved_introduction: { version: 1, title: 'Injected', model: 'attacker-model', style: 'attacker-style', recipe: { beats: [] } },
      })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    fixtureJobIds.add(response.body.job_id)
    const params = jq.getJob(response.body.job_id)!.params
    assert.equal(params.script_document_requests, undefined)
    assert.equal(params.script_document_write, undefined)
    assert.equal(params.resolved_introduction, undefined)
  })

  await t.test('manual replay ignores changed injected server fields and retains only its own write contract', async () => {
    const episodeId = 'EP7114'
    const source = await stoppedChapterSource({
      episodeId,
      chapter: 3,
      receipts: [{ item: 'chapter:3', request_key: 'manual-server-field-source' }],
      evidence: [evidence('provider-manual-server-field-source', 'manual-server-field-source')],
    })
    const operationId = '71140000-0000-4000-8000-000000000014'
    const injected = {
      ...body(source.job_id, episodeId, 3, operationId),
      script_document_requests: { version: 1, requests: [{ episode_id: episodeId, item: 'chapter:9', request_key: 'attacker' }] },
      script_document_write: { version: 1, item: 'chapter:9', expected_revision: 'missing', owner_action_id: 'attacker' },
      resolved_introduction: { version: 1, title: 'Injected A', model: 'attacker-a', style: 'auto', recipe: { beats: [] } },
    }
    const first = await request(app).post(`/api/projects/${projectSlug}/generate/chapter-only`).send(injected)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    fixtureJobIds.add(first.body.job_id)
    const params = jq.getJob(first.body.job_id)!.params
    assert.equal(params.script_document_requests, undefined)
    assert.equal(params.resolved_introduction, undefined)
    assert.equal(params.script_document_write.item, 'chapter:3')
    assert.equal(params.script_document_write.owner_action_id, operationId)

    const replay = await request(app).post(`/api/projects/${projectSlug}/generate/chapter-only`).send({
      ...injected,
      script_document_requests: { version: 1, requests: [] },
      script_document_write: { version: 1, item: 'outline', expected_revision: 'sha256:bad', owner_action_id: 'different' },
      resolved_introduction: { version: 1, title: 'Injected B', model: 'attacker-b', style: 'attacker', recipe: { beats: ['changed'] } },
    })
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.job_id, first.body.job_id)
    assert.equal(replay.body.reused, true)
  })
})

test('manual introduction admission freezes an automatic narrator choice to a concrete style', async () => {
  const episodeId = 'EP7115'
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { writeChapterFiles } = await import('../lib/narration-assembly.js')
  const paths = await resolveEpisodePaths(projectSlug, episodeId, 'Concrete automatic introduction')
  await writeChapterFiles(paths.script_dir, episodeId, 'Concrete automatic introduction', {
    chapters: [{ number: 1, title: 'Existing', text: 'Existing chapter context for an introduction.' }],
  })
  const source = await stoppedScriptSource({
    episodeId,
    type: 'introduction-only',
    item: 'introduction',
    key: 'manual-introduction-auto-style',
  })
  const response = await request(app)
    .post(`/api/projects/${projectSlug}/generate/introduction-only`)
    .send({
      episode_id: episodeId,
      title: 'Concrete automatic introduction',
      model: 'mock-chat-v1',
      style: 'auto',
      operation_id: '71150000-0000-4000-8000-000000000015',
      manual_redo: { intent: 'replace_unresolved', source_job_id: source.job_id },
    })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  fixtureJobIds.add(response.body.job_id)
  const frozen = jq.getJob(response.body.job_id)!.params.resolved_introduction
  assert.equal(frozen.version, 1)
  assert.notEqual(frozen.style, 'auto')
  assert.ok(typeof frozen.style === 'string' && frozen.style.length > 0)
})
