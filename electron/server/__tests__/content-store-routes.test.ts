import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { readContentStoreCommerceState } from '../content-store/commerce-state.js'
import { readContentPackState } from '../content-packs/state.js'
import { verifyContentPackRuntimeAtBoot } from '../content-packs/recovery.js'
import {
  getGenStudioContentReceipts,
  purchaseGenStudioContentProduct,
  quoteGenStudioContentProduct,
} from '../lib/genstudio-content-store.js'
import { router as contentStoreRouter } from '../routes/content-store.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { useTempDataDir } from './_helpers.js'
import {
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

const KEY_A = 'gsk_content_account_a'
const KEY_A_ROTATED = 'gsk_content_account_a_rotated'
const KEY_B = 'gsk_content_account_b'
const KEY_C = 'gsk_content_account_c'
const HASH = 'a'.repeat(64)

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService

function release(overrides: Record<string, unknown> = {}) {
  return {
    release_id: 'crel_a', pack_id: 'com.storystudio.test', version: '1.0.0',
    archive_sha256: HASH, archive_bytes: 4096, min_story_version: '1.0.834',
    changelog: 'First release.', component_summary: { count: 1 },
    ...overrides,
  }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', kind: 'series_formula',
    title: 'Test Formula', summary: 'A formula.', description: 'Long description.',
    publisher_id: 'com.storystudio', credit_price: 300, free: false, owned: false,
    retired: false, successor_product_id: null, current_release: release(), compatible: true,
    compatibility_reason: null, bundle_components: [], owned_component_credit_value: 0,
    ...overrides,
  }
}

async function asStoreDeliveryArchive(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'))
  manifest.delivery_profile = 'genstudio-store-receipt-v1'
  zip.file('manifest.json', JSON.stringify(manifest))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

function archiveRelease(archive: Uint8Array, overrides: Record<string, unknown> = {}) {
  return release({
    archive_sha256: createHash('sha256').update(archive).digest('hex'), archive_bytes: archive.byteLength,
    ...overrides,
  })
}

function app() {
  const instance = express()
  instance.use(express.json({ limit: '10mb' }))
  instance.use('/api', contentStoreRouter)
  return instance
}

async function setup(options: { products?: Array<Record<string, unknown>>; key?: string } = {}) {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY_A, 'acct_a')
  mock.registerContentStoreKey(KEY_A_ROTATED, 'acct_a')
  mock.registerContentStoreKey(KEY_B, 'acct_b')
  mock.registerContentStoreKey(KEY_C, 'acct_c')
  mock.contentProducts = options.products ?? [product()]
  for (const owned of mock.contentProducts.filter(product => product.owned === true)) {
    mock.seedContentProductOwnership('acct_a', String(owned.product_id))
  }
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', options.key ?? KEY_A)
  return { app: app(), tempDir: temp.dir }
}

function quote(localApp: express.Express) {
  return request(localApp).post('/api/content-store/quotes').send({ product_id: 'cprod_a', release_id: null })
}

afterEach(async () => {
  await mock?.close()
  await cleanup?.()
  cleanup = undefined
})

describe('Content Store commerce routes', () => {
  test('restores same-account ownership and explicitly installs verified bytes without spending credits', async () => {
    const archive = await asStoreDeliveryArchive(await fs.readFile(new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url)))
    const ownedRelease = {
      ...archiveRelease(archive),
      pack_id: 'com.storystudio.pack.free-recovery-test',
      version: '1.0.0',
      archive_available: true,
    }
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      entitlement_family: 'com.storystudio.family.free-recovery-test',
      current_release: ownedRelease,
    })] })
    mock.setContentArchive('crel_a', archive)

    const otherAccountReceipts = await getGenStudioContentReceipts(KEY_B)
    assert.equal(otherAccountReceipts.entitlements.length, 0, 'legacy fixture ownership is seeded to acct_a only')
    const otherAccountQuote = await quoteGenStudioContentProduct(KEY_B, { product_id: 'cprod_a', release_id: null })
    await purchaseGenStudioContentProduct(KEY_B, {
      quoteCanonicalJson: otherAccountQuote.signedQuote.canonicalJson,
      quoteSignature: otherAccountQuote.quoteSignature,
      idempotencyKey: 'legacy-seed-account-b',
    })
    assert.equal((await getGenStudioContentReceipts(KEY_B)).entitlements.length, 1, 'a legacy catalog flag cannot suppress another account grant')
    const purchasePostsBeforeRestore = mock.contentPurchasePostCount

    const restored = await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    assert.equal(restored.body.capabilities.restore, true)
    assert.equal(restored.body.capabilities.receipt_verification, true)
    assert.equal(restored.body.account.owned[0].receiptVerification, 'verified')
    assert.equal(mock.contentPurchasePostCount, purchasePostsBeforeRestore, 'restore sends no purchase for acct_a')
    assert.equal((await readContentStoreCommerceState()).verified_restore?.account_id, 'acct_a')

    await setApiKey('genstudio', KEY_A_ROTATED)
    const installed = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(200)
    assert.equal(installed.body.install.pack_id, 'com.storystudio.pack.free-recovery-test')
    assert.equal(installed.body.install.version, '1.0.0')
    assert.deepEqual(installed.body.overview.installed, [{
      packId: 'com.storystudio.pack.free-recovery-test', version: '1.0.0',
      installState: 'installed_current', missingDependencies: [],
      productId: 'cprod_a', title: 'Test Formula', kind: 'series_formula', ownedByActiveAccount: true,
    }])
    assert.equal(mock.contentDownloadPostCount, 1)
    assert.equal(mock.contentArchiveGetCount, 1)
    const downloadRequest = mock.requests.find(row => row.path === '/v1/content/downloads')
    assert.deepEqual(JSON.parse(downloadRequest?.bodyText || '{}'), {
      entitlement_family: 'com.storystudio.family.free-recovery-test', version: '1.0.0',
    })
    const archiveRequest = mock.requests.find(row => row.path.startsWith('/v1/content/archives/'))
    assert.equal(archiveRequest?.authorization, '')
    const state = await readContentPackState()
    assert.equal(state.packs['com.storystudio.pack.free-recovery-test'].active_version, '1.0.0')
    assert.doesNotMatch(JSON.stringify(installed.body), /receipt_signature|grant_signature|public_key_base64|download_url|"grant"|gsk_|\/Users\//i)

    await setApiKey('genstudio', KEY_C)
    const otherAccount = await request(localApp).get('/api/content-store').expect(200)
    assert.deepEqual(otherAccount.body.account.owned, [])
    assert.equal(otherAccount.body.installed[0].packId, 'com.storystudio.pack.free-recovery-test')
    assert.equal(otherAccount.body.installed[0].ownedByActiveAccount, false)
    await setApiKey('genstudio', KEY_A_ROTATED)

    mock.contentProducts = [product({
      owned: true,
      entitlement_family: 'com.storystudio.family.free-recovery-test',
      current_release: { ...ownedRelease, archive_available: false },
    })]
    const offlineOwned = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(offlineOwned.body.account.owned[0].downloadAvailable, false)
    assert.equal(offlineOwned.body.account.owned[0].installState, 'installed_current')
    assert.equal(offlineOwned.body.account.owned[0].installedVersion, '1.0.0')
  })

  test('reports an incomplete closure, never Installed, when a local Store pack cannot be verified', async () => {
    const archive = await asStoreDeliveryArchive(await fs.readFile(new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url)))
    const ownedRelease = {
      ...archiveRelease(archive),
      pack_id: 'com.storystudio.pack.free-recovery-test',
      version: '1.0.0',
      archive_available: true,
    }
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      entitlement_family: 'com.storystudio.family.free-recovery-test',
      current_release: ownedRelease,
    })] })
    mock.setContentArchive('crel_a', archive)
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    await request(localApp).post('/api/content-store/releases/crel_a/install').send({}).expect(200)

    const state = await readContentPackState()
    const installed = state.packs['com.storystudio.pack.free-recovery-test'].versions['1.0.0']
    await fs.writeFile(path.join(installed.install_path, 'content', 'archive.sspack'), 'damaged')

    const overview = await request(localApp).get('/api/content-store').expect(200)
    const installedState = overview.body.account.owned[0]
    assert.equal(installedState.installState, 'incomplete')
    assert.equal(installedState.installedVersion, '1.0.0')
    assert.deepEqual(installedState.missingDependencies, [])
    assert.doesNotMatch(JSON.stringify(installedState), /archive\.sspack|\/Users\//i)
  })

  test('ordinary overview durably disables a recalled installed version for the next offline boot', async () => {
    const archive = await asStoreDeliveryArchive(await fs.readFile(new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url)))
    const ownedRelease = { ...archiveRelease(archive), pack_id: 'com.storystudio.pack.free-recovery-test', version: '1.0.0', archive_available: true }
    const { app: localApp } = await setup({ products: [product({
      owned: true, entitlement_family: 'com.storystudio.family.free-recovery-test', current_release: ownedRelease,
    })] })
    mock.setContentArchive('crel_a', archive)
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    await request(localApp).post('/api/content-store/releases/crel_a/install').send({}).expect(200)
    mock.contentProducts = [product({
      owned: true, entitlement_family: 'com.storystudio.family.free-recovery-test', current_release: ownedRelease,
      recalled_release_versions: ['1.0.0'],
    })]
    await request(localApp).get('/api/content-store').expect(200)
    const disabled = await readContentPackState()
    const retained = disabled.packs['com.storystudio.pack.free-recovery-test'].versions['1.0.0']
    assert.equal(disabled.packs['com.storystudio.pack.free-recovery-test'].active_version, undefined)
    assert.equal(retained.recalled?.account_id, 'acct_a')
    assert.equal(retained.recalled?.genstudio_origin, mock.baseUrl)
    await verifyContentPackRuntimeAtBoot()
    assert.equal((await readContentPackState()).packs['com.storystudio.pack.free-recovery-test'].active_version, undefined)
  })

  test('does not advertise verified ownership when an original purchase receipt fails signature verification', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_available: true }),
    })] })
    mock.tamperContentPurchaseReceipt = true
    const response = await request(localApp).post('/api/content-store/restore').send({}).expect(500)
    assert.equal((await readContentStoreCommerceState()).verified_restore, undefined)
    assert.doesNotMatch(JSON.stringify(response.body), /signature|receipt|mock-content-key/i)
  })

  test('refuses a Story-incompatible archive before issuing a download grant', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_bytes: 60 * 1024 * 1024, archive_available: true }),
    })] })
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    const response = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(409)
    assert.equal(response.body.code, 'CONTENT_PACK_TOO_LARGE_FOR_THIS_APP')
    assert.equal(mock.contentDownloadPostCount, 0)
    assert.equal(mock.contentArchiveGetCount, 0)
  })

  test('refuses a release requiring a newer Story version before issuing a download grant', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ min_story_version: '999.0.0', archive_available: true }),
    })] })
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    const response = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(409)
    assert.equal(response.body.code, 'CONTENT_PACK_REQUIRES_NEWER_APP')
    assert.match(response.body.detail, /999\.0\.0/)
    assert.equal(mock.contentDownloadPostCount, 0)
    assert.equal(mock.contentArchiveGetCount, 0)
  })

  test('redacts unknown delivery refusals instead of forwarding upstream internals', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_available: true }),
    })] })
    mock.contentDownloadRefusal = {
      status: 503,
      code: 'future_internal_refusal',
      detail: 'private bucket /srv/private/content/archive is unavailable',
    }
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    const response = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(502)
    assert.equal(response.body.code, 'CONTENT_STORE_UPSTREAM_REFUSED')
    assert.doesNotMatch(JSON.stringify(response.body), /future_internal_refusal|private bucket|\/srv\/private|internal_path/i)
  })

  test('preserves an exact release recall as a terminal refusal without retrying delivery', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_available: true }),
    })] })
    mock.contentDownloadRefusal = {
      status: 410,
      code: 'release_recalled',
      detail: 'release 1.0.0 was recalled: unsafe bundled reference',
      recall_reason: 'unsafe bundled reference',
      recalled_at: '2026-08-14T09:00:00Z',
    }
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)

    const response = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(410)

    assert.deepEqual(response.body, {
      code: 'release_recalled',
      detail: 'GenStudio stopped serving this exact Content Pack release. Ownership remains permanent.',
      recall_reason: 'unsafe bundled reference',
      recalled_at: '2026-08-14T09:00:00Z',
      terminal: true,
    })
    assert.equal(mock.contentDownloadPostCount, 1)
    assert.equal(mock.contentArchiveGetCount, 0)
  })

  test('requires a saved key locally and sends no remote request', async () => {
    const { app: localApp } = await setup({ key: '' })
    const response = await request(localApp).get('/api/content-store').expect(400)
    assert.equal(response.body.code, 'CONTENT_STORE_KEY_REQUIRED')
    assert.equal(mock.requests.length, 0)
  })

  test('loads exact account and products with the current Story version and accepts an empty catalog', async () => {
    const { app: localApp } = await setup({ products: [] })
    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(response.body.phase, 'delivery_ready')
    assert.equal(response.body.account.accountId, 'acct_a')
    assert.deepEqual(response.body.products, [])
    assert.doesNotMatch(JSON.stringify(response.body), /canonicalJson|canonicalBytes|\"raw\"/)
    assert.deepEqual(response.body.capabilities, {
      purchase: true, receipt_verification: true, download: true,
      install_after_purchase: true, restore: true,
    })
    assert.equal(mock.requests.filter(row => row.path === '/v1/content/account').length, 1)
    assert.match(mock.requests.find(row => row.path === '/v1/content/products')!.path, /^\/v1\/content\/products$/)
  })

  test('projects only validated catalog merchandising facts and preserves the published shelf/fallback order', async () => {
    const merchandising = {
      cover: { url: 'https://catalog.example.test/covers/test-formula.webp', alt: 'A documented formula cover' },
      hero: { url: 'https://catalog.example.test/heroes/test-formula.webp', alt: 'A documented formula hero' },
      tags: ['documentary', 'archive'],
      license: { label: 'Story Studio Content Pack License', text: 'Customer-facing terms.' },
      discount: {
        discount_id: 'cdsc_test_formula', version: 1, percent: 25,
        starts_on: null, ends_on: '2026-12-31', timezone: 'Asia/Phnom_Penh',
        list_credit_price: 300, discounted_credit_price: 225,
      },
    }
    const fallback = product({
      product_id: 'cprod_fallback', entitlement_family: 'com.storystudio.fallback',
      title: 'Fallback Formula', ...merchandising,
      discount: null,
    })
    const { app: localApp } = await setup({ products: [product(merchandising), fallback] })
    mock.contentShelves = {
      shelves: [{ shelf_id: 'cshf_featured', title: 'Featured', position: 9, product_ids: ['cprod_a'] }],
      fallback_product_ids: ['cprod_fallback'],
    }

    const response = await request(localApp).get('/api/content-store').expect(200)

    assert.deepEqual(response.body.shelves.map((shelf: { productIds: string[] }) => shelf.productIds), [
      ['cprod_a'], ['cprod_fallback'],
    ])
    assert.equal(response.body.products[0].presentation.cover.src, merchandising.cover.url)
    assert.equal(response.body.products[0].presentation.cover.alt, merchandising.cover.alt)
    assert.equal(response.body.products[0].presentation.licenseLabel, merchandising.license.label)
    assert.deepEqual(response.body.products[0].presentation.tags, merchandising.tags)
    assert.deepEqual(response.body.products[0].discount, {
      id: 'cdsc_test_formula', version: 1, percent: 25,
      startsOn: null, endsOn: '2026-12-31', timezone: 'Asia/Phnom_Penh',
      listCreditPrice: 300, discountedCreditPrice: 225,
    })
    assert.doesNotMatch(JSON.stringify(response.body), /Customer-facing terms|test-formula-hero|canonicalJson|canonicalBytes|"raw"/)
    assert.equal(mock.requests.filter(row => row.path === '/v1/content/shelves').length, 1)
  })

  test('shows recalled owned versions beside the newest safe release without changing ownership', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ release_id: 'crel_safe', version: '0.9.0', archive_available: true }),
      recalled_release_versions: ['1.0.0'],
    })] })

    const response = await request(localApp).get('/api/content-store').expect(200)

    assert.equal(response.body.account.owned[0].currentRelease.version, '0.9.0')
    assert.deepEqual(response.body.account.owned[0].recalledReleaseVersions, ['1.0.0'])
    assert.equal(response.body.account.owned[0].entitlementFamily, 'com.storystudio.test')
  })

  test('does not use stale ownership after a content scope failure', async () => {
    const { app: localApp } = await setup()
    await request(localApp).get('/api/content-store').expect(200)
    mock.registerKey('gsk_without_content_scope', [])
    await setApiKey('genstudio', 'gsk_without_content_scope')
    const response = await request(localApp).get('/api/content-store').expect(401)
    assert.match(response.body.detail, /content:read/i)
    assert.equal(response.body.account, undefined)
  })

  test('strictly quotes a catalog product, saves canonical evidence, and never debits', async () => {
    const { app: localApp } = await setup()
    await request(localApp).post('/api/content-store/quotes').send({ product_id: 'cprod_a', release_id: null, extra: true }).expect(400)
    const response = await quote(localApp).expect(201)
    assert.equal(response.body.product_id, 'cprod_a')
    assert.equal(response.body.status, 'quoted')
    assert.equal(response.body.quote_signature, undefined)
    assert.equal(response.body.quote_canonical_json, undefined)
    assert.equal(mock.contentPurchasePostCount, 0)
    const state = await readContentStoreCommerceState()
    assert.equal(state.attempts[response.body.quote_id].quote_canonical_json.includes('future_'), false)
  })

  test('blocks account switching but permits same-account key rotation', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    await setApiKey('genstudio', KEY_B)
    const mismatch = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(409)
    assert.equal(mismatch.body.code, 'CONTENT_PURCHASE_ACCOUNT_MISMATCH')
    assert.equal(mock.contentPurchasePostCount, 0)

    await setApiKey('genstudio', KEY_A_ROTATED)
    const purchased = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(purchased.body.status, 'completed')
    assert.equal(purchased.body.ownership, 'owned_not_installed')
    assert.equal(mock.contentPurchasePostCount, 1)
  })

  test('checks account ownership even for completed cache and hides other-account attempts from overview', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    await request(localApp).post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    await setApiKey('genstudio', KEY_B)
    const overview = await request(localApp).get('/api/content-store').expect(200)
    assert.deepEqual(overview.body.attempts, [])
    await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({})
      .expect(409)
    assert.equal(mock.contentPurchasePostCount, 1)
  })

  test('returns a durable already-submitting claim without a second purchase POST', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    const { beginPurchaseAttempt } = await import('../content-store/commerce-state.js')
    await beginPurchaseAttempt(quoted.body.quote_id, 'acct_a')
    const response = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(response.body.status, 'submitting')
    assert.equal(mock.contentPurchasePostCount, 0)
  })

  test('coalesces concurrent double-clicks into one purchase POST', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.queueContentPurchaseOutcome({ delayMs: 150 })
    const [first, second] = await Promise.all([
      request(localApp).post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}),
      request(localApp).post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}),
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(first.body.status, 'completed')
    assert.equal(second.body.status, 'completed')
    assert.equal(mock.contentPurchasePostCount, 1)
    assert.equal(first.body.idempotency_key, undefined)
  })

  test('classifies a dropped purchase response uncertain and replays only on explicit retry', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.queueContentPurchaseOutcome({ dropResponse: true })
    const uncertain = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(502)
    assert.deepEqual(uncertain.body, {
      code: 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN',
      detail: "Story Studio did not receive GenStudio's answer. No replacement purchase was sent. Retry this exact purchase to replay its saved idempotency key.",
      status: 'uncertain',
    })
    assert.equal(mock.contentPurchasePostCount, 1)
    const before = await readContentStoreCommerceState()
    const key = before.attempts[quoted.body.quote_id].idempotency_key

    const completed = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    const after = await readContentStoreCommerceState()
    assert.equal(after.attempts[quoted.body.quote_id].idempotency_key, key)
    assert.equal(completed.body.status, 'completed')
    assert.equal(mock.contentPurchasePostCount, 2)
  })

  test('preserves a quote after a definitive purchase-scope rejection and allows the same key to retry', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.registerContentStoreKey('gsk_content_read_only', 'acct_a', ['content:read'])
    await setApiKey('genstudio', 'gsk_content_read_only')
    const denied = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(401)
    assert.match(denied.body.detail, /content:purchase/i)
    const preserved = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id]
    assert.equal(preserved.status, 'quoted')
    const idempotencyKey = preserved.idempotency_key

    await setApiKey('genstudio', KEY_A_ROTATED)
    const completed = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(completed.body.status, 'completed')
    assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].idempotency_key, idempotencyKey)
  })

  test('names content:read when purchase account preflight rejects a purchase-only key', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.registerContentStoreKey('gsk_content_purchase_only', 'acct_a', ['content:purchase'])
    await setApiKey('genstudio', 'gsk_content_purchase_only')
    const denied = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(401)
    assert.match(denied.body.detail, /content:read/i)
    assert.doesNotMatch(denied.body.detail, /content:purchase/i)
    assert.equal(mock.contentPurchasePostCount, 0)
    assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].status, 'quoted')
  })

  test('never leaves submitting after a synchronous not-sent purchase and preserves the key', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    const before = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id]
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input, init) => {
      if (String(input).endsWith('/v1/content/purchases')) throw new Error('synchronous fetch refusal')
      return originalFetch(input, init)
    }) as typeof fetch
    try {
      await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(502)
    } finally {
      globalThis.fetch = originalFetch
    }
    const after = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id]
    assert.equal(after.status, 'quoted')
    assert.equal(after.idempotency_key, before.idempotency_key)
  })

  test('marks malformed and unknown purchase refusals uncertain instead of retaining submitting', async () => {
    for (const outcome of [
      { status: 503 as const, rawBody: '{not json' },
      { status: 418 as any, body: { code: 'unexpected', detail: 'unknown response' } },
    ]) {
      const { app: localApp } = await setup()
      const quoted = await quote(localApp).expect(201)
      mock.queueContentPurchaseOutcome(outcome)
      const response = await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(502)
      assert.equal(response.body.status, 'uncertain')
      assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].status, 'uncertain')
      await mock.close()
      await cleanup?.()
      cleanup = undefined
    }
  })

  test('projects only bounded published refusal fields to the renderer', async () => {
    const { app: localApp } = await setup()
    const quoted = await quote(localApp).expect(201)
    mock.queueContentPurchaseOutcome({
      status: 401 as any,
      body: {
        detail: 'authentication required',
        quote_signature: 'must-not-leak',
        canonical_json: '{secret}',
        path: '/Users/private',
      },
    })
    const response = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(401)
    assert.match(response.body.detail, /content:purchase/)
    assert.doesNotMatch(JSON.stringify(response.body), /signature|canonical|\/Users/)
  })

  for (const [status, code, fields] of [
    [402, 'insufficient_credits', { required_credits: 300, available_credits: 100, shortfall_credits: 200 }],
    [404, 'product_unavailable', {}],
    [409, 'quote_rejected', {}],
    [409, 'already_owned', {}],
    [503, 'signing_unavailable', {}],
  ] as const) {
    test(`preserves exact upstream ${status} ${code} refusal`, async () => {
      const { app: localApp } = await setup()
      const quoted = await quote(localApp).expect(201)
      mock.queueContentPurchaseOutcome({ status, body: { code, detail: `${code} detail`, ...fields } })
      const response = await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(status)
      assert.equal(response.body.code, code)
      assert.equal(response.body.detail, `${code} detail`)
      assert.deepEqual({
        required_credits: response.body.required_credits,
        available_credits: response.body.available_credits,
        shortfall_credits: response.body.shortfall_credits,
      }, {
        required_credits: (fields as any).required_credits,
        available_credits: (fields as any).available_credits,
        shortfall_credits: (fields as any).shortfall_credits,
      })
      assert.equal(response.body.status, 'refused')
      assert.equal(mock.contentPurchasePostCount, 1)
      assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].status, 'refused')
    })
  }

  test('returns completed cache without another POST and exposes no receipt/signature/path/secret', async () => {
    const { app: localApp, tempDir } = await setup()
    const quoted = await quote(localApp).expect(201)
    const pathName = `/api/content-store/quotes/${quoted.body.quote_id}/purchase`
    const completed = await request(localApp).post(pathName).send({}).expect(200)
    const cached = await request(localApp).post(pathName).send({}).expect(200)
    assert.deepEqual(cached.body, completed.body)
    assert.equal(mock.contentPurchasePostCount, 1)
    assert.equal(completed.body.credits_charged, 300)
    assert.equal(completed.body.receipt_verification, 'unverified_phase1')
    assert.doesNotMatch(JSON.stringify(completed.body), /signature|canonical|idempotency|gsk_|commerce-state|\/Users\//i)
    assert.deepEqual(await fs.readdir(path.join(tempDir, 'jobs')).catch(() => []), [])
  })

  test('projects GenStudio final purchase balances when the charge settles below the quote ceiling', async () => {
    const { app: localApp } = await setup({ products: [product({ credit_price: 400 })] })
    const quoted = await quote(localApp).expect(201)
    assert.equal(quoted.body.balance_after, 3_600)
    mock.queueContentPurchaseOutcome({
      status: 200,
      body: { credits_charged: 300, discount_credits: 100, balance_before: 4_000, balance_after: 3_700 },
    })

    const completed = await request(localApp)
      .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
    assert.equal(completed.body.credits_charged, 300)
    assert.equal(completed.body.discount_credits, 100)
    assert.equal(completed.body.quoted_credits, 400)
    assert.equal(completed.body.balance_before, 4_000)
    assert.equal(completed.body.balance_after, 3_700)
  })

  for (const refusal of [
    { status: 402 as const, code: 'insufficient_credits', fields: { required_credits: 400, available_credits: 100, shortfall_credits: 300 } },
    { status: 503 as const, code: 'signing_unavailable', fields: {} },
  ]) {
    test(`explicitly retries ${refusal.status} ${refusal.code} with the saved idempotency key`, async () => {
      const { app: localApp } = await setup({ products: [product({ credit_price: 400 })] })
      const quoted = await quote(localApp).expect(201)
      const savedKey = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id].idempotency_key
      mock.queueContentPurchaseOutcome({
        status: refusal.status,
        body: { code: refusal.code, detail: `${refusal.code} detail`, ...refusal.fields },
      })

      await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(refusal.status)
      const refused = (await readContentStoreCommerceState()).attempts[quoted.body.quote_id]
      assert.equal(refused.status, 'refused')
      assert.equal(refused.idempotency_key, savedKey)
      assert.equal(mock.contentPurchasePostCount, 1)

      const completed = await request(localApp)
        .post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)
      assert.equal(completed.body.status, 'completed')
      assert.equal((await readContentStoreCommerceState()).attempts[quoted.body.quote_id].idempotency_key, savedKey)
      assert.equal(mock.contentPurchasePostCount, 2)
    })
  }

  test('bounds quote IDs and local bodies', async () => {
    const { app: localApp } = await setup()
    await request(localApp).post('/api/content-store/quotes').send({ product_id: 'x'.repeat(257), release_id: null }).expect(400)
    await request(localApp).post(`/api/content-store/quotes/${'x'.repeat(257)}/purchase`).send({}).expect(400)
    await request(localApp).post('/api/content-store/quotes').send({
      product_id: 'cprod_a', release_id: null, padding: 'x'.repeat(20_000),
    }).expect(413)
  })

  test('keeps the financial service independent from installer, lifecycle, queue, and admission modules', async () => {
    const serviceSource = await fs.readFile(new URL('../services/content-store.ts', import.meta.url), 'utf8')
    const routeSource = await fs.readFile(new URL('../routes/content-store.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(serviceSource + routeSource, /content-packs\/(?:installer|lifecycle)|job-queue|admission|generation/i)
  })
})
