import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { readContentPackState } from '../content-packs/state.js'
import { resolveCatalogItem } from '../content-packs/registry.js'
import { resolveProjectContentPins, setProjectContentPin } from '../content-packs/project-pins.js'
import { compareVersionStrings } from '../content-packs/version-order.js'
import {
  getGenStudioContentReceipts,
  issueGenStudioContentDownload,
  listGenStudioContentProducts,
  listGenStudioOwnedContentReleases,
} from '../lib/genstudio-content-store.js'
import { router as contentStoreRouter } from '../routes/content-store.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { loadNiche } from '../services/niche-loader.js'
import * as projectManager from '../services/project-manager.js'
import { loadTemplate } from '../services/thumbnail-template-loader.js'
import { loadTopicPack } from '../services/topic-pack-loader.js'
import { loadVisualStyle } from '../services/visual-style-loader.js'
import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const STARTERS = path.join(ROOT, 'content-packs', 'free-starters')
const KEY = 'gsk_free_starter_account'
const ROTATED_KEY = 'gsk_free_starter_account_rotated'
const OTHER_ACCOUNT_KEY = 'gsk_free_starter_other_account'
const ACCOUNT = 'acct_free_starter'
const TEST_KEY_ID = 'com.storystudio.free-starter-test'

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService | undefined
let restorePackagedTrust: (() => void) | undefined

afterEach(async () => {
  restorePackagedTrust?.()
  restorePackagedTrust = undefined
  await mock?.close()
  mock = undefined
  await cleanup?.()
  cleanup = undefined
})

type SourcePack = {
  source: string
  pack: Record<string, any>
  kind: 'series_formula' | 'topic_pack' | 'visual_style' | 'thumbnail_recipe' | 'niche_bundle'
}

async function starterSources(): Promise<SourcePack[]> {
  const baselineByPackId = new Map<string, SourcePack>()
  const kinds = {
    formula: 'series_formula', topic: 'topic_pack', style: 'visual_style', thumbnail: 'thumbnail_recipe', kit: 'niche_bundle',
  } as const
  for (const [folder, kind] of Object.entries(kinds)) {
    for (const name of (await fs.readdir(path.join(STARTERS, folder))).sort()) {
      const source = path.join(STARTERS, folder, name)
      const packPath = path.join(source, 'pack.json')
      const pack = JSON.parse(await fs.readFile(packPath, 'utf8'))
      const candidate = { source, pack, kind }
      const baseline = baselineByPackId.get(pack.pack_id)
      if (!baseline || compareVersionStrings(pack.version, baseline.pack.version) < 0) {
        baselineByPackId.set(pack.pack_id, candidate)
      }
    }
  }
  return [...baselineByPackId.values()]
}

function sourceProduct(source: SourcePack): Record<string, unknown> {
  const pack = source.pack
  return {
    product_id: `starter-${pack.pack_id.slice('com.storystudio.pack.'.length)}`,
    entitlement_family: pack.entitlement.family,
    kind: source.kind,
    title: pack.pack_id,
    summary: String(pack.changelog ?? ''),
    description: String(pack.changelog ?? ''),
    publisher_id: 'com.storystudio',
    credit_price: 0,
    free: true,
    owned: false,
    retired: false,
    successor_product_id: null,
    current_release: {
      release_id: `release-${pack.pack_id.slice('com.storystudio.pack.'.length)}`,
      pack_id: pack.pack_id,
      version: pack.version,
      archive_sha256: '0'.repeat(64),
      archive_bytes: 1,
      archive_available: false,
      min_story_version: '1.0.0',
      changelog: String(pack.changelog ?? ''),
      component_summary: {},
    },
    compatible: true,
    compatibility_reason: null,
    bundle_components: [],
    owned_component_credit_value: 0,
    showcase_videos: [],
    cover: null,
    hero: null,
    tags: [],
    license: null,
    discount: null,
  }
}

function app(): express.Express {
  const instance = express()
  instance.use(express.json({ limit: '10mb' }))
  instance.use('/api', contentStoreRouter)
  return instance
}

async function asStoreDeliveryArchive(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'))
  delete manifest.key_id
  manifest.delivery_profile = 'genstudio-store-receipt-v1'
  zip.file('manifest.json', JSON.stringify(manifest))
  zip.remove('signature.ed25519')
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

/** Test-only packaged resource seam: delivery keeps its production trust lookup. */
async function installTestFirstPartyTrust(tempDir: string, publicKeyPem: string): Promise<() => void> {
  const resourcesPath = path.join(tempDir, 'packaged-resources')
  const recoveryRoot = path.join(resourcesPath, 'content-packs', 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  await fs.writeFile(path.join(recoveryRoot, 'trust-keys.json'), `${JSON.stringify({
    schema_version: 1,
    keys: [{ key_id: TEST_KEY_ID, publisher_id: 'com.storystudio', public_key_pem: publicKeyPem }],
  })}\n`)
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  const cache = require.cache as Record<string, unknown>
  const previousElectron = cache[electronPath]
  const previousResourcesPath = process.resourcesPath
  const previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE
  cache[electronPath] = { exports: { app: { isPackaged: true, getVersion: () => '1.0.841' } } }
  ;(process as { resourcesPath?: string }).resourcesPath = resourcesPath
  delete process.env.ELECTRON_RUN_AS_NODE
  return () => {
    if (previousElectron === undefined) delete cache[electronPath]
    else cache[electronPath] = previousElectron
    ;(process as { resourcesPath?: string }).resourcesPath = previousResourcesPath
    if (previousRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode
  }
}

async function sourceDocumentId(source: SourcePack): Promise<string> {
  const content = path.join(source.source, 'content')
  const files = (await fs.readdir(content)).filter(name => name.endsWith('.json'))
  assert.equal(files.length, 1, `${source.pack.pack_id} has one catalog document`)
  return String(JSON.parse(await fs.readFile(path.join(content, files[0]!), 'utf8')).id)
}

test('free Starter Kits claim, restore, install, and remain usable without a credit balance or network', async () => {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY, ACCOUNT)
  mock.registerContentStoreKey(ROTATED_KEY, ACCOUNT)
  mock.registerContentStoreKey(OTHER_ACCOUNT_KEY, 'acct_free_starter_other')
  mock.setContentAccountCredits(ACCOUNT, 0)
  mock.setContentAccountCredits('acct_free_starter_other', 0)
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', KEY)

  const sources = await starterSources()
  assert.equal(sources.length, 46)
  assert.ok(sources.every(source => source.pack.version === '1.0.0'), 'launch fixture keeps exact 1.0.0 kit dependencies')
  const products = sources.map(sourceProduct)
  mock.contentProducts = products
  const productsByPackId = new Map(products.map(product => [String((product.current_release as Record<string, unknown>).pack_id), product]))
  for (const kit of sources.filter(source => source.kind === 'niche_bundle')) {
    const product = productsByPackId.get(kit.pack.pack_id)!
    const componentProductIds = kit.pack.dependencies.map((dependency: { pack_id: string }) =>
      productsByPackId.get(dependency.pack_id)!.product_id as string)
    const components = kit.pack.bundles[0].components.map((component: { pack_id: string }) => {
      const componentProduct = productsByPackId.get(component.pack_id)!
      return {
        product_id: componentProduct.product_id,
        entitlement_family: componentProduct.entitlement_family,
        title: componentProduct.title,
        kind: componentProduct.kind,
        component_credit_value: 0,
        owned: false,
      }
    })
    product.bundle_components = components
    mock.configureContentBundle(String(product.product_id), componentProductIds)
  }
  await listGenStudioContentProducts(KEY, '1.0.0')

  const project = await projectManager.createProject({ name: 'Pinned before free Starter Kit claim' })
  const projectPath = path.join(temporary.dir, 'projects', project.slug, 'project.json')
  const initialProject = JSON.parse(await fs.readFile(projectPath, 'utf8'))
  initialProject.content_pack_versions = { 'com.storystudio.pack.existing': '4.2.0' }
  await fs.writeFile(projectPath, `${JSON.stringify(initialProject, null, 2)}\n`)

  const local = app()
  const kitProducts = products.filter(product => product.kind === 'niche_bundle')
  for (const product of kitProducts) {
    const quote = await request(local).post('/api/content-store/quotes').send({ product_id: product.product_id, release_id: null }).expect(201)
    assert.equal(quote.body.quoted_credits, 0)
    const claimed = await request(local).post(`/api/content-store/quotes/${quote.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(claimed.body.credits_charged, 0)
    assert.equal(claimed.body.ownership, 'owned_not_installed')
  }
  assert.equal(mock.totalCreditsCharged, 0)
  assert.equal(mock.contentPurchaseCharges.length, 10)
  assert.deepEqual(mock.contentPurchaseCharges, Array(10).fill(0))
  assert.equal(new Set(mock.grantedFamilies).size, mock.grantedFamilies.length)
  assert.equal(mock.familyGrantCount('com.storystudio.family.style.watercolor-storybook'), 1)
  assert.equal(mock.familyGrantCount('com.storystudio.family.thumbnail.centered-hero-headline'), 1)

  const owned = await request(local).get('/api/content-store').expect(200)
  assert.ok(owned.body.account.owned.every((entry: { installState: string }) => entry.installState !== 'installed_current'))
  await setApiKey('genstudio', ROTATED_KEY)
  const restored = await request(local).post('/api/content-store/restore').send({}).expect(200)
  assert.equal(restored.body.account.accountId, ACCOUNT)
  const restoredReceipts = await getGenStudioContentReceipts(ROTATED_KEY)
  assert.equal(restoredReceipts.purchaseReceipts.length, 10)
  assert.deepEqual(restoredReceipts.purchaseReceipts.map(receipt => receipt.creditsCharged), Array(10).fill(0))
  assert.equal(new Set(restoredReceipts.purchaseReceipts.map(receipt => receipt.purchaseId)).size, 10)
  assert.deepEqual(
    restoredReceipts.entitlements.map(entitlement => entitlement.entitlementFamily).sort(),
    restored.body.account.owned.map((entry: { entitlementFamily: string }) => entry.entitlementFamily).sort(),
  )
  await setApiKey('genstudio', OTHER_ACCOUNT_KEY)
  const otherAccount = await request(local).post('/api/content-store/restore').send({}).expect(200)
  assert.equal(otherAccount.body.account.owned.length, 0, 'different account cannot inherit Starter ownership')
  await setApiKey('genstudio', ROTATED_KEY)
  const restoredAfterOtherAccount = await request(local).post('/api/content-store/restore').send({}).expect(200)
  assert.deepEqual(
    restoredAfterOtherAccount.body.account.owned.map((entry: { entitlementFamily: string }) => entry.entitlementFamily).sort(),
    restoredReceipts.entitlements.map(entitlement => entitlement.entitlementFamily).sort(),
    'same-account key rotation restores the exact claimed family set',
  )

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const policy = createContentPackKeyring([{
    keyId: TEST_KEY_ID,
    publisherId: 'com.storystudio',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }])
  const selectedPackIds = new Set([
    'com.storystudio.pack.kit.calm-mind', 'com.storystudio.pack.kit.sleep-journeys',
    ...sources.find(source => source.pack.pack_id === 'com.storystudio.pack.kit.calm-mind')!.pack.dependencies.map((row: { pack_id: string }) => row.pack_id),
    ...sources.find(source => source.pack.pack_id === 'com.storystudio.pack.kit.sleep-journeys')!.pack.dependencies.map((row: { pack_id: string }) => row.pack_id),
  ])
  // @ts-expect-error The deterministic publisher is JavaScript-only test tooling.
  const { buildContentPack } = await import('../../../scripts/content-packs/lib.mjs')
  const keyPath = path.join(temporary.dir, 'free-starter-test-private.pem')
  await fs.writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  for (const source of sources.filter(source => selectedPackIds.has(source.pack.pack_id))) {
    const archivePath = path.join(temporary.dir, `${source.pack.pack_id.split('.').at(-1)}.sspack`)
    await buildContentPack({ sourceDirectory: source.source, privateKeyPath: keyPath, outputPath: archivePath, keyId: TEST_KEY_ID, minAppVersion: '1.0.0' })
    const product = productsByPackId.get(source.pack.pack_id)!
    mock.setContentArchive(
      String((product.current_release as Record<string, unknown>).release_id),
      await asStoreDeliveryArchive(await fs.readFile(archivePath)),
    )
  }
  const calmFamily = String(productsByPackId.get('com.storystudio.pack.kit.calm-mind')!.entitlement_family)
  const otherCatalog = await listGenStudioContentProducts(OTHER_ACCOUNT_KEY, '1.0.0')
  assert.equal(otherCatalog.products.find(product => product.productId === productsByPackId.get('com.storystudio.pack.kit.calm-mind')!.product_id)?.owned, false)
  await assert.rejects(() => listGenStudioOwnedContentReleases(OTHER_ACCOUNT_KEY, calmFamily), /not entitled/i)
  await assert.rejects(() => issueGenStudioContentDownload(OTHER_ACCOUNT_KEY, { entitlementFamily: calmFamily, version: '1.0.0' }), /not entitled/i)

  restorePackagedTrust = await installTestFirstPartyTrust(temporary.dir, publicKey.export({ type: 'spki', format: 'pem' }).toString())
  const deliveryDownloadCount = mock.contentDownloadPostCount
  const deliveryRequestStart = mock.requests.length
  const calmRelease = String((productsByPackId.get('com.storystudio.pack.kit.calm-mind')!.current_release as Record<string, unknown>).release_id)
  const sleepRelease = String((productsByPackId.get('com.storystudio.pack.kit.sleep-journeys')!.current_release as Record<string, unknown>).release_id)
  const calmInstall = await request(local).post(`/api/content-store/releases/${calmRelease}/install`).send({})
  assert.equal(calmInstall.status, 200, JSON.stringify(calmInstall.body))
  await request(local).post(`/api/content-store/releases/${sleepRelease}/install`).send({}).expect(200)
  const installAgain = await request(local).post(`/api/content-store/releases/${calmRelease}/install`).send({}).expect(200)
  assert.equal(installAgain.body.install.pack_id, 'com.storystudio.pack.kit.calm-mind')
  assert.equal(mock.contentDownloadPostCount - deliveryDownloadCount, 9, 'only missing exact kit dependencies download')
  const deliveryRequests = mock.requests.slice(deliveryRequestStart)
  const watercolorDownloads = deliveryRequests.filter(row => row.path === '/v1/content/downloads' && row.bodyText.includes('watercolor-storybook'))
  assert.equal(watercolorDownloads.length, 1, 'shared dependency downloads once')
  const expectedDownloadedPacks = new Set([...selectedPackIds])
  const downloadedFamilies = deliveryRequests
    .filter(row => row.path === '/v1/content/downloads')
    .map(row => String(JSON.parse(row.bodyText).entitlement_family))
  assert.equal(downloadedFamilies.length, 9)
  assert.deepEqual(new Set(downloadedFamilies).size, 9)
  assert.deepEqual(
    new Set(downloadedFamilies),
    new Set([...expectedDownloadedPacks].map(packId => String(productsByPackId.get(packId)!.entitlement_family))),
  )
  const releasedFamilies = new Set(deliveryRequests
    .filter(row => /^\/v1\/content\/entitlements\/[^/]+\/releases$/.test(row.path))
    .map(row => decodeURIComponent(row.path.split('/')[4]!)))
  const expectedReleaseFamilies = new Set([...expectedDownloadedPacks]
    .filter(packId => productsByPackId.get(packId)!.kind !== 'niche_bundle')
    .map(packId => String(productsByPackId.get(packId)!.entitlement_family)))
  assert.deepEqual(
    new Set([...releasedFamilies].filter(family => expectedReleaseFamilies.has(family))),
    expectedReleaseFamilies,
    'delivery reads the exact owned histories for every installed dependency among overview reconciliation calls',
  )
  restorePackagedTrust()
  restorePackagedTrust = undefined
  const state = await readContentPackState(getContentPackRuntimePaths())
  assert.equal(state.packs['com.storystudio.pack.kit.calm-mind']?.active_version, '1.0.0')
  assert.equal(state.packs['com.storystudio.pack.kit.sleep-journeys']?.active_version, '1.0.0')

  const starterProject = await projectManager.createProject({ name: 'Starter closure available offline' })
  const calmClosure = ['com.storystudio.pack.kit.calm-mind', ...sources.find(source => source.pack.pack_id === 'com.storystudio.pack.kit.calm-mind')!.pack.dependencies.map((row: { pack_id: string }) => row.pack_id)]
  for (const packId of calmClosure) {
    const release = productsByPackId.get(packId)!.current_release as Record<string, unknown>
    await setProjectContentPin(starterProject.slug, {
      pack_id: String(release.pack_id), version: String(release.version), archive_sha256: String(release.archive_sha256),
    }, { policy, appVersion: '1.0.0' })
  }

  await mock.close()
  mock = undefined
  const offlineProject = await projectManager.getProject(starterProject.slug)
  assert.ok(offlineProject)
  const pins = await resolveProjectContentPins(offlineProject!, { policy, appVersion: '1.0.0' })
  assert.equal(pins.length, calmClosure.length)
  const offlineOptions = { policy, appVersion: '1.0.0', pins }
  const formula = sources.find(source => source.pack.pack_id === 'com.storystudio.pack.formula.guided-mindfulness')!
  const topic = sources.find(source => source.pack.pack_id === 'com.storystudio.pack.topic.everyday-calm')!
  const style = sources.find(source => source.pack.pack_id === 'com.storystudio.pack.style.watercolor-storybook')!
  const recipe = sources.find(source => source.pack.pack_id === 'com.storystudio.pack.thumbnail.centered-hero-headline')!
  const [formulaId, topicId, styleId, recipeId] = await Promise.all([formula, topic, style, recipe].map(sourceDocumentId))
  for (const id of [formulaId, topicId, styleId, recipeId]) {
    assert.equal((await resolveCatalogItem(id, undefined, offlineOptions))?.source, 'signed-installed')
  }
  assert.equal((await loadNiche(formulaId, offlineOptions))?.id, formulaId)
  assert.equal((await loadTopicPack(topicId, offlineOptions))?.id, topicId)
  assert.equal((await loadVisualStyle(styleId, offlineOptions))?.id, styleId)
  assert.equal((await loadTemplate(recipeId, offlineOptions))?.id, recipeId)
  assert.deepEqual((await projectManager.getProject(project.slug))?.content_pack_versions, { 'com.storystudio.pack.existing': '4.2.0' })
})
