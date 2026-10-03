import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { listCatalogEntries } from '../content-packs/registry.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import { router as contentPacksRouter } from '../routes/content-packs.js'
import { errorBoundary } from '../lib/error-boundary.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const PACK_ID = 'com.storystudio.routes-test'
const KEY_ID = 'com.storystudio.key.routes-test'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')
const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function buildArchive(options: {
  packId?: string
  version?: string
  minAppVersion?: string
  signature?: Uint8Array
  includeSignature?: boolean
} = {}): Promise<Uint8Array> {
  const packId = options.packId ?? PACK_ID
  const version = options.version ?? '1.0.0'
  const itemId = `${packId}.style`
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: itemId, name: `Route Style ${version}`,
    description: 'A signed local route fixture.', category: 'Test', tags: ['route'],
    style_bible: 'Keep the scene restrained.', negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }))
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID,
    version, min_app_version: options.minAppVersion ?? '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` }, bundles: [],
    items: [{ id: itemId, kind: 'visual-style', schema_version: 1, path: 'content/style.json' }],
    files: [
      { path: 'content/style.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  if (options.includeSignature !== false) {
    zip.file('signature.ed25519', options.signature ?? sign(null, manifest, keyPair.privateKey), { createFolders: false })
  }
  zip.file('content/style.json', document, { createFolders: false })
  zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temp.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const contentPackOptions = { paths, policy, recoveryRoot, appVersion: '1.0.832' }
  const app = express()
  app.locals.contentPackOptions = contentPackOptions
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', contentPacksRouter)
  app.use(errorBoundary)
  return { app, paths, recoveryRoot, contentPackOptions, tempDir: temp.dir }
}

async function install(
  bytes: Uint8Array,
  options: Awaited<ReturnType<typeof isolated>>['contentPackOptions'],
) {
  return installContentPack({ archiveBytes: bytes, source: 'local-import' }, options)
}

describe('local Content Pack management routes', () => {
  test('first local recovery GET resets a corrupt index and returns its redacted incident', async () => {
    const { app, paths } = await isolated()
    const invalid = '{"schema_version":1,"packs":{},"surprise":true}\n'
    const retained = path.join(paths.installedRoot, 'retained-pack', 'payload.bin')
    await fs.mkdir(path.dirname(retained), { recursive: true })
    await fs.writeFile(retained, 'retained', { mode: 0o600 })
    await fs.writeFile(paths.statePath, invalid, { mode: 0o600 })

    const response = await request(app).get('/api/content-packs/recovery').expect(200)
    assert.equal(response.body.recovery.kind, 'invalid_state_reset')
    assert.match(response.body.recovery.incidentId, /^[0-9a-f-]{36}$/i)
    assert.equal(typeof response.body.recovery.detectedAt, 'string')
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /quarantine|sha256|install_path|acknowledged_at|\/Users\//i,
    )
    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
    const hash = createHash('sha256').update(invalid).digest('hex')
    assert.equal(await fs.readFile(path.join(paths.quarantineRoot, `state-invalid-${hash}.json`), 'utf8'), invalid)
    assert.equal(await fs.readFile(retained, 'utf8'), 'retained')
  })

  test('local recovery DELETE rejects stale IDs and acknowledges only the displayed incident', async () => {
    const { app, paths } = await isolated()
    const invalid = '{"schema_version":1,"packs":{},"surprise":true}\n'
    await fs.mkdir(paths.root, { recursive: true })
    await fs.writeFile(paths.statePath, invalid, { mode: 0o600 })
    const incident = (await request(app).get('/api/content-packs/recovery').expect(200)).body.recovery

    const stale = await request(app)
      .delete('/api/content-packs/recovery/11111111-1111-4111-8111-111111111111')
      .expect(409)
    assert.equal(stale.body.code, 'CONTENT_PACK_RECOVERY_INCIDENT_CHANGED')
    assert.equal((await request(app).get('/api/content-packs/recovery').expect(200)).body.recovery.incidentId, incident.incidentId)

    await request(app).delete(`/api/content-packs/recovery/${incident.incidentId}`).expect(200, { ok: true })
    await request(app).delete(`/api/content-packs/recovery/${incident.incidentId}`).expect(200, { ok: true })
    assert.equal((await request(app).get('/api/content-packs/recovery').expect(200)).body.recovery, null)
    const hash = createHash('sha256').update(invalid).digest('hex')
    assert.equal(await fs.readFile(path.join(paths.quarantineRoot, `state-invalid-${hash}.json`), 'utf8'), invalid)
  })

  test('local recovery routes reject invalid input and preserve malformed evidence', async () => {
    const { app, paths } = await isolated()
    await fs.mkdir(paths.root, { recursive: true })
    const malformed = '{"schema_version":1,"incident":"damaged"}\n'
    await fs.writeFile(paths.recoveryStatePath, malformed, { mode: 0o600 })

    const invalidId = await request(app).delete('/api/content-packs/recovery/not-a-uuid').expect(400)
    assert.equal(invalidId.body.code, 'CONTENT_PACK_RECOVERY_REQUEST_INVALID')
    const failed = await request(app).get('/api/content-packs/recovery').expect(500)
    assert.equal(failed.body.code, 'CONTENT_PACK_RECOVERY_STATE_INVALID')
    assert.equal(await fs.readFile(paths.recoveryStatePath, 'utf8'), malformed)
  })

  test('disables discovery without breaking exact local assets', async () => {
    const { app, contentPackOptions } = await isolated()
    await install(await buildArchive(), contentPackOptions)
    await request(app).post(`/api/content-packs/${PACK_ID}/disable`).expect(200)

    assert.equal((await listCatalogEntries('visual-style', contentPackOptions)).some(entry => entry.pack?.pack_id === PACK_ID), false)

    const asset = await request(app)
      .get(`/api/content-packs/${PACK_ID}/1.0.0/assets/${sha256(PNG_1PX)}`)
      .expect(200)
    assert.equal(asset.headers['content-type'], 'image/png')
    assert.equal(asset.headers['x-content-type-options'], 'nosniff')
    assert.match(asset.headers['cache-control'], /max-age=31536000.*immutable/)

    await request(app).post(`/api/content-packs/${PACK_ID}/enable`).expect(200)
    assert.equal((await listCatalogEntries('visual-style', contentPackOptions)).some(entry => entry.pack?.pack_id === PACK_ID), true)
  })

  test('validates lifecycle IDs before filesystem access', async () => {
    const { app, paths, contentPackOptions } = await isolated()
    await install(await buildArchive({ version: '1.0.0' }), contentPackOptions)

    await request(app).post('/api/content-packs/not-qualified/disable').expect(400)
    assert.equal(await fs.stat(paths.root).then(() => true), true)
    await request(app).get('/api/content-packs/not-qualified/1.0.0/assets/' + sha256(PNG_1PX)).expect(400)
  })

  test('the import, list, rollback, remove, bundle-apply and requirements routes are gone', async () => {
    // Removed 2026-10: the Content Store never called them. The engine behind them stays.
    const { app } = await isolated()
    const source = await fs.readFile(new URL('../routes/content-packs.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /'\/content-packs\/import'|rollback|bundles\/apply|\/requirements|versions\/:version/)
    await request(app).get('/api/content-packs').expect(404)
    await request(app).post('/api/content-packs/import').type('application/octet-stream').send(Buffer.from('x')).expect(404)
    await request(app).post(`/api/content-packs/${PACK_ID}/rollback`).send({ version: '1.0.0' }).expect(404)
    await request(app).delete(`/api/content-packs/${PACK_ID}/versions/1.0.0`).expect(404)
    await request(app).post('/api/content-packs/projects/p/bundles/apply').send({}).expect(404)
    await request(app).get('/api/content-packs/projects/p/requirements').expect(404)
  })

  test('serves only declared verified raster hashes and refuses symlink replacement', async () => {
    const { app, paths, tempDir, contentPackOptions } = await isolated()
    await install(await buildArchive(), contentPackOptions)
    const assetId = sha256(PNG_1PX)
    await request(app).get(`/api/content-packs/${PACK_ID}/1.0.0/assets/${'0'.repeat(64)}`).expect(404)
    await request(app).get(`/api/content-packs/${PACK_ID}/1.0.0/assets/not-a-hash`).expect(400)
    await request(app).get(`/api/content-packs/${PACK_ID}/9.9.9/assets/${assetId}`).expect(404)

    const installed = (await readContentPackState(paths)).packs[PACK_ID].versions['1.0.0']
    const assetPath = path.join(installed.install_path, 'assets', 'preview.png')
    const outside = path.join(tempDir, 'outside.png')
    await fs.writeFile(outside, PNG_1PX)
    await fs.unlink(assetPath)
    await fs.symlink(outside, assetPath)
    await request(app).get(`/api/content-packs/${PACK_ID}/1.0.0/assets/${assetId}`).expect(404)
  })

  test('serves compatible signed recovery assets but does not expose incompatible recovery packs', async () => {
    const { app, recoveryRoot } = await isolated()
    const recoveryId = 'com.storystudio.routes-recovery-asset'
    await fs.writeFile(path.join(recoveryRoot, 'compatible.sspack'), await buildArchive({ packId: recoveryId }))
    await fs.writeFile(path.join(recoveryRoot, 'incompatible.sspack'), await buildArchive({
      packId: 'com.storystudio.routes-too-new', minAppVersion: '99.0.0',
    }))

    await request(app)
      .get(`/api/content-packs/${recoveryId}/1.0.0/assets/${sha256(PNG_1PX)}`)
      .expect(200)
    await request(app)
      .get(`/api/content-packs/com.storystudio.routes-too-new/1.0.0/assets/${sha256(PNG_1PX)}`)
      .expect(404)
  })

  test('does not serve an installed version while its durable removal is pending', async () => {
    const { app, paths, recoveryRoot, contentPackOptions } = await isolated()
    const first = await buildArchive({ version: '1.0.0' })
    await install(first, contentPackOptions)
    await install(await buildArchive({ version: '1.1.0' }), contentPackOptions)
    await fs.writeFile(path.join(recoveryRoot, 'same-version.sspack'), first)
    await mutateContentPackState(state => {
      state.packs[PACK_ID].versions['1.0.0'].pending_removal = {
        operation_id: '11111111-1111-4111-8111-111111111111',
        started_at: new Date().toISOString(),
      }
    }, paths)

    await request(app)
      .get(`/api/content-packs/${PACK_ID}/1.0.0/assets/${sha256(PNG_1PX)}`)
      .expect(404)
  })

  test('contains no GenStudio, key-store, purchase, or commerce dependency', async () => {
    const source = await fs.readFile(new URL('../routes/content-packs.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /genstudio|api.?key|secret|purchase|checkout|receipt|entitlement|account/i)
  })
})
