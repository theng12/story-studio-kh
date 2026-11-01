import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, test } from 'node:test'

import JSZip from 'jszip'
import sharp from 'sharp'
import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
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
    // `rewriteCoverSrc` takes a whole product, so the fixture carries the
    // canonical envelope too - it only ever reads `cover.url`.
    raw: { value: {}, canonicalJson: '{}', canonicalBytes: new Uint8Array() },
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


// Preview pictures of an installed pack.
//
// The Gateway publishes only `cover` and `hero: null` per product, so a shelf
// pack's previews are NOT on the wire at all. What IS readable is the pack this
// Mac already has: its previews live inside the signed archive. These tests pin
// the four answers that must stay distinct - installed, not installed, not a
// known pack, and an identity that tries to climb out.

const PREVIEW_KEY_ID = 'com.storystudio.test-previews'
const PREVIEW_PUBLISHER = 'com.storystudio'
const previewKeyPair = generateKeyPairSync('ed25519')
const previewPolicy = createContentPackKeyring([{
  keyId: PREVIEW_KEY_ID,
  publisherId: PREVIEW_PUBLISHER,
  publicKeyPem: previewKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const STYLE_PACK_ID = 'com.storystudio.pack.style.previews'
const TOPIC_PACK_ID = 'com.storystudio.pack.topic.previews'
const PACK_VERSION = '1.0.0'
const PREVIEW_PATHS = ['assets/hero.webp', 'assets/quiet-wide.webp', 'assets/hardest.webp']

// A real 1672x941 WebP, the size a style pack's previews actually are. The
// archive verifier DECODES every declared raster and checks the declared mime
// against what it decoded, so a stand-in file would be refused outright.
async function previewRaster(index: number): Promise<Buffer> {
  return sharp({
    create: { width: 1672, height: 941, channels: 3, background: { r: 30 + index * 40, g: 60, b: 90 + index * 30 } },
  }).webp().toBuffer()
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function previewStyleDocument(): Record<string, unknown> {
  return {
    kind: 'visual-style', schema_version: 1,
    id: 'com.storystudio.style.preview-probe', name: 'Preview Probe',
    description: 'A style whose previews are the point.',
    category: 'painterly', tags: ['test'], style_bible: 'Loose brushwork.', negative_prompt: 'text',
    preview_assets: PREVIEW_PATHS, compatible_formula_ids: [],
  }
}

function topicDocument(): Record<string, unknown> {
  return {
    kind: 'topic-pack', schema_version: 1,
    id: 'com.storystudio.topic.preview-probe', name: 'Topic Probe',
    description: 'A pack with no pictures at all.',
    compatible_formula_ids: ['com.storystudio.formula.sleep-story'],
    subjects: ['sleep'], episode_objects: ['bed'], time_place_scopes: ['night'],
    mechanisms: ['rest'], evidence_lenses: ['observation'], exclusions: [], max_siblings_per_subject: 4,
    prompt_context: 'Quiet nights.',
  }
}

async function installPreviewFixture(spec: {
  packId: string
  documentPath: string
  document: Record<string, unknown>
  rasters?: readonly string[]
}): Promise<void> {
  const documentBytes = Buffer.from(JSON.stringify(spec.document), 'utf8')
  const rasters = spec.rasters ?? []
  const rasterBytes = new Map(await Promise.all(rasters.map(async path => [path, await previewRaster(rasters.indexOf(path))] as const)))
  const files = [
    { path: spec.documentPath, sha256: sha256(documentBytes), bytes: documentBytes.byteLength, mime: 'application/json' },
    ...rasters.map(path => ({
      path, sha256: sha256(rasterBytes.get(path)!), bytes: rasterBytes.get(path)!.byteLength, mime: 'image/webp',
    })),
  ]
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: spec.packId, publisher_id: PREVIEW_PUBLISHER, key_id: PREVIEW_KEY_ID,
    version: PACK_VERSION, min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: spec.packId + '.sku', family: spec.packId + '.family' },
    bundles: [],
    items: [{ id: spec.document.id, kind: spec.document.kind, schema_version: 1, path: spec.documentPath }],
    files,
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, previewKeyPair.privateKey), { createFolders: false })
  zip.file(spec.documentPath, documentBytes, { createFolders: false })
  for (const path of rasters) zip.file(path, rasterBytes.get(path)!, { createFolders: false })
  const archiveBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
  await installContentPack(
    { archiveBytes, source: 'local-import', expectedArchiveSha256: sha256(archiveBytes) },
    { paths: getContentPackRuntimePaths(), policy: previewPolicy },
  )
}

function previewApp(paths: ReturnType<typeof getContentPackRuntimePaths>): express.Express {
  const built = express()
  // The previews route reads pack state through the same seam the Content Pack
  // routes use, so the test hands it the temp runtime directly.
  built.locals.contentPackOptions = { paths, policy: previewPolicy }
  built.use('/api', contentStoreCoversRouter)
  built.use(errorBoundary)
  return built
}

describe('the preview pictures of an installed pack', () => {
  test('an installed style pack lists its three previews in archive order', async () => {
    const app = previewApp(getContentPackRuntimePaths())
    await installPreviewFixture({
      packId: STYLE_PACK_ID, documentPath: 'content/style.json', document: previewStyleDocument(), rasters: PREVIEW_PATHS,
    })
    const response = await request(app).get('/api/content-store/previews/' + STYLE_PACK_ID + '/' + PACK_VERSION)
    assert.equal(response.status, 200)
    assert.equal(response.body.available, true)
    assert.equal(response.body.reason, null)
    assert.equal(response.body.pictures.length, 3)

    // Order is the archive's: hero, quiet wide scene, hardest use.
    assert.deepEqual(response.body.pictures.map((row: { alt: string }) => row.alt), [
      'Preview Probe — Hero',
      'Preview Probe — Quiet wide scene',
      'Preview Probe — Hardest legal case',
    ])
    // Every picture is a Story same-origin URL, never a Gateway path the CSP
    // would refuse, and never a filesystem path.
    for (const row of response.body.pictures) {
      assert.match(row.src, /^\/api\/content-packs\//)
      assert.equal(row.src.includes('..'), false)
    }
  })

  test('a pack that is not installed says so, and fetches nothing', async () => {
    const app = previewApp(getContentPackRuntimePaths())
    const response = await request(app).get('/api/content-store/previews/' + STYLE_PACK_ID + '/' + PACK_VERSION)
    assert.equal(response.status, 200)
    assert.equal(response.body.available, false)
    // Distinct from a pack Story could not read (AGENTS.md 6).
    assert.equal(response.body.reason, 'not-installed')
    assert.deepEqual(response.body.pictures, [])
  })

  test('an unknown pack identity is the same honest not-installed answer', async () => {
    const app = previewApp(getContentPackRuntimePaths())
    const response = await request(app).get('/api/content-store/previews/com.storystudio.pack.style.never-existed/9.9.9')
    assert.equal(response.status, 200)
    assert.equal(response.body.available, false)
    assert.equal(response.body.reason, 'not-installed')
  })

  test('a pack installed with no previews lists none, and stays available', async () => {
    const app = previewApp(getContentPackRuntimePaths())
    await installPreviewFixture({
      packId: TOPIC_PACK_ID, documentPath: 'content/topic.json', document: topicDocument(),
    })
    const response = await request(app).get('/api/content-store/previews/' + TOPIC_PACK_ID + '/' + PACK_VERSION)
    assert.equal(response.status, 200)
    assert.equal(response.body.available, true)
    assert.deepEqual(response.body.pictures, [])
  })

  test('a pack identity that could carry a path is refused before any read', async () => {
    const app = previewApp(getContentPackRuntimePaths())
    for (const url of [
      '/api/content-store/previews/..%2F..%2Fetc/' + PACK_VERSION,
      '/api/content-store/previews/' + STYLE_PACK_ID + '/..%2F1.0.0',
      '/api/content-store/previews/p%2F..%2Fq/' + PACK_VERSION,
      '/api/content-store/previews/%2e%2e%2f%2e%2e/' + PACK_VERSION,
    ]) {
      const response = await request(app).get(url)
      assert.equal(response.status, 400, url)
      assert.equal(response.body.code, 'CONTENT_STORE_PREVIEW_INVALID', url)
    }
  })
})
