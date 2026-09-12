import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  GenStudioContentStoreApiError,
  downloadGenStudioContentArchive,
  getGenStudioContentPublicKey,
  getGenStudioContentReceipts,
  issueGenStudioContentDownload,
  listGenStudioOwnedContentReleases,
  parseContentStoreCatalog,
  parseContentStoreDownloadGrant,
  parseContentStorePurchase,
  parseContentStorePublicKey,
  parseContentStoreReceipts,
  parseOwnedContentReleases,
} from '../lib/genstudio-content-store.js'
import {
  verifyContentStoreDownloadGrant,
  verifyContentStorePurchase,
  verifyContentStoreRestore,
  verifyContentStoreRestoreReceipt,
} from '../lib/genstudio-content-store-trust.js'
import { bindRootClosure, resolveOwnedContentStoreDependency } from '../services/content-store-delivery.js'
import { useTempDataDir } from './_helpers.js'

const HASH = 'a'.repeat(64)
const KEY_ID = 'content-store-test-1'
const keyPair = generateKeyPairSync('ed25519')
const publicDer = keyPair.publicKey.export({ format: 'der', type: 'spki' })
const PUBLIC_KEY_BASE64 = publicDer.subarray(publicDer.byteLength - 32).toString('base64')
const historicalKeyPair = generateKeyPairSync('ed25519')
const historicalPublicDer = historicalKeyPair.publicKey.export({ format: 'der', type: 'spki' })
const HISTORICAL_KEY_BASE64 = historicalPublicDer.subarray(historicalPublicDer.byteLength - 32).toString('base64')

function recursivelyCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(recursivelyCanonical).join(',')}]`
  const row = value as Record<string, unknown>
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${recursivelyCanonical(row[key])}`).join(',')}}`
}

function signature(payload: Record<string, unknown>): string {
  return sign(null, Buffer.from(recursivelyCanonical(payload), 'utf8'), keyPair.privateKey).toString('base64')
}

function historicalSignature(payload: Record<string, unknown>): string {
  return sign(null, Buffer.from(recursivelyCanonical(payload), 'utf8'), historicalKeyPair.privateKey).toString('base64')
}

function publicKey(overrides: Record<string, unknown> = {}) {
  return {
    key_id: KEY_ID,
    algorithm: 'ed25519',
    public_key_base64: PUBLIC_KEY_BASE64,
    payload_types: [
      'genstudio.content.download.v1',
      'genstudio.content.quote.v1',
      'genstudio.content.receipt.v1',
      'genstudio.content.restore.v1',
    ],
    canonicalization: 'json:sorted-keys,no-whitespace,utf-8',
    ...overrides,
  }
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    release_id: 'crel_a',
    pack_id: 'com.storystudio.test',
    version: '1.0.0',
    archive_sha256: HASH,
    archive_bytes: 18,
    min_story_version: '1.0.839',
    changelog: 'First release.',
    component_summary: { ideas: 500 },
    ...overrides,
  }
}

function restorePayload(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'genstudio.content.restore.v1',
    key_id: KEY_ID,
    receipt_id: 'crst_a',
    account_id: 'acct_a',
    content_account_id: 'acct_a',
    entitlement_families: ['com.storystudio.test'],
    entitlements: [{
      entitlement_family: 'com.storystudio.test', product_id: 'cprod_a', title: 'Test Formula',
      kind: 'series_formula', granted_at: '2026-08-14T09:12:44Z', purchase_id: 'cpur_a',
    }],
    releases: [{
      entitlement_family: 'com.storystudio.test', release_id: 'crel_a', pack_id: 'com.storystudio.test',
      version: '1.0.0', archive_sha256: HASH, archive_bytes: 18, min_story_version: '1.0.839',
    }],
    issued_at: '2026-08-14T10:03:11Z',
    expiry_policy: {
      ownership: 'permanent', receipt_expires_at: null,
      refresh_recommended_after: '2026-09-13T10:03:11Z',
    },
    ...overrides,
  }
}

function purchasePayload(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'genstudio.content.receipt.v1', key_id: KEY_ID, receipt_id: 'crc_a', purchase_id: 'cpur_a', quote_id: 'cq_test',
    account_id: 'acct_a', entitlement_families: ['com.storystudio.test'],
    granted_families: ['com.storystudio.test'], previously_owned_families: [], bundle_closure: [],
    base_credit_price: 250, component_discount_credits: 0,
    operator_discount: null, operator_discount_credits: 0,
    product: { product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', kind: 'series_formula' },
    release: release(), credits_charged: 250, issued_at: '2026-08-14T09:12:44Z',
    ...overrides,
  }
}

function receipts(overrides: Record<string, unknown> = {}) {
  const restore = restorePayload()
  const purchase = purchasePayload()
  return {
    account_id: 'acct_a',
    content_account_id: 'acct_a',
    restore_receipt: { receipt: restore, receipt_signature: signature(restore), key_id: KEY_ID },
    purchase_receipts: [{
      purchase_id: 'cpur_a', receipt: purchase, receipt_signature: signature(purchase), key_id: KEY_ID,
      credits_charged: 250, created_at: '2026-08-14T09:12:44Z',
    }],
    entitlements: [{
      entitlement_id: 'cent_a', entitlement_family: 'com.storystudio.test', product_id: 'cprod_a',
      title: 'Test Formula', kind: 'series_formula', publisher_id: 'com.storystudio',
      granted_at: '2026-08-14T09:12:44Z', purchase_id: 'cpur_a', retired: false,
      current_release: release({ archive_available: true }), download_available: true,
    }],
    ...overrides,
  }
}

function purchaseResponse() {
  const payload = purchasePayload()
  return {
    purchase_id: 'cpur_a', account_id: 'acct_a', credits_charged: 250, discount_credits: 0,
    base_credit_price: 250, component_discount_credits: 0,
    operator_discount: null, operator_discount_credits: 0,
    balance_before: 1000, balance_after: 750, entitlement_ids: ['cent_a'],
    entitlement_families: ['com.storystudio.test'], granted_families: ['com.storystudio.test'],
    previously_owned_families: [], bundle_closure: [], product: payload.product, release: payload.release,
    ledger_event_key: 'content-purchase:cpur_a',
    receipt: { receipt: payload, receipt_signature: signature(payload), key_id: KEY_ID },
    replayed: false,
  }
}

function grantPayload(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'genstudio.content.download.v1', key_id: KEY_ID, grant_id: 'cdg_a', account_id: 'acct_a',
    product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', release_id: 'crel_a',
    pack_id: 'com.storystudio.test', version: '1.0.0', archive_sha256: HASH, archive_bytes: 18,
    issued_at: '2026-08-14T10:03:11Z', expires_at: '2026-08-14T10:18:11Z',
    ...overrides,
  }
}

function grant(overrides: Record<string, unknown> = {}) {
  const payload = grantPayload()
  return {
    grant_id: 'cdg_a', account_id: 'acct_a', product_id: 'cprod_a',
    entitlement_family: 'com.storystudio.test', release_id: 'crel_a', pack_id: 'com.storystudio.test',
    version: '1.0.0', archive_sha256: HASH, archive_bytes: 18,
    download_url: 'https://objects.example.test/opaque?grant=secret',
    expires_at: '2026-08-14T10:18:11Z', ttl_seconds: 900,
    grant: payload, grant_signature: signature(payload), key_id: KEY_ID,
    ...overrides,
  }
}

function ownedReleases(overrides: Record<string, unknown> = {}) {
  return {
    entitlement_family: 'com.storystudio.test', entitlement_id: 'cent_a', product_id: 'cprod_a',
    title: 'Test Formula', kind: 'series_formula', publisher_id: 'com.storystudio',
    granted_at: '2026-08-14T09:12:44Z', retired: false, current_release_id: 'crel_b',
    releases: [
      release({ release_id: 'crel_b', version: '2.0.0', archive_available: true,
        state: 'published', published_at: '2026-08-14T10:00:00Z', current: true }),
      release({ release_id: 'crel_a', version: '1.0.0', archive_available: true,
        state: 'withdrawn', published_at: '2026-07-14T10:00:00Z', current: false }),
    ],
    ...overrides,
  }
}

describe('GenStudio Content Store 1.6 delivery trust boundary', () => {
  test('defaults archive_available to false and preserves a published true value', () => {
    const base = {
      product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', kind: 'series_formula',
      title: 'Test', summary: '', description: '', publisher_id: 'com.storystudio', credit_price: 0,
      free: true, owned: true, retired: false, successor_product_id: null, compatible: true,
      compatibility_reason: null, bundle_components: [], owned_component_credit_value: 0,
      cover: null, hero: null, tags: [], license: null, discount: null,
    }
    const parsed = parseContentStoreCatalog({ products: [
      { ...base, current_release: release() },
      { ...base, product_id: 'cprod_b', current_release: release({ archive_available: true }) },
    ] })
    assert.equal(parsed.products[0].currentRelease?.archiveAvailable, false)
    assert.equal(parsed.products[1].currentRelease?.archiveAvailable, true)
    assert.throws(() => parseContentStoreCatalog({ products: [{
      ...base,
      current_release: release({ archive_bytes: 128 * 1024 * 1024 + 1 }),
    }] }), /archive_bytes|128|limit/i)
  })

  test('accepts only the published Ed25519 public-key contract', () => {
    const parsed = parseContentStorePublicKey(publicKey())
    assert.equal(parsed.keyId, KEY_ID)
    assert.equal(parsed.publicKeyBytes.byteLength, 32)
    assert.throws(() => parseContentStorePublicKey(publicKey({ algorithm: 'rsa' })), /algorithm|ed25519/i)
    assert.throws(() => parseContentStorePublicKey(publicKey({ canonicalization: 'json' })), /canonical/i)
    assert.throws(() => parseContentStorePublicKey(publicKey({ public_key_base64: 'not base64!' })), /base64|public key/i)
    assert.throws(() => parseContentStorePublicKey(publicKey({ payload_types: ['genstudio.content.receipt.v1'] })), /payload_types/i)
    assert.throws(() => parseContentStorePublicKey(publicKey({
      payload_types: [...publicKey().payload_types as string[], 'genstudio.content.future.v1'],
    })), /payload_types/i)
  })

  test('parses the current-first keyring and verifies historical receipts by their signed key id', () => {
    const keyring = parseContentStorePublicKey(publicKey({ keys: [
      { key_id: KEY_ID, algorithm: 'ed25519', public_key_base64: PUBLIC_KEY_BASE64, current: true },
      { key_id: 'content-store-test-old', algorithm: 'ed25519', public_key_base64: HISTORICAL_KEY_BASE64, current: false },
    ] }))
    assert.deepEqual(keyring.keys.map(key => [key.keyId, key.current]), [
      [KEY_ID, true], ['content-store-test-old', false],
    ])

    const response = receipts()
    const historical = purchasePayload({ key_id: 'content-store-test-old' })
    response.purchase_receipts[0] = {
      purchase_id: 'cpur_a', receipt: historical, receipt_signature: historicalSignature(historical),
      key_id: 'content-store-test-old', credits_charged: 250, created_at: '2026-08-14T09:12:44Z',
    }
    verifyContentStoreRestore(keyring, parseContentStoreReceipts(response), 'acct_a')
  })

  test('caches the key that signed the restore receipt instead of assuming the current key', async () => {
    const source = await readFile(new URL('../services/content-store-delivery.ts', import.meta.url), 'utf8')
    assert.match(source, /keys\.find\([^\n]+restoreReceipt\.keyId/)
    assert.match(source, /key_id: restoreSigningKey\.keyId/)
    assert.match(source, /public_key_base64: restoreSigningKey\.publicKeyBase64/)
  })

  test('fails closed on unknown receipt keys and malformed keyring current-key invariants', () => {
    const validKeys = [
      { key_id: KEY_ID, algorithm: 'ed25519', public_key_base64: PUBLIC_KEY_BASE64, current: true },
      { key_id: 'content-store-test-old', algorithm: 'ed25519', public_key_base64: HISTORICAL_KEY_BASE64, current: false },
    ]
    const keyring = parseContentStorePublicKey(publicKey({ keys: validKeys }))
    const response = receipts()
    const unknown = purchasePayload({ key_id: 'unknown-key' })
    response.purchase_receipts[0] = {
      purchase_id: 'cpur_a', receipt: unknown, receipt_signature: signature(unknown), key_id: 'unknown-key',
      credits_charged: 250, created_at: '2026-08-14T09:12:44Z',
    }
    assert.throws(() => verifyContentStoreRestore(keyring, parseContentStoreReceipts(response), 'acct_a'), /unknown|key_id|trusted/i)
    assert.throws(() => parseContentStorePublicKey(publicKey({ keys: [...validKeys].reverse() })), /current|first/i)
    assert.throws(() => parseContentStorePublicKey(publicKey({ keys: validKeys.map(key => ({ ...key, current: false })) })), /current/i)
    assert.throws(() => parseContentStorePublicKey(publicKey({ keys: [validKeys[0], validKeys[0]] })), /duplicate|key_id/i)
  })

  test('keeps retired keys verify-only and refuses a new download grant signed by one', () => {
    const keyring = parseContentStorePublicKey(publicKey({ keys: [
      { key_id: KEY_ID, algorithm: 'ed25519', public_key_base64: PUBLIC_KEY_BASE64, current: true },
      { key_id: 'content-store-test-old', algorithm: 'ed25519', public_key_base64: HISTORICAL_KEY_BASE64, current: false },
    ] }))
    const payload = grantPayload({ key_id: 'content-store-test-old' })
    const parsed = parseContentStoreDownloadGrant(grant({
      grant: payload, grant_signature: historicalSignature(payload), key_id: 'content-store-test-old',
    }))
    assert.throws(() => verifyContentStoreDownloadGrant(keyring, parsed, {
      accountId: 'acct_a', productId: 'cprod_a', entitlementFamily: 'com.storystudio.test',
      releaseId: 'crel_a', packId: 'com.storystudio.test', version: '1.0.0',
      archiveSha256: HASH, archiveBytes: 18,
    }, new Date('2026-08-14T10:10:00Z')), /current|retired|verify-only/i)
  })

  // Sized from the real account on 2026-08-25, the day the store went dark:
  // 82 owned packs and 38 purchase receipts, which canonicalises to 5,644 JSON
  // nodes. The node cap was 4,096, so `GET /v1/content/receipts` threw inside
  // canonicalJson and every surface -- Discover, Owned, Installed, Updates --
  // reported zero. This test is that payload, and it fails against any cap
  // below the real library's size.
  const OWNED_PACKS = 82
  const PURCHASES = 38

  function fullLibraryReceipts() {
    const family = (index: number) => `com.storystudio.pack.${String(index).padStart(3, '0')}`
    const owned = Array.from({ length: OWNED_PACKS }, (_unused, index) => ({
      entitlement_family: family(index),
      product_id: `cprod_${String(index).padStart(3, '0')}`,
      title: `Owned Pack ${index}`,
      kind: 'topic_pack',
      granted_at: '2026-08-25T09:12:44Z',
      purchase_id: index < PURCHASES ? `cpur_${String(index).padStart(3, '0')}` : null,
    }))
    const releases = owned.map((row, index) => ({
      entitlement_family: row.entitlement_family,
      release_id: `crel_${String(index).padStart(3, '0')}`,
      pack_id: row.entitlement_family,
      version: '1.0.0',
      archive_sha256: HASH,
      archive_bytes: 18,
      min_story_version: '1.0.839',
    }))
    const restore = restorePayload({
      entitlement_families: owned.map(row => row.entitlement_family),
      entitlements: owned,
      releases,
    })
    return {
      account_id: 'acct_a',
      content_account_id: 'acct_a',
      restore_receipt: { receipt: restore, receipt_signature: signature(restore), key_id: KEY_ID },
      purchase_receipts: owned.slice(0, PURCHASES).map((row, index) => {
        const payload = purchasePayload({
          receipt_id: `crc_${String(index).padStart(3, '0')}`,
          purchase_id: row.purchase_id,
          quote_id: `cq_${String(index).padStart(3, '0')}`,
          entitlement_families: [row.entitlement_family],
          granted_families: [row.entitlement_family],
          product: {
            product_id: row.product_id, entitlement_family: row.entitlement_family, kind: 'topic_pack',
            title: row.title, summary: 'An owned pack.', credit_price: 250, publisher_id: 'com.storystudio',
          },
          // Real receipts for kits pin their components; an all-empty closure
          // would make the fixture smaller than the payload it stands in for.
          bundle_closure: Array.from({ length: 2 }, (_pin, position) => ({
            position,
            product_id: `cprod_component_${index}_${position}`,
            entitlement_family: `${row.entitlement_family}.component.${position}`,
            release_id: `crel_component_${index}_${position}`,
            version: '1.0.0',
            archive_sha256: HASH,
          })),
          release: release({
            release_id: releases[index].release_id,
            pack_id: releases[index].pack_id,
          }),
        })
        return {
          purchase_id: row.purchase_id, receipt: payload, receipt_signature: signature(payload),
          key_id: KEY_ID, credits_charged: 250, created_at: '2026-08-25T09:12:44Z',
        }
      }),
      entitlements: owned.map((row, index) => ({
        entitlement_id: `cent_${String(index).padStart(3, '0')}`,
        entitlement_family: row.entitlement_family,
        product_id: row.product_id,
        title: row.title,
        kind: row.kind,
        publisher_id: 'com.storystudio',
        granted_at: row.granted_at,
        purchase_id: row.purchase_id,
        retired: false,
        current_release: release({
          release_id: releases[index].release_id,
          pack_id: releases[index].pack_id,
          archive_available: true,
        }),
        download_available: true,
        recalled_release_versions: [],
        showcase_videos: [],
      })),
    }
  }

  function jsonNodes(value: unknown): number {
    if (Array.isArray(value)) return value.reduce<number>((total, entry) => total + jsonNodes(entry), 1)
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).reduce<number>((total, entry) => total + jsonNodes(entry), 1)
    }
    return 1
  }

  test('parses and verifies a whole owned library, not just a payload that fits an old cap', () => {
    const response = fullLibraryReceipts()
    // Guard the fixture itself: if it ever shrinks below the cap that broke the
    // store, the test stops testing anything.
    const nodes = jsonNodes(response)
    assert.ok(nodes > 4_096, `restore fixture must exceed the old 4,096-node cap, measured ${nodes}`)
    assert.ok(nodes >= 5_000 && nodes <= 7_000, `restore fixture must stay near the measured 5,644 nodes, got ${nodes}`)

    const parsed = parseContentStoreReceipts(response)
    assert.equal(parsed.entitlements.length, OWNED_PACKS)
    assert.equal(parsed.purchaseReceipts.length, PURCHASES)
    // The signed evidence still has to verify at this size -- raising a parsing
    // bound must not buy the library back by loosening what proves it is owned.
    verifyContentStoreRestore(parseContentStorePublicKey(publicKey()), parsed, 'acct_a')
    assert.throws(() => verifyContentStoreRestore(parseContentStorePublicKey(publicKey()), parsed, 'acct_other'), /account/i)
  })

  test('verifies restore and original purchase receipts against the owning account', () => {
    const key = parseContentStorePublicKey(publicKey())
    const parsed = parseContentStoreReceipts(receipts())
    verifyContentStoreRestore(key, parsed, 'acct_a')
    assert.equal(parsed.entitlements[0].currentRelease?.archiveAvailable, true)
    assert.equal(parsed.entitlements[0].downloadAvailable, true)

    assert.throws(() => verifyContentStoreRestore(key, parsed, 'acct_other'), /account/i)
    const original = receipts()
    const tampered = parseContentStoreReceipts(receipts({ restore_receipt: {
      ...original.restore_receipt,
      receipt: { ...original.restore_receipt.receipt as Record<string, unknown>, future_fact: 'tampered' },
    } }))
    assert.throws(() => verifyContentStoreRestore(key, tampered, 'acct_a'), /signature|match|entitlement/i)
  })

  test('parses canonical entitlement showcase videos and defaults a pre-1.7 entitlement to none', () => {
    const video = {
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ', title: 'A vertical example', description: 'Published by GenStudio.',
    }
    const withVideo = receipts()
    ;(withVideo.entitlements as Array<Record<string, unknown>>)[0] = {
      ...withVideo.entitlements[0], showcase_videos: [video],
    }
    assert.deepEqual(parseContentStoreReceipts(withVideo).entitlements[0].showcaseVideos, [video])
    assert.deepEqual(parseContentStoreReceipts(receipts()).entitlements[0].showcaseVideos, [])
  })

  test('preserves recalled release versions without changing permanent ownership', () => {
    const response = receipts()
    ;(response.entitlements as Array<Record<string, unknown>>)[0] = {
      ...response.entitlements[0],
      recalled_release_versions: ['1.1.0', '2.0.0'],
    }
    const entitlement = parseContentStoreReceipts(response).entitlements[0]
    assert.deepEqual(entitlement.recalledReleaseVersions, ['1.1.0', '2.0.0'])
    assert.equal(entitlement.currentRelease?.version, '1.0.0')
    assert.equal(entitlement.downloadAvailable, true)
    assert.deepEqual(parseContentStoreReceipts(receipts()).entitlements[0].recalledReleaseVersions, [])

    const malformed = receipts()
    ;(malformed.entitlements as Array<Record<string, unknown>>)[0] = {
      ...malformed.entitlements[0],
      recalled_release_versions: ['1.1.0', 2],
    }
    assert.throws(() => parseContentStoreReceipts(malformed), /recalled_release_versions\[1\]/i)
  })

  test('re-canonicalises parsed receipt values at verification time', () => {
    const key = parseContentStorePublicKey(publicKey())
    const parsed = parseContentStoreReceipts(receipts())
    parsed.restoreReceipt.signedReceipt.value.future_fact = 'changed after parsing'
    assert.throws(() => verifyContentStoreRestore(key, parsed, 'acct_a'), /canonical|signature|payload/i)
  })

  test('re-verifies cached restore evidence without an unsigned response envelope', () => {
    const key = parseContentStorePublicKey(publicKey())
    const cached = parseContentStoreReceipts(receipts()).restoreReceipt
    assert.equal(verifyContentStoreRestoreReceipt(key, cached, 'acct_a').value.receipt_id, 'crst_a')
    assert.throws(() => verifyContentStoreRestoreReceipt(key, cached, 'acct_other'), /account/i)

    cached.signedReceipt.value.future_fact = 'tampered offline'
    assert.throws(() => verifyContentStoreRestoreReceipt(key, cached, 'acct_a'), /canonical|signature/i)
  })

  test('verifies the immediate purchase receipt before it is trusted or cached', () => {
    const key = parseContentStorePublicKey(publicKey())
    const purchase = parseContentStorePurchase(purchaseResponse())
    verifyContentStorePurchase(key, purchase, 'acct_a')
    assert.throws(() => verifyContentStorePurchase(key, purchase, 'acct_other'), /account/i)
    purchase.receipt.signedReceipt.value.future_fact = 'tampered after purchase'
    assert.throws(() => verifyContentStorePurchase(key, purchase, 'acct_a'), /canonical|signature/i)
  })

  test('rejects wrong signed types, key ids, envelope drift, and malformed restore facts', () => {
    const wrongType = receipts()
    const payload = restorePayload({ typ: 'genstudio.content.receipt.v1' })
    wrongType.restore_receipt = { receipt: payload, receipt_signature: signature(payload), key_id: KEY_ID }
    assert.throws(() => parseContentStoreReceipts(wrongType), /typ|restore/i)

    const wrongKey = receipts()
    wrongKey.restore_receipt = { ...wrongKey.restore_receipt, key_id: 'other-key' }
    assert.throws(() => parseContentStoreReceipts(wrongKey), /key/i)

    assert.throws(() => parseContentStoreReceipts(receipts({ content_account_id: 'acct_other' })), /account/i)
    assert.throws(() => parseContentStoreReceipts(receipts({
      entitlements: [{ ...receipts().entitlements[0], download_available: true, current_release: null }],
    })), /download|release/i)
  })

  test('verifies a short-lived grant against every expected immutable release fact', () => {
    const key = parseContentStorePublicKey(publicKey())
    const parsed = parseContentStoreDownloadGrant(grant())
    verifyContentStoreDownloadGrant(key, parsed, {
      accountId: 'acct_a', productId: 'cprod_a', entitlementFamily: 'com.storystudio.test',
      releaseId: 'crel_a', packId: 'com.storystudio.test', version: '1.0.0',
      archiveSha256: HASH, archiveBytes: 18,
    }, new Date('2026-08-14T10:10:00Z'))

    assert.throws(() => verifyContentStoreDownloadGrant(key, parsed, {
      accountId: 'acct_other', productId: 'cprod_a', entitlementFamily: 'com.storystudio.test',
      releaseId: 'crel_a', packId: 'com.storystudio.test', version: '1.0.0',
      archiveSha256: HASH, archiveBytes: 18,
    }, new Date('2026-08-14T10:10:00Z')), /account/i)
    assert.throws(() => verifyContentStoreDownloadGrant(key, parsed, {
      accountId: 'acct_a', productId: 'cprod_a', entitlementFamily: 'com.storystudio.test',
      releaseId: 'crel_a', packId: 'com.storystudio.test', version: '1.0.0',
      archiveSha256: HASH, archiveBytes: 18,
    }, new Date('2026-08-14T10:18:11Z')), /expired/i)
    assert.throws(() => parseContentStoreDownloadGrant(grant({ release_id: 'crel_other' })), /release_id|match/i)

    const upstreamBytes = 60 * 1024 * 1024
    const largePayload = grantPayload({ archive_bytes: upstreamBytes })
    const upstreamValid = parseContentStoreDownloadGrant(grant({
      archive_bytes: upstreamBytes,
      grant: largePayload,
      grant_signature: signature(largePayload),
    }))
    assert.equal(upstreamValid.archiveBytes, upstreamBytes)
  })

  test('parses published, withdrawn, and terminal recalled release states exactly', () => {
    const recalledAt = '2026-08-14T10:30:00Z'
    const reason = 'Unsafe bundled reference image detected.'
    const withRecall = ownedReleases({
      releases: [
        ...ownedReleases().releases,
        release({
          release_id: 'crel_recalled', version: '1.1.0', archive_available: false,
          state: 'recalled', published_at: '2026-08-01T10:00:00Z', current: false,
          recalled_at: recalledAt, recall_reason: reason,
        }),
      ],
    })
    const recalled = parseOwnedContentReleases(withRecall).releases[2]!
    assert.equal(recalled.state, 'recalled')
    assert.equal(recalled.current, false)
    assert.equal(recalled.recalledAt, recalledAt)
    assert.equal(recalled.recallReason, reason)

    const parsed = parseOwnedContentReleases(ownedReleases())
    assert.equal(parsed.currentReleaseId, 'crel_b')
    assert.deepEqual(parsed.releases.map(item => [item.version, item.state, item.current]), [
      ['2.0.0', 'published', true], ['1.0.0', 'withdrawn', false],
    ])
    assert.throws(() => parseOwnedContentReleases(ownedReleases({
      releases: [release({ ...ownedReleases().releases[0], state: 'draft' })],
    })), /state|published|withdrawn|recalled/i)
    assert.throws(() => parseOwnedContentReleases(ownedReleases({
      current_release_id: 'crel_recalled',
      releases: [release({
        release_id: 'crel_recalled', archive_available: false, state: 'recalled',
        published_at: '2026-08-01T10:00:00Z', current: true,
        recalled_at: recalledAt, recall_reason: reason,
      })],
    })), /recalled.*current|current.*recalled/i)
    assert.throws(() => parseOwnedContentReleases(ownedReleases({
      releases: [release({
        ...ownedReleases().releases[0], state: 'recalled', current: false,
        recalled_at: null, recall_reason: null,
      })],
      current_release_id: null,
    })), /recall_reason|recalled_at/i)
  })
})

describe('GenStudio Content Store 1.6 delivery client', () => {
  let restoreDataDir: (() => Promise<void>) | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const temp = await useTempDataDir()
    restoreDataDir = temp.cleanup
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await restoreDataDir?.()
  })

  test('names the payload that was too big instead of failing anonymously', async () => {
    const oversized = { values: Array.from({ length: 70_000 }, () => 0) }
    globalThis.fetch = (async () => new Response(JSON.stringify(oversized), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch
    await assert.rejects(
      () => getGenStudioContentReceipts('gsk_test'),
      (error: Error) => {
        assert.equal((error as { code?: string }).code, 'CONTENT_STORE_PAYLOAD_TOO_LARGE')
        assert.match(error.message, /JSON nodes/)
        assert.match(error.message, /\/v1\/content\/receipts/)
        return true
      },
    )
  })

  test('uses the exact authenticated read paths and one download-grant POST', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      if (String(input).endsWith('/public-key')) return Response.json(publicKey())
      if (String(input).endsWith('/receipts')) return Response.json(receipts())
      if (String(input).includes('/entitlements/')) return Response.json(ownedReleases())
      return Response.json(grant())
    }
    await getGenStudioContentPublicKey('gsk_test')
    await getGenStudioContentReceipts('gsk_test')
    await listGenStudioOwnedContentReleases('gsk_test', 'com.storystudio.test/family')
    await issueGenStudioContentDownload('gsk_test', {
      entitlementFamily: 'com.storystudio.test/family', version: '1.0.0',
    })
    assert.deepEqual(calls.map(call => [call.url, call.init?.method]), [
      ['http://127.0.0.1:8000/v1/content/public-key', 'GET'],
      ['http://127.0.0.1:8000/v1/content/receipts', 'GET'],
      ['http://127.0.0.1:8000/v1/content/entitlements/com.storystudio.test%2Ffamily/releases', 'GET'],
      ['http://127.0.0.1:8000/v1/content/downloads', 'POST'],
    ])
    for (const call of calls) assert.equal((call.init?.headers as Record<string, string>).Authorization, 'Bearer gsk_test')
    assert.equal(calls[3].init?.body, JSON.stringify({
      entitlement_family: 'com.storystudio.test/family', version: '1.0.0',
    }))
  })

  test('preserves the exact terminal 410 release recall refusal without retrying', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return Response.json({
        code: 'release_recalled',
        detail: 'release 1.1.0 was recalled',
        recall_reason: 'Unsafe bundled reference image detected.',
        recalled_at: '2026-08-14T10:30:00Z',
      }, { status: 410 })
    }
    await assert.rejects(
      issueGenStudioContentDownload('gsk_test', {
        entitlementFamily: 'com.storystudio.test', version: '1.1.0',
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenStudioContentStoreApiError)
        assert.equal(error.status, 410)
        assert.equal(error.code, 'release_recalled')
        assert.equal(error.refusal.recall_reason, 'Unsafe bundled reference image detected.')
        assert.equal(error.refusal.recalled_at, '2026-08-14T10:30:00Z')
        return true
      },
    )
    assert.equal(calls, 1)
  })

  test('fetches the opaque archive without an API key and verifies exact bytes', async () => {
    const archive = Buffer.from('valid sspack bytes')
    const digest = createHash('sha256').update(archive).digest('hex')
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://objects.example.test/opaque?grant=secret')
      assert.equal(init?.method, 'GET')
      const headers = new Headers(init?.headers)
      assert.equal(headers.has('Authorization'), false)
      assert.equal(headers.has('X-Api-Key'), false)
      assert.equal(init?.redirect, 'error')
      return new Response(archive, { status: 200, headers: { 'Content-Length': String(archive.byteLength) } })
    }
    const observed: Array<{ downloadedBytes: number; totalBytes: number }> = []
    const bytes = await downloadGenStudioContentArchive(
      'https://objects.example.test/opaque?grant=secret',
      { archiveSha256: digest, archiveBytes: archive.byteLength },
      progress => observed.push(progress),
    )
    assert.deepEqual(Buffer.from(bytes), archive)
    assert.deepEqual(observed, [
      { downloadedBytes: 0, totalBytes: archive.byteLength },
      { downloadedBytes: archive.byteLength, totalBytes: archive.byteLength },
    ])
  })

  test('resolves an exact historical or withdrawn dependency only through an owned family history', async () => {
    const calls: string[] = []
    globalThis.fetch = async input => {
      calls.push(String(input))
      return Response.json(ownedReleases({
        current_release_id: 'crel_a',
        releases: [
          release({ release_id: 'crel_a', version: '1.0.0', archive_available: true,
            state: 'published', published_at: '2026-08-14T10:00:00Z', current: true }),
          release({ release_id: 'crel_old', version: '0.9.0', archive_available: true,
            state: 'withdrawn', published_at: '2026-07-14T10:00:00Z', current: false }),
        ],
      }))
    }
    const resolved = await resolveOwnedContentStoreDependency({
      apiKey: 'gsk_test', receipts: parseContentStoreReceipts(receipts()), releaseHistories: new Map(),
    }, 'com.storystudio.test', '0.9.0')
    assert.equal(resolved.entitlement.entitlementFamily, 'com.storystudio.test')
    assert.equal(resolved.release.version, '0.9.0')
    assert.equal(resolved.release.state, 'withdrawn')
    assert.deepEqual(calls, ['http://127.0.0.1:8000/v1/content/entitlements/com.storystudio.test/releases'])

    await assert.rejects(resolveOwnedContentStoreDependency({
      apiKey: 'gsk_test', receipts: parseContentStoreReceipts(receipts()), releaseHistories: new Map(),
    }, 'com.storystudio.missing', '1.0.0'), /not own|dependency/i)
  })

  test('refuses a recalled exact dependency locally and never requests its bytes', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return Response.json(ownedReleases({
        releases: [
          release({ release_id: 'crel_a', version: '1.0.0', archive_available: true,
            state: 'published', published_at: '2026-07-14T10:00:00Z', current: true }),
          release({ release_id: 'crel_bad', version: '1.1.0', archive_available: false,
            state: 'recalled', published_at: '2026-08-01T10:00:00Z', current: false,
            recall_reason: 'Unsafe bundled reference image detected.', recalled_at: '2026-08-14T10:30:00Z' }),
        ],
        current_release_id: 'crel_a',
      }))
    }
    await assert.rejects(
      resolveOwnedContentStoreDependency({
        apiKey: 'gsk_test', receipts: parseContentStoreReceipts(receipts()), releaseHistories: new Map(),
      }, 'com.storystudio.test', '1.1.0'),
      (error: any) => {
        assert.equal(error.code, 'release_recalled')
        assert.equal(error.status, 410)
        assert.match(error.message, /Unsafe bundled reference image detected/i)
        return true
      },
    )
    assert.equal(calls, 1, 'only the owned release history may be read; no download request is sent')
  })

  test('rejects non-HTTP and embedded-credential archive URLs before fetch', async () => {
    let fetchCalls = 0
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('must not fetch') }
    const expected = { archiveSha256: HASH, archiveBytes: 18 }
    await assert.rejects(downloadGenStudioContentArchive('file:///tmp/archive.sspack', expected), /HTTP|URL/i)
    await assert.rejects(downloadGenStudioContentArchive('https://user:secret@example.test/archive', expected), /credential|URL/i)
    assert.equal(fetchCalls, 0)
  })

  test('rejects hash, size, and 50 MiB limit violations without retaining bad bytes', async () => {
    const archive = Buffer.from('valid sspack bytes')
    globalThis.fetch = async () => new Response(archive)
    await assert.rejects(
      downloadGenStudioContentArchive('https://objects.example.test/opaque', {
        archiveSha256: '0'.repeat(64), archiveBytes: archive.byteLength,
      }),
      /sha|digest|hash/i,
    )
    await assert.rejects(
      downloadGenStudioContentArchive('https://objects.example.test/opaque', {
        archiveSha256: createHash('sha256').update(archive).digest('hex'), archiveBytes: archive.byteLength + 1,
      }),
      /size|bytes/i,
    )
    await assert.rejects(
      downloadGenStudioContentArchive('https://objects.example.test/opaque', {
        archiveSha256: '0'.repeat(64), archiveBytes: 50 * 1024 * 1024 + 1,
      }),
      /size|limit|bytes/i,
    )

    let pulls = 0
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(6 * 1024 * 1024))
      },
    }))
    await assert.rejects(
      downloadGenStudioContentArchive('https://objects.example.test/opaque', {
        archiveSha256: '0'.repeat(64), archiveBytes: 50 * 1024 * 1024,
      }),
      /size|limit|bytes/i,
    )
    assert.ok(pulls <= 10, `bounded reader pulled ${pulls} chunks before stopping`)
  })
})

describe('a restore receipt states the whole owned library, not only its newest row', () => {
  const ORIGIN = 'http://127.0.0.1:8000'

  /** The family's history: the current release, and an older one it still owns. */
  function history() {
    return ownedReleases({
      current_release_id: 'crel_a',
      releases: [
        release({ release_id: 'crel_a', version: '1.0.0', archive_available: true,
          state: 'published', published_at: '2026-08-14T10:00:00Z', current: true }),
        release({ release_id: 'crel_old', version: '0.9.0', archive_available: true,
          state: 'withdrawn', published_at: '2026-07-14T10:00:00Z', current: false }),
      ],
    })
  }

  function evidence(payload: Record<string, unknown>) {
    return {
      account_id: 'acct_a', product_id: 'cprod_kit', entitlement_family: 'com.storystudio.family.kit',
      release_id: 'crel_kit', pack_id: 'com.storystudio.pack.kit', version: '1.0.3',
      archive_sha256: 'b'.repeat(64), archive_bytes: 597, genstudio_origin: ORIGIN,
      subject: 'receipt-root' as const, closure_members: [], key_id: KEY_ID,
      receipt_canonical_json: JSON.stringify(payload), receipt_signature: signature(payload),
    }
  }

  function attestedRow(overrides: Record<string, unknown> = {}) {
    return {
      entitlement_family: 'com.storystudio.test', release_id: 'crel_old', pack_id: 'com.storystudio.test',
      version: '0.9.0', archive_sha256: HASH, archive_bytes: 18, min_story_version: '1.0.839',
      ...overrides,
    }
  }

  /**
   * The kit pins `com.storystudio.test@0.9.0`. `releases` names one row per
   * family -- the CURRENT release, 1.0.0 -- so binding against it alone
   * refuses a version the account owns outright and can still download. That
   * is how a repinned kit stopped installing the day its Topic Pack shipped a
   * new release: not a missing entitlement, a receipt that declined to mention
   * one. `owned_releases` is the wider, honest statement.
   */
  test('binds a dependency the account owns but which is no longer its family\u2019s current release', async () => {
    globalThis.fetch = async () => Response.json(history())
    const payload = restorePayload({ owned_releases: [attestedRow()] })

    const bound = await bindRootClosure(
      evidence(payload),
      [{ pack_id: 'com.storystudio.test', version: '0.9.0' }],
      { apiKey: 'gsk_test', receipts: parseContentStoreReceipts(receipts()), releaseHistories: new Map() },
    )

    assert.deepEqual(bound.closure_members, [{
      position: 0, pack_id: 'com.storystudio.test', version: '0.9.0', product_id: 'cprod_a',
      entitlement_family: 'com.storystudio.test', release_id: 'crel_old', archive_sha256: HASH,
    }])
  })

  test('still refuses a dependency no attested row matches exactly', async () => {
    globalThis.fetch = async () => Response.json(history())
    // Every field of the wider list matches except the digest. Widening WHERE
    // the truth is read from must never soften HOW exactly it has to match.
    const payload = restorePayload({ owned_releases: [attestedRow({ archive_sha256: 'c'.repeat(64) })] })

    await assert.rejects(bindRootClosure(
      evidence(payload),
      [{ pack_id: 'com.storystudio.test', version: '0.9.0' }],
      { apiKey: 'gsk_test', receipts: parseContentStoreReceipts(receipts()), releaseHistories: new Map() },
    ), /CLOSURE_MISMATCH|does not attest/i)
  })
})
