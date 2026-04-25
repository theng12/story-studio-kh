/**
 * Tests for the credit / balance preflight layer.
 *
 * Pins down three invariants that have silently broken in the past or that
 * protect spend:
 *
 *   1. `assertBalanceAvailable` blocks a run only when the provider returns a
 *      *definitely* empty numeric balance. Uncertainty (network errors,
 *      non-numeric strings like `'admin key needed'`, missing fields) is
 *      treated as "maybe fine" so a flaky balance endpoint never blocks the
 *      user's legitimate work.
 *   2. The credit cache keys by `sha256(apiKey)`, not the old 8-char prefix —
 *      two different keys that happened to share a prefix used to collide
 *      and show one project's balance to another.
 *   3. The cache is cleared after every job reaches a terminal state, so the
 *      UI sees live balances within the 5-second TTL instead of the 30 s
 *      stale window we used to have.
 *
 * All provider HTTP calls are stubbed via `global.fetch`. The original fetch
 * is saved before each test block and restored after so one stub doesn't
 * leak into a neighbouring test.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let utils: typeof import('../services/utils.js')
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

// Snapshot the real fetch so tests that stub it can put it back.
const realFetch = globalThis.fetch

type StubResponse = { ok: boolean; status?: number; json?: any; headers?: Record<string, string> }
type StubFn = (url: string, init?: RequestInit) => Promise<StubResponse>

function installFetchStub(stub: StubFn) {
  // Type-cast only — the test stubs don't need the full Response surface.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const r = await stub(url, init)
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      headers: new Map(Object.entries(r.headers ?? {})) as any,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json ?? ''),
    } as unknown as Response
  }) as any
}

function restoreFetch() {
  globalThis.fetch = realFetch
}

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  utils = await import('../services/utils.js')
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => {
  restoreFetch()
  await cleanup()
})

// Always wipe the cache between tests — one stub's cached value must not
// survive into the next stub's expectations.
beforeEach(() => {
  utils.invalidateCreditCache()
})

afterEach(() => {
  restoreFetch()
})

describe('assertBalanceAvailable', () => {
  test('blocks kie when balance is a definite 0', async () => {
    installFetchStub(async () => ({ ok: true, json: { data: 0 } }))
    await assert.rejects(
      utils.assertBalanceAvailable('kie', 'test-kie-key'),
      /balance is 0/,
    )
  })

  test('blocks fal when balance is a definite 0', async () => {
    installFetchStub(async () => ({ ok: true, json: { credits: { current_balance: 0 } } }))
    await assert.rejects(
      utils.assertBalanceAvailable('fal', 'test-fal-key'),
      /balance is empty/,
    )
  })

  test('passes when balance is positive', async () => {
    installFetchStub(async () => ({ ok: true, json: { data: 250 } }))
    await utils.assertBalanceAvailable('kie', 'test-kie-key')
    // no throw == pass
  })

  test('does NOT block on network errors — uncertainty is not a zero', async () => {
    installFetchStub(async () => { throw new Error('ECONNREFUSED') })
    // The preflight must be best-effort: a balance endpoint that's down
    // shouldn't prevent the user from running a legitimate generation.
    await utils.assertBalanceAvailable('kie', 'test-kie-key')
    await utils.assertBalanceAvailable('fal', 'test-fal-key')
    await utils.assertBalanceAvailable('elevenlabs', 'test-eleven-key')
  })

  test('does NOT block fal when balance returns the admin-key sentinel', async () => {
    // fal returns 403 for non-admin keys; getFalBalance surfaces the string
    // `'admin key needed'`. That's uncertainty, not a zero.
    installFetchStub(async () => ({ ok: false, status: 403, json: {} }))
    await utils.assertBalanceAvailable('fal', 'test-fal-key')
  })

  test('no-ops when apiKey is empty', async () => {
    // Empty-key checks are owned by the caller (with better messages).
    // Make sure the preflight doesn't crash or call fetch at all.
    let called = false
    installFetchStub(async () => { called = true; return { ok: true, json: {} } })
    await utils.assertBalanceAvailable('kie', '')
    assert.equal(called, false, 'preflight should not hit the network for an empty key')
  })
})

describe('credit cache collision resistance', () => {
  test('two keys with a shared 8-char prefix are NOT treated as the same cache entry', async () => {
    // Old implementation used `apiKey.slice(0, 8)` as the cache key —
    // these two keys would collide. The SHA-256 key scheme fixes it.
    const keyA = 'PREFIXAA_account_one'
    const keyB = 'PREFIXAA_account_two'

    let seen = 0
    installFetchStub(async (_url, init) => {
      seen++
      const auth = String((init?.headers as any)?.Authorization || '')
      // Return a distinct balance per key so a collision would be observable.
      if (auth.includes(keyA)) return { ok: true, json: { data: 111 } }
      if (auth.includes(keyB)) return { ok: true, json: { data: 222 } }
      return { ok: true, json: { data: -1 } }
    })

    const a = await utils.getKieCredits(keyA)
    const b = await utils.getKieCredits(keyB)
    assert.equal(a, 111, 'keyA should see its own balance')
    assert.equal(b, 222, 'keyB should see its own balance, not keyA\'s')
    assert.equal(seen, 2, 'each key must make its own live fetch')
  })

  test('same key served from cache on the second call (no extra fetch)', async () => {
    let seen = 0
    installFetchStub(async () => { seen++; return { ok: true, json: { data: 42 } } })

    assert.equal(await utils.getKieCredits('same-key'), 42)
    assert.equal(await utils.getKieCredits('same-key'), 42)
    assert.equal(seen, 1, 'second call must hit the cache, not the network')
  })
})

describe('credit cache invalidation on job completion', () => {
  test('invalidateCreditCache() clears all entries', async () => {
    let seen = 0
    installFetchStub(async () => { seen++; return { ok: true, json: { data: 7 } } })

    await utils.getKieCredits('abc')
    await utils.getKieCredits('abc')
    assert.equal(seen, 1, 'second call should have been cached')

    utils.invalidateCreditCache()
    await utils.getKieCredits('abc')
    assert.equal(seen, 2, 'post-invalidation call must go back to the network')
  })

  test('terminal job transition fires the invalidator via jobEvents', async () => {
    // Warm the cache
    let seen = 0
    installFetchStub(async () => { seen++; return { ok: true, json: { data: 99 } } })
    await utils.getKieCredits('job-flow-key')
    assert.equal(seen, 1)

    // Run a no-op job end-to-end. emitUpdate fires on every transition, and
    // terminal transitions schedule invalidateCreditCache(). It's scheduled
    // via dynamic import, so we wait a beat for the resolution.
    const proj = await pm.createProject({ name: 'CacheFlow' })
    jq.registerExecutor('script-only', async () => {})
    jq.enqueue({
      project_slug: proj.slug, type: 'script-only', episode_id: 'CACHE_EP1',
      title: 't', params: {},
    })
    // Long enough for: enqueue → processQueue → executor resolves →
    // persistJob → emitUpdate(done) → dynamic import of utils → cache.clear.
    await new Promise((r) => setTimeout(r, 200))

    await utils.getKieCredits('job-flow-key')
    assert.equal(
      seen, 2,
      'cache should be cleared after job completes, forcing a fresh fetch',
    )
  })
})

describe('getGenaiproBalance', () => {
  // GenAIPro's /v1/labs/credits endpoint returns an array of credit buckets
  // ({ amount, ... } each). The balance shown in the sidebar is the sum
  // across buckets — otherwise a user with multiple TTS credit packs would
  // see only one pack's worth. These tests pin that behaviour so a future
  // refactor can't silently swap summing for first-bucket-only.

  test('sums the amount field across all credit buckets', async () => {
    installFetchStub(async () => ({ ok: true, json: [{ amount: 100 }, { amount: 250 }, { amount: 50 }] }))
    const balance = await utils.getGenaiproBalance('some-key')
    assert.equal(balance, 400, 'balance must be the sum of every bucket\'s amount')
  })

  test('returns 0 for an empty credits array (valid key, no packs)', async () => {
    installFetchStub(async () => ({ ok: true, json: [] }))
    const balance = await utils.getGenaiproBalance('empty-pack-key')
    assert.equal(balance, 0, 'no buckets means zero balance, not null — null is reserved for failures')
  })

  test('returns null on HTTP failure (invalid key, network error)', async () => {
    installFetchStub(async () => ({ ok: false, status: 401, json: {} }))
    const balance = await utils.getGenaiproBalance('bad-key')
    assert.equal(balance, null, 'non-2xx must surface as null so the sidebar renders "..." instead of "0"')
  })

  test('returns null for an empty apiKey without fetching', async () => {
    let fetched = 0
    installFetchStub(async () => { fetched++; return { ok: true, json: [] } })
    const balance = await utils.getGenaiproBalance('')
    assert.equal(balance, null)
    assert.equal(fetched, 0, 'empty key must short-circuit before hitting the network')
  })

  test('serves the same key from cache on the second call', async () => {
    let seen = 0
    installFetchStub(async () => { seen++; return { ok: true, json: [{ amount: 42 }] } })
    assert.equal(await utils.getGenaiproBalance('dup-key'), 42)
    assert.equal(await utils.getGenaiproBalance('dup-key'), 42)
    assert.equal(seen, 1, 'second call must hit the cache, not the network')
  })
})
