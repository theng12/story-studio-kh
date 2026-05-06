/**
 * Tests for the HTTP-level cancel propagation — audit-reports/09-jobs.md H1.
 *
 * Two things this locks in:
 *   1. `pollForResult({ isCancelled: () => true })` stops immediately with
 *      a "Cancelled by user" error — used by every queue-polling client
 *      (fal TTS, fal video, kie video).
 *   2. When a queued job using `generateTts` is cancelled mid-poll against
 *      a fake server that never returns COMPLETED, the job settles as
 *      `cancelled` within ~1 second instead of running the full 5-minute
 *      MAX_WAIT. This is the end-to-end wiring that was missing before
 *      the audit fix: cancelling a 50-image batch used to leak 50×6-min
 *      poll loops because the clients ignored the cancel set.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { pollForResult } from '../lib/http-retry.js'
import { generateTts } from '../lib/fal-client.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

describe('pollForResult isCancelled probe', () => {
  test('throws "Cancelled by user" immediately when isCancelled is true', async () => {
    // Fake status server that would otherwise claim IN_PROGRESS forever.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'IN_PROGRESS' }))
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as AddressInfo).port

    try {
      const start = Date.now()
      await assert.rejects(
        () => pollForResult<string>({
          label: 'test poll',
          url: `http://127.0.0.1:${port}/`,
          headers: {},
          deadline: Date.now() + 60_000,
          intervalMs: 1000,
          isCancelled: () => true,
          onData: () => ({ continue: true }),
        }),
        /Cancelled by user/,
      )
      // Should be nearly instant — the probe fires before the first fetch.
      const elapsed = Date.now() - start
      assert.ok(elapsed < 500, `expected cancel to be fast, took ${elapsed}ms`)
    } finally {
      server.close()
    }
  })
})

describe('pollForResult — timeout / failure propagation', () => {
  test('throws "timed out" when deadline expires while server keeps returning IN_PROGRESS', async () => {
    // Fake provider that never completes. Without the deadline check
    // the poll loop would run forever; this test pins the timeout
    // message shape so a future refactor can't silently break it.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'IN_PROGRESS' }))
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as AddressInfo).port

    try {
      const start = Date.now()
      // 800ms deadline + 100ms interval — at most ~8 ticks before timeout.
      await assert.rejects(
        () => pollForResult<string>({
          label: 'fal.ai status',
          url: `http://127.0.0.1:${port}/`,
          headers: {},
          deadline: Date.now() + 800,
          intervalMs: 100,
          onData: () => ({ continue: true }),
        }),
        (err: Error) => {
          assert.match(err.message, /timed out/, `expected timeout message; got: ${err.message}`)
          assert.match(err.message, /fal\.ai status/, 'label is included so users see which provider')
          return true
        },
      )
      const elapsed = Date.now() - start
      // Deadline + one interval slack — the loop checks Date.now() at the
      // top, so a tick can overshoot by intervalMs.
      assert.ok(elapsed < 2000, `should timeout near the deadline; took ${elapsed}ms`)
    } finally {
      server.close()
    }
  })

  test('escalates with provider status after MAX_CONSECUTIVE_FAILURES of 5xx', async () => {
    // Server consistently 503s. The poll loop counts consecutive failures
    // and after 8 raises a meaningful error including status code + body
    // tail, instead of silently looping until deadline.
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Upstream gateway is dead, try later')
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as AddressInfo).port

    try {
      await assert.rejects(
        () => pollForResult<string>({
          label: 'kie.ai video',
          url: `http://127.0.0.1:${port}/`,
          headers: {},
          // Generous deadline — we want failure escalation to fire BEFORE
          // the deadline kicks in, proving the consecutive-error path
          // works independently.
          deadline: Date.now() + 60_000,
          intervalMs: 1,  // tight cadence so all 8 failures fire fast
          onData: () => ({ continue: true }),
        }),
        (err: Error) => {
          // Body tail is included so users can see the upstream's actual
          // explanation rather than a generic "failed".
          assert.match(err.message, /503/, 'status code in message')
          assert.match(err.message, /kie\.ai video/, 'label in message')
          assert.match(err.message, /gateway is dead/, 'response body tail surfaces')
          return true
        },
      )
    } finally {
      server.close()
    }
  })

  test('redactKey scrubs the API key from a 503 body before it reaches the thrown error', async () => {
    // Audit hook: any provider that echoes the Authorization header in
    // a 4xx/5xx body (some quota-rejection endpoints do) would leak
    // secrets through the queue → SSE → renderer log chain. The
    // redactKey hook on pollForResult scrubs them before throwing.
    const SECRET = 'sk_live_VERY_SECRET_KEY_42'
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end(`Authorization=${SECRET} not allowed`)
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as AddressInfo).port

    try {
      await assert.rejects(
        () => pollForResult<string>({
          label: 'fal.ai',
          url: `http://127.0.0.1:${port}/`,
          headers: {},
          deadline: Date.now() + 60_000,
          intervalMs: 1,
          onData: () => ({ continue: true }),
          redactKey: SECRET,
        }),
        (err: Error) => {
          assert.ok(!err.message.includes(SECRET),
            `secret leaked into error message: ${err.message}`)
          return true
        },
      )
    } finally {
      server.close()
    }
  })
})

describe('end-to-end: cancel aborts in-flight TTS poll', () => {
  test('cancelJob settles a stuck-in-poll TTS job as cancelled within ~1s', async (t) => {
    // Fake fal queue: submit returns { status_url }, status forever reports IN_PROGRESS.
    let submits = 0
    let polls = 0
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST') {
        submits++
        res.writeHead(200)
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status`
        res.end(JSON.stringify({ status_url: url, response_url: url }))
      } else {
        polls++
        res.writeHead(200)
        res.end(JSON.stringify({ status: 'IN_PROGRESS' }))
      }
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as AddressInfo).port
    t.after(() => server.close())

    // Monkey-patch fetch so fal-client hits our fake server instead of
    // queue.fal.run. We only need to redirect the queue URL.
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : String(input.url || input)
      if (urlStr.startsWith('https://queue.fal.run/')) {
        return originalFetch(`http://127.0.0.1:${port}/`, init)
      }
      return originalFetch(input, init)
    }) as typeof fetch
    t.after(() => { globalThis.fetch = originalFetch })

    const proj = await pm.createProject({ name: 'CancelFetch' })

    // Executor calls generateTts with the job's isCancelled probe — same
    // shape the audio generator uses.
    const jobPromise = new Promise<Error | null>((resolve) => {
      jq.registerExecutor('script-only', async (job) => {
        try {
          await generateTts('hello', 'fake-key', {
            model: 'turbo-v2.5',
            voiceId: 'fake-voice',
            timeoutMs: 60_000,
            isCancelled: () => jq.isCancelled(job.job_id),
          })
          resolve(null)
        } catch (e: any) {
          resolve(e)
        }
      })
    })

    const job = jq.enqueue({
      project_slug: proj.slug, type: 'script-only', episode_id: 'CF_1',
      title: 't', params: {},
    })

    // Let the executor submit + enter the poll loop.
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(submits >= 1, 'submit should have fired')

    const cancelledAt = Date.now()
    jq.cancelJob(job.job_id)

    const err = await Promise.race([
      jobPromise,
      new Promise<Error | null>((_, rej) =>
        setTimeout(() => rej(new Error('generateTts did not reject within 3s')), 3000),
      ),
    ])

    const elapsed = Date.now() - cancelledAt
    assert.ok(err instanceof Error, 'generateTts should reject on cancel')
    assert.match(err!.message, /Cancelled by user/)
    assert.ok(elapsed < 1500, `expected cancel to unwind in <1.5s, took ${elapsed}ms`)

    // The queue runner should classify this as 'cancelled'.
    await new Promise((r) => setTimeout(r, 200))
    const settled = jq.getJob(job.job_id)
    assert.equal(settled?.status, 'cancelled')
  })
})
