/**
 * Music format phase 1 — the Song Pool routes, the Music Formula save, and the generator end to
 * end against the in-process Gateway mock: complete, partial, retry (no re-buy, no re-write),
 * regenerate (old take kept disabled), and the writing model being the one picked at start.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { STARTING_SONG_FORMULA, STARTING_EPISODE_DEFAULTS } from '../contracts/song-formula.js'

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
  test('the writing model is required and never assigned for you', async () => {
    const r = await request(app).post(`/api/projects/${slug}/song-pool/generate`).send({ operation_id: crypto.randomUUID(), count: 2 })
    assert.equal(r.status, 400)
    assert.match(r.body.detail, /writing model/)
    const m = await request(app).post(`/api/projects/${slug}/song-pool/generate`).send({ operation_id: crypto.randomUUID(), count: 2, writer_model: 'mock-chat-v1' })
    assert.equal(m.status, 400, 'the song model is never defaulted either (the first published row can be paid)')
    assert.match(m.body.detail, /song model/)
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
