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
import { transform } from 'esbuild'

// ── Controllable fetch stub (happy-dom supplies a real fetch; we override) ──

type Reply = { ok: boolean; status?: number; body?: unknown }
type Handler = (url: string, init?: any) => Reply | Promise<Reply>
let handler: Handler = () => ({ ok: true, status: 200 })
let fetchCalls: string[] = []
;(globalThis as any).fetch = async (url: string, init?: any) => {
  fetchCalls.push(url)
  const r = await handler(url, init)
  return {
    ok: r.ok,
    status: r.status ?? (r.ok ? 200 : 500),
    json: async () => r.body ?? ({}),
    text: async () => '',
  } as unknown as Response
}

const { useNetworkStatus } = await import('../composables/useNetworkStatus.js')
const composableSource = readFileSync(
  fileURLToPath(new URL('../composables/useNetworkStatus.ts', import.meta.url)),
  'utf8',
)

function sleep(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)) }

async function useClientNetworkStatus(): Promise<ReturnType<typeof useNetworkStatus>> {
  const vueUrl = await import.meta.resolve('vue')
  const transformed = await transform(
    composableSource.replace('import.meta.client', 'true'),
    { loader: 'ts', format: 'esm' },
  )
  const clientModule = await import(`data:text/javascript;base64,${Buffer.from(
    transformed.code
      .replaceAll('"vue"', JSON.stringify(vueUrl))
      .replaceAll('"./useVisibleInterval.js"', JSON.stringify(new URL('../composables/useVisibleInterval.ts', import.meta.url).href)),
  ).toString('base64')}`) as typeof import('../composables/useNetworkStatus.js')

  // The client branch owns a real 20-second interval. Keep this behavioral
  // test from leaving a process-level timer behind while exercising it.
  const originalSetInterval = globalThis.setInterval
  ;(globalThis as any).setInterval = () => 0
  try {
    return clientModule.useNetworkStatus()
  } finally {
    globalThis.setInterval = originalSetInterval
  }
}

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

  test('credentials can be unavailable while the engine remains online, then recover', async () => {
    const { online, credentialsMessage, refresh } = useNetworkStatus()
    handler = url => ({ ok: true, body: url === '/api/health'
      ? { credentials: { state: 'unavailable', message: 'Credentials unavailable. Choose Help → Unlock credentials…' } }
      : {} })
    await refresh()
    assert.equal(online.value, true)
    assert.match(credentialsMessage.value, /Credentials unavailable/)
    assert.equal(fetchCalls.some(url => url.includes('unlock')), false, 'status probes never request an interactive unlock')
    handler = () => ({ ok: true, body: { credentials: { state: 'available', message: '' } } })
    await refresh()
    assert.equal(credentialsMessage.value, '')
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

  test('browser offline event re-probes health and updates status', async () => {
    const { online, refresh } = await useClientNetworkStatus()
    await refresh()
    fetchCalls = []
    handler = () => ({ ok: false, status: 500 })

    window.dispatchEvent(new Event('offline'))
    await sleep(0)

    assert.equal(fetchCalls.filter(url => url === '/api/health').length, 1,
      'offline event triggers a health probe')
    assert.equal(online.value, false, 'offline event reflects failed health probe')
  })

  test('browser online event re-probes health and updates status', async () => {
    const { online, refresh } = await useClientNetworkStatus()
    handler = () => ({ ok: false, status: 500 })
    await refresh()
    assert.equal(online.value, false)
    fetchCalls = []
    handler = () => ({ ok: true, status: 200 })

    window.dispatchEvent(new Event('online'))
    await sleep(0)

    assert.equal(fetchCalls.filter(url => url === '/api/health').length, 1,
      'online event triggers a health probe')
    assert.equal(online.value, true, 'online event reflects successful health probe')
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

  test('reports the Gateway separately: a running engine with a stopped Gateway is not "online"', async () => {
    const { online, gateway, gatewayUrl, refresh } = useNetworkStatus()
    handler = url => url === '/api/gateway/status'
      ? { ok: true, body: { reachable: false, url: 'http://127.0.0.1:8787' } }
      : { ok: true }
    await refresh()
    assert.equal(online.value, true)
    assert.equal(gateway.value, 'unreachable')
    assert.equal(gatewayUrl.value, 'http://127.0.0.1:8787')

    handler = url => url === '/api/gateway/status' ? { ok: true, body: { reachable: true, url: 'http://127.0.0.1:8787' } } : { ok: true }
    await refresh()
    assert.equal(gateway.value, 'reachable')
  })

  test('the Gateway is "unknown", never "unreachable", when the engine itself is down or the answer is unreadable', async () => {
    const { gateway, refresh } = useNetworkStatus()
    handler = () => ({ ok: false, status: 500 })
    fetchCalls = []
    await refresh()
    assert.equal(gateway.value, 'unknown')
    assert.equal(fetchCalls.includes('/api/gateway/status'), false, 'no Gateway probe through a dead engine')

    handler = url => url === '/api/gateway/status' ? { ok: false, status: 401 } : { ok: true }
    await refresh()
    assert.equal(gateway.value, 'unknown')
  })

  test('the 20 s probe pauses while the window is hidden', () => {
    assert.match(composableSource, /createVisibleInterval\(/)
    assert.doesNotMatch(composableSource, /\bsetInterval\(/)
  })

  test('composable has no queue mutation state or endpoints', () => {
    assert.doesNotMatch(composableSource, /\/api\/system\/queue\/pause/)
    assert.doesNotMatch(composableSource, /\/api\/system\/queue\/resume/)
    assert.doesNotMatch(composableSource, /queueSyncFailed/)
  })
})
