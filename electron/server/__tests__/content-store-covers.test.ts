import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { errorBoundary } from '../lib/error-boundary.js'
import { buildRequireSession, buildSessionCookie, signSession } from '../lib/auth-session.js'
import { parseContentStoreCatalog } from '../lib/genstudio-content-store.js'
import { router as contentStoreCoversRouter } from '../routes/content-store-covers.js'
import { rewriteCoverSrc } from '../services/content-store.js'
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
const SESSION_SECRET = 'a'.repeat(64)
const WEBP_BYTES = Buffer.from('RIFF....WEBPVP8 ', 'ascii')
let cleanup: (() => Promise<void>) | undefined
let app: express.Express
/** The same route behind the server-mode session gate, for remote-peer cases. */
let remoteApp: express.Express
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

  // A second app for the remote-peer cases. supertest always connects from
  // loopback, and the gate deliberately trusts loopback (the Electron window
  // on the mini needs no login dialog), so a cookie-less call would pass for
  // the wrong reason. `trust proxy` makes `req.ip` read the forwarded address,
  // which is what a browser at `http://100.x.x.x:8766` really presents.
  remoteApp = express()
  remoteApp.set('trust proxy', true)
  remoteApp.use('/api', buildRequireSession(
    () => ({ username: 'owner', password_hash: 'x', session_secret: SESSION_SECRET, session_ttl_hours: 168, login_max_attempts_per_minute: 30 }),
  ))
  remoteApp.use('/api', contentStoreCoversRouter)
  remoteApp.use(errorBoundary)
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

/**
 * The owner saw every card broken from the browser at `http://100.x.x.x:8766`,
 * while the same images worked on the mini itself.
 *
 * The cause was the cover URL the SERVER put on the wire: it handed the
 * browser a Gateway-relative path (`/admin/api/content-library/covers/…`),
 * which the browser resolved against Story's own origin. Story serves no such
 * route, so every request was a 404 and the card fell back. The Library tab
 * already rewrote that path to the same-origin proxy in `buildLibraryCards`;
 * the catalogue the Discover grid reads did not.
 *
 * These tests pin both halves of the fix: the server rewrites the path, and
 * the proxy it rewrites to still answers in server/remote mode, where every
 * `/api` route sits behind the session gate and a plain `<img>` request
 * carries the session cookie like any other same-origin request.
 */
describe('a cover reaches a remote browser through Story', () => {
  const GATEWAY_COVER = '/admin/api/content-library/covers/com.storystudio.pack.style.oil/1.0.1'
  const PRODUCT = {
    productId: 'com.storystudio.pack.style.oil',
    entitlementFamily: 'family.oil',
    kind: 'visual_style' as const,
    title: 'Oil',
    summary: '',
    description: '',
    publisherId: 'com.storystudio',
    creditPrice: 0,
    free: true,
    owned: true,
    retired: false,
    successorProductId: null,
    currentRelease: null,
    compatible: true,
    compatibilityReason: null,
    bundleComponents: [],
    ownedComponentCreditValue: 0,
    showcaseVideos: [],
    cover: { url: GATEWAY_COVER, alt: 'Oil painting' },
    hero: null,
    tags: [],
    license: null,
    discount: null,
    removeFromInstalls: false,
    removeFromInstallsAt: null,
  }

  test('the server hands the page Story\'s own proxy path, not the Gateway\'s', () => {
    // What is STORED is the Gateway's path; what the page is GIVEN is Story's
    // same-origin proxy, so the browser never has to reach a host the CSP
    // forbids. This is the line the Discover grid was missing.
    const rewritten = rewriteCoverSrc({ ...PRODUCT, cover: { url: GATEWAY_COVER, alt: 'Oil painting' } })
    assert.equal(rewritten, '/api/content-store/covers/com.storystudio.pack.style.oil/1.0.1')
  })

  test('a cover that is not a Gateway path is left exactly as published', () => {
    // Marketing art on a canonical HTTPS host is not a pack cover and must not
    // be routed through a pack-cover proxy.
    const https = 'https://cdn.example.com/style/oil.webp'
    assert.equal(rewriteCoverSrc({ ...PRODUCT, cover: { url: https, alt: 'Oil painting' } }), https)
  })

  test('with a live session the proxy streams the image', async () => {
    const cookie = buildSessionCookie(signSession({ username: 'owner', exp: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET), 3600)
    const response = await request(remoteApp).get('/api/content-store/covers/com.storystudio.pack.style.oil/1.0.1')
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '203.0.113.9')
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^image\/webp/)
    assert.equal(response.body.equals(WEBP_BYTES), true)
  })

  test('without a session it fails closed, so the card falls back rather than hanging', async () => {
    const response = await request(remoteApp).get('/api/content-store/covers/com.storystudio.pack.style.oil/1.0.1')
      .set('X-Forwarded-For', '203.0.113.9')
    assert.equal(response.status, 401)
  })

  test('a session for another user is refused', async () => {
    const cookie = buildSessionCookie(signSession({ username: 'someone-else', exp: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET), 3600)
    const response = await request(remoteApp).get('/api/content-store/covers/com.storystudio.pack.style.oil/1.0.1')
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '203.0.113.9')
    assert.equal(response.status, 401)
  })

  test('the Electron window on the mini itself keeps working with no cookie at all', async () => {
    // Loopback is trusted by physical access; a login dialog there would be
    // hostile. This is the local-mode half of the same route, on the same
    // gated app, reached from the address the Electron window really uses.
    const response = await request(remoteApp).get('/api/content-store/covers/com.storystudio.pack.style.oil/1.0.1')
      .set('X-Forwarded-For', '127.0.0.1')
    assert.equal(response.status, 200)
  })
})
