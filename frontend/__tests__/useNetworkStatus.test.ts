/**
 * Tests for `useNetworkStatus` — the informational reachability badge.
 *
 * v1.0.190 — reachability is decided by ONE signal: a periodic
 * `GET /api/health` probe of the local backend. `navigator.onLine` is
 * deliberately ignored (it false-negatives on macOS sleep/wake + VPN changes
 * and used to freeze the whole queue). Health reporting never mutates queue
 * state, regardless of probe result.
 *
 * Runs under happy-dom (registered by __tests__/setup.ts). `fetch` is
 * stubbed per test; the composable's module-scoped `started` flag means
 * the listener wiring happens exactly once across the test process, so
 * all tests share the same singleton state. That's fine — each test
 * walks through a full transition and asserts the outcomes.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Controllable fetch stub (happy-dom supplies a real fetch; we override) ──

type Handler = (url: string, init?: any) => { ok: boolean; status?: number } | Promise<{ ok: boolean; status?: number }>
let handler: Handler = () => ({ ok: true, status: 200 })
let fetchCalls: string[] = []
;(globalThis as any).fetch = async (url: string, init?: any) => {
  fetchCalls.push(url)
  const r = await handler(url, init)
  return {
    ok: r.ok,
    status: r.status ?? (r.ok ? 200 : 500),
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response
}

const { useNetworkStatus } = await import('../composables/useNetworkStatus.js')
const composableSource = readFileSync(
  fileURLToPath(new URL('../composables/useNetworkStatus.ts', import.meta.url)),
  'utf8',
)

beforeEach(() => {
  fetchCalls = []
  handler = () => ({ ok: true, status: 200 })
})

describe('useNetworkStatus', () => {
  test('successful probe reports online and never calls queue controls', async () => {
    const { online, lastChecked, refresh } = useNetworkStatus()
    // The first useNetworkStatus() call kicked off the initial refresh during
    // module init; drive another one explicitly to assert against a known state.
    const previousCheck = lastChecked.value
    await refresh()

    assert.equal(online.value, true, 'successful health probe means online')
    assert.ok(lastChecked.value >= previousCheck, 'successful probe updates lastChecked')
    assert.ok(fetchCalls.some(u => u === '/api/health'),
      'a probe to /api/health must have fired')
    assert.equal(fetchCalls.filter(url => url.includes('/api/system/queue/')).length, 0)
  })

  test('failed probe reports offline and never calls queue controls', async () => {
    const { online, refresh } = useNetworkStatus()
    // Prime to online so we observe a transition.
    handler = () => ({ ok: true })
    await refresh()
    assert.equal(online.value, true)
    fetchCalls = []

    // Now make the probe fail — health endpoint returns 500.
    handler = (url) => url === '/api/health'
      ? { ok: false, status: 500 }
      : { ok: true, status: 200 } // allow the pause POST through
    await refresh()

    assert.equal(online.value, false, 'failed probe flips online=false')
    assert.equal(fetchCalls.filter(url => url.includes('/api/system/queue/')).length, 0)
  })

  test('repeated failed probes never call queue controls', async () => {
    const { online, refresh } = useNetworkStatus()

    // Drive an explicit online→offline transition so we know repeated probes
    // are still informational even if previous tests left singleton state set.
    handler = () => ({ ok: true, status: 200 })
    await refresh()
    fetchCalls = []

    handler = () => ({ ok: false, status: 500 })
    await refresh()
    await refresh()
    await refresh()

    assert.equal(online.value, false)
    assert.equal(fetchCalls.filter(url => url.includes('/api/system/queue/')).length, 0)
  })

  test('recovery reports online and never calls queue controls', async () => {
    const { online, refresh } = useNetworkStatus()

    // Go offline
    handler = () => ({ ok: false, status: 500 })
    await refresh()
    assert.equal(online.value, false)
    fetchCalls = []

    // Come back online
    handler = () => ({ ok: true, status: 200 })
    await refresh()
    await refresh() // second refresh must not re-POST resume

    assert.equal(online.value, true)
    assert.equal(fetchCalls.filter(url => url.includes('/api/system/queue/')).length, 0)
  })

  test('browser online/offline events still nudge health probes', () => {
    assert.match(composableSource, /window\.addEventListener\('online', refresh\)/)
    assert.match(composableSource, /window\.addEventListener\('offline', refresh\)/)
  })

  test('navigator.onLine=false is IGNORED — the backend probe decides (v1.0.190 fix)', async () => {
    const { online, refresh } = useNetworkStatus()
    // The OS claims the interface is down (a common macOS false-negative after
    // sleep/wake or a VPN flap), but the backend probe succeeds. We must stay
    // online so a flaky browser flag can never freeze the job queue.
    handler = () => ({ ok: true, status: 200 })
    // happy-dom's navigator has writable onLine; flip it and re-check.
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true })
    fetchCalls = []

    try {
      await refresh()
      assert.equal(online.value, true,
        'navigator.onLine=false must NOT force offline when the backend is reachable')
      assert.equal(fetchCalls.filter(url => url.includes('/api/system/queue/')).length, 0)
    } finally {
      Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })
    }
  })

  test('composable has no queue mutation state or endpoints', () => {
    assert.doesNotMatch(composableSource, /\/api\/system\/queue\/pause/)
    assert.doesNotMatch(composableSource, /\/api\/system\/queue\/resume/)
    assert.doesNotMatch(composableSource, /queueSyncFailed/)
  })
})
