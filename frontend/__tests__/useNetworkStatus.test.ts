/**
 * Tests for `useNetworkStatus` — the online/offline banner + queue-pause driver.
 *
 * The composable merges two signals:
 *   1. `navigator.onLine` — fast, OS-level interface state.
 *   2. A periodic `HEAD /api/health` probe — confirms the backend is
 *      actually reachable even when the OS thinks we're online.
 *
 * When it flips offline, it POSTs `/api/system/queue/pause` so new jobs
 * don't try to submit without connectivity. On recovery it resumes.
 *
 * Runs under happy-dom (registered by __tests__/setup.ts). `fetch` is
 * stubbed per test; the composable's module-scoped `started` flag means
 * the listener wiring happens exactly once across the test process, so
 * all tests share the same singleton state. That's fine — each test
 * walks through a full transition and asserts the outcomes.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

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

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }

beforeEach(() => {
  fetchCalls = []
  handler = () => ({ ok: true, status: 200 })
})

describe('useNetworkStatus', () => {
  test('initial probe succeeds → online=true + no pause POST', async () => {
    const { online, refresh } = useNetworkStatus()
    // The first useNetworkStatus() call kicked off the initial refresh during
    // module init; drive another one explicitly to assert against a known state.
    await refresh()

    assert.equal(online.value, true, 'successful health probe means online')
    assert.ok(fetchCalls.some(u => u === '/api/health'),
      'a probe to /api/health must have fired')
    assert.ok(!fetchCalls.some(u => u === '/api/system/queue/pause'),
      'no pause POST when we\'re online')
  })

  test('probe failure flips online=false and POSTs queue/pause once', async () => {
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
    assert.ok(fetchCalls.some(u => u === '/api/system/queue/pause'),
      'offline transition must POST /api/system/queue/pause')
  })

  test('pause POST does NOT fire again on repeated failed probes', async () => {
    const { online, refresh } = useNetworkStatus()

    // Drive an explicit online→offline transition so we know the pause POST
    // fires exactly once even if previous tests left `lastPausedState` set.
    handler = () => ({ ok: true, status: 200 })
    await refresh()
    fetchCalls = []

    handler = () => ({ ok: false, status: 500 })
    await refresh() // transition: pause POST fires
    await refresh() // still offline: NO pause POST (idempotent)
    await refresh()

    assert.equal(online.value, false)
    const pauseCalls = fetchCalls.filter(u => u === '/api/system/queue/pause').length
    assert.equal(pauseCalls, 1,
      'pause must POST exactly once on the online→offline transition, not on every subsequent failure')
  })

  test('recovery POSTs queue/resume exactly once', async () => {
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
    const resumeCalls = fetchCalls.filter(u => u === '/api/system/queue/resume').length
    assert.equal(resumeCalls, 1, 'resume POST must be idempotent')
  })

  test('navigator.onLine=false takes precedence over a successful probe', async () => {
    const { online, refresh } = useNetworkStatus()
    // Health endpoint would say we're fine, but the OS says the interface is down.
    handler = () => ({ ok: true, status: 200 })
    // happy-dom's navigator has writable onLine; flip it and re-check.
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true })

    try {
      await refresh()
      assert.equal(online.value, false,
        'navigator.onLine=false must be trusted immediately even if the probe would succeed')
    } finally {
      Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })
    }
  })
})
