/**
 * The warm-up pass over the two job-time catalogues.
 *
 * Production evidence (2026-10-19, Mac mini on 1.4.320): under load, the
 * `/v1/tts/models` and `/v1/chat/models` reads timed out at the old 8-second
 * ceiling for more than half an hour while 30-second control calls to the same
 * Gateway answered normally. The stale-catalogue guard then refused paid jobs,
 * so a slow catalogue read became a generation outage. Two changes answer it —
 * a 30-second ceiling (pinned in `genstudio-client-boundary.test.ts`) and this
 * background refresh, which is what this file pins.
 *
 * No network: `globalThis.fetch` is stubbed.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

// Claim this test's own data directory before anything reads a settings file.
const temp = await useTempDataDir()
const { setApiKey } = await import('../services/app-secrets-store.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { refreshGenStudioCatalogues, CATALOG_REFRESH_INTERVAL_MS } =
  await import('../services/genstudio-catalog-refresh.js')

const PAYLOADS: Record<string, unknown> = {
  '/v1/tts/models': [{
    id: 'tts-v1', display_name: 'Voice V1', credits_per_1000_characters: 1,
    minimum_credits: 1, maximum_input_characters: 5_000,
  }],
  '/v1/chat/models': [{ id: 'chat-v1', display_name: 'Chat V1', available: true, qualification_only: false }],
}

function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch
  return () => { globalThis.fetch = original }
}

after(async () => { await temp.cleanup() })

test('one pass reads both job-time catalogues', async () => {
  await setApiKey('genstudio', 'catalog-refresh-test-key')
  clearGenStudioCatalogCache()
  const seen: string[] = []
  const restore = stubFetch(url => {
    const path = new URL(url).pathname
    seen.push(path)
    return new Response(JSON.stringify(PAYLOADS[path] ?? []), { status: 200 })
  })
  try {
    await refreshGenStudioCatalogues()
    assert.ok(seen.includes('/v1/tts/models'), `the voice catalogue was not refreshed: ${seen.join(', ')}`)
    assert.ok(seen.includes('/v1/chat/models'), `the chat catalogue was not refreshed: ${seen.join(', ')}`)
  } finally { restore() }
})

test('one catalogue failing does not stop the other, and never escapes the pass', async () => {
  await setApiKey('genstudio', 'catalog-refresh-test-key')
  clearGenStudioCatalogCache()
  const seen: string[] = []
  const restore = stubFetch(url => {
    const path = new URL(url).pathname
    seen.push(path)
    if (path === '/v1/tts/models') return new Response('nope', { status: 500 })
    return new Response(JSON.stringify(PAYLOADS[path] ?? []), { status: 200 })
  })
  try {
    await refreshGenStudioCatalogues()
    assert.ok(seen.includes('/v1/chat/models'),
      'the chat catalogue must still be refreshed when the voice one is failing')
  } finally { restore() }
})

test('the pass is a no-op without a key, and refreshes no more often than the readers\' own window', async () => {
  await setApiKey('genstudio', '')
  clearGenStudioCatalogCache()
  let calls = 0
  const restore = stubFetch(() => { calls += 1; return new Response('[]', { status: 200 }) })
  try {
    await refreshGenStudioCatalogues()
    assert.equal(calls, 0, 'no key means no request')
  } finally { restore() }
  assert.equal(CATALOG_REFRESH_INTERVAL_MS, 5 * 60_000)
})
