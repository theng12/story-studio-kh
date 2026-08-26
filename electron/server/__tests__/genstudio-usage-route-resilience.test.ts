/**
 * The endpoint the header badge actually polls, exercised end to end.
 *
 * `GET /api/app-settings/genstudio/usage` is where `GenStudio Unavailable`
 * comes from: the badge empties itself whenever this route fails. It used to
 * fail for three separate reasons that all looked identical to the user — one
 * slow overview read, one 502 overview read, or a settlement-history read that
 * failed while the balance itself was perfectly readable. None of them mean the
 * account is unreachable, and all three fired while jobs generated normally.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let app: any
let clearCache: () => void
let cleanup: () => Promise<void>
let originalFetch: typeof globalThis.fetch

const OVERVIEW = {
  credit_balance: 4_210,
  credits_used_30d: 900,
  subscription_plan_name: 'Angkor Pro',
  paid_concurrency_limit: 5,
  paid_active_jobs: 1,
  active_jobs: 1,
  completed_jobs: 12,
}
const EMPTY_PAGE = { items: [], page: 1, page_size: 20, total: 0, total_pages: 0 }

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  clearCache = (await import('../lib/genstudio-client.js')).clearGenStudioCatalogCache
  originalFetch = globalThis.fetch
  await request(app)
    .put('/api/app-settings/api-keys/genstudio')
    .send({ apiKey: 'gsk_usage_resilience' })
    .expect(200)
})

after(async () => {
  globalThis.fetch = originalFetch
  await cleanup()
})

/** `overview` decides how the balance read behaves on each successive attempt. */
function upstream(overview: Array<'ok' | 'timeout' | 'gateway'>, history: 'ok' | 'gateway' = 'ok'): () => number {
  let attempts = 0
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input)
    if (url.includes('/v1/account/overview')) {
      const reply = overview[Math.min(attempts, overview.length - 1)]
      attempts++
      if (reply === 'timeout') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
      if (reply === 'gateway') return new Response('bad gateway', { status: 502 })
      return Response.json(OVERVIEW)
    }
    if (url.includes('/v1/account/')) {
      return history === 'gateway' ? new Response('bad gateway', { status: 502 }) : Response.json(EMPTY_PAGE)
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof globalThis.fetch
  return () => attempts
}

test('a transient balance failure answers 200 with the balance — the badge never flips', async () => {
  clearCache()
  // The owner's exact report: an 8-second timeout, then a 502.
  const attempts = upstream(['timeout', 'gateway', 'ok'])
  const response = await request(app).get('/api/app-settings/genstudio/usage').expect(200)
  assert.equal(response.body.overview.credit_balance, 4_210)
  assert.equal(response.body.overview_freshness.stale, false)
  assert.equal(attempts(), 3, 'the blip was retried rather than reported')
})

test('a balance read that stays down serves the last known balance, marked stale', async () => {
  clearCache()
  upstream(['ok'])
  await request(app).get('/api/app-settings/genstudio/usage').expect(200)

  upstream(['gateway'])
  const response = await request(app).get('/api/app-settings/genstudio/usage').expect(200)
  assert.equal(response.body.overview.credit_balance, 4_210, 'still a real balance, just not a new one')
  assert.equal(response.body.overview_freshness.stale, true, 'and the UI is told to say so')
  assert.ok(response.body.overview_freshness.ageMs >= 0)
})

test('settlement history failing does not take the balance down with it', async () => {
  clearCache()
  upstream(['ok'], 'gateway')
  const response = await request(app).get('/api/app-settings/genstudio/usage').expect(200)
  assert.equal(response.body.overview.credit_balance, 4_210)
  assert.ok(response.body.history_error, 'the history failure is reported, not disguised as an empty history')
  assert.deepEqual(response.body.jobs.items, [])
})

test('only a balance that is down with nothing cached returns a failure at all', async () => {
  clearCache()
  upstream(['gateway'])
  await request(app).get('/api/app-settings/genstudio/usage').expect(502)
})
