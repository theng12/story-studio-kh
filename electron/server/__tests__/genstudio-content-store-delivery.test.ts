import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
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
import { resolveOwnedContentStoreDependency } from '../services/content-store-delivery.js'
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
    typ: 'genstudio.content.receipt.v1', key_id: KEY_ID, receipt_id: 'crc_a', purchase_id: 'cpur_a',
    account_id: 'acct_a', entitlement_families: ['com.storystudio.test'],
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
    balance_before: 1000, balance_after: 750, entitlement_ids: ['cent_a'],
    entitlement_families: ['com.storystudio.test'], product: payload.product, release: payload.release,
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

  test('parses owned published and withdrawn releases without inventing unreleased states', () => {
    const parsed = parseOwnedContentReleases(ownedReleases())
    assert.equal(parsed.currentReleaseId, 'crel_b')
    assert.deepEqual(parsed.releases.map(item => [item.version, item.state, item.current]), [
      ['2.0.0', 'published', true], ['1.0.0', 'withdrawn', false],
    ])
    assert.throws(() => parseOwnedContentReleases(ownedReleases({
      releases: [release({ ...ownedReleases().releases[0], state: 'draft' })],
    })), /state|published|withdrawn/i)
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
    const bytes = await downloadGenStudioContentArchive(
      'https://objects.example.test/opaque?grant=secret',
      { archiveSha256: digest, archiveBytes: archive.byteLength },
    )
    assert.deepEqual(Buffer.from(bytes), archive)
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
