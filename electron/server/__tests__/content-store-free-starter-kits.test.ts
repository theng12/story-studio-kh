import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { createContentPackKeyring } from '../content-packs/keyring.js'
import { installContentPack, verifyInstalledContentPackClosure } from '../content-packs/installer.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { readContentPackState } from '../content-packs/state.js'
import { downloadGenStudioContentArchive, issueGenStudioContentDownload, listGenStudioContentProducts } from '../lib/genstudio-content-store.js'
import { router as contentStoreRouter } from '../routes/content-store.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import * as projectManager from '../services/project-manager.js'
import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const STARTERS = path.join(ROOT, 'content-packs', 'free-starters')
const KEY = 'gsk_free_starter_account'
const ROTATED_KEY = 'gsk_free_starter_account_rotated'
const ACCOUNT = 'acct_free_starter'
const TEST_KEY_ID = 'com.storystudio.free-starter-test'

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService | undefined

afterEach(async () => {
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
  const rows: SourcePack[] = []
  const kinds = {
    formula: 'series_formula', topic: 'topic_pack', style: 'visual_style', thumbnail: 'thumbnail_recipe', kit: 'niche_bundle',
  } as const
  for (const [folder, kind] of Object.entries(kinds)) {
    for (const name of (await fs.readdir(path.join(STARTERS, folder))).sort()) {
      const source = path.join(STARTERS, folder, name)
      const packPath = path.join(source, 'pack.json')
      const pack = JSON.parse(await fs.readFile(packPath, 'utf8'))
      rows.push({ source, pack, kind })
    }
  }
  return rows
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
  }
}

function app(): express.Express {
  const instance = express()
  instance.use(express.json({ limit: '10mb' }))
  instance.use('/api', contentStoreRouter)
  return instance
}

test('free Starter Kits claim, restore, install, and remain usable without a credit balance or network', async () => {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY, ACCOUNT)
  mock.registerContentStoreKey(ROTATED_KEY, ACCOUNT)
  mock.setContentAccountCredits(ACCOUNT, 0)
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', KEY)

  const sources = await starterSources()
  assert.equal(sources.length, 46)
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
    mock.setContentArchive(String((product.current_release as Record<string, unknown>).release_id), await fs.readFile(archivePath))
  }

  const installed = new Set<string>()
  async function installExplicit(packId: string): Promise<void> {
    if (installed.has(packId)) return
    const product = productsByPackId.get(packId)!
    const release = product.current_release as Record<string, unknown>
    const grant = await issueGenStudioContentDownload(ROTATED_KEY, {
      entitlementFamily: String(product.entitlement_family), version: String(release.version),
    })
    const archive = await downloadGenStudioContentArchive(grant.downloadUrl, {
      archiveSha256: String(release.archive_sha256), archiveBytes: Number(release.archive_bytes),
    })
    const source = sources.find(candidate => candidate.pack.pack_id === packId)!
    for (const dependency of source.pack.dependencies ?? []) await installExplicit(dependency.pack_id)
    await installContentPack({ archiveBytes: archive, source: 'genstudio-store', expectedPackId: packId, expectedVersion: String(release.version) }, { policy, appVersion: '1.0.0' })
    installed.add(packId)
  }

  await installExplicit('com.storystudio.pack.kit.calm-mind')
  await installExplicit('com.storystudio.pack.kit.sleep-journeys')
  assert.equal(mock.contentDownloadPostCount, 9, 'only missing exact kit dependencies download')
  const watercolorDownloads = mock.requests.filter(row => row.path === '/v1/content/downloads' && row.bodyText.includes('watercolor-storybook'))
  assert.equal(watercolorDownloads.length, 1, 'shared dependency downloads once')
  const state = await readContentPackState(getContentPackRuntimePaths())
  await verifyInstalledContentPackClosure(state, 'com.storystudio.pack.kit.calm-mind', '1.0.0', policy)
  await verifyInstalledContentPackClosure(state, 'com.storystudio.pack.kit.sleep-journeys', '1.0.0', policy)

  await mock.close()
  const offlineState = await readContentPackState(getContentPackRuntimePaths())
  await verifyInstalledContentPackClosure(offlineState, 'com.storystudio.pack.kit.calm-mind', '1.0.0', policy)
  assert.deepEqual((await projectManager.getProject(project.slug))?.content_pack_versions, { 'com.storystudio.pack.existing': '4.2.0' })
})
