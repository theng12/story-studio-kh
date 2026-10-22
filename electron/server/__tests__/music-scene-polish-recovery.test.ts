/**
 * next348 — a music scene polish run keeps its OWN record of the request it
 * made, and recovers from it instead of polishing the same scenes twice.
 *
 * THE DEFECT THIS COVERS. `music_scene_polish` saved the polished prompts and
 * then recorded its result. A run interrupted between those two steps — or
 * restarted after the Gateway had already accepted the request — came back
 * with a document that carried the polished prompts, so the request it built
 * again was DIFFERENT (the body is the document's current prompts), so its
 * digest was different, so the Gateway was asked for the same polish a second
 * time: a second paid request and a second polish overwriting the first.
 *
 * The other half of the defect was the completion audit: it accepted "the
 * document is fresh and its prompts are not empty" as proof that THIS run had
 * produced them, which an old prompt plus an unrelated fresh save satisfies
 * (review, 2026-10-22).
 *
 * These tests pin the four decisions that fix both halves:
 *
 *  - the record is read at the boundary, and an unreadable record REFUSES
 *    instead of reading as "no record" (which would authorise a first
 *    submission);
 *  - a prepared key means the answer is COLLECTED under that key, not asked
 *    for again;
 *  - the same request is the same request — the fingerprint covers every
 *    digest input;
 *  - what may be written for a scene: this run's answer where the document
 *    still holds what the run started from, nothing where it already holds
 *    the answer, and a refusal where the owner changed it.
 *
 * THE ACTUAL RUN. The first half of this file proves those decisions as pure
 * functions. The second half drives `generateMusicScenePolish` itself — the
 * in-process mock Gateway, a real project and a real episode on disk, and the
 * queue's own durable checkpoint — so the decisions are proved against the
 * code that ships:
 *
 *  - a checkpoint that cannot be written stops the run BEFORE the request
 *    leaves the process;
 *  - a run whose answers are already on record finishes from the record, with
 *    no new request and no new charge;
 *  - a request the Gateway already holds is reattached by its key;
 *  - a partial answer keeps what it polished and fails the run naming what it
 *    missed;
 *  - a prompt the owner changed after the run is never overwritten;
 *  - a record that cannot be read refuses the run instead of starting a new
 *    one.
 *
 * Zero paid calls: every request in here goes to an in-process mock HTTP
 * server.
 */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import request from 'supertest'

import type { GenStudioRequestPreview } from '../lib/genstudio-request-preview.js'
import { getProjectDir } from '../services/project-manager.js'
import {
  MUSIC_SCENE_POLISH_SNAPSHOT_KEY,
  inspectScenePolishCompletion,
  readMusicScenePolishSnapshot,
  type MusicScenePolishParamsRef,
} from '../services/text-completion.js'
import {
  decideScenePolishRestore,
  generateMusicScenePolish,
  scenePolishInputFingerprint,
  scenePolishRecoveryOptions,
} from '../generators/music-scene-polish.js'
import { saveMusicEpisodeBuild } from '../generators/music-episode-build.js'
import { isNonRetryableError } from '../services/job-retry-policy.js'
import * as jq from '../services/job-queue.js'
import {
  buildEpisodeView,
  episodeDirFor,
  loadEpisodeContext,
  musicScenePolishRunPath,
  newEpisodeDoc,
  readEpisodeDoc,
  readMusicScenePolishRun,
  saveEpisodeDoc,
  updateEpisodeDoc,
  type MusicEpisodeBuild,
  type MusicScenePolishRunArtifact,
} from '../services/music-episode-store.js'
import { MUSIC_EPISODE_FILENAME } from '../services/music-episode-store.js'
import { __pendingLockWaitersForTests, withLock } from '../lib/atomic-store.js'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const JOB_ID = 'job-music-polish-1'
const SCENE = 'ms-0a1b2c3d4e5f'
const POLISHED = 'A quiet archive lit by one lantern, dust turning in the beam.'
const STARTED_FROM = 'The song\'s own scene idea.'

async function assertEventually(predicate: () => boolean, label: string): Promise<void> {
  await waitFor(() => predicate() ? true : false, { label, timeoutMs: 2_000, maxWallClockMs: 30_000 })
}

/** The lightweight v2 params reference paired with an episode-side artifact. */
function paramsRef(record: MusicScenePolishRunArtifact): MusicScenePolishParamsRef {
  return {
    version: 2,
    run_id: record.run_id,
    project_slug: record.project_slug,
    episode_code: record.episode_code,
    scene_ids: record.scene_ids,
    input_fingerprint: record.input_fingerprint,
    owner_job_id: record.owner_job_id,
    ...(record.prepared_key ? { prepared_key: record.prepared_key } : {}),
    ...(record.accepted_key ? { accepted_key: record.accepted_key } : {}),
    ...(record.accepted_job_id ? { accepted_job_id: record.accepted_job_id } : {}),
    ...(record.outputs ? { output_digests: Object.fromEntries(Object.entries(record.outputs).map(([id, text]) => [id, createHash('sha256').update(text).digest('hex')])) } : {}),
    ...(record.missing ? { missing: record.missing } : {}),
    ...(record.outputs_recorded_at ? { outputs_recorded_at: record.outputs_recorded_at } : {}),
  }
}

function ref(over: Record<string, unknown> = {}): MusicScenePolishParamsRef {
  return {
    version: 2,
    run_id: 'a'.repeat(32),
    project_slug: slug,
    episode_code: 'ME001',
    scene_ids: [SCENE],
    input_fingerprint: 'fingerprint',
    owner_job_id: JOB_ID,
    ...over,
  } as MusicScenePolishParamsRef
}

/** A v2 episode-side artifact for a run that asked for one scene and got an answer. */
function artifact(over: Partial<MusicScenePolishRunArtifact> = {}): MusicScenePolishRunArtifact {
  return {
    version: 2,
    run_id: 'a'.repeat(32),
    project_slug: slug,
    episode_code: 'ME001',
    owner_job_id: JOB_ID,
    scene_ids: [SCENE],
    request: {
      model: 'genstudio-chat:qwen',
      system: '',
      user_message: 'polish these scenes',
      temperature: 0.6,
      output_budget: 'standard',
      output_contract: { mode: 'json_object', name: 'music_scene_prompts' } as any,
      request_identity: slug,
    },
    input_fingerprint: 'fingerprint',
    baseline_prompts: { [SCENE]: STARTED_FROM },
    outputs: { [SCENE]: POLISHED },
    missing: [],
    ...over,
  } as MusicScenePolishRunArtifact
}

describe('the run\'s own record is read at the boundary', () => {
  test('a run that never prepared a request has no record', () => {
    const read = readMusicScenePolishSnapshot({ job_id: JOB_ID, params: {} })
    assert.equal(read.state, 'absent')
  })

  test('a complete record is read as this run\'s record', () => {
    const read = readMusicScenePolishSnapshot({
      job_id: JOB_ID,
      params: { [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: ref() },
    })
    assert.equal(read.state, 'valid')
    if (read.state !== 'valid') return
    assert.equal(read.ref.owner_job_id, JOB_ID)
    assert.deepEqual(read.ref.scene_ids, [SCENE])
  })

  test('a record that cannot be read is INVALID, never absent', () => {
    // "Absent" is what authorises a first submission. A record that exists
    // but cannot be read must refuse instead.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['it names no scene', { ...ref(), scene_ids: [] }],
      ['it holds no input fingerprint', { ...ref(), input_fingerprint: '' }],
      ['it names no owner job', { ...ref(), owner_job_id: '' }],
      ['its run id is not a 32-hex string', { ...ref(), run_id: 'not-hex' }],
      ['it names the same scene twice', { ...ref(), scene_ids: [SCENE, SCENE] }],
      ['its version is not one this build understands', { ...ref(), version: 1 as any }],
    ]
    for (const [why, value] of cases) {
      const read = readMusicScenePolishSnapshot({ job_id: JOB_ID, params: { [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: value } })
      assert.equal(read.state, 'invalid', `${why} must not read as absent`)
    }
  })

  test('a record that is not a record at all is invalid', () => {
    const read = readMusicScenePolishSnapshot({
      job_id: JOB_ID,
      params: { [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: 'polished' },
    })
    assert.equal(read.state, 'invalid')
  })
})

describe('a prepared key means the answer is collected, not asked for again', () => {
  test('a prepared key with no acceptance evidence reattaches under that key', () => {
    // The POST failed after the key was prepared (or the run was interrupted
    // between the preparation and the answer). The key still names the request
    // the Gateway holds, so the answer is collected under it — not asked for
    // again under a new digest.
    const options = scenePolishRecoveryOptions({ prepared_key: 'key-prepared' })
    assert.equal(options.recoverByIdempotencyKey, true)
    assert.equal(options.idempotencyKey, 'key-prepared')
    assert.deepEqual(options.allowedRecoveryKeys, ['key-prepared'])
  })

  test('the Gateway\'s accepted key outranks the prepared one', () => {
    const options = scenePolishRecoveryOptions({
      prepared_key: 'key-prepared',
      accepted_key: 'key-accepted',
    })
    assert.equal(options.idempotencyKey, 'key-accepted')
    assert.deepEqual(options.allowedRecoveryKeys, ['key-accepted'])
  })

  test('a record with no key is a request that never went out', () => {
    const options = scenePolishRecoveryOptions({})
    assert.equal(options.recoverByIdempotencyKey, undefined)
    assert.equal(options.idempotencyKey, undefined)
  })
})

describe('the same request is the same request', () => {
  const base = {
    model: 'genstudio-chat:qwen',
    system: '',
    userMessage: 'polish these scenes',
    temperature: 0.6,
    outputBudget: 'standard',
    outputContract: { mode: 'json_object' as const, name: 'music_scene_prompts' },
    requestIdentity: 'a-project',
    sceneIds: [SCENE],
    baselinePrompts: { [SCENE]: STARTED_FROM },
  }

  test('the same inputs give the same fingerprint', () => {
    assert.equal(scenePolishInputFingerprint(base), scenePolishInputFingerprint({ ...base }))
  })

  test('a changed digest input gives a different fingerprint', () => {
    const changed = [
      { ...base, model: 'genstudio-chat:another' },
      { ...base, userMessage: 'polish these other scenes' },
      { ...base, temperature: 0.7 },
      { ...base, outputBudget: 'long' },
      { ...base, requestIdentity: 'another-project' },
      { ...base, sceneIds: [SCENE, 'ms-111111111111'] },
      { ...base, outputContract: { mode: 'json_object' as const, name: 'other_contract' } },
    ]
    for (const input of changed) {
      assert.notEqual(scenePolishInputFingerprint(input), scenePolishInputFingerprint(base),
        'a changed request must not look like the same request')
    }
  })
})

describe('what may be written for a scene', () => {
  test('a scene that still holds what the run started from is restored', () => {
    const decision = decideScenePolishRestore({
      sceneId: SCENE,
      produced: POLISHED,
      savedNow: STARTED_FROM,
      startedFrom: STARTED_FROM,
    })
    assert.equal(decision.action, 'restore')
    if (decision.action !== 'restore') return
    assert.equal(decision.prompt, POLISHED)
  })

  test('a scene that already holds this run\'s answer is left alone', () => {
    const decision = decideScenePolishRestore({
      sceneId: SCENE,
      produced: POLISHED,
      savedNow: POLISHED,
      startedFrom: STARTED_FROM,
    })
    assert.equal(decision.action, 'skip')
  })

  test('a scene the owner changed after the run is a conflict, not an overwrite', () => {
    const decision = decideScenePolishRestore({
      sceneId: SCENE,
      produced: POLISHED,
      savedNow: 'A prompt the owner typed by hand.',
      startedFrom: STARTED_FROM,
    })
    assert.equal(decision.action, 'conflict')
    if (decision.action !== 'conflict') return
    assert.equal(decision.scene_id, SCENE)
  })
})

describe('the audit asks for THIS run\'s text, not for a document that looks finished', () => {
  test('no record is not complete', () => {
    const audit = inspectScenePolishCompletion({
      promptOverrides: { [SCENE]: POLISHED },
      artifact: null,
    })
    assert.equal(audit.complete, false)
  })

  test('a record without answers is not complete', () => {
    const audit = inspectScenePolishCompletion({
      promptOverrides: { [SCENE]: POLISHED },
      artifact: artifact({ outputs: undefined, missing: undefined }),
    })
    assert.equal(audit.complete, false)
  })

  test('the document has to carry exactly this run\'s text', () => {
    const withRun = artifact({ outputs: { [SCENE]: POLISHED }, missing: [] })
    assert.equal(inspectScenePolishCompletion({
      promptOverrides: { [SCENE]: POLISHED },
      artifact: withRun,
    }).complete, true)
    assert.equal(inspectScenePolishCompletion({
      promptOverrides: { [SCENE]: 'Somebody else\'s prompt.' },
      artifact: withRun,
    }).complete, false)
    assert.equal(inspectScenePolishCompletion({
      promptOverrides: {},
      artifact: withRun,
    }).complete, false)
  })

  test('a partial run names the scene it missed', () => {
    const audit = inspectScenePolishCompletion({
      promptOverrides: { [SCENE]: POLISHED },
      artifact: artifact({
        scene_ids: [SCENE, 'ms-111111111111'],
        baseline_prompts: { [SCENE]: STARTED_FROM, 'ms-111111111111': '' },
        outputs: { [SCENE]: POLISHED },
        missing: ['ms-111111111111'],
      }),
    })
    assert.equal(audit.complete, false)
    assert.match(String(audit.detail || ''), /ms-111111111111/,
      'the scene the answer never came back for has to be named')
  })
})

// ── The actual run ──────────────────────────────────────────────────────────

const MODEL = 'genstudio-chat:mock-chat-v1'
/** The Gateway product the mock publishes (GET /v1/chat/models). */
const CHAT_MODEL = 'mock-chat-v1'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let service: MockGenStudioService
let slug: string

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup

  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const mod = await import('../app.js')
  app = mod.app

  service = await startMockGenStudioService()

  const proj = await request(app).post('/api/projects').send({
    name: 'Music Polish Recovery',
    episode_prefix: 'ME',
    episode_digits: 3,
  })
  assert.equal(proj.status, 201)
  slug = proj.body.slug

  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)
})

after(async () => {
  await service?.close()
  await cleanup()
})

beforeEach(() => { service.reset() })

/** A job of the shape the queue hands a generator. */
function polishJob(options: { jobId?: string; code?: string; params?: Record<string, unknown> } = {}): Job {
  const now = new Date().toISOString()
  const code = options.code ?? 'ME001'
  return {
    job_id: options.jobId ?? `test-polish-${Math.random().toString(36).slice(2)}`,
    project_slug: slug,
    type: 'music_scene_polish',
    episode_id: code,
    title: 'Music polish recovery',
    status: 'running',
    created_at: now,
    started_at: now,
    finished_at: null,
    error: null,
    output_lines: [],
    progress: 0,
    params: { episode_id: code, model: MODEL, ...(options.params || {}) },
  }
}

/** An episode with two songs, so the run has two scenes to polish. */
async function makeEpisode(code: string): Promise<{ sceneIds: string[] }> {
  const doc = await newEpisodeDoc(slug, code)
  doc.songs = [
    { pool_id: 'pool-a', song_id: 'song-1' },
    { pool_id: 'pool-a', song_id: 'song-2' },
  ]
  doc.prompt_overrides = {}
  const ctx = await loadEpisodeContext(slug, code, doc.settings)
  await saveEpisodeDoc(slug, doc, ctx.byKey)
  const view = await buildEpisodeView(slug, code)
  assert.equal(view.scenes.length, 2, 'the fixture episode must have two scenes')
  return { sceneIds: view.scenes.map(scene => scene.id) }
}

/** The document as it stands now. */
async function episodeDoc(code: string) {
  const doc = await readEpisodeDoc(slug, code)
  assert.ok(doc, 'the episode document must exist')
  return doc
}

/** Put the document back to what it held before the run: no prompt overrides. */
async function clearEpisodePrompts(code: string): Promise<void> {
  const doc = await episodeDoc(code)
  const ctx = await loadEpisodeContext(slug, code, doc.settings)
  await saveEpisodeDoc(slug, { ...doc, prompt_overrides: {} }, ctx.byKey)
}

/** The owner's own edit, made after a run had already polished the scene. */
async function setEpisodePrompt(code: string, sceneId: string, prompt: string): Promise<void> {
  const doc = await episodeDoc(code)
  const ctx = await loadEpisodeContext(slug, code, doc.settings)
  await saveEpisodeDoc(slug, { ...doc, prompt_overrides: { ...doc.prompt_overrides, [sceneId]: prompt } }, ctx.byKey)
}

/** The run's own record, read back from the project's durable job store and sidecar. */
async function persistedRecord(jobId: string): Promise<MusicScenePolishRunArtifact> {
  const dir = getProjectDir(slug)
  assert.ok(dir, 'the project folder must exist')
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'jobs.json'), 'utf-8')) as { jobs?: Job[] }
  const stored = (raw.jobs || []).find(job => job.job_id === jobId)
  assert.ok(stored, 'the run must be on record in the project\'s job store')
  const read = readMusicScenePolishSnapshot(stored)
  assert.equal(read.state, 'valid', 'the durable record must be readable')
  if (read.state !== 'valid') throw new Error('unreachable')
  const artifact = await readMusicScenePolishRun(slug, read.ref.episode_code, read.ref.run_id)
  assert.ok(artifact, 'the sidecar artifact must exist')
  return artifact
}

/** The answer the mock Gateway gives back: one polished prompt per scene. */
function polishedAnswer(sceneIds: string[], prompts?: string[]): string {
  return JSON.stringify({
    scenes: sceneIds.map((id, index) => ({
      id,
      prompt: prompts?.[index] ?? `Polished prompt ${index + 1}.`,
    })),
  })
}

describe('the run itself: a durable checkpoint that cannot be written stops the request', () => {
  test('the request is never sent when the checkpoint cannot be made durable', async () => {
    const { sceneIds } = await makeEpisode('ME001')
    service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })

    const dir = getProjectDir(slug)
    assert.ok(dir)
    const jobsFile = path.join(dir, 'jobs.json')
    let persists = 0
    // The queue's own test seam: the durable write of this project's job
    // store fails from the SECOND write on — the first write is the run's
    // record, the second is the key the client prepares BEFORE it posts.
    const restore = jq._setJobFileLockProbeForTesting(async (operation, file) => {
      if (operation !== 'persist' || file !== jobsFile) return
      persists += 1
      if (persists >= 2) throw new Error('the durable write was refused')
    })

    try {
      const job = polishJob({ code: 'ME001' })
      await assert.rejects(generateMusicScenePolish(job), /the durable write was refused/)

      assert.equal(persists, 2, 'the record was written, and the write of the prepared key failed')
      const read = readMusicScenePolishSnapshot(job)
      assert.equal(read.state, 'valid')
      assert.ok(
        read.state === 'valid' && read.ref.prepared_key,
        'the client prepared the request before the checkpoint that guards it failed',
      )
      assert.equal(service.providerSubmissionCount('chat'), 0, 'no provider request was made')
      assert.equal(
        service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/chat/responses').length,
        0,
        'nothing was posted to the Gateway',
      )
    } finally {
      restore()
    }
  })
})

test('episode build attaches metadata after a queued editorial save without losing the edit or deadlocking', async () => {
  const code = 'ME009'
  const { sceneIds } = await makeEpisode(code)
  const original = await episodeDoc(code)
  const docPath = path.join(await episodeDirFor(slug, code), MUSIC_EPISODE_FILENAME)
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const held = withLock(docPath, () => blocked)
  const editedPrompt = 'Edited while the mix was building.'
  const pendingWrite = saveEpisodeDoc(slug, { ...original, prompt_overrides: { [sceneIds[0]!]: editedPrompt } }, (await loadEpisodeContext(slug, code, original.settings)).byKey)
  await assertEventually(() => __pendingLockWaitersForTests(docPath) === 1, 'editorial save waits behind the build lock')
  const built: MusicEpisodeBuild = {
    at: new Date().toISOString(), merged_audio: '/tmp/ME009_merged_audio.m4a',
    tracklist_path: '/tmp/ME009_tracklist.txt', total_sec: 42, starts: [0, 21],
    song_keys: original.songs.map(song => `${song.pool_id}/${song.song_id}`), join_seconds: 0,
  }
  const buildSave = saveMusicEpisodeBuild(slug, code, built.song_keys, built)
  await assertEventually(() => __pendingLockWaitersForTests(docPath) === 2, 'build update waits behind the same document lock')
  release()
  await Promise.all([held, pendingWrite, buildSave])
  const saved = await episodeDoc(code)
  assert.equal(saved.prompt_overrides[sceneIds[0]!], editedPrompt)
  assert.deepEqual(saved.built, built)
})

test('the prepared callback failure prevents a provider POST', async () => {
  const { sceneIds } = await makeEpisode('ME010')
  service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })
  const job = polishJob({ code: 'ME010' })
  const dir = getProjectDir(slug)
  assert.ok(dir)
  let persists = 0
  const restore = jq._setJobFileLockProbeForTesting(async (operation, file) => {
    if (operation !== 'persist' || file !== path.join(dir, 'jobs.json')) return
    persists += 1
    if (persists >= 2) throw new Error('prepared callback checkpoint failure')
  })
  try {
    await assert.rejects(generateMusicScenePolish(job), /prepared callback checkpoint failure/)
  } finally {
    restore()
  }
  assert.equal(service.providerSubmissionCount('chat'), 0)
  assert.equal(service.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/chat/responses').length, 0)
})

test('a prepared key with a proven 404 replays the saved preview body once', async () => {
    const { sceneIds } = await makeEpisode('ME008')
    service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })
    const owner = polishJob({ code: 'ME008' })
    await generateMusicScenePolish(owner)
    const saved = await persistedRecord(owner.job_id)
    const retry = polishJob({
      jobId: `retry-${owner.job_id}`,
      code: 'ME008',
      params: { music_scene_polish_retry_of: { job_id: owner.job_id, run_id: saved.run_id } },
    })
    const originalSubmission = service.submissions.find(entry => entry.operation === 'chat')
    assert.ok(originalSubmission)
    assert.ok(saved.prepared_key)
    const requestPreview = saved.request_preview as GenStudioRequestPreview
    assert.ok(requestPreview, 'the prepared callback persisted the actual request preview')
    assert.equal(requestPreview.idempotency_key, saved.prepared_key)
    const exactSavedBody = originalSubmission.bodyText
    const recoveredArtifact = {
      ...saved,
      owner_job_id: owner.job_id,
      outputs: undefined, missing: undefined, outputs_recorded_at: undefined,
    }
    const retryRef = { ...paramsRef(recoveredArtifact), owner_job_id: owner.job_id, prepared_key: saved.prepared_key }
    await fs.writeFile(
      musicScenePolishRunPath(await episodeDirFor(slug, 'ME008'), saved.run_id),
      JSON.stringify(recoveredArtifact),
    )
    service.reset()
    service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })
    retry.params = { episode_id: 'ME008', model: MODEL, [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: retryRef, music_scene_polish_retry_of: { job_id: owner.job_id, run_id: saved.run_id } }
    await generateMusicScenePolish(retry)
    const submissions = service.submissions.filter(entry => entry.operation === 'chat')
    assert.equal(service.requests.filter(entry => entry.method === 'GET' && entry.path.includes('/by-idempotency-key/')).length, 1)
    assert.equal(submissions.length, 1, 'the proven uncreated key is submitted exactly once')
    assert.equal(submissions[0]!.idempotencyKey, saved.prepared_key)
    assert.equal(submissions[0]!.bodyText, exactSavedBody, 'the saved request body is replayed byte for byte')
})

test('a run interrupted after it recorded its answers finishes with no new request', async () => {
    const { sceneIds } = await makeEpisode('ME002')
    service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })

    const job = polishJob({ code: 'ME002' })
    await generateMusicScenePolish(job)
    assert.equal(service.providerSubmissionCount('chat'), 1, 'the first attempt made one request')
    assert.equal(job.result?.complete, true)

    // The record is durable: it is on the job store, not only in memory.
    const record = await persistedRecord(job.job_id)
    assert.ok(record.outputs, 'the run recorded the answers it got')
    assert.deepEqual(Object.keys(record.outputs || {}).sort(), [...sceneIds].sort())

    // The crash window: the answers are on record, the document save did not
    // happen yet.
    await clearEpisodePrompts('ME002')
    const again = polishJob({
      jobId: job.job_id,
      code: 'ME002',
      params: { [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: paramsRef(record) },
    })
    await generateMusicScenePolish(again)

    assert.equal(service.providerSubmissionCount('chat'), 1, 'the Gateway was not asked a second time')
    const doc = await episodeDoc('ME002')
    assert.equal(doc.prompt_overrides[sceneIds[0]!], 'Polished prompt 1.')
    assert.equal(doc.prompt_overrides[sceneIds[1]!], 'Polished prompt 2.')
    assert.equal(again.result?.complete, true)
    assert.match(again.output_lines.join('\n'), /Recovered this run's own polished prompt/)
})

describe('the run itself: a request the Gateway already holds is reattached by its key', () => {
  test('the answer is collected under the saved key, with no new submission', async () => {
    const { sceneIds } = await makeEpisode('ME003')
    service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })

    const job = polishJob({ code: 'ME003' })
    await generateMusicScenePolish(job)
    assert.equal(service.providerSubmissionCount('chat'), 1)
    assert.equal(service.jobCount('chat'), 1)

    const record = await persistedRecord(job.job_id)
    assert.ok(record.accepted_key, 'the Gateway\'s acceptance was recorded')

    // The crash window one step earlier: the request was made and accepted,
    // but the answer was not written to the record yet.
    const beforeAnswer = artifact({
      ...record,
      outputs: undefined,
      missing: undefined,
      outputs_recorded_at: undefined,
    })
    // Write the pre-answer artifact to disk so the sidecar matches the ref.
    // Without this, the sidecar still holds the original record WITH outputs,
    // causing output_digests mismatch between ref (no digests) and artifact (has digests).
    await fs.writeFile(
      musicScenePolishRunPath(await episodeDirFor(slug, 'ME003'), beforeAnswer.run_id),
      JSON.stringify(beforeAnswer),
    )
    await clearEpisodePrompts('ME003')
    const again = polishJob({
      jobId: job.job_id,
      code: 'ME003',
      params: { [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: paramsRef(beforeAnswer) },
    })
    await generateMusicScenePolish(again)

    assert.equal(service.providerSubmissionCount('chat'), 1, 'the Gateway was not asked a second time')
    assert.equal(service.jobCount('chat'), 1, 'no second Gateway job was created')
    assert.ok(
      service.requests.some(entry => entry.method === 'GET' && entry.path.includes('/by-idempotency-key/')),
      'the answer was collected under the saved key',
    )
    const doc = await episodeDoc('ME003')
    assert.equal(doc.prompt_overrides[sceneIds[0]!], 'Polished prompt 1.')
    assert.equal(again.result?.complete, true)
  })
})

describe('the run itself: a partial answer keeps what it polished and fails the run', () => {
  test('the polished scenes stay on the episode and the missing one is named', async () => {
    const { sceneIds } = await makeEpisode('ME004')
    service.queueScenario('chat', {
      outputText: JSON.stringify({ scenes: [{ id: sceneIds[0]!, prompt: 'Polished prompt 1.' }] }),
    })

    const job = polishJob({ code: 'ME004' })
    await assert.rejects(generateMusicScenePolish(job), /scene 2/)

    const doc = await episodeDoc('ME004')
    assert.equal(doc.prompt_overrides[sceneIds[0]!], 'Polished prompt 1.',
      'the answer that did come back is kept on the episode')
    assert.equal(doc.prompt_overrides[sceneIds[1]!], undefined, 'nothing was invented for the missed scene')
    assert.equal(job.result?.complete, false, 'the run as a whole failed')
    assert.equal(job.result?.completion?.completed, 1)
    assert.equal(job.result?.completion?.expected, 2)
    assert.deepEqual(job.result?.completion?.missing, ['scene 2'])
  })
})

describe('the run itself: an editorial change after the run is never overwritten', () => {
  test('the run refuses, does not retry itself, and leaves the owner\'s text alone', async () => {
    const { sceneIds } = await makeEpisode('ME005')
    service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })

    const job = polishJob({ code: 'ME005' })
    await generateMusicScenePolish(job)
    assert.equal(service.providerSubmissionCount('chat'), 1)

    // The owner edits the scene after the run polished it.
    await setEpisodePrompt('ME005', sceneIds[0]!, 'A prompt the owner typed by hand.')

    const record = await persistedRecord(job.job_id)
    const again = polishJob({
      jobId: job.job_id,
      code: 'ME005',
      params: { [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: paramsRef(record) },
    })
    await assert.rejects(generateMusicScenePolish(again), (error: unknown) => {
      const failure = error as Error
      assert.ok(isNonRetryableError(failure), 'the refusal must not send the run round again')
      assert.match(failure.message, /changed after this run started/)
      // The user-facing error message identifies the conflicting scene by its
      // scene_index (e.g., "scene 1"), not by the raw ms-id, so the assertion
      // pins the exact scene number the owner sees in Episode Builder.
      assert.match(failure.message, /scene 1/)
      return true
    })

    const doc = await episodeDoc('ME005')
    assert.equal(doc.prompt_overrides[sceneIds[0]!], 'A prompt the owner typed by hand.',
      'the owner\'s own text is not overwritten')
    assert.equal(service.providerSubmissionCount('chat'), 1, 'no new request went to the Gateway')
  })
})

describe('the run itself: a record that cannot be read refuses the run', () => {
  test('nothing is sent when the run\'s own record is unreadable', async () => {
    const { sceneIds } = await makeEpisode('ME006')
    service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })

    // A COMPLETE, readable v2 reference that belongs to THIS job (owner_job_id
    // matches the job's own id, so snapshot validation passes) — but whose
    // sidecar artifact was never written to disk. This is the intended
    // boundary: the reference itself is valid, the run's OWN record is what
    // cannot be read, so the run refuses instead of starting a new request.
    const jobId = 'test-polish-me006-unreadable'
    const job = polishJob({
      jobId,
      code: 'ME006',
      params: { [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: {
        version: 2,
        run_id: 'a'.repeat(32),
        project_slug: slug,
        episode_code: 'ME006',
        scene_ids: [sceneIds[0]!],
        input_fingerprint: 'f'.repeat(64),
        owner_job_id: jobId,
      } },
    })
    await assert.rejects(generateMusicScenePolish(job), (error: unknown) => {
      const failure = error as Error
      assert.ok(isNonRetryableError(failure), 'the refusal must not send the run round again')
      assert.match(failure.message, /missing or malformed/)
      return true
    })

    assert.equal(service.providerSubmissionCount('chat'), 0, 'no provider request was made')
    assert.equal(
      service.requests.filter(entry => entry.method === 'POST').length,
      0,
      'nothing was posted to the Gateway',
    )
    const doc = await episodeDoc('ME006')
    assert.deepEqual(doc.prompt_overrides, {}, 'nothing was polished')
  })
})

describe('the run itself: the model really is the one the Gateway publishes', () => {
  test('the run asks the selected product for every scene it was told to polish', async () => {
    const { sceneIds } = await makeEpisode('ME007')
    service.queueScenario('chat', { outputText: polishedAnswer(sceneIds) })

    const job = polishJob({ code: 'ME007' })
    await generateMusicScenePolish(job)

    const submitted = service.submissions.find(entry => entry.operation === 'chat')
    assert.ok(submitted, 'the run submitted one writing request')
    assert.equal(submitted.parsedBody?.model_id, CHAT_MODEL)
  })
})
