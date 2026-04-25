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
import { useTempDataDir } from './_helpers.js'

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

/**
 * Open an SSE subscription, collect frames for `waitMs`, then close the
 * connection and resolve. Returns everything received in the window, so
 * callers can trigger side-effects (enqueue, clear) inside the window and
 * assert on the frames afterwards.
 */
function collectFrames(urlPath: string, waitMs: number): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl)
    const frames: SseFrame[] = []
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => {
        if (res.statusCode !== 200) {
          req.destroy()
          reject(new Error(`SSE responded ${res.statusCode}`))
          return
        }
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
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
    setTimeout(() => {
      req.destroy()
      resolve(frames)
    }, waitMs)
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
  await cleanup()
})

describe('SSE /projects/:slug/jobs/stream', () => {
  test('sends exactly one snapshot frame on subscribe', async () => {
    const proj = await pm.createProject({ name: 'SSE_Snap' })
    const frames = await collectFrames(`/api/projects/${proj.slug}/jobs/stream`, 150)
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
    const collection = collectFrames(`/api/projects/${proj.slug}/jobs/stream`, 400)
    // Let the snapshot flush before we enqueue so the `update` is clearly
    // attributable to our action.
    await new Promise((r) => setTimeout(r, 50))
    jq.enqueue({
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

    const collectionA = collectFrames(`/api/projects/${a.slug}/jobs/stream`, 300)
    await new Promise((r) => setTimeout(r, 50))
    // Enqueue on project B — A's subscriber must NOT see it.
    jq.enqueue({
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

    // Enqueue and wait for it to complete so clearFinished has something
    // to purge. The no-op executor means the job reaches `done` in < 50 ms.
    jq.enqueue({
      project_slug: proj.slug,
      type: 'script-only',
      episode_id: 'SSE_CLEAR_1',
      title: 'to be cleared',
      params: {},
    })
    await new Promise((r) => setTimeout(r, 100))

    const collection = collectFrames(`/api/projects/${proj.slug}/jobs/stream`, 300)
    await new Promise((r) => setTimeout(r, 50))
    await jq.clearFinished(proj.slug)
    const frames = await collection

    assert.ok(
      frames.some(f => f.event === 'cleared'),
      `expected cleared frame; got: ${frames.map(f => f.event).join(', ')}`,
    )
  })
})
