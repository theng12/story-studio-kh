/**
 * v1.4.46 — installing a free upgrade, end to end.
 *
 * This is the THIRD attempt at the same bug, and the first two were declared
 * fixed while it still did not work:
 *
 *   1.4.45 taught the delivery attestation to accept a restore receipt, and
 *   the install then failed further in with a generic "Failed to install the
 *   owned Content Pack" — the archive was QUARANTINED as `invalid_archive`
 *   because `verifyGenStudioDeliveryAttestation` still read the receipt in the
 *   purchase shape (`product` + `release` + `bundle_closure`), which a restore
 *   receipt does not have.
 *
 * The lesson is the test, not the fix: a source-level assertion cannot see a
 * quarantined archive. This drives the whole path — publish a successor, offer
 * it as an update, install it — against the mock Store.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

import request from 'supertest'
import express from 'express'

import { router as contentStoreRouter } from '../routes/content-store.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const STARTERS = path.join(ROOT, 'content-packs', 'free-starters')
const KEY = 'gsk_free_upgrade_account'
const ACCOUNT = 'acct_free_upgrade'

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
  await cleanup?.()
  cleanup = undefined
})

function app(): express.Express {
  const instance = express()
  instance.use(express.json({ limit: '10mb' }))
  instance.use('/api', contentStoreRouter)
  return instance
}

test('a free upgrade installs: no purchase receipt exists for it, and none is needed', async () => {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup

  // One real starter pack, built twice: the version he owns and its successor.
  // @ts-expect-error The deterministic publisher is JavaScript-only test tooling.
  const { buildContentPack } = await import('../../../scripts/content-packs/lib.mjs')
  const source = path.join(STARTERS, 'style', (await fs.readdir(path.join(STARTERS, 'style'))).sort()[0]!)
  const pack = JSON.parse(await fs.readFile(path.join(source, 'pack.json'), 'utf8'))

  const ownedArchive = path.join(temporary.dir, 'owned.sspack')
  await buildContentPack({
    sourceDirectory: source, outputPath: ownedArchive,
    minAppVersion: '1.0.0', deliveryProfile: 'genstudio-store-receipt-v1',
  })
  const ownedBytes = new Uint8Array(await fs.readFile(ownedArchive))

  const successorSource = path.join(temporary.dir, 'successor')
  await fs.cp(source, successorSource, { recursive: true })
  const successorPack = { ...pack, version: '1.0.1', changelog: 'The free upgrade.' }
  await fs.writeFile(path.join(successorSource, 'pack.json'), JSON.stringify(successorPack, null, 2))
  const successorArchive = path.join(temporary.dir, 'successor.sspack')
  await buildContentPack({
    sourceDirectory: successorSource, outputPath: successorArchive,
    minAppVersion: '1.0.0', deliveryProfile: 'genstudio-store-receipt-v1',
  })
  const successorBytes = new Uint8Array(await fs.readFile(successorArchive))

  const productId = 'free-upgrade-style'
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY, ACCOUNT)
  mock.setContentAccountCredits(ACCOUNT, 0)
  mock.contentProducts = [{
    product_id: productId,
    entitlement_family: pack.entitlement.family,
    kind: 'visual_style',
    title: pack.pack_id,
    summary: '', description: '',
    publisher_id: 'com.storystudio',
    credit_price: 0, free: true, owned: false, retired: false,
    successor_product_id: null,
    current_release: {
      release_id: 'release-free-upgrade-style',
      pack_id: pack.pack_id,
      version: pack.version,
      archive_sha256: '0'.repeat(64), archive_bytes: 1, archive_available: false,
      min_story_version: '1.0.0', changelog: '', component_summary: {},
    },
    compatible: true, compatibility_reason: null,
    bundle_components: [], owned_component_credit_value: 0,
    showcase_videos: [], cover: null, hero: null, tags: [], license: null, discount: null,
  }]
  mock.setContentArchive('release-free-upgrade-style', ownedBytes)
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', KEY)

  const local = app()

  // Own the version he owns. This one HAS a purchase receipt.
  mock.seedContentProductOwnership(ACCOUNT, productId)
  const owned = await request(local).get('/api/content-store').expect(200)
  const ownedRelease = owned.body.account.owned[0].currentRelease.releaseId
  await request(local).post(`/api/content-store/releases/${ownedRelease}/install`).send({}).expect(200)

  // GenStudio publishes 1.0.1. Ownership is family-level, so it is his for
  // free — and no purchase receipt will ever name it.
  const successor = mock.publishContentSuccessor(productId, '1.0.1', successorBytes)

  const refreshed = await request(local).get('/api/content-store').expect(200)
  const entitlement = refreshed.body.account.owned[0]
  assert.equal(entitlement.currentRelease.releaseId, successor.releaseId)
  assert.equal(entitlement.currentRelease.version, '1.0.1')
  assert.equal(entitlement.installState, 'update_available', 'the Store must offer it')

  // The whole point: this must install.
  const installed = await request(local)
    .post(`/api/content-store/releases/${successor.releaseId}/install`)
    .send({})
    .expect(200)

  assert.equal(installed.body.install.version, '1.0.1')
  assert.equal(installed.body.install.activated, true)

  // And nothing was quarantined on the way — the failure mode 1.4.45 shipped
  // with was a quarantined archive behind a generic error message.
  const quarantine = path.join(temporary.dir, 'content-packs', 'quarantine')
  const quarantined = await fs.readdir(quarantine).catch(() => [] as string[])
  assert.deepEqual(quarantined.filter(name => name.endsWith('.sspack')), [],
    'a free upgrade must verify, not be quarantined as an invalid archive')

  const after = await request(local).get('/api/content-store').expect(200)
  assert.equal(after.body.account.owned[0].installState, 'installed_current')
})
