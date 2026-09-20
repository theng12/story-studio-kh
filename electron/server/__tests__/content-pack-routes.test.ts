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
import * as projectManager from '../services/project-manager.js'
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

async function buildRouteBundleArchives() {
  const rootPackId = 'com.storystudio.routes-bundle-root'
  const bundleId = 'com.storystudio.bundle.routes-multi-style'
  const componentPackIds = [
    'com.storystudio.routes-bundle-formula',
    'com.storystudio.routes-bundle-topic',
    'com.storystudio.routes-bundle-recipe',
    'com.storystudio.routes-bundle-style-pastel',
    'com.storystudio.routes-bundle-style-impasto',
    'com.storystudio.routes-bundle-style-oil',
  ]
  const itemIds = componentPackIds.map(packId => `${packId}.item`)
  const [formulaId, topicId, recipeId, ...styleIds] = itemIds
  const documents = [
    {
      kind: 'series-formula', schema_version: 1, id: formulaId, name: 'Route Formula', description: 'Route formula.',
      channel_promise: 'Explain a bounded system.', audience: 'Curious adults.', narrative_rules: ['Stay precise.'], title_rules: ['Name the mechanism.'],
      script_structure: { default_chapter_count: 3, chapter_count_range: [2, 4], default_length_minutes: 10, length_minutes_range: [5, 15], duration_presets: [5, 10, 15], default_words_per_minute: 120, chapters_independent: true, pacing_arc: ['Opening'], additional_rules: ['Stay bounded.'] },
      compatible_topic_pack_ids: [topicId], default_topic_pack_ids: [topicId], recommended_visual_style_ids: [], recommended_thumbnail_recipe_ids: [], script_context: 'Route context.',
    },
    { kind: 'topic-pack', schema_version: 1, id: topicId, name: 'Route Topic', description: 'Route topic.', compatible_formula_ids: [formulaId], subjects: ['Ledger'], episode_objects: ['Record'], time_place_scopes: ['Modern'], mechanisms: ['Choice'], evidence_lenses: ['Documents'], exclusions: [], max_siblings_per_subject: 4, prompt_context: 'Use evidence.' },
    { kind: 'thumbnail-recipe', schema_version: 1, id: recipeId, name: 'Route Recipe', description: 'Route recipe.', layout: 'hero', category: 'Test', tags: ['route'], aspect_ratio: '16:9', title_mode: 'ai', composition_guidance: 'One subject.', required_elements: ['Subject'], avoid_elements: ['Clutter'], headline_mode: 'episode-title', headline_guidance: 'Short.', default_text_style: 'Ivory', default_font_style: 'Serif', default_text_position: 'top', headline_formats: ['THE RECORD'], visual_style_guidance: 'Restrained.', preview_assets: ['assets/preview.png'], compatible_formula_ids: [formulaId] },
    ...styleIds.map((id, index) => ({ kind: 'visual-style', schema_version: 1, id, name: `Route Style ${index}`, description: 'Route style.', category: 'Test', tags: ['route'], style_bible: `Ordered style ${index}.`, negative_prompt: 'No text.', preview_assets: ['assets/preview.png'], compatible_formula_ids: [formulaId] })),
  ]
  const components = documents.map((document, index) => ({
    pack_id: componentPackIds[index]!, version: '1.0.0', item_id: document.id, kind: document.kind,
  }))
  const componentArchives: Uint8Array[] = []
  for (const [index, document] of documents.entries()) {
    const packId = componentPackIds[index]!
    const contentBytes = Buffer.from(JSON.stringify(document))
    const usesPreview = document.kind === 'visual-style' || document.kind === 'thumbnail-recipe'
    const componentManifest = Buffer.from(JSON.stringify({
      pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID,
      version: '1.0.0', min_app_version: '1.0.0', lifecycle: 'active',
      entitlement: { sku: `${packId}.sku`, family: `${packId}.family` }, bundles: [],
      items: [{ id: document.id, kind: document.kind, schema_version: 1, path: 'content/item.json' }],
      files: [
        { path: 'content/item.json', sha256: sha256(contentBytes), bytes: contentBytes.byteLength, mime: 'application/json' },
        ...(usesPreview ? [{ path: 'assets/preview.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' }] : []),
      ],
    }))
    const zip = new JSZip()
    zip.file('manifest.json', componentManifest, { createFolders: false })
    zip.file('signature.ed25519', sign(null, componentManifest, keyPair.privateKey), { createFolders: false })
    zip.file('content/item.json', contentBytes, { createFolders: false })
    if (usesPreview) zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
    componentArchives.push(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' }))
  }
  const rootManifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: rootPackId, publisher_id: PUBLISHER_ID, key_id: KEY_ID,
    version: '1.0.0', min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${rootPackId}.sku`, family: `${rootPackId}.family` },
    dependencies: components.map(({ pack_id, version }) => ({ pack_id, version })),
    bundles: [{ id: bundleId, kind: 'channel-kit', name: 'Route Multi-Style Kit', components }], items: [], files: [],
  }))
  const rootZip = new JSZip()
  rootZip.file('manifest.json', rootManifest, { createFolders: false })
  rootZip.file('signature.ed25519', sign(null, rootManifest, keyPair.privateKey), { createFolders: false })
  return {
    componentArchives,
    componentPackIds,
    itemIds,
    root: await rootZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' }),
    bundleId,
  }
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

  test('imports only bounded binary signed archives and never accepts JSON archives', async () => {
    const { app, paths } = await isolated()
    const archive = await buildArchive()
    const imported = await request(app)
      .post('/api/content-packs/import')
      .type('application/octet-stream')
      .send(Buffer.from(archive))
      .expect(201)
    assert.equal(imported.body.pack_id, PACK_ID)
    assert.equal(imported.body.version, '1.0.0')

    await request(app)
      .post('/api/content-packs/import')
      .type('application/json')
      .send({ archive: Buffer.from(archive).toString('base64') })
      .expect(415)
    await request(app)
      .post('/api/content-packs/import')
      .type('application/octet-stream')
      .send(Buffer.from('not a pack'))
      .expect(400)
    await request(app)
      .post('/api/content-packs/import')
      .type('application/octet-stream')
      .send(Buffer.from(await buildArchive({ includeSignature: false })))
      .expect(400)

    assert.equal(Object.keys((await readContentPackState(paths)).packs).length, 1)
  })

  test('rejects an archive larger than 50 MiB before installer persistence', async () => {
    const { app, paths } = await isolated()
    await request(app)
      .post('/api/content-packs/import')
      .type('application/octet-stream')
      .send(Buffer.alloc(50 * 1024 * 1024 + 1))
      .expect(413)
    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
  })

  test('lists bounded verified installed and recovery metadata without sensitive internals', async () => {
    const { app, recoveryRoot, contentPackOptions } = await isolated()
    await install(await buildArchive(), contentPackOptions)
    await fs.writeFile(path.join(recoveryRoot, 'free.sspack'), await buildArchive({
      packId: 'com.storystudio.routes-recovery', version: '2.0.0',
    }))

    const response = await request(app).get('/api/content-packs').expect(200)
    assert.equal(response.body.packs.length, 2)
    const installed = response.body.packs.find((pack: any) => pack.pack_id === PACK_ID)
    assert.equal(installed.discovery_disabled, false)
    assert.equal(installed.versions[0].active, true)
    assert.deepEqual(installed.versions[0].affected_projects, [])
    assert.match(JSON.stringify(response.body), /signed-(?:installed|recovery)/)
    assert.doesNotMatch(JSON.stringify(response.body), /install_path|publicKey|BEGIN PUBLIC KEY|archiveBytes|entitlement|account|api.?key|\/Users\//i)
  })

  test('disables discovery without hiding management or breaking exact local assets', async () => {
    const { app, contentPackOptions } = await isolated()
    await install(await buildArchive(), contentPackOptions)
    await request(app).post(`/api/content-packs/${PACK_ID}/disable`).expect(200)

    const managed = await request(app).get('/api/content-packs').expect(200)
    assert.equal(managed.body.packs.find((pack: any) => pack.pack_id === PACK_ID).discovery_disabled, true)
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

  test('validates lifecycle IDs before filesystem access and applies rollback and uninstall guards', async () => {
    const { app, paths, contentPackOptions } = await isolated()
    await install(await buildArchive({ version: '1.0.0' }), contentPackOptions)
    await install(await buildArchive({ version: '1.1.0' }), contentPackOptions)

    await request(app).post('/api/content-packs/not-qualified/disable').expect(400)
    await request(app).post(`/api/content-packs/${PACK_ID}/rollback`).send({ version: '../1.0.0' }).expect(400)
    await request(app).post(`/api/content-packs/${PACK_ID}/rollback`).send({ version: '1.0.0' }).expect(200)
    assert.equal((await readContentPackState(paths)).packs[PACK_ID].active_version, '1.0.0')
    await request(app).delete(`/api/content-packs/${PACK_ID}/versions/1.0.0`).expect(409)
    await request(app).delete(`/api/content-packs/${PACK_ID}/versions/1.1.0`).expect(200)
    assert.equal((await readContentPackState(paths)).packs[PACK_ID].versions['1.1.0'], undefined)

    assert.equal(await fs.stat(paths.root).then(() => true), true)
    await request(app).get('/api/content-packs/not-qualified/1.0.0/assets/' + sha256(PNG_1PX)).expect(400)
  })

  test('reports exact project requirements and affected projects without document bodies', async () => {
    const { app, contentPackOptions } = await isolated()
    await install(await buildArchive(), contentPackOptions)
    const projectDir = path.join(projectManager.ensureProjectsRoot(), 'route-project')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      name: 'Route Project', slug: 'route-project', created_at: new Date().toISOString(),
      content_pack_versions: { [PACK_ID]: '1.0.0', 'com.storystudio.missing': '4.0.0' },
      content_pack_items: {
        [`${PACK_ID}.style`]: { pack_id: PACK_ID, kind: 'visual-style' },
        'com.storystudio.missing.topic': { pack_id: 'com.storystudio.missing', kind: 'topic-pack' },
      },
    }))

    const requirements = await request(app)
      .get('/api/content-packs/projects/route-project/requirements')
      .expect(200)
    assert.equal(requirements.body.project_slug, 'route-project')
    assert.equal(requirements.body.requirements.length, 2)
    assert.equal(requirements.body.requirements.find((entry: any) => entry.pack_id === PACK_ID).available, true)
    assert.equal(requirements.body.requirements.find((entry: any) => entry.pack_id === 'com.storystudio.missing').available, false)

    const managed = await request(app).get('/api/content-packs').expect(200)
    assert.deepEqual(
      managed.body.packs.find((pack: any) => pack.pack_id === PACK_ID).versions[0].affected_projects,
      ['route-project'],
    )
    assert.doesNotMatch(JSON.stringify(requirements.body), /style_bible|prompt_context|install_path|\/Users\//i)
  })

  test('strictly validates and explicitly applies an installed multi-Style bundle without installation side effects', async () => {
    const { app, paths, contentPackOptions } = await isolated()
    const fixture = await buildRouteBundleArchives()
    const components = []
    for (const archive of fixture.componentArchives) components.push(await install(archive, contentPackOptions))
    const root = await install(fixture.root, contentPackOptions)
    const project = await projectManager.createProject({ name: 'Route Bundle Apply' })
    const beforePacks = Object.keys((await readContentPackState(paths)).packs).sort()

    await request(app).post('/api/content-packs/projects/INVALID!/bundles/apply').send({}).expect(400)
    await request(app).post(`/api/content-packs/projects/${project.slug}/bundles/apply`).send({
      root: { pack_id: root.pack_id, version: root.version, archive_sha256: root.archive_sha256 },
      bundle_id: fixture.bundleId,
      install: true,
    }).expect(400)
    await request(app).post('/api/content-packs/projects/missing-project/bundles/apply').send({
      root: { pack_id: root.pack_id, version: root.version, archive_sha256: root.archive_sha256 },
      bundle_id: fixture.bundleId,
    }).expect(404)
    await request(app).post(`/api/content-packs/projects/${project.slug}/bundles/apply`).send({
      root: { pack_id: components[0].pack_id, version: components[0].version, archive_sha256: components[0].archive_sha256 },
      bundle_id: fixture.bundleId,
    }).expect(400)

    const response = await request(app).post(`/api/content-packs/projects/${project.slug}/bundles/apply`).send({
      root: { pack_id: root.pack_id, version: root.version, archive_sha256: root.archive_sha256 },
      bundle_id: fixture.bundleId,
    }).expect(200)
    assert.equal(response.body.default_style_id, fixture.itemIds[3])
    assert.deepEqual(response.body.alternative_style_ids, fixture.itemIds.slice(4))
    assert.deepEqual(Object.keys((await readContentPackState(paths)).packs).sort(), beforePacks)

    const saved = await projectManager.getProject(project.slug)
    assert.deepEqual(saved?.content_pack_versions, Object.fromEntries(fixture.componentPackIds.map(packId => [packId, '1.0.0'])))
    assert.equal(Object.keys(saved?.content_pack_items ?? {}).length, 6)

    const conflictDir = path.join(projectManager.ensureProjectsRoot(), project.slug)
    const conflicted = JSON.parse(await fs.readFile(path.join(conflictDir, 'project.json'), 'utf8'))
    conflicted.content_pack_versions[fixture.componentPackIds[0]] = '9.9.9'
    await fs.writeFile(path.join(conflictDir, 'project.json'), JSON.stringify(conflicted))
    const conflict = await request(app).post(`/api/content-packs/projects/${project.slug}/bundles/apply`).send({
      root: { pack_id: root.pack_id, version: root.version, archive_sha256: root.archive_sha256 },
      bundle_id: fixture.bundleId,
    }).expect(409)
    assert.match(conflict.body.detail, /explicit upgrade|pins.*9\.9\.9/i)

    const operationalFailureProject = await projectManager.createProject({ name: 'Route Bundle Operational Failure' })
    app.locals.contentPackOptions = {
      ...contentPackOptions,
      hooks: { beforeProjectWrite: async () => { throw new Error('private disk failure detail') } },
    }
    const operationalFailure = await request(app)
      .post(`/api/content-packs/projects/${operationalFailureProject.slug}/bundles/apply`)
      .send({
        root: { pack_id: root.pack_id, version: root.version, archive_sha256: root.archive_sha256 },
        bundle_id: fixture.bundleId,
      })
      .expect(500)
    assert.deepEqual(operationalFailure.body, { detail: 'Internal server error' })
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

    const catalog = await request(app).get('/api/content-packs').expect(200)
    assert.equal(catalog.body.packs.some((pack: any) => pack.pack_id === recoveryId), true)
    assert.equal(catalog.body.packs.some((pack: any) => pack.pack_id === 'com.storystudio.routes-too-new'), false)
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
