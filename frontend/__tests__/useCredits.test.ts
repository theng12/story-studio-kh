/**
 * Tests for `useCredits` — the app-shell account-standing polling state.
 *
 * Covers the three invariants the dashboard layout renders against:
 *
 *   1. `fetchHealth()` reads the one scoped key and authoritative
 *      GenStudio usage snapshot.
 *   2. `startPolling()` fires an immediate fetch without project context and
 *      shares one interval across shell consumers.
 *   3. A fetch error clears the displayed number so stale credits are never
 *      presented as authoritative.
 *   4. Slow balance reads are shared instead of overlapping.
 *
 * `$fetch` is a Nuxt global stubbed before the module loads.
 */

import { test, describe, beforeEach } from 'node:test'
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
      if (url === '/api/app-settings/genstudio/usage') return authoritativeUsage
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
      '/api/app-settings/genstudio/usage',
    ])
  })

  test('a fetch error clears stale credits and exposes an actionable error', async () => {
    fetchHandler = (url) => {
      if (url === '/api/app-settings/api-keys') return configuredKey
      if (url === '/api/app-settings/genstudio/usage') return authoritativeUsage
      throw new Error(`unexpected ${url}`)
    }
    const { fetchHealth, genstudioCredits, usageError } = useCredits()
    await fetchHealth()
    assert.equal(genstudioCredits.value, 250)

    fetchHandler = () => { throw new Error('network down') }
    await fetchHealth()
    assert.equal(genstudioCredits.value, null)
    assert.match(usageError.value, /network down/)
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
      if (url === '/api/app-settings/genstudio/usage') return authoritativeUsage
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
      if (url === '/api/app-settings/genstudio/usage') return authoritativeUsage
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
