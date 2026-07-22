/**
 * Tests for `useCredits` — the sidebar-badge polling state.
 *
 * Covers the three invariants the dashboard layout renders against:
 *
 *   1. `fetchHealth(slug)` reads the one scoped key and authoritative
 *      GenStudio usage snapshot.
 *   2. `startPolling(slug)` fires an immediate fetch then schedules more on
 *      `intervalMs`. `stopPolling()` clears the interval.
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
const authoritativeUsage = { overview: { credit_balance: 250 } }

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

    const { fetchHealth, genstudioCredits, genstudioConfigured, usageError } = useCredits()
    await fetchHealth('active')

    assert.equal(genstudioCredits.value, 250)
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
    await fetchHealth('active')
    assert.equal(genstudioCredits.value, 250)

    fetchHandler = () => { throw new Error('network down') }
    await fetchHealth('active')
    assert.equal(genstudioCredits.value, null)
    assert.match(usageError.value, /network down/)
  })
})

describe('useCredits.startPolling()', () => {
  test('uses a calm 30-second default cadence', () => {
    assert.equal(DEFAULT_CREDIT_POLL_MS, 30_000)
  })

  test('fires an immediate fetch, then on the interval; stopPolling clears it', async () => {
    let count = 0
    fetchHandler = (url) => {
      if (url === '/api/app-settings/api-keys') { count++; return configuredKey }
      if (url === '/api/app-settings/genstudio/usage') return authoritativeUsage
      throw new Error(`unexpected ${url}`)
    }

    const { startPolling, stopPolling } = useCredits()
    startPolling('active', 60) // short interval for the test

    // Immediate fetch happens synchronously-then-await, so give it a tick.
    await sleep(30)
    assert.equal(count, 1, 'startPolling should fire an immediate fetchHealth')

    await sleep(130) // ~2 more intervals
    assert.ok(count >= 3, `expected >=3 fetches, got ${count}`)

    const before = count
    stopPolling()
    await sleep(150)
    assert.equal(count, before, 'stopPolling must clear the interval — no more fetches')
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
    const first = fetchHealth('active')
    const second = fetchHealth('active')
    await sleep(20)
    assert.equal(healthCalls, 1)
    release()
    await Promise.all([first, second])
  })
})
