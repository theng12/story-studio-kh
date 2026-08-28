/**
 * Tests for the shared GenStudio catalogue caching policy
 * (`composables/useGenStudioCatalogCache.ts`) — the single helper every
 * `useGenStudio*` composable now runs its fetch through.
 *
 * Before this helper existed, each composable had its own ad hoc
 * `loading`/`loaded` pair with no TTL: once a fetch succeeded, the data was
 * treated as fresh forever. These tests pin down the replacement policy:
 * a short fresh window, a hard staleness ceiling past which cached data is
 * no longer "usable", coalesced concurrent fetches, and no fabricated data
 * on a failure with nothing trustworthy cached.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { _advanceGenStudioCatalogClockForTests, createGenStudioCatalogCache } from '../composables/useGenStudioCatalogCache.ts'

/**
 * Cross a freshness boundary by MOVING the cache's clock, not by sleeping.
 * (The hook also ticks the shared staleness clock, so the `isStale` /
 * `isExpired` computeds re-evaluate immediately instead of waiting on the
 * real 15s production interval.)
 *
 * These windows are two-sided: "stale but not expired" requires the age to be
 * ABOVE `freshMs` and BELOW `staleCeilingMs`. A real `sleep(40)` only ever
 * guaranteed the floor — the ceiling was a bet on the scheduler, and it lost.
 * On 2026-08-28 that 40ms sleep was measured at 2,656ms under concurrent
 * suites (41ms when run alone), pushing the cache past a 1,000ms ceiling and
 * failing an assertion about the product that was never actually false.
 *
 * Advancing the clock makes the elapsed age EXACTLY `ms`, so both sides of
 * every window are genuinely proven on every run rather than one side proven
 * and the other merely hoped for. It also drops this file's real-time cost to
 * zero.
 */
function advancePastThreshold(ms: number): void {
  _advanceGenStudioCatalogClockForTests(ms)
}

interface Row { id: string }

function makeFetcher(behaviors: Array<(() => Row[]) | (() => never)>) {
  let calls = 0
  const fn = async (): Promise<Row[]> => {
    const behavior = behaviors[Math.min(calls, behaviors.length - 1)]
    calls += 1
    return behavior()
  }
  return { fetcher: fn, callCount: () => calls }
}

function failing(message: string): () => never {
  return () => { throw new Error(message) }
}

describe('createGenStudioCatalogCache', () => {
  test('a fresh fetch is served from cache within the window — refresh() is a no-op', async () => {
    const { fetcher, callCount } = makeFetcher([() => [{ id: 'a' }]])
    const cache = createGenStudioCatalogCache<Row[]>({ empty: [], fetcher, freshMs: 200, staleCeilingMs: 1000 })

    await cache.refresh()
    assert.equal(callCount(), 1)
    assert.deepEqual(cache.data.value, [{ id: 'a' }])
    assert.equal(cache.isStale.value, false)
    assert.equal(cache.isUsable.value, true)

    // Still inside the fresh window — must not fire a second request.
    await cache.refresh()
    assert.equal(callCount(), 1)
    assert.deepEqual(cache.data.value, [{ id: 'a' }])
  })

  test('data past the fresh window is marked stale but stays displayable', async () => {
    const { fetcher, callCount } = makeFetcher([() => [{ id: 'a' }]])
    const cache = createGenStudioCatalogCache<Row[]>({ empty: [], fetcher, freshMs: 20, staleCeilingMs: 1000 })

    await cache.refresh()
    assert.equal(cache.isStale.value, false)

    advancePastThreshold(40)
    assert.equal(cache.isStale.value, true)
    assert.equal(cache.isExpired.value, false)
    // Stale is still shown — the last good snapshot, not wiped out.
    assert.deepEqual(cache.data.value, [{ id: 'a' }])
    // A plain refresh() (no force) now fetches again because it's stale.
    await cache.refresh()
    assert.equal(callCount(), 2)
  })

  test('data past the hard ceiling is not offered as usable for new work', async () => {
    const { fetcher } = makeFetcher([() => [{ id: 'a' }]])
    const cache = createGenStudioCatalogCache<Row[]>({ empty: [], fetcher, freshMs: 10, staleCeilingMs: 30 })

    await cache.refresh()
    assert.equal(cache.isUsable.value, true)

    advancePastThreshold(50)
    assert.equal(cache.isExpired.value, true)
    assert.equal(cache.isUsable.value, false)
    // Still visible for display (better than a blank panel)...
    assert.deepEqual(cache.data.value, [{ id: 'a' }])
  })

  test('an expired cache that fails to refresh is cleared instead of kept on display', async () => {
    const { fetcher } = makeFetcher([() => [{ id: 'seed' }], failing('down')])
    const cache = createGenStudioCatalogCache<Row[]>({ empty: [], fetcher, freshMs: 10, staleCeilingMs: 30 })

    await cache.refresh()
    assert.deepEqual(cache.data.value, [{ id: 'seed' }])

    advancePastThreshold(50) // now past the hard ceiling
    await cache.refresh(true)

    assert.equal(cache.error.value, 'down')
    assert.deepEqual(cache.data.value, [])
    assert.equal(cache.isUsable.value, false)
  })

  test('concurrent callers coalesce onto a single in-flight request', async () => {
    let resolveFetch: (rows: Row[]) => void = () => {}
    let calls = 0
    const fetcher = () => {
      calls += 1
      return new Promise<Row[]>((resolve) => { resolveFetch = resolve })
    }
    const cache = createGenStudioCatalogCache<Row[]>({ empty: [], fetcher, freshMs: 1000, staleCeilingMs: 5000 })

    const first = cache.refresh()
    const second = cache.refresh()
    const third = cache.refresh(true) // even a forced call joins the same in-flight request
    assert.equal(calls, 1)

    resolveFetch([{ id: 'coalesced' }])
    await Promise.all([first, second, third])

    assert.equal(calls, 1)
    assert.deepEqual(cache.data.value, [{ id: 'coalesced' }])
  })

  test('a failed fetch with no usable cache surfaces an error rather than a fabricated catalogue', async () => {
    const cache = createGenStudioCatalogCache<Row[]>({
      empty: [],
      fetcher: failing('GenStudio unreachable'),
      freshMs: 1000,
      staleCeilingMs: 5000,
    })

    await cache.refresh()

    assert.deepEqual(cache.data.value, [])
    assert.equal(cache.error.value, 'GenStudio unreachable')
    assert.equal(cache.isUsable.value, false)
    assert.equal(cache.loaded.value, true)
  })

  test('a failed refresh while still under the ceiling keeps the last good snapshot displayable', async () => {
    const { fetcher } = makeFetcher([() => [{ id: 'good' }], failing('blip')])
    const cache = createGenStudioCatalogCache<Row[]>({ empty: [], fetcher, freshMs: 10, staleCeilingMs: 5000 })

    await cache.refresh()
    advancePastThreshold(20)
    await cache.refresh()

    assert.equal(cache.error.value, 'blip')
    // Still under the hard ceiling — the last good data is kept, not blanked.
    assert.deepEqual(cache.data.value, [{ id: 'good' }])
    assert.equal(cache.isUsable.value, false)
  })

  test('lastFetchedAt reflects only successful fetches', async () => {
    const cache = createGenStudioCatalogCache<Row[]>({
      empty: [],
      fetcher: failing('nope'),
      freshMs: 1000,
      staleCeilingMs: 5000,
    })
    assert.equal(cache.lastFetchedAt.value, null)
    await cache.refresh()
    assert.equal(cache.lastFetchedAt.value, null)
  })
})
