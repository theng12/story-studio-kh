/**
 * Tests for `useCredits` — the sidebar-badge polling state.
 *
 * Covers the three invariants the dashboard layout renders against:
 *
 *   1. `fetchHealth(slug)` hits `/projects/:slug/health` and `/usage`, then
 *      writes each provider's balance into the right ref.
 *   2. `startPolling(slug)` fires an immediate fetch then schedules more on
 *      `intervalMs`. `stopPolling()` clears the interval.
 *   3. A fetch error doesn't null out previous values — the sidebar keeps
 *      showing the last-known balance instead of flashing to '...' on a
 *      single network blip.
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

function happyHealth() {
  return {
    credits: {
      kie: 250,
      fal: 12.5,
      elevenlabs: { tier: 'starter', character_count: 3000, character_limit: 30000, remaining: 27000 },
    },
    api_keys: { kie: true, fal: true, openai: true, anthropic: false, elevenlabs: true, genaipro: false },
  }
}

beforeEach(() => {
  const { stopPolling } = useCredits()
  stopPolling()
  fetchCalls = []
  fetchHandler = () => { throw new Error('no handler set') }
})

describe('useCredits.fetchHealth()', () => {
  test('populates each balance ref from the health + usage payloads', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/health')) return happyHealth()
      if (url === '/api/usage') return { total_cost: 7.42 }
      throw new Error(`unexpected ${url}`)
    }

    const { fetchHealth, kieCredits, falBalance, elevenLabsBalance, apiKeys, openaiUsage } = useCredits()
    await fetchHealth('active')

    assert.equal(kieCredits.value, 250)
    assert.equal(falBalance.value, 12.5)
    assert.equal(elevenLabsBalance.value?.tier, 'starter')
    assert.equal(elevenLabsBalance.value?.remaining, 27000)
    assert.equal(openaiUsage.value, 7.42)
    assert.equal(apiKeys.value.kie, true)
    assert.equal(apiKeys.value.anthropic, false)

    // Both endpoints hit in the one call.
    assert.ok(fetchCalls.some(u => u === '/api/projects/active/health'))
    assert.ok(fetchCalls.some(u => u === '/api/usage'))
  })

  test('a fetch error leaves previous values intact (silent-fail by design)', async () => {
    // First fetch — populate with a known-good snapshot.
    fetchHandler = (url) => {
      if (url.endsWith('/health')) return happyHealth()
      if (url === '/api/usage') return { total_cost: 5 }
      throw new Error(`unexpected ${url}`)
    }
    const { fetchHealth, kieCredits, falBalance, openaiUsage } = useCredits()
    await fetchHealth('active')
    assert.equal(kieCredits.value, 250)
    assert.equal(falBalance.value, 12.5)
    assert.equal(openaiUsage.value, 5)

    // Second fetch errors — refs must stay at the previous snapshot.
    fetchHandler = () => { throw new Error('network down') }
    await fetchHealth('active')
    assert.equal(kieCredits.value, 250, 'prior balance preserved on error')
    assert.equal(falBalance.value, 12.5)
    assert.equal(openaiUsage.value, 5)
  })
})

describe('useCredits.startPolling()', () => {
  test('uses a calm 30-second default cadence', () => {
    assert.equal(DEFAULT_CREDIT_POLL_MS, 30_000)
  })

  test('fires an immediate fetch, then on the interval; stopPolling clears it', async () => {
    let count = 0
    fetchHandler = (url) => {
      if (url.endsWith('/health')) { count++; return happyHealth() }
      if (url === '/api/usage') return { total_cost: 0 }
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
      if (url.endsWith('/health')) {
        healthCalls++
        await healthReady
        return happyHealth()
      }
      if (url === '/api/usage') return { total_cost: 0 }
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
