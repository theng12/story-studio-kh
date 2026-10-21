import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, test } from 'node:test'

import JSZip from 'jszip'

import { verifyContentPackArchive, verifyDeliveryAttestedContentPackArchive, verifyPossessedContentPackArchive } from '../content-packs/archive.js'
import { readGenStudioDeliveryClosure, verifyGenStudioDeliveryAttestation } from '../content-packs/delivery-attestation.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { ContentPackDeliveryAttestationSchema } from '../content-packs/runtime-types.js'
import { canonicalizeContentStoreObject, parseContentStorePublicKey } from '../lib/genstudio-content-store.js'
import { verifyContentStoreDeliveryReceipt } from '../lib/genstudio-content-store-trust.js'

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')
const localKey = generateKeyPairSync('ed25519')
const commerceKey = generateKeyPairSync('ed25519')
const commercePublicDer = commerceKey.publicKey.export({ format: 'der', type: 'spki' })
const COMMERCE_KEY_ID = 'content-store-test-key'
const COMMERCE_KEY_BASE64 = commercePublicDer.subarray(commercePublicDer.byteLength - 32).toString('base64')

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function deliveryArchive(options: { keyId?: string; signature?: Uint8Array } = {}): Promise<Uint8Array> {
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: 'com.storystudio.delivery-test.style', name: 'Delivery Test',
    description: 'A delivery-attested fixture.', category: 'Test', tags: ['test'],
    style_bible: 'Keep the scene clear.', negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: 'com.storystudio.delivery-test', publisher_id: 'com.storystudio',
    ...(options.keyId ? { key_id: options.keyId } : {}),
    version: '1.0.0', min_app_version: '1.0.0', lifecycle: 'active',
    delivery_profile: 'genstudio-store-receipt-v1',
    entitlement: { sku: 'com.storystudio.delivery-test.sku', family: 'com.storystudio.delivery-test.family' },
    bundles: [], items: [{ id: 'com.storystudio.delivery-test.style', kind: 'visual-style', schema_version: 1, path: 'content/visual-style.json' }],
    files: [
      { path: 'content/visual-style.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ],
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  if (options.signature) zip.file('signature.ed25519', options.signature, { createFolders: false })
  zip.file('content/visual-style.json', document, { createFolders: false })
  zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

describe('delivery-attested Content Pack archive boundary', () => {
  test('admits a receipt-profile archive only through the GenStudio delivery verifier', async () => {
    const archive = await deliveryArchive()
    const localPolicy = createContentPackKeyring([{
      keyId: 'com.storystudio.local-test', publisherId: 'com.storystudio',
      publicKeyPem: localKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }])

    await assert.rejects(verifyContentPackArchive(archive, localPolicy), /signature|publisher/i)
    const verified = await verifyDeliveryAttestedContentPackArchive(archive)
    assert.equal(verified.manifest.delivery_profile, 'genstudio-store-receipt-v1')
  })

  test('rejects publisher key identity and signature entries from a delivery-attested archive', async () => {
    await assert.rejects(
      verifyDeliveryAttestedContentPackArchive(await deliveryArchive({ keyId: 'com.storystudio.delivery-test' })),
      /key_id|publisher key|delivery-attested/i,
    )
    await assert.rejects(
      verifyDeliveryAttestedContentPackArchive(await deliveryArchive({ signature: Buffer.alloc(64) })),
      /signature|delivery-attested/i,
    )
  })

  test('possession admits a keyless receipt-profile archive without claiming a publisher', async () => {
    const localPolicy = createContentPackKeyring([{
      keyId: 'com.storystudio.local-test', publisherId: 'com.storystudio',
      publicKeyPem: localKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }])
    const archive = await deliveryArchive()
    const verified = await verifyPossessedContentPackArchive(archive, localPolicy)
    assert.equal(verified.manifest.delivery_profile, 'genstudio-store-receipt-v1')
    assert.equal(verified.manifest.key_id, undefined)

    // The publisher verifier and the receipt verifier keep their own strict doors.
    await assert.rejects(verifyContentPackArchive(archive, localPolicy), /signature|publisher/i)
    await assert.rejects(
      verifyPossessedContentPackArchive(await deliveryArchive({ signature: Buffer.alloc(64) }), localPolicy),
      /signature|delivery-attested/i,
    )
  })

  test('binds a Store archive to the permanent signed receipt rather than the transport grant', () => {
    const receipt = {
      typ: 'genstudio.content.receipt.v1', key_id: COMMERCE_KEY_ID, receipt_id: 'crc_test', purchase_id: 'cpur_test',
      account_id: 'acct_test', entitlement_families: ['com.storystudio.delivery-test.family'],
      product: { product_id: 'cprod_test', entitlement_family: 'com.storystudio.delivery-test.family', kind: 'visual_style' },
      release: {
        release_id: 'crel_test', pack_id: 'com.storystudio.delivery-test', version: '1.0.0',
        archive_sha256: 'a'.repeat(64), archive_bytes: 123, min_story_version: '1.0.0', changelog: 'First release.', component_summary: {},
      },
      bundle_closure: [], credits_charged: 0, issued_at: '2026-08-15T00:00:00Z',
    }
    const signature = sign(null, Buffer.from(canonicalizeContentStoreObject(receipt).canonicalJson, 'utf8'), commerceKey.privateKey).toString('base64')
    const keyring = parseContentStorePublicKey({
      key_id: COMMERCE_KEY_ID, algorithm: 'ed25519', public_key_base64: COMMERCE_KEY_BASE64,
      payload_types: ['genstudio.content.download.v1', 'genstudio.content.quote.v1', 'genstudio.content.receipt.v1', 'genstudio.content.restore.v1'],
      canonicalization: 'json:sorted-keys,no-whitespace,utf-8',
    })
    const signedReceipt = canonicalizeContentStoreObject(receipt)

    assert.doesNotThrow(() => verifyContentStoreDeliveryReceipt(keyring, {
      signedReceipt, receiptSignature: signature, keyId: COMMERCE_KEY_ID, raw: signedReceipt,
    }, {
      accountId: 'acct_test', productId: 'cprod_test', entitlementFamily: 'com.storystudio.delivery-test.family',
      releaseId: 'crel_test', packId: 'com.storystudio.delivery-test', version: '1.0.0', archiveSha256: 'a'.repeat(64), archiveBytes: 123,
    }))
    assert.throws(() => verifyContentStoreDeliveryReceipt(keyring, {
      signedReceipt, receiptSignature: signature, keyId: COMMERCE_KEY_ID, raw: signedReceipt,
    }, {
      accountId: 'acct_test', productId: 'cprod_test', entitlementFamily: 'com.storystudio.delivery-test.family',
      releaseId: 'crel_test', packId: 'com.storystudio.delivery-test', version: '1.0.0', archiveSha256: 'b'.repeat(64), archiveBytes: 123,
    }), /archiveSha256|archive_sha256|release/i)
  })

  test('rejects receipt evidence when its archive identity and manifest entitlement diverge', () => {
    const receipt = {
      typ: 'genstudio.content.receipt.v1', key_id: COMMERCE_KEY_ID, receipt_id: 'crc_test', purchase_id: 'cpur_test',
      account_id: 'acct_test', entitlement_families: ['com.storystudio.delivery-test.family'],
      product: { product_id: 'cprod_test', entitlement_family: 'com.storystudio.delivery-test.family', kind: 'visual_style' },
      release: {
        release_id: 'crel_test', pack_id: 'com.storystudio.delivery-test', version: '1.0.0',
        archive_sha256: 'a'.repeat(64), archive_bytes: 123, min_story_version: '1.0.0', changelog: 'First release.', component_summary: {},
      },
      bundle_closure: [], credits_charged: 0, issued_at: '2026-08-15T00:00:00Z',
    }
    const receiptCanonicalJson = canonicalizeContentStoreObject(receipt).canonicalJson
    const receiptSignature = sign(null, Buffer.from(receiptCanonicalJson, 'utf8'), commerceKey.privateKey).toString('base64')
    const evidence = {
      account_id: 'acct_test', product_id: 'cprod_test', entitlement_family: 'com.storystudio.delivery-test.family',
      release_id: 'crel_test', pack_id: 'com.storystudio.delivery-test', version: '1.0.0',
      archive_sha256: 'a'.repeat(64), archive_bytes: 123, genstudio_origin: 'https://genstudio.example',
      subject: 'receipt-root' as const, closure_members: [], key_id: COMMERCE_KEY_ID,
      receipt_canonical_json: receiptCanonicalJson, receipt_signature: receiptSignature,
    }
    const manifest = {
      pack_id: 'com.storystudio.delivery-test', version: '1.0.0',
      entitlement: { family: 'com.storystudio.delivery-test.family' }, delivery_profile: 'genstudio-store-receipt-v1',
    }

    assert.doesNotThrow(() => verifyGenStudioDeliveryAttestation(evidence, manifest, 'a'.repeat(64), 123, COMMERCE_KEY_BASE64))
    assert.throws(() => verifyGenStudioDeliveryAttestation(evidence, manifest, 'b'.repeat(64), 123, COMMERCE_KEY_BASE64), /archive_sha256|archive/i)
    assert.throws(() => verifyGenStudioDeliveryAttestation(evidence, {
      ...manifest, entitlement: { family: 'com.storystudio.other.family' },
    }, 'a'.repeat(64), 123, COMMERCE_KEY_BASE64), /entitlement|identity/i)
  })

  test('reads only ordered exact closure pins from signed delivery evidence', () => {
    const payload = {
      typ: 'genstudio.content.receipt.v1', key_id: COMMERCE_KEY_ID, bundle_closure: [{
        position: 0, product_id: 'cprod_dependency', entitlement_family: 'com.storystudio.dependency.family',
        release_id: 'crel_dependency', version: '1.2.3', archive_sha256: 'c'.repeat(64),
      }],
    }
    assert.deepEqual(readGenStudioDeliveryClosure({
      receipt_canonical_json: canonicalizeContentStoreObject(payload).canonicalJson,
    }), [{
      product_id: 'cprod_dependency', entitlement_family: 'com.storystudio.dependency.family',
      release_id: 'crel_dependency', version: '1.2.3', archive_sha256: 'c'.repeat(64),
    }])
    assert.throws(() => readGenStudioDeliveryClosure({
      receipt_canonical_json: canonicalizeContentStoreObject({ ...payload, bundle_closure: [{ ...payload.bundle_closure[0], position: 1 }] }).canonicalJson,
    }), /closure|position/i)
  })

  test('does not permit mutable pack evidence to repoint a receipt key id', () => {
    const rogue = generateKeyPairSync('ed25519')
    const rogueDer = rogue.publicKey.export({ format: 'der', type: 'spki' })
    const receipt = {
      typ: 'genstudio.content.receipt.v1', key_id: COMMERCE_KEY_ID, account_id: 'acct_test', entitlement_families: ['family'],
      product: { product_id: 'product', entitlement_family: 'family' },
      release: { release_id: 'release', pack_id: 'com.storystudio.delivery-test', version: '1.0.0', archive_sha256: 'a'.repeat(64), archive_bytes: 1 },
      bundle_closure: [],
    }
    const canonical = canonicalizeContentStoreObject(receipt).canonicalJson
    const evidence = {
      account_id: 'acct_test', product_id: 'product', entitlement_family: 'family', release_id: 'release',
      pack_id: 'com.storystudio.delivery-test', version: '1.0.0', archive_sha256: 'a'.repeat(64), archive_bytes: 1,
      genstudio_origin: 'https://genstudio.example', subject: 'receipt-root' as const, closure_members: [], key_id: COMMERCE_KEY_ID,
      receipt_canonical_json: canonical, receipt_signature: sign(null, Buffer.from(canonical), commerceKey.privateKey).toString('base64'),
    }
    assert.equal(ContentPackDeliveryAttestationSchema.safeParse({ ...evidence, public_key_base64: COMMERCE_KEY_BASE64 }).success, false)
    assert.throws(() => verifyGenStudioDeliveryAttestation(evidence, {
      pack_id: evidence.pack_id, version: evidence.version, entitlement: { family: evidence.entitlement_family }, delivery_profile: 'genstudio-store-receipt-v1',
    }, evidence.archive_sha256, evidence.archive_bytes, rogueDer.subarray(rogueDer.byteLength - 32).toString('base64')), /signature|key/i)
  })

  test('accepts an exact leaf closure pin but rejects an unbound nested leaf', () => {
    const receipt = {
      typ: 'genstudio.content.receipt.v1', key_id: COMMERCE_KEY_ID, account_id: 'acct_test', entitlement_families: ['root-family', 'leaf-family'],
      product: { product_id: 'root-product', entitlement_family: 'root-family' }, release: { release_id: 'root-release', pack_id: 'com.root', version: '1.0.0', archive_sha256: 'b'.repeat(64), archive_bytes: 2 },
      bundle_closure: [{ position: 0, product_id: 'leaf-product', entitlement_family: 'leaf-family', release_id: 'leaf-release', version: '2.0.0', archive_sha256: 'c'.repeat(64) }],
    }
    const canonical = canonicalizeContentStoreObject(receipt).canonicalJson
    const evidence = {
      account_id: 'acct_test', product_id: 'leaf-product', entitlement_family: 'leaf-family', release_id: 'leaf-release', pack_id: 'com.leaf', version: '2.0.0', archive_sha256: 'c'.repeat(64), archive_bytes: 7,
      genstudio_origin: 'https://genstudio.example', subject: 'bundle-closure-member' as const, closure_members: [], key_id: COMMERCE_KEY_ID,
      receipt_canonical_json: canonical, receipt_signature: sign(null, Buffer.from(canonical), commerceKey.privateKey).toString('base64'),
    }
    assert.doesNotThrow(() => verifyGenStudioDeliveryAttestation(evidence, {
      pack_id: 'com.leaf', version: '2.0.0', entitlement: { family: 'leaf-family' }, dependencies: [], delivery_profile: 'genstudio-store-receipt-v1',
    }, 'c'.repeat(64), 7, COMMERCE_KEY_BASE64))
    assert.throws(() => verifyGenStudioDeliveryAttestation(evidence, {
      pack_id: 'com.leaf', version: '2.0.0', entitlement: { family: 'leaf-family' }, dependencies: [{ pack_id: 'com.bad', version: '1.0.0' }], delivery_profile: 'genstudio-store-receipt-v1',
    }, 'c'.repeat(64), 7, COMMERCE_KEY_BASE64), /nested|closure/i)
  })

  /**
   * The persisted mirror of the live install. A live install binds a
   * dependency out of `owned_releases` -- every owned, fetchable release --
   * and falls back to `releases`, which names only each family's current one.
   * Re-verifying cached evidence against the narrower list would fail a
   * reinstall that the original install had passed, on bytes that never
   * changed. See services/content-store-delivery.ts bindRootClosure.
   */
  test('re-verifies persisted evidence against the same owned releases the install bound against', () => {
    const attested = {
      entitlement_family: 'topic-family', release_id: 'crel_topic_100', pack_id: 'com.topic',
      version: '1.0.0', archive_sha256: 'd'.repeat(64), archive_bytes: 9, min_story_version: '1.0.0',
    }
    // `releases` names the family's CURRENT release, 1.0.1. The kit pins
    // 1.0.0, which the account still owns -- and only `owned_releases` says so.
    const receipt = {
      typ: 'genstudio.content.restore.v1', key_id: COMMERCE_KEY_ID,
      account_id: 'acct_test', content_account_id: 'acct_test',
      entitlement_families: ['kit-family', 'topic-family'],
      // One row per family: the kit itself (the install root, and its family's
      // current release) and the Topic Pack's current release, 1.0.1.
      releases: [{
        entitlement_family: 'kit-family', release_id: 'crel_kit', pack_id: 'com.kit',
        version: '1.0.3', archive_sha256: 'f'.repeat(64), archive_bytes: 597, min_story_version: '1.0.0',
      }, { ...attested, release_id: 'crel_topic_101', version: '1.0.1', archive_sha256: 'e'.repeat(64) }],
      owned_releases: [attested, { ...attested, release_id: 'crel_topic_101', version: '1.0.1', archive_sha256: 'e'.repeat(64) }],
    }
    const canonical = canonicalizeContentStoreObject(receipt).canonicalJson
    const evidence = {
      account_id: 'acct_test', product_id: 'kit-product', entitlement_family: 'kit-family',
      release_id: 'crel_kit', pack_id: 'com.kit', version: '1.0.3',
      archive_sha256: 'f'.repeat(64), archive_bytes: 597,
      genstudio_origin: 'https://genstudio.example', subject: 'receipt-root' as const,
      closure_members: [{
        position: 0, pack_id: 'com.topic', version: '1.0.0', product_id: 'topic-product',
        entitlement_family: 'topic-family', release_id: 'crel_topic_100', archive_sha256: 'd'.repeat(64),
      }],
      key_id: COMMERCE_KEY_ID, receipt_canonical_json: canonical,
      receipt_signature: sign(null, Buffer.from(canonical), commerceKey.privateKey).toString('base64'),
    }
    const manifest = {
      pack_id: 'com.kit', version: '1.0.3', entitlement: { family: 'kit-family' },
      dependencies: [{ pack_id: 'com.topic', version: '1.0.0' }],
      delivery_profile: 'genstudio-store-receipt-v1',
    }

    assert.doesNotThrow(() => verifyGenStudioDeliveryAttestation(
      evidence, manifest, 'f'.repeat(64), 597, COMMERCE_KEY_BASE64))

    // Widening WHERE the truth is read from must not soften HOW exactly it has
    // to match: one wrong digest and the assignment is still refused.
    const forged = { ...receipt, owned_releases: [{ ...attested, archive_sha256: '9'.repeat(64) }] }
    const forgedCanonical = canonicalizeContentStoreObject(forged).canonicalJson
    assert.throws(() => verifyGenStudioDeliveryAttestation({
      ...evidence, receipt_canonical_json: forgedCanonical,
      receipt_signature: sign(null, Buffer.from(forgedCanonical), commerceKey.privateKey).toString('base64'),
    }, manifest, 'f'.repeat(64), 597, COMMERCE_KEY_BASE64), /attestation|bind|closure/i)
  })
})
