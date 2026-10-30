import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { errorBoundary } from '../lib/error-boundary.js'
import { parseContentStoreCatalog } from '../lib/genstudio-content-store.js'
import { router as contentStoreCoversRouter } from '../routes/content-store-covers.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { useTempDataDir } from './_helpers.js'

/**
 * Pack covers are proxied through Story, not loaded from the Gateway.
 *
 * The renderer's CSP allows `img-src 'self' …` only, so a cover on a LAN
 * Gateway (`http://host:port`) would be blocked and render as a silent blank.
 * A cover that does not exist is a 404, and the card shows "no preview yet" —
 * never an invented picture.
 */

const GATEWAY_URL = 'http://127.0.0.1:8796'
const GATEWAY_KEY = 'gateway-cover-test-key'
const WEBP_BYTES = Buffer.from('RIFF....WEBPVP8 ', 'ascii')
let cleanup: (() => Promise<void>) | undefined
let app: express.Express
let calls: Array<{ url: string; init: RequestInit }> = []
let handler: (url: string, init: RequestInit) => Response | Promise<Response>
const originalFetch = globalThis.fetch

beforeEach(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await setGenStudioUrl(GATEWAY_URL)
  await setApiKey('genstudio', GATEWAY_KEY)
  calls = []
  handler = () => new Response(WEBP_BYTES, { status: 200, headers: { 'Content-Type': 'image/webp' } })
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  app = express()
  app.use('/api', contentStoreCoversRouter)
  app.use(errorBoundary)
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await cleanup?.()
})

describe('a pack cover through Story', () => {
  test('streams the Gateway image bytes with a same-origin, cacheable response', async () => {
    const response = await request(app).get('/api/content-store/covers/com.storystudio.pack.style.oil/1.0.1')
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^image\/webp/)
    assert.equal(response.headers['cache-control'], 'private, max-age=600')
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.body.equals(WEBP_BYTES), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, `${GATEWAY_URL}/admin/api/content-library/covers/com.storystudio.pack.style.oil/1.0.1`)
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${GATEWAY_KEY}`)
    assert.equal(calls[0]!.init.redirect, 'error')
  })

  test('a pack with no cover is a 404, which the card reads as "no preview yet"', async () => {
    handler = () => new Response('', { status: 404 })
    const response = await request(app).get('/api/content-store/covers/com.storystudio.pack.topic.animals/1.0.0')
    assert.equal(response.status, 404)
    assert.equal(response.body.code, 'CONTENT_STORE_COVER_UNAVAILABLE')
  })

  test('a Gateway that answers with something that is not an image is refused', async () => {
    handler = () => new Response('<html>nope</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    const response = await request(app).get('/api/content-store/covers/p/1.0.0')
    assert.equal(response.status, 502)
    assert.equal(response.body.code, 'CONTENT_STORE_COVER_INVALID')
  })

  test('an oversized cover is refused before it reaches the page', async () => {
    handler = () => new Response(WEBP_BYTES, {
      status: 200,
      headers: { 'Content-Type': 'image/webp', 'Content-Length': String(5 * 1024 * 1024) },
    })
    const response = await request(app).get('/api/content-store/covers/p/1.0.0')
    assert.equal(response.status, 502)
    assert.equal(response.body.code, 'CONTENT_STORE_COVER_INVALID')
  })

  test('a pack identity that could carry a path is refused without a Gateway call', async () => {
    for (const url of [
      '/api/content-store/covers/..%2F..%2Fetc/1.0.0',
      '/api/content-store/covers/p/..%2F1.0.0',
      '/api/content-store/covers/p%2F..%2Fq/1.0.0',
    ]) {
      const response = await request(app).get(url)
      assert.equal(response.status, 400, url)
      assert.equal(response.body.code, 'CONTENT_STORE_COVER_INVALID', url)
    }
    assert.equal(calls.length, 0)
  })
})

describe('the catalogue accepts a cover the Gateway serves itself', () => {
  const base = {
    product_id: 'com.storystudio.pack.style.oil', entitlement_family: 'family.oil', kind: 'visual_style',
    title: 'Oil', summary: '', description: '', publisher_id: 'com.storystudio', credit_price: 0, free: true,
    owned: true, retired: false, successor_product_id: null, current_release: null, compatible: true,
    compatibility_reason: null, bundle_components: [], owned_component_credit_value: 0, showcase_videos: [],
    hero: null, tags: [], license: null, discount: null,
  }

  test('a relative cover path parses, so one cover cannot empty the whole catalogue', () => {
    const catalog = parseContentStoreCatalog({
      products: [{ ...base, cover: { url: '/admin/api/content-library/covers/oil/1.0.0', alt: 'Oil painting' } }],
    })
    assert.equal(catalog.products[0]?.cover?.url, '/admin/api/content-library/covers/oil/1.0.0')
  })

  test('a path that tries to climb out, or reach the gated archives, is still refused', () => {
    for (const url of ['//evil.example/x', '/a/../b', '/%2e%2e/etc', '/v1/content/archives/x', '/x?y=1']) {
      assert.throws(
        () => parseContentStoreCatalog({ products: [{ ...base, cover: { url, alt: 'x' } }] }),
        /cover/,
        url,
      )
    }
  })

  test('an absolute http URL is still refused, so the old rule is intact', () => {
    assert.throws(
      () => parseContentStoreCatalog({ products: [{ ...base, cover: { url: 'http://host.test/c.webp', alt: 'x' } }] }),
      /cover/i,
    )
  })
})
