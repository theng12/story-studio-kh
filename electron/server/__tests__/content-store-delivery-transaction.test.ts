import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import { router as contentStoreRouter } from '../routes/content-store.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { installOwnedContentStoreRelease } from '../services/content-store-delivery.js'
import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const KEY = 'gsk_delivery_transaction'
const ACCOUNT = 'acct_delivery_transaction'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
  await cleanup?.()
  cleanup = undefined
})

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function product(productId: string, family: string, packId: string, version: string, kind: string, bundleComponents: Array<Record<string, unknown>> = []) {
  return {
    product_id: productId, entitlement_family: family, kind,
    title: productId, summary: 'Transactional delivery fixture.', description: 'Transactional delivery fixture.',
    publisher_id: 'com.storystudio', credit_price: 0, free: true, owned: false,
    retired: false, successor_product_id: null,
    current_release: {
      release_id: `release-${productId}`, pack_id: packId, version,
      archive_sha256: '0'.repeat(64), archive_bytes: 1, archive_available: false,
      min_story_version: '1.0.0', changelog: '', component_summary: {},
    },
    compatible: true, compatibility_reason: null, bundle_components: bundleComponents,
    owned_component_credit_value: 0, showcase_videos: [], cover: null, hero: null, tags: [], license: null, discount: null,
  }
}

async function archive(packId: string, family: string, version: string, dependencies: Array<{ pack_id: string; version: string }> = []): Promise<Uint8Array> {
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: `${packId}.style`, name: 'Transactional Fixture',
    description: 'A valid Store-delivery fixture.', category: 'Test', tags: ['test'],
    style_bible: 'Keep the scene clear.', negative_prompt: 'No text.', preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }))
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: 'com.storystudio', key_id: 'com.storystudio.test-key', version,
    min_app_version: '1.0.0', lifecycle: 'active', delivery_profile: 'genstudio-store-receipt-v1',
    entitlement: { sku: `${packId}.sku`, family }, dependencies, bundles: [],
    items: [{ id: `${packId}.style`, kind: 'visual-style', schema_version: 1, path: 'content/visual-style.json' }],
    files: [
      { path: 'content/visual-style.json', sha256: digest(document), bytes: document.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: digest(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', Buffer.alloc(64), { createFolders: false })
  zip.file('content/visual-style.json', document, { createFolders: false })
  zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

function app(): express.Express {
  const instance = express()
  instance.use(express.json({ limit: '10mb' }))
  instance.use('/api', contentStoreRouter)
  return instance
}

async function setupClosure() {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY, ACCOUNT)
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', KEY)

  const rootId = 'com.storystudio.pack.transaction-root'
  const dep1Id = 'com.storystudio.pack.transaction-dep-one'
  const dep2Id = 'com.storystudio.pack.transaction-dep-two'
  const root = product('product-root', 'com.storystudio.family.transaction-root', rootId, '1.0.0', 'niche_bundle')
  const dep1 = product('product-dep-one', 'com.storystudio.family.transaction-dep-one', dep1Id, '1.0.0', 'visual_style')
  const dep2 = product('product-dep-two', 'com.storystudio.family.transaction-dep-two', dep2Id, '1.0.0', 'visual_style')
  const dependencies = [{ pack_id: dep1Id, version: '1.0.0' }, { pack_id: dep2Id, version: '1.0.0' }]
  root.bundle_components = [dep1, dep2].map(component => ({
    product_id: component.product_id, entitlement_family: component.entitlement_family,
    title: component.title, kind: component.kind, component_credit_value: 0, owned: false,
  }))
  mock.contentProducts = [root, dep1, dep2]
  mock.configureContentBundle('product-root', ['product-dep-one', 'product-dep-two'])
  mock.setContentArchive('release-product-root', await archive(rootId, 'com.storystudio.family.transaction-root', '1.0.0', dependencies))
  mock.setContentArchive('release-product-dep-one', await archive(dep1Id, 'com.storystudio.family.transaction-dep-one', '1.0.0'))
  mock.setContentArchive('release-product-dep-two', await archive(dep2Id, 'com.storystudio.family.transaction-dep-two', '1.0.0'))

  const local = app()
  const quoted = await request(local).post('/api/content-store/quotes').send({ product_id: 'product-root', release_id: null }).expect(201)
  await request(local).post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)

  return { local, rootId, dep1Id, dep2Id, dep2 }
}

function activationSnapshot(state: Awaited<ReturnType<typeof readContentPackState>>) {
  return Object.fromEntries(Object.entries(state.packs)
    .filter(([, pack]) => pack.active_version !== undefined || pack.discovery_disabled)
    .map(([packId, pack]) => [packId, {
    active_version: pack.active_version, discovery_disabled: pack.discovery_disabled,
  }]))
}

test('keeps every prior activation unchanged when a newly downloaded first dependency is followed by a failed dependency', async () => {
  const { local, dep1Id, dep2 } = await setupClosure()
  const paths = getContentPackRuntimePaths()
  const before = activationSnapshot(await readContentPackState(paths))
  ;(dep2.current_release as Record<string, unknown>).archive_available = false

  await request(local).post('/api/content-store/releases/release-product-root/install').send({}).expect(409)

  const after = await readContentPackState(paths)
  assert.deepEqual(activationSnapshot(after), before)
  assert.equal(after.packs[dep1Id]?.active_version, undefined, 'the first downloaded dependency remains inactive')
})

test('does not activate an already-installed inactive dependency when a later dependency fails', async () => {
  const { local, dep1Id, dep2 } = await setupClosure()
  const paths = getContentPackRuntimePaths()
  await installOwnedContentStoreRelease('release-product-dep-one')
  await mutateContentPackState(state => {
    delete state.packs[dep1Id]!.active_version
  }, paths)
  const before = activationSnapshot(await readContentPackState(paths))
  ;(dep2.current_release as Record<string, unknown>).archive_available = false

  await request(local).post('/api/content-store/releases/release-product-root/install').send({}).expect(409)

  const after = await readContentPackState(paths)
  assert.deepEqual(activationSnapshot(after), before)
  assert.equal(after.packs[dep1Id]?.active_version, undefined)
})

test('keeps the root selection unchanged when the root cannot be committed after every dependency verifies', async () => {
  const { local, rootId, dep1Id } = await setupClosure()
  const paths = getContentPackRuntimePaths()
  await installOwnedContentStoreRelease('release-product-dep-one')
  await installOwnedContentStoreRelease('release-product-dep-two')
  // Reserve an immutable root slot that fails only after this attempt has
  // re-verified the complete dependency closure.
  const state = await readContentPackState(paths)
  const dependency = state.packs[dep1Id]!.versions['1.0.0']!
  state.packs[rootId] = { discovery_disabled: true, versions: {
    '1.0.0': {
      ...dependency,
      manifest: { ...dependency.manifest, pack_id: rootId, version: '1.0.0' },
      install_path: dependency.install_path.replace(dep1Id, rootId),
    archive_sha256: 'f'.repeat(64),
    },
  } }
  await mutateContentPackState(current => { current.packs[rootId] = state.packs[rootId]! }, paths)
  const before = activationSnapshot(await readContentPackState(paths))

  await request(local).post('/api/content-store/releases/release-product-root/install').send({}).expect(500)

  const after = await readContentPackState(paths)
  assert.deepEqual(activationSnapshot(after), before)
})
