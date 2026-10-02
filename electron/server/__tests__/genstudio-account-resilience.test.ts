/**
 * The account overview is on the same resilient path as every catalogue.
 *
 * It used to be the one bare `fetch` in the GenStudio client: 8-second timeout,
 * no retry, no cache, no fallback. A single slow response emptied the balance,
 * and the header badge announced `GenStudio Unavailable` beside a narration job
 * that was generating perfectly well — because every other surface it could be
 * compared against already retried and already tolerated a stale copy.
 *
 * Three states, and the difference between them is the whole point:
 *
 *   - a refresh that succeeds (even on a retry) → live, never marked stale
 *   - a refresh that fails with a copy in hand  → that copy, MARKED stale
 *   - a refresh that fails with nothing in hand → typed refusal; only now is
 *                                                 the account truly unreachable
 *   - 401 / 403                                 → always throws, never serves a
 *                                                 balance the key may no longer
 *                                                 be entitled to see
 *
 * No network: `globalThis.fetch` is stubbed for every case.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const {
  clearGenStudioCatalogCache,
  GenStudioAccountUnavailableError,
  getGenStudioAccountOverviewSnapshot,
} = await import('../lib/genstudio-client.js')

const OVERVIEW = {
  credit_balance: 4_210,
  credits_used_30d: 900,
  subscription_plan_name: 'Mekong Studio',
  api_concurrency_limit: 5,
  paid_concurrency_limit: 5,
  paid_active_jobs: 1,
  paid_queued_jobs: 0,
  max_queued_jobs: 250,
  generation_submissions_per_minute: 240,
  total_jobs: 12,
  active_jobs: 1,
  completed_jobs: 11,
  failed_jobs: 0,
  available_assets: 3,
  next_asset_expiration: null,
}

/** How the overview endpoint behaves on each successive call. */
type Reply = 'ok' | 'timeout' | 'gateway' | 'forbidden'

function stubOverview(script: Reply[]): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input)
    if (!url.includes('/v1/account/overview')) throw new Error(`Unexpected request: ${url}`)
    // The last entry repeats, so "fails forever" is one word rather than a list.
    const reply = script[Math.min(calls, script.length - 1)]
    calls++
    if (reply === 'timeout') throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
    if (reply === 'gateway') return new Response('bad gateway', { status: 502 })
    if (reply === 'forbidden') return new Response(JSON.stringify({ detail: 'no usage scope' }), { status: 403 })
    return Response.json(OVERVIEW)
  }) as typeof globalThis.fetch
  return { calls: () => calls, restore: () => { globalThis.fetch = original } }
}

test.after(() => temp.cleanup?.())

test('a transient overview failure is retried and never reports the account unavailable', async () => {
  clearGenStudioCatalogCache()
  // Exactly the shape the owner hit: the first attempt times out at ~8s, and a
  // 502 behind it. The third attempt answers. Nothing about this is an outage.
  const stub = stubOverview(['timeout', 'gateway', 'ok'])
  try {
    const snapshot = await getGenStudioAccountOverviewSnapshot('scoped-key')
    assert.equal(snapshot.value.credit_balance, 4_210)
    assert.equal(snapshot.freshness, 'live')
    assert.equal(snapshot.stale, false, 'a value fetched during this call is not stale')
    assert.equal(stub.calls(), 3, 'the failures must have been retried, not surfaced')
  } finally {
    stub.restore()
  }
})

test('a failure with a copy in hand serves the last known balance, marked stale', async () => {
  clearGenStudioCatalogCache()
  const good = stubOverview(['ok'])
  try {
    assert.equal((await getGenStudioAccountOverviewSnapshot('scoped-key')).freshness, 'live')
  } finally {
    good.restore()
  }

  const down = stubOverview(['gateway'])
  try {
    const snapshot = await getGenStudioAccountOverviewSnapshot('scoped-key')
    // The balance is still shown — it is real, it is just not one refreshed now.
    assert.equal(snapshot.value.credit_balance, 4_210)
    assert.equal(snapshot.freshness, 'stale')
    assert.equal(snapshot.stale, true, 'the UI must be told to mark this')
    assert.ok(snapshot.ageMs >= 0, 'and told how old it is')
    assert.ok(Date.parse(snapshot.loadedAt) > 0, 'with the load time it can render')
    assert.ok(down.calls() >= 3, 'stale is a fallback AFTER retries, not instead of them')
  } finally {
    down.restore()
  }
})

test('the overview always revalidates, so a moving balance is never served from a warm cache', async () => {
  clearGenStudioCatalogCache()
  const stub = stubOverview(['ok'])
  try {
    await getGenStudioAccountOverviewSnapshot('scoped-key')
    const second = await getGenStudioAccountOverviewSnapshot('scoped-key')
    assert.equal(second.freshness, 'live', 'a balance must not lag real spend')
    assert.equal(stub.calls(), 2, 'both calls hit the Gateway')
  } finally {
    stub.restore()
  }
})

test('a sustained failure with nothing cached is the only genuinely unavailable state', async () => {
  clearGenStudioCatalogCache()
  const stub = stubOverview(['gateway'])
  try {
    await assert.rejects(
      getGenStudioAccountOverviewSnapshot('scoped-key'),
      (error: unknown) => {
        assert.ok(error instanceof GenStudioAccountUnavailableError)
        assert.equal(error.ageMs, null, 'there was no cached copy at all')
        assert.match(error.message, /could not be refreshed/)
        // The wording must not imply running work died with the balance read.
        assert.match(error.message, /Work already running is\s+unaffected/)
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('a key that lost its entitlement is never answered from a cached balance', async () => {
  clearGenStudioCatalogCache()
  const good = stubOverview(['ok'])
  try {
    await getGenStudioAccountOverviewSnapshot('scoped-key')
  } finally {
    good.restore()
  }

  const revoked = stubOverview(['forbidden'])
  try {
    await assert.rejects(
      getGenStudioAccountOverviewSnapshot('scoped-key'),
      (error: unknown) => {
        assert.ok(!(error instanceof GenStudioAccountUnavailableError), 'a scope failure is not a staleness failure')
        return true
      },
    )
    assert.equal(revoked.calls(), 1, '403 is terminal; retrying it would only repeat the refusal')
  } finally {
    revoked.restore()
  }
})
