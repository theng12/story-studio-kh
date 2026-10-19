/**
 * `GET /gateway/status` — the shell's "is the Gateway answering?" probe.
 *
 * The sidebar used to report only the app's own engine ("Story Studio online"), which is up whenever
 * the window is, so a stopped or restarting Gateway looked healthy. This route asks the Gateway's
 * unauthenticated `/health` with no key and no catalogue read, and calls only a refused/timed-out
 * connection "not reachable".
 */
import { after, afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'

import { router as healthRouter } from '../routes/health.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
before(async () => { cleanup = (await useTempDataDir()).cleanup })
after(async () => { await cleanup() })

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function app() {
  const server = express()
  server.use(healthRouter)
  return server
}

describe('GET /gateway/status', () => {
  test('a Gateway that answers is reachable, and only its key-free /health is asked', async () => {
    const calls: Array<{ url: string; headers: unknown }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers })
      return new Response('{"status":"ok"}', { status: 200 })
    }) as typeof fetch
    const res = await request(app()).get('/gateway/status')
    assert.equal(res.status, 200)
    assert.equal(res.body.reachable, true)
    assert.equal(res.body.url, 'http://127.0.0.1:8787')
    assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:8787/health'])
    assert.equal(calls[0]!.headers, undefined, 'no API key leaves Story Studio for a liveness check')
  })

  test('any HTTP answer proves the Gateway is running (a 404 included)', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch
    const res = await request(app()).get('/gateway/status')
    assert.equal(res.body.reachable, true)
  })

  test('a refused or timed-out connection is "not reachable", answered as 200 so the shell can show it', async () => {
    for (const failure of [
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' }) }),
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    ]) {
      globalThis.fetch = (async () => { throw failure }) as typeof fetch
      const res = await request(app()).get('/gateway/status')
      assert.equal(res.status, 200)
      assert.equal(res.body.reachable, false)
    }
  })

  test('the liveness body is released, not left holding its socket open', async () => {
    // Only "did it answer" is read here, and the shell asks every 20 s per
    // client. An unread body keeps its connection with nothing draining it, so
    // the route must cancel it — one stranded socket per poll per client is how
    // 264 connections accumulated against the Gateway.
    let released = false
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"status":"ok"}')) },
      cancel() { released = true },
    }), { status: 200 })) as typeof fetch
    const res = await request(app()).get('/gateway/status')
    assert.equal(res.body.reachable, true)
    assert.equal(released, true, 'the unread liveness body was never released')
  })
})
