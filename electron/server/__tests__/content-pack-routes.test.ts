import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { installContentPack, verifyInstalledContentPackVersion } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { listVerifiedRecoveryPacks } from '../content-packs/recovery.js'
import { listCatalogEntries } from '../content-packs/registry.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import { router as contentPacksRouter } from '../routes/content-packs.js'
import { errorBoundary } from '../lib/error-boundary.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const PACK_ID = 'com.storystudio.routes-test'
const POSSESSED_PACK_ID = 'com.storystudio.possessed-routes'
const KEY_ID = 'com.storystudio.key.routes-test'
const MAX_IMPORT_BYTES = 50 * 1024 * 1024
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

/** The keyless receipt-profile shape produced for Store delivery, imported by possession. */
async function buildPossessedArchive(options: {
  packId?: string
  version?: string
  minAppVersion?: string
  dependencies?: Array<{ pack_id: string; version: string }>
  declaredPreviewSha256?: string
  includeSignature?: boolean
  styleSuffix?: string
} = {}): Promise<Uint8Array> {
  const packId = options.packId ?? POSSESSED_PACK_ID
  const version = options.version ?? '1.0.0'
  const itemId = `${packId}.style`
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: itemId, name: `Possessed Style ${version}`,
    description: 'A keyless possession fixture.', category: 'Test', tags: ['route'],
    style_bible: `Keep the scene restrained.${options.styleSuffix ?? ''}`, negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID,
    version, min_app_version: options.minAppVersion ?? '1.0.0', lifecycle: 'active',
    delivery_profile: 'genstudio-store-receipt-v1',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    dependencies: options.dependencies,
    bundles: [],
    items: [{ id: itemId, kind: 'visual-style', schema_version: 1, path: 'content/style.json' }],
    files: [
      { path: 'content/style.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      {
        path: 'assets/preview.png', sha256: options.declaredPreviewSha256 ?? sha256(PNG_1PX),
        bytes: PNG_1PX.byteLength, mime: 'image/png',
      },
    ],
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  if (options.includeSignature) zip.file('signature.ed25519', Buffer.alloc(64), { createFolders: false })
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

/** Existing policy seam: a keyring read can fail like any other local resource. */
class FailingPublisherKeys extends Map<string, { publisherId: string; publicKeyPem: string }> {
  constructor(private readonly failureCode: string) { super() }
  override get(): { publisherId: string; publicKeyPem: string } | undefined {
    throw Object.assign(new Error('simulated local storage failure'), { code: this.failureCode })
  }
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

  test('imports a possessed keyless archive with local-import semantics through reverify and catalog', async () => {
    const { app, paths, contentPackOptions } = await isolated()
    const archive = await buildPossessedArchive()
    const response = await request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(archive))
      .expect(201)
    assert.deepEqual(response.body, {
      pack_id: POSSESSED_PACK_ID, version: '1.0.0', archive_sha256: sha256(archive),
      activated: true, retained_versions: ['1.0.0'],
    })

    const state = await readContentPackState(paths)
    const installed = state.packs[POSSESSED_PACK_ID].versions['1.0.0']
    assert.equal(installed.source, 'local-import')
    assert.equal(installed.delivery_attestation, undefined)
    assert.equal(installed.archive_sha256, sha256(archive))
    await assert.doesNotReject(verifyInstalledContentPackVersion(installed, policy))

    const catalog = await listCatalogEntries('visual-style', contentPackOptions)
    assert.equal(catalog.some(entry => entry.pack?.pack_id === POSSESSED_PACK_ID), true)

    const asset = await request(app)
      .get(`/api/content-packs/${POSSESSED_PACK_ID}/1.0.0/assets/${sha256(PNG_1PX)}`)
      .expect(200)
    assert.equal(asset.headers['content-type'], 'image/png')

    // Reverify keeps the same local-import possession semantics and still catches a changed file.
    const preview = path.join(installed.install_path, 'assets', 'preview.png')
    await fs.writeFile(preview, Buffer.concat([PNG_1PX, Buffer.from('changed')]))
    await assert.rejects(verifyInstalledContentPackVersion(installed, policy), /materialised|differs/i)
  })

  test('rejects tampered, incompatible and dependency-missing possessed archives without installing', async () => {
    const { app, paths } = await isolated()
    const tampered = await request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(await buildPossessedArchive({ declaredPreviewSha256: '0'.repeat(64) })))
      .expect(400)
    assert.match(tampered.body.detail, /could not be verified/i)

    const incompatible = await request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(await buildPossessedArchive({ minAppVersion: '99.0.0' })))
      .expect(400)
    assert.match(incompatible.body.detail, /99\.0\.0/)

    const missingDependency = await request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(await buildPossessedArchive({
        dependencies: [{ pack_id: 'com.storystudio.missing', version: '1.0.0' }],
      })))
      .expect(400)
    assert.match(missingDependency.body.detail, /dependency/i)

    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
  })

  test('import route enforces a binary body, non-empty bytes and the 50 MiB limit', async () => {
    const { app } = await isolated()
    await request(app)
      .post('/api/content-packs/import')
      .send({ archive: 'not-binary' })
      .expect(415, { detail: 'Content Pack import requires application/octet-stream.' })
    await request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(0))
      .expect(400, { detail: 'Content Pack archive bytes are required.' })
    const tooLarge = await request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(MAX_IMPORT_BYTES + 1))
      .expect(413)
    assert.match(tooLarge.body.detail, /52428800/)
  })

  test('reports storage and internal failures truthfully without absolute paths', async () => {
    const { app, contentPackOptions } = await isolated()
    const archive = Buffer.from(await buildArchive({ packId: 'com.storystudio.infrastructure-route-import' }))
    const post = () => request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(archive)

    contentPackOptions.policy = {
      publisherKeys: new FailingPublisherKeys('ENOSPC'),
    } as unknown as typeof policy
    const diskFull = await post().expect(503)
    assert.match(diskFull.body.detail, /disk is full/i)
    assert.doesNotMatch(diskFull.body.detail, /\//)

    contentPackOptions.policy = {
      publisherKeys: new FailingPublisherKeys('EACCES'),
    } as unknown as typeof policy
    const denied = await post().expect(500)
    assert.match(denied.body.detail, /local storage/i)
    assert.doesNotMatch(denied.body.detail, /\//)

    contentPackOptions.policy = {
      get limits(): never { throw new Error('Content Pack first-party key resource is unavailable') },
    } as unknown as typeof policy
    const internal = await post().expect(500)
    assert.match(internal.body.detail, /internal error/i)
    assert.doesNotMatch(internal.body.detail, /key resource|\//i)
  })

  test('reports immutable and pending-removal conflicts as 409', async () => {
    const { app, paths } = await isolated()
    const archive = await buildPossessedArchive()
    const post = (bytes: Uint8Array) => request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(bytes))

    await post(archive).expect(201)
    const conflict = await post(await buildPossessedArchive({ styleSuffix: ' Different immutable bytes.' })).expect(409)
    assert.match(conflict.body.detail, /immutable/i)
    assert.doesNotMatch(conflict.body.detail, /\//)

    await mutateContentPackState(state => {
      // Real lifecycle clears activation before a version becomes pending removal.
      delete state.packs[POSSESSED_PACK_ID].active_version
      state.packs[POSSESSED_PACK_ID].versions['1.0.0'].pending_removal = {
        operation_id: '11111111-1111-4111-8111-111111111111',
        started_at: new Date().toISOString(),
      }
    }, paths)
    const pending = await post(archive).expect(409)
    assert.match(pending.body.detail, /pending removal/i)
    assert.doesNotMatch(pending.body.detail, /\//)
  })

  test('keeps publisher signatures strict while recovery and Store refuse the keyless profile', async () => {
    const { app, recoveryRoot, contentPackOptions } = await isolated()
    await request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(await buildArchive({ packId: 'com.storystudio.signed-route-import' })))
      .expect(201)
    await request(app)
      .post('/api/content-packs/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(await buildArchive({
        packId: 'com.storystudio.bad-signature-route-import',
        signature: new Uint8Array(64),
      })))
      .expect(400)

    const keyless = await buildPossessedArchive({ packId: 'com.storystudio.possessed-recovery' })
    await fs.writeFile(path.join(recoveryRoot, 'keyless.sspack'), keyless)
    assert.deepEqual(await listVerifiedRecoveryPacks(contentPackOptions), [])
    await request(app)
      .get(`/api/content-packs/com.storystudio.possessed-recovery/1.0.0/assets/${sha256(PNG_1PX)}`)
      .expect(404)

    await assert.rejects(
      installContentPack({ archiveBytes: keyless, source: 'genstudio-store' }, contentPackOptions),
      /attestation|invalid/i,
    )
  })

  test('the unused management routes stay gone', async () => {
    // Removed 2026-10: the Content Store never called them. The engine behind them stays.
    const { app } = await isolated()
    const source = await fs.readFile(new URL('../routes/content-packs.ts', import.meta.url), 'utf8')
    assert.match(source, /'\/content-packs\/import'/)
    assert.doesNotMatch(source, /rollback|bundles\/apply|\/requirements|router\.delete\(\s*['"]\/content-packs\/:packId\/versions\/:version/)
    await request(app).get('/api/content-packs').expect(404)
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
