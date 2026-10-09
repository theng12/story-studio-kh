/**
 * 1.4.270 — a music top-up keeps a rolling window of requests sized to the fleet (was one Mac at a
 * time), and up to 3 projects' top-ups run at once. Against the in-process Gateway mock: the window
 * (fallback, live capacity, background class), saved tracks in plan order whatever order they finish
 * in, one failure not stopping the rest, and cancel.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

let cleanup: () => Promise<void>
let app: any
let slug: string
let service: MockGenStudioService
let mg: typeof import('../generators/music-generate.js')
let jq: typeof import('../services/job-queue.js')

const waitFor = async (check: () => boolean, label: string, timeoutMs = 10_000) => {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const musicSubmissions = () => service.submissions.filter(s => s.operation === 'music' && !s.replay).length

function fakeJob(count: number): any {
  return {
    job_id: `test-music-${Math.random().toString(36).slice(2)}`, project_slug: slug, type: 'music_generate',
    episode_id: '', title: 'music', status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    finished_at: null, error: null, output_lines: [] as string[],
    params: { brief: 'calm night piano', count, model: 'mock-music-v1', instrumental: true },
  }
}
const planIndex = (filename: string) => Number(/^calm-night-piano-(\d+)-/.exec(filename)?.[1])

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  const proj = await request(app).post('/api/projects').send({ name: 'Night Piano', episode_prefix: 'NP', episode_digits: 4 })
  assert.equal(proj.status, 201)
  slug = proj.body.slug
  service = await startMockGenStudioService()
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)
  mg = await import('../generators/music-generate.js')
  jq = await import('../services/job-queue.js')
})
after(async () => { await jq?._waitForJobPersistenceForTesting(); await service.close(); await cleanup() })
beforeEach(() => service.reset())

describe('music top-up runs its tracks concurrently', () => {
  test('an older Gateway (no capacity reading): six in flight; saved tracks keep plan order although they finish in reverse', async () => {
    // Earlier tracks are slower, so they finish last.
    for (let i = 0; i < 8; i++) service.queueScenario('music', { states: ['accepted', 'succeeded'], submitDelayMs: 900 - i * 100 })
    const job = fakeJob(8)
    const run = mg.generateMusicLibraryTracks(job)
    await waitFor(() => musicSubmissions() >= 6, 'six requests in flight')
    assert.equal(musicSubmissions(), 6, 'never more than six at once')
    assert.equal(job.item_progress.concurrency, 6)
    assert.equal(job.item_progress.active.length, 6)
    await run
    assert.equal(musicSubmissions(), 8)
    assert.deepEqual(job.item_progress && { completed: job.item_progress.completed, failed: job.item_progress.failed, active: job.item_progress.active.length },
      { completed: 8, failed: 0, active: 0 })
    const order = (job.result.saved_tracks as string[]).map(planIndex)
    assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7, 8], job.result.saved_tracks.join(', '))
    assert.equal(job.progress, 100)
  })

  const capacity = (idle: number, queuedBackground = 0) => [{
    id: 'mock-music-v1', model_id: 'mock-music-v1', modality: 'music', locations: 2, eligible_macs: 57, idle_macs: idle,
    running: { normal: 0, background: 0 }, queued: { normal: 0, background: queuedBackground },
  }]

  test('Gateway 0.2.165: the window is idle Macs + 2, sent as background, and grows as Macs free', async () => {
    service.setFleetCapacity(capacity(3))
    for (let i = 0; i < 12; i++) service.queueScenario('music', { states: ['accepted', 'succeeded'], submitDelayMs: 500 })
    const job = fakeJob(12)
    // Peak in flight until the first track is saved (the window is only re-read then).
    let peak = 0
    const sampler = setInterval(() => { if (!job.item_progress?.completed) peak = Math.max(peak, job.item_progress?.active.length ?? 0) }, 2)
    const run = mg.generateMusicLibraryTracks(job)
    await waitFor(() => (job.item_progress?.completed ?? 0) >= 1, 'the first track saved')
    clearInterval(sampler)
    assert.equal(peak, 5, 'idle 3 + buffer 2 in flight, never more')
    service.setFleetCapacity(capacity(20))
    await run
    assert.equal(musicSubmissions(), 12)
    const bodies = service.submissions.filter(s => s.operation === 'music').map(s => s.parsedBody!)
    assert.ok(bodies.every(b => b.priority === 'background'), JSON.stringify(bodies[0]))
    assert.deepEqual((job.result.saved_tracks as string[]).map(planIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.ok(job.output_lines.some((l: string) => /57 Mac\(s\) can run this model, 3 idle now/.test(l)), job.output_lines.join('\n'))
  })

  test('Gateway 0.2.165: background work already waiting there holds new requests back', async () => {
    service.setFleetCapacity(capacity(4, 6))
    service.queueScenario('music', { states: ['accepted', 'succeeded'], submitDelayMs: 300 })
    service.queueScenario('music', { states: ['accepted', 'succeeded'], submitDelayMs: 300 })
    const job = fakeJob(2)
    await mg.generateMusicLibraryTracks(job)
    // Nothing free beyond what waits: one at a time (the window never drops below one).
    assert.equal(job.item_progress.concurrency, 1)
    assert.equal(job.result.saved_tracks.length, 2)
  })

  test('an older Gateway (capacity endpoint 404) never receives the priority field', async () => {
    service.queueScenario('music', { states: ['accepted', 'succeeded'] })
    await mg.generateMusicLibraryTracks(fakeJob(1))
    assert.ok(service.submissions.filter(s => s.operation === 'music').every(s => !('priority' in (s.parsedBody || {}))))
  })

  test('one failed track does not stop the others', async () => {
    for (let i = 0; i < 4; i++) {
      service.queueScenario('music', i === 1
        ? { states: ['accepted', 'failed'], failureCode: 'PROVIDER_REJECTED' }
        : { states: ['accepted', 'succeeded'], submitDelayMs: 100 })
    }
    const job = fakeJob(4)
    await assert.rejects(mg.generateMusicLibraryTracks(job))
    assert.equal(job.item_progress.completed, 3)
    assert.equal(job.item_progress.failed, 1)
    assert.equal(job.result.saved_tracks.length, 3)
    assert.ok(job.output_lines.some((l: string) => /Continuing with the rest/.test(l)), job.output_lines.join('\n'))
  })

  test('cancel stops new requests and ends the job', async () => {
    // Accepted quickly, then running for a while: Story only cancels once every submission is known.
    for (let i = 0; i < 10; i++) service.queueScenario('music', { states: ['accepted', ...Array(40).fill('running'), 'succeeded'] })
    const r = await request(app).post(`/api/projects/${slug}/music-library/generate`)
      .send({ brief: 'calm night piano', count: 10, model: 'mock-music-v1', instrumental: true, operation_id: crypto.randomUUID() })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const id = r.body.job_id as string
    await waitFor(() => musicSubmissions() >= 6, 'six requests in flight')
    let c: any
    const end = Date.now() + 10_000
    // Refused while a submit answer is outstanding; retried until every submission is known.
    do {
      c = await request(app).post(`/api/projects/${slug}/jobs/${id}/cancel`)
    } while (c.status >= 300 && Date.now() < end && await waitFor(() => false, 'retry pause', 100).catch(() => true))
    assert.ok(c.status < 300, JSON.stringify(c.body))
    // The executor stops (the job then waits for the Gateway to confirm the cancellations, as before).
    const stopped = () => (jq.getJob(id)?.output_lines || []).some(l => /Cancelled by user/.test(l)) || jq.getJob(id)?.status === 'cancelled'
    await waitFor(stopped, 'executor to stop', 30_000)
    assert.notEqual(jq.getJob(id)?.status, 'done')
    assert.equal(musicSubmissions(), 6, 'no request started after the cancel')
  })
})

describe('the rolling window', () => {
  test('a window that grows is used without waiting for a finish; a fatal error stops new starts', async () => {
    const { runRollingWindow, backgroundWindow } = await import('../lib/music-window.js')
    let size = 2
    let inFlight = 0
    let peak = 0
    const releases: Array<() => void> = []
    const run = runRollingWindow(Array.from({ length: 6 }, (_, i) => i), async () => size, async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise<void>(resolve => releases.push(resolve))
      inFlight--
    }, () => false, 20)
    await waitFor(() => inFlight === 2, 'two in flight')
    size = 5
    await waitFor(() => inFlight === 5, 'grows to five with nothing finished')
    while (releases.length) releases.shift()!()
    await waitFor(() => releases.length === 1, 'the last one starts')
    releases.shift()!()
    await run
    assert.equal(peak, 5)

    let started = 0
    await assert.rejects(runRollingWindow([1, 2, 3, 4], async () => 1, async item => {
      started++
      if (item === 2) throw new Error('out of credits')
    }, () => false, 20), /out of credits/)
    assert.equal(started, 2)

    const cap = (idle: number, queued: number) => ({ eligible_macs: 57, idle_macs: idle, running: { normal: 0, background: 0 }, queued: { normal: 0, background: queued } })
    assert.equal(backgroundWindow(cap(23, 0), 0), 25)
    assert.equal(backgroundWindow(cap(23, 0), 40), 65, 'keeps what is in flight and adds the idle Macs + 2')
    assert.equal(backgroundWindow(cap(0, 2), 40), 40, 'a full fleet adds nothing; nothing in flight is dropped')
    assert.equal(backgroundWindow(cap(5, 30), 10), 10, 'a waiting background queue holds new requests back')
  })
})

describe('music jobs across projects', () => {
  // Last in the file: it replaces the music_generate executor for this process.
  test('three projects at once; a fourth waits for a free slot; a second job for one project is refused', async () => {
    assert.equal(jq.MUSIC_PROJECTS_AT_ONCE, 3)
    const started: string[] = []
    const releases = new Map<string, () => void>()
    jq.registerExecutor('music_generate', async (job: any) => {
      started.push(job.title)
      await new Promise<void>(resolve => releases.set(job.title, resolve))
    })
    const add = (project: string, title: string) => jq.enqueuePreparedForTest({ project_slug: project, type: 'music_generate', episode_id: '', title, params: {} })
    for (const [p, t] of [['alpha', 'A'], ['beta', 'B'], ['gamma', 'C'], ['delta', 'D']]) add(p!, t!)
    assert.throws(() => add('alpha', 'A2'), /already queued\/running/)
    await waitFor(() => started.length === 3, 'three to start')
    assert.deepEqual([...started].sort(), ['A', 'B', 'C'], 'D waits for a free slot')
    releases.get('B')!()
    await waitFor(() => started.length === 4, 'the fourth to start')
    assert.equal(started[3], 'D')
    for (const t of ['A', 'C', 'D']) releases.get(t)!()
  })
})
