/**
 * Music format phase 1 — the Song Pool routes, the Music Formula save, and the generator end to
 * end against the in-process Gateway mock: complete, partial, retry (no re-buy, no re-write),
 * regenerate (old take kept disabled), and the writing model being the one picked at start.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { STARTING_SONG_FORMULA, STARTING_EPISODE_DEFAULTS } from '../contracts/song-formula.js'
import { buildGenStudioMusicIdempotencyKey } from '../lib/genstudio-client.js'
import { freshActionFingerprint } from '../lib/fresh-generation-action.js'

let cleanup: () => Promise<void>
let app: any
let slug: string
let service: MockGenStudioService

const W = ['Amber', 'Birch', 'Cinder', 'Dune', 'Ember', 'Fjord', 'Glade', 'Heron', 'Isle', 'Juniper']
let n = 0
function writerAnswer(count: number): string {
  return JSON.stringify({ songs: Array.from({ length: count }, (_, i) => {
    const k = n++
    return { n: i + 1, title: `${W[k % 10]} ${k}`, line: `${'abcdefghij'[k % 10]!.repeat(3)} line ${k * 7919}`, scene_idea: `${'klmnopqrst'[k % 10]!.repeat(4)} scene ${k * 104729}` }
  }) })
}

function fakeJob(params: Record<string, unknown>): any {
  return {
    job_id: `test-song-pool-${Math.random().toString(36).slice(2)}`, project_slug: slug, type: 'music_generate',
    episode_id: '', title: 'songs', status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    finished_at: null, error: null, output_lines: [] as string[], params: { song_pool: true, ...params },
  }
}

const poolFile = async () => JSON.parse(await fs.readFile(path.join((await import('../services/song-pool.js')).poolDir(slug)!, 'library.json'), 'utf8'))
const batchFile = async (batchId: string) => JSON.parse(await fs.readFile(path.join((await import('../services/song-pool.js')).poolDir(slug)!, 'batches', `${batchId}.json`), 'utf8'))

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  const proj = await request(app).post('/api/projects').send({ name: 'Cello Evenings', episode_prefix: 'CE', episode_digits: 4 })
  assert.equal(proj.status, 201)
  slug = proj.body.slug
  service = await startMockGenStudioService()
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)
})
after(async () => { await service.close(); await cleanup() })
beforeEach(() => service.reset())

describe('Music Formula save', () => {
  test('without a music formula the pool says what to do, and generating is refused', async () => {
    const r = await request(app).get(`/api/projects/${slug}/song-pool`)
    assert.equal(r.status, 200)
    assert.match(r.body.formula.error, /not a music channel/)
    const g = await request(app).post(`/api/projects/${slug}/song-pool/generate`).send({ operation_id: crypto.randomUUID(), count: 2, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1' })
    assert.equal(g.status, 409)
  })

  test('saving merges into musicFormat of a fork pointed at the project, keeping the worlds', async () => {
    assert.equal((await request(app).put(`/api/projects/${slug}/niche`).send({ niche_id: 'music-mix' })).status, 200)
    const bad = await request(app).patch(`/api/niches/music-mix/music-format?project_slug=${slug}`).send({ songFormula: { ...STARTING_SONG_FORMULA, moods: [] } })
    assert.equal(bad.status, 400)
    const r = await request(app).patch(`/api/niches/music-mix/music-format?project_slug=${slug}`)
      .send({ songFormula: { ...STARTING_SONG_FORMULA, length_s: { min: 60, max: 61 } }, episodeDefaults: STARTING_EPISODE_DEFAULTS })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.match(r.body.id, /^user:/)
    const eff = await request(app).get(`/api/projects/${slug}/effective-niche`)
    assert.equal(eff.body.niche.musicFormat.worlds.length, 90, 'registers and worlds are carried across')
    assert.deepEqual(eff.body.niche.musicFormat.songFormula.length_s, { min: 60, max: 61 })
    assert.equal(eff.body.niche.musicFormat.episodeDefaults.join.style, 'crossfade')
  })

  test('scene settings save on this channel only; the built-in worlds and formula stay as they are', async () => {
    const empty = await request(app).patch(`/api/niches/music-mix/music-format?project_slug=${slug}`).send({ sceneSettings: [] })
    assert.equal(empty.status, 400, 'an empty list is refused')
    const eff0 = await request(app).get(`/api/projects/${slug}/effective-niche`)
    const id = encodeURIComponent(eff0.body.niche.id)
    const r = await request(app).patch(`/api/niches/${id}/music-format`).send({ sceneSettings: ['Kyoto kissaten', ' kyoto kissaten', 'Rooftop café at dusk'] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const eff = await request(app).get(`/api/projects/${slug}/effective-niche`)
    assert.deepEqual(eff.body.niche.musicFormat.sceneSettings, ['Kyoto kissaten', 'Rooftop café at dusk'])
    assert.equal(eff.body.niche.musicFormat.worlds.length, 90, 'song themes are untouched')
    assert.deepEqual(eff.body.niche.musicFormat.songFormula.length_s, { min: 60, max: 61 }, 'the song formula is untouched')
    const builtin = await request(app).get('/api/niches/music-mix')
    assert.equal(builtin.body.musicFormat.sceneSettings, undefined, 'the built-in formula has no list')
    const cleared = await request(app).patch(`/api/niches/${id}/music-format`).send({ sceneSettings: null })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.niche.musicFormat.sceneSettings, undefined)
    assert.equal((await request(app).patch(`/api/niches/${id}/music-format`).send({ sceneSettings: ['Kyoto kissaten', 'Rooftop café at dusk'] })).status, 200)
  })

  test('Duplicate As New Channel makes a named copy nothing points at yet', async () => {
    const eff = await request(app).get(`/api/projects/${slug}/effective-niche`)
    const r = await request(app).post(`/api/niches/${encodeURIComponent(eff.body.niche.id)}/duplicate-music-channel`).send({ name: 'Piano Channel' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.notEqual(r.body.id, eff.body.niche.id)
    const copy = await request(app).get(`/api/niches/${encodeURIComponent(r.body.id)}`)
    assert.equal(copy.body.name, 'Piano Channel')
    assert.deepEqual(copy.body.musicFormat.songFormula.length_s, { min: 60, max: 61 })
    const still = await request(app).get(`/api/projects/${slug}/effective-niche`)
    assert.equal(still.body.niche.id, eff.body.niche.id, 'this project keeps its own formula')
  })
})

describe('generating songs', () => {
  test('an exact music receipt belongs to one stable item and only its supported retry/take identities', async () => {
    const { validSongPoolMusicAttempt } = await import('../generators/song-pool-generate.js')
    const item: any = { item_key: 'song-0', cell: {}, brief: {
      ...STARTING_SONG_FORMULA,
      title: 'Exact Cedar', prompt: 'Exact cello prompt', lyrics: undefined, seed: 41,
    } }
    const batch: any = { batch_id: 'b_binding', mode: 'new', writer_model: 'mock-chat-v1', created_at: '', items: [item] }
    const make = (identity: string, prompt = item.brief.prompt) => {
      const request = { title: item.brief.title, prompt, instrumental: true, duration_seconds: 60,
        model_id: 'mock-music-v1', seed: 41, request_identity: identity }
      return {
        version: 1 as const, planned_item_fingerprint: freshActionFingerprint({ item_key: item.item_key, brief: item.brief }), request,
        idempotency_key: buildGenStudioMusicIdempotencyKey({
          title: request.title, prompt: request.prompt, instrumental: true, durationSeconds: 60,
          modelId: request.model_id, seed: 41, requestIdentity: identity,
        }),
      }
    }
    assert.equal(validSongPoolMusicAttempt(slug, batch, item, make(`${slug}:song-pool:b_binding:song-0:41`)), true)
    assert.equal(validSongPoolMusicAttempt(slug, batch, item, make(`${slug}:song-pool:b_binding:song-0:41:0123456789abcdef`)), true)
    assert.equal(validSongPoolMusicAttempt(slug, batch, item, make(`${slug}:song-pool:b_binding:song-0:41:0123456789abcdef:take2`)), true)
    assert.equal(validSongPoolMusicAttempt(slug, batch, item, make(`${slug}:song-pool:b_binding:song-1:41`)), false)
    assert.equal(validSongPoolMusicAttempt(slug, batch, item, make(`${slug}:song-pool:b_binding:song-0:41`, 'Another item prompt')), false)
  })

  test('an unresolved saved request resumes with its original body and key after current defaults change', async () => {
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const sp = await import('../services/song-pool.js')
    const batchId = 'b_unknown_resume'
    const itemBrief: any = {
      ensemble: 'Cello quartet', mood: 'calm', tempo_band: 'slow', tempo_bpm: 72, key: 'D minor',
      structure: 'AABA', texture: 'warm', theme: 'Rain', length_s: 60, energy: 2,
      combo_key: 'unknown-resume', seed: 41, title: 'Saved Unknown', line: 'Rain on cedar',
      scene_idea: 'Window', prompt: 'Exact saved prompt',
    }
    const requestIdentity = `${slug}:song-pool:${batchId}:song-0:41`
    const savedRequest = {
      title: itemBrief.title, prompt: itemBrief.prompt, instrumental: true,
      model_id: 'mock-music-v1', request_identity: requestIdentity,
    }
    const savedKey = buildGenStudioMusicIdempotencyKey({
      title: savedRequest.title, prompt: savedRequest.prompt, instrumental: true,
      modelId: savedRequest.model_id, requestIdentity,
    })
    await fs.mkdir(path.join(sp.poolDir(slug)!, 'batches'), { recursive: true })
    await fs.writeFile(path.join(sp.poolDir(slug)!, 'batches', `${batchId}.json`), `${JSON.stringify({
      batch_id: batchId, mode: 'new', writer_model: 'mock-chat-v1', created_at: new Date().toISOString(),
      items: [{ item_key: 'song-0', cell: itemBrief, brief: itemBrief, music_attempts: [{
        version: 1, planned_item_fingerprint: freshActionFingerprint({ item_key: 'song-0', brief: itemBrief }),
        request: savedRequest, idempotency_key: savedKey,
      }] }],
    }, null, 2)}\n`)
    const job = fakeJob({ mode: 'new', count: 1, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', in_flight: 1, batch_id: batchId })
    job.genstudio_jobs = [{
      id: `pending:${savedKey}`, operation: 'music.generation', state: 'submitting', dispatch_state: 'dispatched',
      recovery_required: true, request_key: savedKey, request: { idempotency_key: savedKey }, updated_at: new Date().toISOString(),
    }]
    await generateSongPool(job)
    const submitted = service.submissions.find(entry => entry.operation === 'music')!
    assert.equal(submitted.idempotencyKey, savedKey)
    for (const field of ['lyrics', 'duration_seconds', 'seed', 'output_format', 'priority']) {
      assert.equal(field in submitted.parsedBody!, false, `${field} must remain absent on exact replay`)
    }
    assert.equal(submitted.parsedBody?.prompt, 'Exact saved prompt')
    const resumed = await batchFile(batchId)
    assert.equal(resumed.items[0].music_attempts.length, 1, 'an unresolved request never gains a new paid identity')
  })

  test('manual music-stage generation consumes one copied item without planning or listen-back', async () => {
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const batchId = 'b_manual_exact_item'
    const itemBrief: any = {
      ensemble: 'Cello quartet', mood: 'calm', tempo_band: 'slow', tempo_bpm: 72, key: 'D minor',
      structure: 'AABA', texture: 'warm', theme: 'Rain', length_s: 60, energy: 2,
      combo_key: 'manual-exact', seed: 917, title: 'Retained Cedar', line: 'Rain on cedar',
      scene_idea: 'Window', prompt: 'Retained exact cello request',
    }
    const before = await poolFile()
    const job = fakeJob({
      mode: 'manual-redo', count: 1, writer_model: '', music_model: 'mock-music-v1', in_flight: 1, batch_id: batchId,
      manual_song_pool_item: {
        version: 1, source_job_id: 'old-stopped-job', source_batch_id: 'old-batch', source_item_key: 'song-4',
        brief: itemBrief,
        request: {
          title: itemBrief.title, prompt: itemBrief.prompt, instrumental: true, duration_seconds: 47,
          model_id: 'mock-music-v1', seed: 917, output_format: 'm4a', priority: 'background',
          request_identity: `${slug}:song-pool:old-batch:song-4:917`,
        },
      },
    })
    await generateSongPool(job)
    assert.equal(job.result.complete, true, job.output_lines.join('\n'))
    assert.equal(service.providerSubmissionCount('chat'), 0)
    assert.equal(service.providerSubmissionCount('transcription'), 0)
    assert.equal(service.providerSubmissionCount('music'), 1)
    const body = service.submissions.find(entry => entry.operation === 'music')!.parsedBody!
    assert.equal(body.title, itemBrief.title)
    assert.equal(body.prompt, itemBrief.prompt)
    assert.equal(body.duration_seconds, 47)
    const checkpoint = await batchFile(batchId)
    assert.equal(checkpoint.items.length, 1)
    assert.equal(checkpoint.items[0].music_attempts.length, 1)
    assert.ok(checkpoint.items[0].music_attempts[0].accepted_task_id)
    assert.match(checkpoint.items[0].music_attempts[0].request.request_identity, new RegExp(`^${slug}:song-pool:${batchId}:song-0:917$`))
    const after = await poolFile()
    assert.equal(after.songs.length, before.songs.length + 1)
    assert.ok(before.songs.every((song: any) => after.songs.some((candidate: any) => candidate.id === song.id
      && candidate.enabled === song.enabled && candidate.file === song.file)), 'all existing songs and take states are retained')
  })

  test('manual vocal music keeps copied provenance and applies Off, Warn, and Block without transcription', async () => {
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const pm = await import('../services/project-manager.js')
    for (const mode of ['off', 'warn', 'block'] as const) {
      service.reset()
      await pm.updateConfig(slug, { safety_checks: { lyrics_listen_back: mode } } as any)
      const batchId = `b_manual_vocal_${mode}`
      const itemBrief: any = {
        ensemble: 'Cello quartet', mood: 'calm', tempo_band: 'slow', tempo_bpm: 72, key: 'D minor',
        structure: 'AABA', texture: 'warm', theme: 'Rain', length_s: 60, energy: 2,
        combo_key: `manual-vocal-${mode}`, seed: 918, title: `Retained Vocal ${mode}`,
        line: 'Rain on cedar', scene_idea: 'Window', prompt: 'Plain brief prompt',
        lyrics: '[Verse]\nRain rests on cedar\n[Chorus]\nStay awhile', style: 'smoky alto, close microphone',
      }
      const copied = {
        title: itemBrief.title, prompt: 'Plain brief prompt, exact copied singer phrase', lyrics: itemBrief.lyrics,
        instrumental: false, duration_seconds: 47, model_id: 'mock-music-v1', seed: 991,
        request_identity: `${slug}:song-pool:old-vocal:song-2:918`,
      }
      const job = fakeJob({
        mode: 'manual-redo', count: 1, writer_model: '', music_model: 'mock-music-v1', in_flight: 1, batch_id: batchId,
        manual_song_pool_item: {
          version: 1, source_job_id: 'old-vocal-job', source_batch_id: 'old-vocal', source_item_key: 'song-2',
          brief: itemBrief, request: copied,
        },
      })
      if (mode === 'block') await assert.rejects(generateSongPool(job), /Song generation/)
      else await generateSongPool(job)
      assert.equal(service.providerSubmissionCount('chat'), 0)
      assert.equal(service.providerSubmissionCount('transcription'), 0)
      assert.equal(service.providerSubmissionCount('music'), 1)
      const made = (await poolFile()).songs.filter((song: any) => song.batch_id === batchId)
      assert.equal(made.length, 1)
      assert.equal(made[0].lyrics, copied.lyrics)
      assert.equal(made[0].style, itemBrief.style)
      assert.equal(made[0].lyrics_check, 'unchecked')
      assert.equal(made[0].prompt, copied.prompt)
      assert.equal(made[0].length_s, copied.duration_seconds)
      assert.equal(made[0].seed, copied.seed)
      assert.equal(made[0].enabled, mode !== 'block')
      assert.equal(mode === 'warn' ? job.result.safety_warnings?.[0]?.check : undefined,
        mode === 'warn' ? 'lyrics_listen_back' : undefined)
      const checkpoint = await batchFile(batchId)
      assert.equal(Boolean(checkpoint.items[0].song_id), mode !== 'block')
    }
  })

  test('a recovered unknown that settles is retired before the supported next retry identity', async () => {
    service.reset()
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const pm = await import('../services/project-manager.js')
    const sp = await import('../services/song-pool.js')
    await pm.updateConfig(slug, { safety_checks: { lyrics_listen_back: 'block' } } as any)
    const batchId = 'b_recovered_then_retry'
    const brief: any = {
      ensemble: 'Cello quartet', mood: 'calm', tempo_band: 'slow', tempo_bpm: 72, key: 'D minor',
      structure: 'AABA', texture: 'warm', theme: 'Rain', length_s: 60, energy: 2,
      combo_key: 'recovered-retry', seed: 919, title: 'Recovered Vocal', line: 'Rain on cedar',
      scene_idea: 'Window', prompt: 'Recovered vocal prompt', lyrics: '[Verse]\nRain rests on cedar', style: 'alto',
    }
    const originalRequest = {
      title: brief.title, prompt: brief.prompt, lyrics: brief.lyrics, instrumental: false,
      duration_seconds: 47, model_id: 'mock-music-v1', seed: 919,
      request_identity: `${slug}:song-pool:${batchId}:song-0:919`,
    }
    const originalKey = buildGenStudioMusicIdempotencyKey({
      title: originalRequest.title, prompt: originalRequest.prompt, lyrics: originalRequest.lyrics,
      instrumental: false, durationSeconds: 47, modelId: originalRequest.model_id,
      seed: 919, requestIdentity: originalRequest.request_identity,
    })
    await fs.mkdir(path.join(sp.poolDir(slug)!, 'batches'), { recursive: true })
    await fs.writeFile(path.join(sp.poolDir(slug)!, 'batches', `${batchId}.json`), `${JSON.stringify({
      batch_id: batchId, mode: 'manual-redo', writer_model: '', created_at: new Date().toISOString(),
      items: [{ item_key: 'song-0', cell: brief, brief, manual_request: originalRequest, music_attempts: [{
        version: 1, planned_item_fingerprint: freshActionFingerprint({ item_key: 'song-0', brief }),
        request: originalRequest, idempotency_key: originalKey,
      }] }],
    }, null, 2)}\n`)
    const params = {
      mode: 'manual-redo', count: 1, writer_model: '', music_model: 'mock-music-v1', in_flight: 1, batch_id: batchId,
      manual_song_pool_item: {
        version: 1, source_job_id: 'old-job', source_batch_id: 'old-batch', source_item_key: 'song-0', brief,
        request: originalRequest,
      },
    }
    const evidence = [{
      id: `pending:${originalKey}`, operation: 'music.generation', state: 'submitting', dispatch_state: 'dispatched',
      recovery_required: true, request_key: originalKey, request: { idempotency_key: originalKey }, updated_at: new Date().toISOString(),
    }]
    const first = fakeJob(params); first.genstudio_jobs = structuredClone(evidence)
    await assert.rejects(generateSongPool(first), /Song generation/)
    const afterFirst = await batchFile(batchId)
    assert.equal(afterFirst.items[0].music_attempts[0].state, 'succeeded')
    const second = fakeJob(params); second.genstudio_jobs = structuredClone(evidence)
    await assert.rejects(generateSongPool(second), /Song generation/)
    const afterSecond = await batchFile(batchId)
    assert.equal(afterSecond.items[0].music_attempts.length, 2)
    assert.equal(afterSecond.items[0].music_attempts[0].idempotency_key, originalKey)
    assert.notEqual(afterSecond.items[0].music_attempts[1].idempotency_key, originalKey)
  })

  test('the writing model is required and never assigned for you', async () => {
    const r = await request(app).post(`/api/projects/${slug}/song-pool/generate`).send({ operation_id: crypto.randomUUID(), count: 2 })
    assert.equal(r.status, 400)
    assert.match(r.body.detail, /writing model/)
    const m = await request(app).post(`/api/projects/${slug}/song-pool/generate`).send({ operation_id: crypto.randomUUID(), count: 2, writer_model: 'mock-chat-v1' })
    assert.equal(m.status, 400, 'the song model is never defaulted either (the first published row can be paid)')
    assert.match(m.body.detail, /song model/)
  })

  test('one ordinary UUID binds the complete Song Pool request and never aliases another music lane', async () => {
    const jq = await import('../services/job-queue.js')
    const wasPaused = jq.isQueuePaused()
    const operationId = '71000000-0000-4000-8000-000000000071'
    const body = {
      operation_id: operationId,
      mode: 'new', count: 2,
      writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', check_model: 'mock-stt-v1',
      length_min_s: 60, length_max_s: 61, in_flight: 2,
      song_ids: ['source-song-a'], brief_edits: { title: 'Remember this exact edit' },
    }
    let jobId = ''
    try {
      await jq.setQueuePaused(true)
      const [left, right] = await Promise.all([
        request(app).post(`/api/projects/${slug}/song-pool/generate`).send(body),
        request(app).post(`/api/projects/${slug}/song-pool/generate`).send(body),
      ])
      jobId = left.body?.job_id || right.body?.job_id || ''
      assert.deepEqual([left.status, right.status].sort(), [200, 201], `${JSON.stringify(left.body)}\n${JSON.stringify(right.body)}`)
      assert.equal(left.body.job_id, right.body.job_id)
      const exact = await request(app).post(`/api/projects/${slug}/song-pool/generate`).send(body)
      assert.equal(exact.status, 200, JSON.stringify(exact.body))
      assert.equal(exact.body.job_id, jobId)

      const changes: Array<[string, Record<string, unknown>]> = [
        ['mode', { mode: 'fill-gaps' }],
        ['count', { count: 3 }],
        ['writer model', { writer_model: 'mock-chat-v2' }],
        ['music model', { music_model: 'mock-music-v2' }],
        ['check model', { check_model: 'mock-stt-v2' }],
        ['minimum length', { length_min_s: 59 }],
        ['maximum length', { length_max_s: 62 }],
        ['in-flight count', { in_flight: 3 }],
        ['song ids', { song_ids: ['source-song-b'] }],
        ['brief edits', { brief_edits: { title: 'A different edit' } }],
      ]
      for (const [name, change] of changes) {
        const conflict = await request(app).post(`/api/projects/${slug}/song-pool/generate`).send({ ...body, ...change })
        assert.equal(conflict.status, 409, `${name}: ${JSON.stringify(conflict.body)}`)
      }
      const actionJobs = await jq.findJobs(slug, job => job.params?.generation_action?.id === operationId)
      assert.equal(actionJobs.length, 1)

      const aliasProject = await request(app).post('/api/projects').send({ name: 'Song Pool UUID Alias', episode_prefix: 'SA', episode_digits: 4 })
      assert.equal(aliasProject.status, 201)
      const aliasSlug = aliasProject.body.slug
      const aliasId = '72000000-0000-4000-8000-000000000072'
      const library = jq.enqueuePreparedForTest({
        project_slug: aliasSlug, type: 'music_generate', episode_id: '', title: 'Library action',
        params: { song_pool: false, generation_action: { id: aliasId, kind: 'fresh' } },
      })
      const alias = await request(app).post(`/api/projects/${aliasSlug}/song-pool/generate`).send({ ...body, operation_id: aliasId })
      assert.equal(alias.status, 409, JSON.stringify(alias.body))
      await jq.requestJobCancellation(aliasSlug, library.job_id)
    } finally {
      if (jobId) await jq.requestJobCancellation(slug, jobId)
      await jq.setQueuePaused(wasPaused)
    }
  })

  test('plan is free and shows what the songs will cover', async () => {
    const r = await request(app).post(`/api/projects/${slug}/song-pool/plan`).send({ count: 200 })
    assert.equal(r.status, 200)
    assert.equal(r.body.count, 200); assert.equal(r.body.writing_calls, 10); assert.equal(r.body.new_combinations, 200)
    assert.equal(r.body.first.length, 4)
    assert.equal(service.providerSubmissionCount(), 0)
  })

  test('complete run: briefs written by the picked model, one request per song with a seed, saved + measured', async () => {
    service.queueScenario('chat', { outputText: writerAnswer(3) })
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const job = fakeJob({ mode: 'new', count: 3, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', in_flight: 2, batch_id: 'b_complete' })
    await generateSongPool(job)
    assert.equal(job.result.complete, true, job.output_lines.join('\n'))
    assert.equal(service.providerSubmissionCount('music'), 3)
    const bodies = service.submissions.filter(s => s.operation === 'music').map(s => s.parsedBody!)
    assert.ok(bodies.every(b => Number.isInteger(b.seed) && b.instrumental === true && [60, 61].includes(Number(b.duration_seconds))))
    assert.ok(bodies.every(b => /^Solo cello|^Cello/.test(String(b.prompt))), 'prompt assembled by code from the fields')
    const checkpoint = await batchFile('b_complete')
    assert.equal(checkpoint.items.length, 3)
    for (const [index, item] of checkpoint.items.entries()) {
      assert.equal(item.item_key, `song-${index}`)
      assert.equal(item.music_attempts.length, 1)
      const attempt = item.music_attempts[0]
      assert.ok(attempt.accepted_task_id)
      assert.equal(attempt.state, 'succeeded')
      assert.equal(attempt.idempotency_key, buildGenStudioMusicIdempotencyKey({
        title: attempt.request.title, prompt: attempt.request.prompt, lyrics: attempt.request.lyrics,
        instrumental: attempt.request.instrumental, durationSeconds: attempt.request.duration_seconds,
        modelId: attempt.request.model_id, requestIdentity: attempt.request.request_identity,
        outputFormat: attempt.request.output_format, seed: attempt.request.seed,
      }))
    }
    const pool = await poolFile()
    const songs = pool.songs.filter((s: any) => s.batch_id === 'b_complete')
    assert.equal(songs.length, 3)
    for (const s of songs) {
      assert.ok(s.combo_key && s.scene_idea && s.line && s.prompt && s.writer_model === 'mock-chat-v1')
      assert.ok(s.duration_s > 0, 'measured at save')
      assert.deepEqual(s.episodes, []); assert.equal(s.rating, null)
      await fs.access(path.join(path.dirname((await import('../services/song-pool.js')).poolDir(slug)!), 'music-library', s.file))
    }
    assert.equal(new Set(songs.map((s: any) => s.combo_key)).size, 3)
  })

  test('1.4.270: pool reads during generation never index a new song twice', async () => {
    service.queueScenario('chat', { outputText: writerAnswer(3) })
    const sp = await import('../services/song-pool.js')
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const job = fakeJob({ mode: 'new', count: 3, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', in_flight: 3, batch_id: 'b_race' })
    let done = false
    let reads = 0
    const seenAsFolder = new Set<string>()
    const reader = (async () => {
      while (!done) {
        for (const song of (await sp.readPool(slug)).songs) if (song.source === 'folder') seenAsFolder.add(song.file)
        reads++
        await new Promise(r => setTimeout(r, 1))
      }
    })()
    try { await generateSongPool(job) } finally { done = true; await reader }
    assert.equal(job.result.complete, true, job.output_lines.join('\n'))
    assert.ok(reads > 5, `the reader ran during generation (${reads} reads)`)
    const pool = await poolFile()
    const files = pool.songs.filter((s: any) => s.status !== 'rejected').map((s: any) => s.file)
    assert.equal(new Set(files).size, files.length, 'one entry per file')
    const made = pool.songs.filter((s: any) => job.result.saved_tracks.includes(s.file))
    assert.equal(made.length, 3)
    assert.ok(made.every((s: any) => s.source === 'generated' && s.batch_id === 'b_race'))
    assert.deepEqual(made.filter((s: any) => seenAsFolder.has(s.file)).map((s: any) => s.file), [], 'no read saw a half-made file')
  })

  test('1.4.270: a pool with folder duplicates is repaired on load; plays merge, the file stays, old ids still resolve', async () => {
    const sp = await import('../services/song-pool.js')
    const pool = await poolFile()
    const real = pool.songs.find((s: any) => s.batch_id === 'b_race')
    const dir = sp.poolDir(slug)!
    const use = { code: 'CE0007', project_slug: slug, used_at: '2026-10-01T00:00:00.000Z' }
    // As an older build left it: a folder entry for the same file (drawn into an episode), and a second
    // one an earlier clean-up switched off and tagged.
    pool.songs.push(
      { id: 's_folder_dup', file: real.file, status: 'ready', enabled: true, title: real.file, tags: [], source: 'folder', created_at: real.created_at, rating: 4, episodes: [use] },
      { id: 's_tagged_dup', file: real.file, status: 'ready', enabled: false, title: real.file, tags: ['duplicate-index'], source: 'folder', created_at: real.created_at, rating: null, episodes: [] },
    )
    await fs.writeFile(path.join(dir, 'library.json'), JSON.stringify(pool))
    const repaired = await sp.readPool(slug)
    const rows = repaired.songs.filter(s => s.file === real.file)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, real.id)
    assert.equal(rows[0]!.enabled, true)
    assert.equal(rows[0]!.rating, 4)
    assert.deepEqual(rows[0]!.episodes.map(e => e.code), ['CE0007'])
    assert.deepEqual(rows[0]!.merged_ids?.sort(), ['s_folder_dup', 's_tagged_dup'])
    assert.ok(!rows[0]!.tags.includes('duplicate-index'))
    await fs.access(path.join(dir, real.file))
    // An episode plan that still names the folded id resolves to the kept song.
    const { loadEpisodeContext } = await import('../services/music-episode-store.js')
    const ctx = await loadEpisodeContext(slug, 'CE0099', { ...STARTING_EPISODE_DEFAULTS, pools: [] } as any)
    assert.equal(ctx.byKey.get(`${repaired.pool_id}/s_folder_dup`)?.id, real.id)
  })

  test('partial run fails loudly; Retry makes only the missing song and never rewrites a brief', async () => {
    service.queueScenario('chat', { outputText: writerAnswer(2) })
    service.queueScenario('music', {})
    service.queueScenario('music', { states: ['failed'], failureCode: 'PROVIDER_REJECTED' })
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const params = { mode: 'new', count: 2, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', in_flight: 1, batch_id: 'b_partial' }
    const first = fakeJob(params)
    await assert.rejects(generateSongPool(first), /Song generation/)
    assert.equal(first.result.complete, false)
    assert.equal((await poolFile()).songs.filter((s: any) => s.batch_id === 'b_partial').length, 1, 'the saved song is kept')
    const chatBefore = service.providerSubmissionCount('chat')
    const musicBefore = service.providerSubmissionCount('music')
    const retry = fakeJob(params)
    await generateSongPool(retry)
    assert.equal(retry.result.complete, true, retry.output_lines.join('\n'))
    assert.equal(service.providerSubmissionCount('chat'), chatBefore, 'no brief is rewritten')
    assert.equal(service.providerSubmissionCount('music') - musicBefore, 1, 'only the missing song is asked for')
    assert.equal((await poolFile()).songs.filter((s: any) => s.batch_id === 'b_partial').length, 2)
    const checkpoint = await batchFile('b_partial')
    const retried = checkpoint.items.find((item: any) => item.music_attempts?.length > 1)
    assert.ok(retried, 'the settled retry keeps both exact request identities')
    assert.notEqual(retried.music_attempts[0].idempotency_key, retried.music_attempts[1].idempotency_key)
    assert.ok(retried.music_attempts.every((attempt: any) => attempt.accepted_task_id))
  })

  test('a quit after the scratch save and trim, before the pool move, resumes the same song instead of refusing it', async () => {
    // A real M4A with an abrupt ending: checkSong fades it in place, so the scratch file no longer
    // matches the downloaded bytes (song-audio.ts). Review 2026-10-16 #2.
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'song-pool-m4a-'))
    const source = path.join(work, 'take.m4a')
    assert.equal(spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:a', 'aac', '-b:a', '128k', '-f', 'ipod', source]).status, 0)
    const bytes = await fs.readFile(source)
    service.queueScenario('chat', { outputText: writerAnswer(1) })
    service.queueScenario('music', { audioArtifact: bytes })
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const sp = await import('../services/song-pool.js')
    const incoming = path.join(sp.poolDir(slug)!, '.incoming')
    const params = { mode: 'new', count: 1, writer_model: 'mock-chat-v1', music_model: 'mock-music-v1', in_flight: 1, batch_id: 'b_quit_after_trim' }
    const realRename = fs.rename
    fs.rename = (async (from: any, to: any) => {
      if (String(from).startsWith(incoming + path.sep) && !String(to).startsWith(incoming + path.sep)) {
        throw new Error('simulated quit before the pool move')
      }
      return realRename(from, to)
    }) as typeof fs.rename
    try {
      await assert.rejects(generateSongPool(fakeJob(params)))
    } finally {
      fs.rename = realRename
    }
    const scratch = (await fs.readdir(incoming)).filter(name => name.endsWith('.m4a') && !name.startsWith('.'))
    assert.equal(scratch.length, 1, 'the trimmed scratch file is left behind')
    assert.equal((await fs.readFile(path.join(incoming, scratch[0]!))).equals(bytes), false, 'checkSong rewrote it')

    service.queueScenario('music', { audioArtifact: bytes })
    const resumed = fakeJob(params)
    await generateSongPool(resumed)
    assert.equal(resumed.result.complete, true, resumed.output_lines.join('\n'))
    const songs = (await poolFile()).songs.filter((s: any) => s.batch_id === 'b_quit_after_trim')
    assert.equal(songs.length, 1)
    await fs.access(path.join(sp.poolDir(slug)!, songs[0].file))
    assert.deepEqual((await fs.readdir(incoming)).filter(name => !name.startsWith('.')), [], 'the stale scratch file went to Trash, not into the pool')
  })

  test('regenerate: same brief, new seed, old take kept but disabled', async () => {
    const before = (await poolFile()).songs.find((s: any) => s.batch_id === 'b_complete')
    const { generateSongPool } = await import('../generators/song-pool-generate.js')
    const job = fakeJob({ mode: 'regenerate', count: 1, writer_model: '', music_model: 'mock-music-v1', song_ids: [before.id], batch_id: 'b_retake' })
    await generateSongPool(job)
    assert.equal(job.result.complete, true, job.output_lines.join('\n'))
    assert.equal(service.providerSubmissionCount('chat'), 0, 'a retake needs no writing model')
    const pool = await poolFile()
    const retake = pool.songs.find((s: any) => s.take_of === before.id)
    assert.ok(retake)
    assert.equal(retake.title, before.title); assert.equal(retake.prompt, before.prompt); assert.notEqual(retake.seed, before.seed)
    assert.equal(pool.songs.find((s: any) => s.id === before.id).enabled, false)
  })

  test('the pool page data: stats, window, coverage, rating and reject', async () => {
    const pool = await poolFile()
    const target = pool.songs.find((s: any) => s.batch_id === 'b_partial')
    assert.equal((await request(app).patch(`/api/projects/${slug}/song-pool/songs/${target.id}`).send({ rating: 6 })).status, 400)
    assert.equal((await request(app).patch(`/api/projects/${slug}/song-pool/songs/${target.id}`).send({ rating: 4, add_tags: ['calm'] })).status, 200)
    const r = await request(app).get(`/api/projects/${slug}/song-pool`)
    assert.equal(r.status, 200)
    assert.equal(r.body.coverage.rows.length, 7); assert.equal(r.body.coverage.cols.length, 3)
    assert.equal(r.body.coverage.combinations, 7560)
    assert.ok(r.body.stats.songs >= 6)
    assert.equal(r.body.pool.songs.find((s: any) => s.id === target.id).rating, 4)
    const audio = await request(app).get(`/api/projects/${slug}/song-pool/songs/${target.id}/audio`)
    assert.equal(audio.status, 200)
    const rej = await request(app).post(`/api/projects/${slug}/song-pool/reject`).send({ song_ids: [target.id] })
    assert.deepEqual(rej.body, { trashed: [target.id], archived: [] })
    const list = await request(app).get('/api/song-pools')
    assert.ok(list.body.pools.some((p: any) => p.project_slug === slug && p.pool_id === pool.pool_id))
  })
})
