import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { readContentPackState } from '../content-packs/state.js'
import { router as contentPacksRouter } from '../routes/content-packs.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { errorBoundary } from '../lib/error-boundary.js'
import { useTempDataDir } from './_helpers.js'

/**
 * The Gateway archive bank is not a second installer and not a second
 * ownership state. Story lists authenticated archive metadata, downloads the
 * exact digest, and hands those bytes to the existing local-import installer.
 */

const GATEWAY_URL = 'http://127.0.0.1:8795'
const GATEWAY_KEY = 'gateway-archive-test-key'
const PACK_ID = 'kh.owner.gateway-archive'
const VERSION = '1.2.0'
const MAX_IMPORT_BYTES = 50 * 1024 * 1024
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  'base64',
)

let cleanup: (() => Promise<void>) | undefined
let app: express.Express
let paths: ReturnType<typeof getContentPackRuntimePaths>
let calls: Array<{ url: string; init: RequestInit }> = []
let handler: (url: string, init: RequestInit) => Response | Promise<Response>
const originalFetch = globalThis.fetch

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function buildArchive(): Promise<Uint8Array> {
  const itemId = `${PACK_ID}.style`
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style',
    schema_version: 1,
    id: itemId,
    name: 'Gateway Archive Style',
    description: 'A keyless possession fixture.',
    category: 'Test',
    tags: ['gateway', 'archive'],
    style_bible: 'Keep the scene restrained.',
    negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'],
    compatible_formula_ids: [],
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: PACK_ID,
    publisher_id: 'kh.owner',
    version: VERSION,
    min_app_version: '1.0.0',
    lifecycle: 'active',
    delivery_profile: 'genstudio-store-receipt-v1',
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` },
    bundles: [],
    items: [{ id: itemId, kind: 'visual-style', schema_version: 1, path: 'content/style.json' }],
    files: [
      { path: 'content/style.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ],
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('content/style.json', document, { createFolders: false })
  zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  paths = getContentPackRuntimePaths()
  await setGenStudioUrl(GATEWAY_URL)
  await setApiKey('genstudio', GATEWAY_KEY)
  calls = []
  handler = () => { throw new Error('No Gateway request expected') }
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch

  app = express()
  app.locals.contentPackOptions = {
    paths,
    policy: createContentPackKeyring([]),
    appVersion: '1.0.832',
  }
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', contentPacksRouter)
  app.use(errorBoundary)
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await cleanup?.()
  cleanup = undefined
})

describe('Gateway archive bank routes', () => {
  test('lists safe archive metadata with the saved Gateway key and hides trust internals', async () => {
    const archive = await buildArchive()
    const digest = sha256(archive)
    handler = (url, init) => {
      assert.equal(url, `${GATEWAY_URL}/admin/api/content-library`)
      assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${GATEWAY_KEY}`)
      assert.equal(init.redirect, 'error')
      return jsonResponse({
        archives: [
          {
            archive_sha256: digest,
            bytes: archive.byteLength,
            pack_id: PACK_ID,
            publisher_id: 'kh.owner',
            version: VERSION,
            min_app_version: '1.0.0',
            title: 'Gateway Archive Style',
            description: 'Internal shelf blurb',
            tags: ['internal'],
            entitlement: { sku: 'internal-sku' },
            item_ids: ['internal-item'],
            delivery_profile: 'genstudio-store-receipt-v1',
            item_kinds: ['visual-style'],
            file_count: 2,
            integrity: 'verified',
            ownership: 'unverified',
            installable: false,
            trust_requirement: 'Internal trust detail',
            compatibility: 'Internal compatibility detail',
          },
          {
            archive_sha256: 'f'.repeat(64),
            integrity: 'unreadable',
            installable: false,
          },
          { archive_sha256: 'not-a-digest', integrity: 'verified' },
        ],
      })
    }

    const response = await request(app).get('/api/content-packs/gateway-archives').expect(200)
    assert.equal(response.body.archives.length, 2)
    const listed = response.body.archives.find((row: any) => row.archiveSha256 === digest)
    assert.deepEqual(listed, {
      archiveSha256: digest,
      bytes: archive.byteLength,
      packId: PACK_ID,
      version: VERSION,
      title: 'Gateway Archive Style',
      minAppVersion: '1.0.0',
      itemKinds: ['visual-style'],
      integrity: 'verified',
    })
    const unreadable = response.body.archives.find((row: any) => row.archiveSha256 === 'f'.repeat(64))
    assert.deepEqual(unreadable, {
      archiveSha256: 'f'.repeat(64),
      bytes: null,
      packId: '',
      version: '',
      title: '',
      minAppVersion: '',
      itemKinds: [],
      integrity: 'unreadable',
    })
    const serialized = JSON.stringify(response.body)
    assert.doesNotMatch(serialized, /ownership|installable|trust_requirement|entitlement|internal-sku|internal shelf/i)
  })

  test('downloads the exact digest and installs through local-import semantics', async () => {
    const archive = await buildArchive()
    const digest = sha256(archive)
    handler = (url, init) => {
      assert.equal(url, `${GATEWAY_URL}/admin/api/content-library/${digest}/archive`)
      assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${GATEWAY_KEY}`)
      assert.equal(init.redirect, 'error')
      return new Response(archive, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    }

    const response = await request(app)
      .post(`/api/content-packs/gateway-archives/${digest}/install`)
      .expect(201)
    assert.deepEqual(response.body, {
      pack_id: PACK_ID,
      version: VERSION,
      archive_sha256: digest,
      activated: true,
      retained_versions: [VERSION],
    })

    const installed = (await readContentPackState(paths)).packs[PACK_ID].versions[VERSION]
    assert.equal(installed.source, 'local-import')
    assert.equal(installed.archive_sha256, digest)
    assert.equal(installed.delivery_attestation, undefined)
  })

  test('refuses a digest mismatch before anything is installed', async () => {
    const archive = await buildArchive()
    const requested = 'a'.repeat(64)
    handler = () => new Response(archive, { status: 200 })
    const response = await request(app)
      .post(`/api/content-packs/gateway-archives/${requested}/install`)
      .expect(502)
    assert.equal(response.body.code, 'CONTENT_PACK_GATEWAY_ARCHIVE_MISMATCH')
    assert.match(response.body.detail, /Nothing was installed/)
    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
  })

  test('refuses an oversized archive before reading it into memory', async () => {
    const digest = 'b'.repeat(64)
    handler = () => new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'content-length': String(MAX_IMPORT_BYTES + 1) },
    })
    const response = await request(app)
      .post(`/api/content-packs/gateway-archives/${digest}/install`)
      .expect(413)
    assert.equal(response.body.code, 'CONTENT_PACK_GATEWAY_ARCHIVE_TOO_LARGE')
    assert.match(response.body.detail, /50 MiB/)
    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
  })

  test('names a missing Gateway key and rejects an invalid digest without a request', async () => {
    await setApiKey('genstudio', '')
    const missing = await request(app).get('/api/content-packs/gateway-archives').expect(400)
    assert.equal(missing.body.code, 'CONTENT_PACK_GATEWAY_KEY_REQUIRED')
    assert.equal(calls.length, 0)

    const invalid = await request(app)
      .post('/api/content-packs/gateway-archives/not-a-digest/install')
      .expect(400)
    assert.equal(invalid.body.code, 'CONTENT_PACK_GATEWAY_DIGEST_INVALID')
    assert.equal(calls.length, 0)
  })
})
