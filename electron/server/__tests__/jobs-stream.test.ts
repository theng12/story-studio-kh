/**
 * Integration tests for the `/api/projects/:slug/jobs/stream` SSE endpoint.
 *
 * Supertest doesn't handle long-lived responses well, so these tests spin a
 * real server on an ephemeral port for the duration of each assertion. Every
 * test bounds its wait window with a short timeout — the stream stays open
 * until we close it from the client side.
 *
 * Coverage:
 *   - On subscribe, the server sends exactly one `snapshot` frame.
 *   - An `enqueue()` after subscribe produces `update` frames on the stream.
 *   - `clearFinished()` triggers a `cleared` frame.
 *   - Subscribing to project A never receives events scoped to project B.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { createBufferedJobStream, durableJobScopes } from '../routes/jobs.js'
import { softDeleteProjectAfterGuard } from '../services/soft-delete.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let server: http.Server
let baseUrl: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

interface SseFrame {
  event: string
  data: string
}

test('buffers job events until the initial snapshot has been sent', () => {
  const sent: Array<{ event: string, payload: unknown }> = []
  const stream = createBufferedJobStream((event, payload) => sent.push({ event, payload }))
  const update = { job_id: 'during-snapshot', project_slug: 'alpha', status: 'queued' }
  const snapshot = { jobs: [], stats: { running: 0, queued: 0, paused: 0, done: 0, error: 0, total: 0 } }

  stream.send('update', update)
  assert.deepEqual(sent, [], 'an update emitted while snapshot work is pending must not overtake the snapshot')

  stream.sendSnapshot(snapshot)
  assert.deepEqual(sent, [
    { event: 'snapshot', payload: snapshot },
    { event: 'update', payload: update },
  ])
})

test('reports an initial snapshot failure before releasing buffered job events', () => {
  const sent: Array<{ event: string, payload: unknown }> = []
  const stream = createBufferedJobStream((event, payload) => sent.push({ event, payload }), 'Could not load project Jobs.')
  const update = { job_id: 'during-failure', project_slug: 'alpha', status: 'queued' }

  stream.send('update', update)
  stream.sendSnapshotError()

  assert.deepEqual(sent, [
    { event: 'snapshot-error', payload: { detail: 'Could not load project Jobs.' } },
    { event: 'update', payload: update },
  ])
})

/**
 * Open an SSE subscription, collect frames, then close the connection and
 * resolve. Callers trigger side-effects (enqueue, clear) inside the window and
 * assert on the frames afterwards.
 *
 * WAIT FOR THE FRAME, NOT FOR A DURATION. Every test here used to collect for a
 * flat 150-400ms chosen against an idle machine. In v1.4.73 the backend suite
 * roughly tripled in length and disk traffic, and two different tests in this
 * file failed on two different runs — "expected cleared frame; got: snapshot,
 * update, update", then "should send exactly one snapshot: 0 !== 1". Both times
 * the stream was working and the window had simply closed too early, which
 * reads on the report as a broken endpoint.
 *
 * So `until` says what the test is waiting for. The window closes `graceMs`
 * AFTER that becomes true — the grace is what still catches a SECOND snapshot,
 * or an event that should never have arrived, so negative assertions keep their
 * meaning. `SSE_HARD_CAP_MS` bounds a predicate that never comes true, and the
 * assertion then fails on the frames actually received rather than on a hang.
 */
const SSE_HARD_CAP_MS = 30_000

function hasEvent(frames: SseFrame[], event: string): boolean {
  return frames.some(frame => frame.event === event)
}

function hasEpisodeUpdate(frames: SseFrame[], episodeId: string): boolean {
  return frames.some(frame => {
    if (frame.event !== 'update') return false
    try { return JSON.parse(frame.data).episode_id === episodeId } catch { return false }
  })
}

function collectFrames(
  urlPath: string,
  graceMs: number,
  until: (frames: SseFrame[]) => boolean = () => true,
): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl)
    const frames: SseFrame[] = []
    let graceTimer: NodeJS.Timeout | undefined
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(graceTimer)
      clearTimeout(hardCap)
      req.destroy()
      resolve(frames)
    }
    const hardCap = setTimeout(finish, SSE_HARD_CAP_MS)
    const considerSatisfied = () => {
      if (settled || graceTimer) return
      if (!until(frames)) return
      graceTimer = setTimeout(finish, graceMs)
    }
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(hardCap)
          req.destroy()
          reject(new Error(`SSE responded ${res.statusCode}`))
          return
        }
        // Lets the default predicate start its window at open, which is the
        // old fixed-duration behaviour for any caller that wants it.
        considerSatisfied()
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buf += chunk
          // SSE frames are separated by blank lines ("\n\n").
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            // Skip comment-only keepalives (`:ping`).
            if (raw.startsWith(':')) continue
            // Skip the initial `retry: 5000` hint frame — it has no data/event fields.
            if (raw.startsWith('retry:')) continue
            let event = 'message'
            const dataLines: string[] = []
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
            }
            frames.push({ event, data: dataLines.join('\n') })
          }
          considerSatisfied()
        })
        res.on('error', reject)
      },
    )
    req.on('error', (error) => { clearTimeout(hardCap); clearTimeout(graceTimer); reject(error) })
    req.end()
  })
}

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })

  // Prevent app.ts's own listen() path; we bind our own port below.
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')

  // Register a no-op executor so enqueued jobs complete immediately and we
  // exercise the full queued → running → done transition set in one test.
  jq.registerExecutor('script-only', async () => {})

  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address() as import('net').AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

describe('SSE /projects/:slug/jobs/stream', () => {
  test('sends exactly one snapshot frame on subscribe', async () => {
    const proj = await pm.createProject({ name: 'SSE_Snap' })
    const frames = await collectFrames(`/api/projects/${proj.slug}/jobs/stream`, 150, f => hasEvent(f, 'snapshot'))
    const snapshots = frames.filter(f => f.event === 'snapshot')
    assert.equal(snapshots.length, 1, 'should send exactly one snapshot')
    const payload = JSON.parse(snapshots[0].data)
    assert.ok(Array.isArray(payload.jobs))
    assert.ok(payload.stats)
    assert.equal(typeof payload.stats.total, 'number')
  })

  test('emits an update frame when a job is enqueued after subscribe', async () => {
    const proj = await pm.createProject({ name: 'SSE_Enqueue' })

    // Kick off the collection first, then enqueue a job inside the window.
    const collection = collectFrames(`/api/projects/${proj.slug}/jobs/stream`, 50, f => hasEpisodeUpdate(f, 'SSE_EP1'))
    // Let the snapshot flush before we enqueue so the `update` is clearly
    // attributable to our action.
    await new Promise((r) => setTimeout(r, 50))
    jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'script-only',
      episode_id: 'SSE_EP1',
      title: 'stream probe',
      params: {},
    })
    const frames = await collection

    const updates = frames.filter(f => f.event === 'update').map(f => JSON.parse(f.data))
    assert.ok(updates.length > 0, 'should receive at least one update')
    assert.ok(
      updates.some(u => u.episode_id === 'SSE_EP1'),
      `no update for enqueued job — got: ${JSON.stringify(updates.map(u => u.episode_id))}`,
    )
  })

  test('never leaks events from another project into the stream', async () => {
    const a = await pm.createProject({ name: 'SSE_Scope_A' })
    const b = await pm.createProject({ name: 'SSE_Scope_B' })

    // A negative assertion: wait for A's own snapshot, then keep listening for a
    // further 300ms, which is the window in which B's event would have leaked.
    const collectionA = collectFrames(`/api/projects/${a.slug}/jobs/stream`, 300, f => hasEvent(f, 'snapshot'))
    await new Promise((r) => setTimeout(r, 50))
    // Enqueue on project B — A's subscriber must NOT see it.
    jq.enqueuePreparedForTest({
      project_slug: b.slug,
      type: 'script-only',
      episode_id: 'SSE_SCOPE_B1',
      title: 'should be invisible',
      params: {},
    })
    const framesA = await collectionA

    const leaked = framesA
      .filter(f => f.event === 'update')
      .map(f => JSON.parse(f.data))
      .filter(u => u.project_slug === b.slug)
    assert.equal(leaked.length, 0, 'events from other projects leaked into the stream')
  })

  test('emits a cleared frame when finished jobs are wiped', async () => {
    const proj = await pm.createProject({ name: 'SSE_Cleared' })

    // Enqueue and wait for it to complete so clearFinished has something to
    // purge. The no-op executor reaches `done` in well under 50ms on an idle
    // machine, and this used to be a flat 100ms sleep on that basis. Under the
    // v1.4.73 suite — roughly three times its former length, and far heavier on
    // disk — 100ms was sometimes not enough, and then clearFinished had nothing
    // to purge and emitted no `cleared` frame. The test read as "the stream is
    // broken" when the stream was fine; the frames it did receive were
    // `snapshot, update, update`. Wait for the CONDITION instead of guessing a
    // duration, so the test measures what it is about.
    jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'script-only',
      episode_id: 'SSE_CLEAR_1',
      title: 'to be cleared',
      params: {},
    })
    const settleBy = Date.now() + 30_000
    while (Date.now() < settleBy) {
      const jobs = await jq.getJobs(proj.slug)
      if (jobs.length && jobs.every(job => job.status === 'done' || job.status === 'error')) break
      await new Promise((r) => setTimeout(r, 25))
    }

    const collection = collectFrames(`/api/projects/${proj.slug}/jobs/stream`, 50, f => hasEvent(f, 'cleared'))
    await new Promise((r) => setTimeout(r, 50))
    await jq.clearFinished(proj.slug)
    const frames = await collection

    assert.ok(
      frames.some(f => f.event === 'cleared'),
      `expected cleared frame; got: ${frames.map(f => f.event).join(', ')}`,
    )
  })

  test('paused reconciliation evidence waits for one deterministic dirty flush', async () => {
    assert.equal(typeof jq._flushDirtyJobStreamsForTesting, 'function', 'the production dirty flush needs a deterministic test seam')
    const proj = await pm.createProject({ name: 'SSE_Paused_Reconciliation' })
    const jobsFile = path.join(tempDir, 'projects', proj.slug, 'jobs.json')
    const paused = {
      job_id: 'paused-reconciliation', project_slug: proj.slug, type: 'audio', episode_id: 'SSE_PAUSED', title: '',
      status: 'paused', pause_origin: 'manual', created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z', finished_at: null, error: null, output_lines: [], params: {},
      remote_cancellations: {
        'voice.tts:provider-paused': {
          status: 'requested', operation: 'voice.tts', provider_job_id: 'provider-paused',
          requested_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [paused] }))
    await jq.getJobs(proj.slug)
    const updates: any[] = []
    const onUpdate = (job: any) => {
      if (job.job_id === paused.job_id) updates.push(job)
    }
    jq.jobEvents.on('update', onUpdate)
    try {
      await jq.recordRemoteCancellation('paused-reconciliation', 'voice.tts', 'provider-paused', {
        status: 'confirmed', cancelled: true,
      })
      assert.equal(updates.length, 0, 'nonterminal reconciliation evidence is cadence-bound')

      jq._flushDirtyJobStreamsForTesting()

      assert.equal(updates.length, 1)
      assert.equal(updates[0].status, 'paused')
      assert.equal(updates[0].remote_cancellations['voice.tts:provider-paused'].status, 'confirmed')
    } finally {
      jq.jobEvents.off('update', onUpdate)
    }
  })
})

describe('SSE /jobs/all/stream', () => {
  test('treats a missing durable root as empty but surfaces an unreadable root', async () => {
    const missingRoot = path.join(tempDir, 'missing-projects-root')
    assert.deepEqual(await durableJobScopes(missingRoot, new Set()), [])

    const notDirectory = path.join(tempDir, 'projects-root-file')
    await fs.writeFile(notDirectory, 'not a directory')
    await assert.rejects(durableJobScopes(notDirectory, new Set()), { code: 'ENOTDIR' })
  })

  test('retains application-scoped jobs in the universal snapshot and stream', async () => {
    const appJob = jq.enqueuePreparedForTest({
      project_slug: '_app_', type: 'script-only', episode_id: 'APP_SCOPE', title: 'app scope', params: {},
    })

    const appJobs = await request(app).get('/api/jobs/app').expect(200)
    assert.ok(appJobs.body.jobs.some((job: any) => job.job_id === appJob.job_id))

    const allJobs = await request(app).get('/api/jobs/all').expect(200)
    assert.ok(allJobs.body.jobs.some((job: any) => job.job_id === appJob.job_id))

    const frames = await collectFrames('/api/jobs/all/stream', 50, f => hasEvent(f, 'snapshot'))
    const snapshot = frames.find(frame => frame.event === 'snapshot')
    assert.ok(snapshot, 'universal stream should send a snapshot')
    assert.ok(JSON.parse(snapshot.data).jobs.some((job: any) => job.job_id === appJob.job_id))
  })

  test('does not resurrect a soft-deleted project through its durable jobs scope', async () => {
    const slug = 'SSE_Hidden_Durable'
    await fs.mkdir(path.join(tempDir, 'projects', slug), { recursive: true })
    await fs.writeFile(path.join(tempDir, 'projects', slug, 'jobs.json'), JSON.stringify({ jobs: [{
      job_id: 'hidden-durable-job', project_slug: slug, type: 'script-only', episode_id: 'HIDDEN_ONLY', title: 'hidden scope',
      status: 'done', created_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:01:00.000Z', error: null, output_lines: [], params: {},
    }] }))
    await softDeleteProjectAfterGuard(slug)

    const allJobs = await request(app).get('/api/jobs/all').expect(200)
    assert.ok(!allJobs.body.jobs.some((job: any) => job.job_id === 'hidden-durable-job'),
      'All Jobs must retain the Library\'s hidden-project boundary')
  })

  test('includes a durable project scope that the Library cannot list', async () => {
    // A project Jobs URL hydrates its own durable scope directly. The all-jobs
    // endpoints must include that same scope even when project.json is absent
    // or unreadable and the Library therefore omits the folder.
    const slug = 'SSE_Durable_Only'
    await fs.mkdir(path.join(tempDir, 'projects', slug), { recursive: true })
    await fs.writeFile(path.join(tempDir, 'projects', slug, 'jobs.json'), JSON.stringify({ jobs: [{
      job_id: 'durable-only-job', project_slug: slug, type: 'script-only', episode_id: 'DURABLE_ONLY', title: 'durable scope',
      status: 'done', created_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:01:00.000Z', error: null, output_lines: [], params: {},
    }] }))

    const projectJobs = await request(app).get(`/api/projects/${slug}/jobs`).expect(200)
    assert.equal(projectJobs.body.jobs.length, 1, 'the project endpoint proves this durable scope is readable')

    const allJobs = await request(app).get('/api/jobs/all').expect(200)
    assert.ok(allJobs.body.jobs.some((job: any) => job.job_id === 'durable-only-job'),
      'the all-jobs snapshot must include every readable per-project jobs scope')

    const frames = await collectFrames('/api/jobs/all/stream', 50, f => hasEvent(f, 'snapshot'))
    const snapshot = frames.find(frame => frame.event === 'snapshot')
    assert.ok(snapshot, 'universal stream should send a snapshot')
    assert.ok(JSON.parse(snapshot.data).jobs.some((job: any) => job.job_id === 'durable-only-job'),
      'the universal stream snapshot must include every readable per-project jobs scope')
  })

  test('initial snapshot combines jobs from every project', async () => {
    const a = await pm.createProject({ name: 'SSE_All_A' })
    const b = await pm.createProject({ name: 'SSE_All_B' })
    jq.enqueuePreparedForTest({ project_slug: a.slug, type: 'script-only', episode_id: 'ALL_A1', title: '', params: {} })
    jq.enqueuePreparedForTest({ project_slug: b.slug, type: 'script-only', episode_id: 'ALL_B1', title: '', params: {} })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const frames = await collectFrames('/api/jobs/all/stream', 50, f => hasEvent(f, 'snapshot'))
    const snapshot = frames.find(frame => frame.event === 'snapshot')
    assert.ok(snapshot, 'universal stream should send a snapshot')
    const payload = JSON.parse(snapshot.data)
    assert.ok(payload.jobs.some((job: any) => job.project_slug === a.slug && job.episode_id === 'ALL_A1'))
    assert.ok(payload.jobs.some((job: any) => job.project_slug === b.slug && job.episode_id === 'ALL_B1'))
    assert.equal(payload.stats.total, payload.jobs.length)
  })

  test('receives updates from another project without resubscribing', async () => {
    const project = await pm.createProject({ name: 'SSE_All_Update' })
    const collection = collectFrames('/api/jobs/all/stream', 50, f => hasEpisodeUpdate(f, 'ALL_LIVE_1'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'script-only', episode_id: 'ALL_LIVE_1', title: '', params: {} })
    const frames = await collection
    const updates = frames.filter(frame => frame.event === 'update').map(frame => JSON.parse(frame.data))
    assert.ok(updates.some(job => job.project_slug === project.slug && job.episode_id === 'ALL_LIVE_1'))
  })
})
