/**
 * Tests for `useCredits` — the app-shell account-standing polling state.
 *
 * Covers the three invariants the dashboard layout renders against:
 *
 *   1. `fetchHealth()` reads the one scoped key and authoritative
 *      lightweight GenStudio account overview.
 *   2. `startPolling()` fires an immediate fetch without project context and
 *      shares one interval across shell consumers.
 *   3. A fetch error does NOT empty the displayed number. It is marked stale
 *      instead, and only a definitive failure clears it — see below.
 *   4. Slow balance reads are shared instead of overlapping.
 *
 * `$fetch` is a Nuxt global stubbed before the module loads.
 */

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// ── Controllable $fetch stub ────────────────────────────────────────────────

type FetchHandler = (url: string) => any | Promise<any>
let fetchHandler: FetchHandler = () => { throw new Error('no handler set') }
let fetchCalls: string[] = []

;(globalThis as any).$fetch = async (url: string) => {
  fetchCalls.push(url)
  return await fetchHandler(url)
}

const { DEFAULT_CREDIT_POLL_MS, useCredits } = await import('../composables/useCredits.js')

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }

const configuredKey = { providers: [{ providerId: 'genstudio', hasKey: true }] }
const authoritativeUsage = {
  overview: {
    credit_balance: 250,
    paid_active_jobs: 1,
    paid_concurrency_limit: 2,
    service_tier: {
      current: { code: 'starter', display_name: 'Starter', threshold_cents: 500, paid_concurrency_limit: 2, max_queued_jobs: 25, generation_submissions_per_minute: 10, max_api_keys: 2 },
      ladder: { code: 'starter', display_name: 'Starter', threshold_cents: 500, paid_concurrency_limit: 2, max_queued_jobs: 25, generation_submissions_per_minute: 10, max_api_keys: 2 },
      floor: null,
      overridden: false,
      lifetime_paid_cents: 1_700,
      next_tier: { code: 'creator', display_name: 'Creator', threshold_cents: 5_000, paid_concurrency_limit: 4, max_queued_jobs: 50, generation_submissions_per_minute: 20, max_api_keys: 4 },
      cents_to_next_tier: 3_300,
    },
  },
}

beforeEach(() => {
  const { stopPolling } = useCredits()
  stopPolling()
  fetchCalls = []
  fetchHandler = () => { throw new Error('no handler set') }
})

describe('useCredits.fetchHealth()', () => {
  test('populates the authoritative GenStudio credit balance', async () => {
    fetchHandler = (url) => {
      if (url === '/api/app-settings/api-keys') return configuredKey
      if (url === '/api/app-settings/genstudio/overview') return authoritativeUsage
      throw new Error(`unexpected ${url}`)
    }

    const { fetchHealth, genstudioCredits, genstudioTier, genstudioActiveLanes, genstudioLaneLimit, genstudioConfigured, usageError } = useCredits()
    await fetchHealth()

    assert.equal(genstudioCredits.value, 250)
    assert.equal(genstudioTier.value?.current.display_name, 'Starter')
    assert.equal(genstudioActiveLanes.value, 1)
    assert.equal(genstudioLaneLimit.value, 2)
    assert.equal(genstudioConfigured.value, true)
    assert.equal(usageError.value, '')

    assert.deepEqual(fetchCalls, [
      '/api/app-settings/api-keys',
      '/api/app-settings/genstudio/overview',
    ])
  })

  /**
   * The defect this replaces: any failed poll emptied the balance, and the
   * header announced `GenStudio Unavailable` beside a narration job that was
   * generating perfectly well. The server already retries and already falls
   * back to its own last known copy before it reports failure at all, so a
   * failed poll is not evidence the account is unreachable.
   */
  test('a transient fetch error keeps the balance, marked stale, and still surfaces the error', async () => {
    fetchHandler = (url) => {
      if (url === '/api/app-settings/api-keys') return configuredKey
      if (url === '/api/app-settings/genstudio/overview') return authoritativeUsage
      throw new Error(`unexpected ${url}`)
    }
    const { fetchHealth, genstudioCredits, genstudioCreditsStale, usageError } = useCredits()
    await fetchHealth()
    assert.equal(genstudioCredits.value, 250)
    assert.equal(genstudioCreditsStale.value, false)

    fetchHandler = () => { throw new Error('network down') }
    await fetchHealth()
    assert.equal(genstudioCredits.value, 250, 'the balance stays; it is real, just not new')
    assert.equal(genstudioCreditsStale.value, true, 'and it is marked so the strip can say so')
    assert.match(usageError.value, /network down/, 'the reason stays available in the tooltip')
  })

  test('a stale server answer is marked stale without any error at all', async () => {
    fetchHandler = (url) => {
      if (url === '/api/app-settings/api-keys') return configuredKey
      if (url === '/api/app-settings/genstudio/overview') {
        // The server retried, failed, and answered from its own kept copy.
        return { ...authoritativeUsage, overview_freshness: { stale: true, ageMs: 4 * 60_000 } }
      }
      throw new Error(`unexpected ${url}`)
    }
    const { fetchHealth, genstudioCredits, genstudioCreditsStale, genstudioCreditsLoadedAt, usageError } = useCredits()
    await fetchHealth()
    assert.equal(genstudioCredits.value, 250)
    assert.equal(genstudioCreditsStale.value, true)
    assert.equal(usageError.value, '', 'a stale 200 is not an error')
    assert.ok(
      Date.now() - (genstudioCreditsLoadedAt.value as number) >= 4 * 60_000 - 1_000,
      'the age reported by the server is carried, not restarted at zero',
    )
  })

  test('a key that can no longer read the account does report unavailable', async () => {
    fetchHandler = (url) => {
      if (url === '/api/app-settings/api-keys') return configuredKey
      if (url === '/api/app-settings/genstudio/overview') return authoritativeUsage
      throw new Error(`unexpected ${url}`)
    }
    const { fetchHealth, genstudioCredits, genstudioCreditsStale } = useCredits()
    await fetchHealth()
    assert.equal(genstudioCredits.value, 250)

    // Definitive, not transient: this key is not entitled to the balance, so
    // the last one we saw is not ours to keep showing.
    fetchHandler = () => {
      throw Object.assign(new Error('scope'), { data: { code: 'GENSTUDIO_USAGE_SCOPE_UNAVAILABLE' } })
    }
    await fetchHealth()
    assert.equal(genstudioCredits.value, null, 'this is what Unavailable is for')
    assert.equal(genstudioCreditsStale.value, false)
  })
})

describe('useCredits.startPolling()', () => {
  test('uses a calm 30-second default cadence', () => {
    assert.equal(DEFAULT_CREDIT_POLL_MS, 30_000)
  })

  test('fires immediately without a project slug and shares one interval across shell consumers', async () => {
    let count = 0
    fetchHandler = (url) => {
      if (url === '/api/app-settings/api-keys') { count++; return configuredKey }
      if (url === '/api/app-settings/genstudio/overview') return authoritativeUsage
      throw new Error(`unexpected ${url}`)
    }

    const { startPolling } = useCredits()
    const releaseFirst = startPolling(60)
    const releaseSecond = startPolling(60)

    // Immediate fetch happens synchronously-then-await, so give it a tick.
    await sleep(30)
    assert.equal(count, 1, 'startPolling should fire an immediate fetchHealth')

    await sleep(130) // ~2 more intervals, never two intervals per layout transition
    assert.ok(count >= 3 && count <= 4, `expected one shared poller, got ${count} reads`)

    releaseFirst()
    const withSecondConsumer = count
    await sleep(80)
    assert.ok(count > withSecondConsumer, 'one remaining shell consumer keeps polling')

    releaseSecond()
    const stopped = count
    await sleep(130)
    assert.equal(count, stopped, 'the final shell release clears the shared poller')
  })

  test('shares an in-flight balance read instead of starting overlapping requests', async () => {
    let healthCalls = 0
    let release!: () => void
    const healthReady = new Promise<void>((resolve) => { release = resolve })
    fetchHandler = async (url) => {
      if (url === '/api/app-settings/api-keys') {
        healthCalls++
        await healthReady
        return configuredKey
      }
      if (url === '/api/app-settings/genstudio/overview') return authoritativeUsage
      throw new Error(`unexpected ${url}`)
    }

    const { fetchHealth } = useCredits()
    const first = fetchHealth()
    const second = fetchHealth()
    await sleep(20)
    assert.equal(healthCalls, 1)
    release()
    await Promise.all([first, second])
  })
})

describe('useCredits polling while the window is hidden', () => {
  test('stops polling while hidden and refreshes as soon as the window is shown', async () => {
    fetchHandler = (url: string) => url.endsWith('/api-keys') ? configuredKey : authoritativeUsage
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    let state: 'visible' | 'hidden' = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
    mock.timers.enable({ apis: ['setInterval'] })
    const { startPolling } = useCredits()
    const release = startPolling(40)
    try {
      await drain()
      state = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      const hiddenAt = fetchCalls.length
      mock.timers.tick(400)
      await drain()
      assert.equal(fetchCalls.length, hiddenAt, 'no account reads while nobody can see the strip')
      state = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
      await drain()
      assert.ok(fetchCalls.length > hiddenAt, 'showing the window refreshes at once')
    } finally {
      release()
      mock.timers.reset()
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
      else delete (document as any).visibilityState
    }
  })
})
