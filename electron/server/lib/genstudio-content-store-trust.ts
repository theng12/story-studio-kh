import { createPublicKey, verify } from 'node:crypto'

import {
  canonicalizeContentStoreObject,
  type CanonicalJsonObject,
  type GenStudioContentDownloadGrant,
  type GenStudioContentPublicKey,
  type GenStudioContentSigningKey,
  type GenStudioContentPurchase,
  type GenStudioContentReceipt,
  type GenStudioContentReceipts,
} from './genstudio-content-store.js'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function matchingKey(publicKey: GenStudioContentPublicKey, keyId: string, field: string): GenStudioContentSigningKey {
  const key = publicKey.keys.find(candidate => candidate.keyId === keyId)
  if (!key) throw new Error(`${field} key_id does not match a trusted Content Store public key`)
  return key
}

function verifySignature(
  publicKey: GenStudioContentPublicKey,
  payload: CanonicalJsonObject,
  signatureBase64: string,
  expectedType: string,
  field: string,
): void {
  if (payload.value.typ !== expectedType) throw new Error(`${field} has the wrong signed payload type`)
  const keyId = typeof payload.value.key_id === 'string' ? payload.value.key_id : ''
  const signingKey = matchingKey(publicKey, keyId, field)
  const currentPayload = canonicalizeContentStoreObject(payload.value)
  if (currentPayload.canonicalJson !== payload.canonicalJson) {
    throw new Error(`${field} canonical payload changed after parsing`)
  }
  const signature = Buffer.from(signatureBase64, 'base64')
  if (signature.byteLength !== 64 || signature.toString('base64') !== signatureBase64) {
    throw new Error(`${field} signature is not canonical 64-byte base64`)
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signingKey.publicKeyBytes)]),
    format: 'der',
    type: 'spki',
  })
  if (key.asymmetricKeyType !== 'ed25519'
    || !verify(null, currentPayload.canonicalBytes, key, signature)) {
    throw new Error(`${field} signature does not match its canonical payload`)
  }
}

export function verifyContentStoreRestore(
  publicKey: GenStudioContentPublicKey,
  receipts: GenStudioContentReceipts,
  expectedAccountId: string,
): void {
  if (typeof expectedAccountId !== 'string' || expectedAccountId.length === 0) {
    throw new TypeError('Expected Content Store account id is required')
  }
  if (receipts.accountId !== expectedAccountId || receipts.contentAccountId !== expectedAccountId) {
    throw new Error('Content Store restore belongs to a different account')
  }
  verifyContentStoreRestoreReceipt(publicKey, receipts.restoreReceipt, expectedAccountId)
  for (const [index, receipt] of receipts.purchaseReceipts.entries()) {
    matchingKey(publicKey, receipt.keyId, `Purchase receipt ${index}`)
    verifySignature(
      publicKey,
      receipt.signedReceipt,
      receipt.receiptSignature,
      'genstudio.content.receipt.v1',
      `Purchase receipt ${index}`,
    )
  }
}

export function verifyContentStoreRestoreReceipt(
  publicKey: GenStudioContentPublicKey,
  receipt: GenStudioContentReceipt,
  expectedAccountId: string,
): CanonicalJsonObject {
  if (typeof expectedAccountId !== 'string' || expectedAccountId.length === 0) {
    throw new TypeError('Expected Content Store account id is required')
  }
  matchingKey(publicKey, receipt.keyId, 'Restore receipt')
  verifySignature(
    publicKey,
    receipt.signedReceipt,
    receipt.receiptSignature,
    'genstudio.content.restore.v1',
    'Restore receipt',
  )
  if (receipt.signedReceipt.value.account_id !== expectedAccountId
    || receipt.signedReceipt.value.content_account_id !== expectedAccountId) {
    throw new Error('Restore receipt belongs to a different account')
  }
  return receipt.signedReceipt
}

export function verifyContentStorePurchase(
  publicKey: GenStudioContentPublicKey,
  purchase: GenStudioContentPurchase,
  expectedAccountId: string,
): CanonicalJsonObject {
  if (purchase.accountId !== expectedAccountId) throw new Error('Content Store purchase belongs to a different account')
  matchingKey(publicKey, purchase.receipt.keyId, 'Purchase receipt')
  verifySignature(
    publicKey,
    purchase.receipt.signedReceipt,
    purchase.receipt.receiptSignature,
    'genstudio.content.receipt.v1',
    'Purchase receipt',
  )
  if (purchase.receipt.signedReceipt.value.account_id !== expectedAccountId) {
    throw new Error('Purchase receipt belongs to a different account')
  }
  return purchase.receipt.signedReceipt
}

export interface ExpectedContentDownload {
  accountId: string
  productId: string
  entitlementFamily: string
  releaseId: string
  packId: string
  version: string
  archiveSha256: string
  archiveBytes: number
}

/** Durable receipt facts that must describe the exact Store archive. */
export type ExpectedContentDelivery = ExpectedContentDownload

function receiptObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Delivery receipt ${field} must be an object`)
  return value as Record<string, unknown>
}

/**
 * Verify the permanent commerce receipt used for Store delivery. The download
 * grant is deliberately excluded: it authorizes transfer for 900 seconds but
 * is not offline evidence.
 */
export function verifyContentStoreDeliveryReceipt(
  publicKey: GenStudioContentPublicKey,
  receipt: GenStudioContentReceipt,
  expected: ExpectedContentDelivery,
): void {
  if (receipt.keyId !== receipt.signedReceipt.value.key_id) {
    throw new Error('Delivery receipt key_id does not match its signed payload')
  }
  verifySignature(publicKey, receipt.signedReceipt, receipt.receiptSignature, 'genstudio.content.receipt.v1', 'Delivery receipt')
  const payload = receipt.signedReceipt.value
  if (payload.account_id !== expected.accountId) throw new Error('Delivery receipt account_id does not match the active account')
  const product = receiptObject(payload.product, 'product')
  const release = receiptObject(payload.release, 'release')
  const directFields: Array<[Record<string, unknown>, string, unknown]> = [
    [product, 'product_id', expected.productId],
    [product, 'entitlement_family', expected.entitlementFamily],
    [release, 'release_id', expected.releaseId],
    [release, 'pack_id', expected.packId],
    [release, 'version', expected.version],
    [release, 'archive_sha256', expected.archiveSha256],
    [release, 'archive_bytes', expected.archiveBytes],
  ]
  const closure = payload.bundle_closure
  if (!Array.isArray(closure)) throw new Error('Delivery receipt bundle_closure must be an array')
  const families = payload.entitlement_families
  if (!Array.isArray(families) || families.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new Error('Delivery receipt entitlement_families must be a non-empty string array')
  }
  const expectedFamilies = [typeof product.entitlement_family === 'string' ? product.entitlement_family : '']
  for (const [index, entry] of closure.entries()) {
    const pin = receiptObject(entry, `bundle_closure[${index}]`)
    if (pin.position !== index || typeof pin.entitlement_family !== 'string' || typeof pin.product_id !== 'string'
      || typeof pin.release_id !== 'string' || typeof pin.version !== 'string'
      || typeof pin.archive_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.archive_sha256)) {
      throw new Error(`Delivery receipt bundle_closure[${index}] is not an exact closure pin`)
    }
    expectedFamilies.push(pin.entitlement_family)
  }
  if (new Set(expectedFamilies).size !== expectedFamilies.length
    || expectedFamilies.length !== families.length
    || expectedFamilies.some((family, index) => family !== families[index])) {
    throw new Error('Delivery receipt entitlement_families do not match its exact closure')
  }
  const direct = directFields.every(([record, field, expectedValue]) => record[field] === expectedValue)
  const pinned = closure.some(entry => {
    const pin = entry as Record<string, unknown>
    return pin.product_id === expected.productId
      && pin.entitlement_family === expected.entitlementFamily
      && pin.release_id === expected.releaseId
      && pin.version === expected.version
      && pin.archive_sha256 === expected.archiveSha256
  })
  if (!direct && !pinned) throw new Error('Delivery receipt does not bind the exact owned release or closure pin')
  if (direct && expectedFamilies[0] !== expected.entitlementFamily) {
    throw new Error('Delivery receipt product entitlement family does not match the exact owned release')
  }
}

export function verifyContentStoreDownloadGrant(
  publicKey: GenStudioContentPublicKey,
  grant: GenStudioContentDownloadGrant,
  expected: ExpectedContentDownload,
  now = new Date(),
): void {
  const signingKey = matchingKey(publicKey, grant.keyId, 'Download grant')
  if (!signingKey.current) throw new Error('Download grant must use the current key; retired keys are verify-only for receipts')
  verifySignature(
    publicKey,
    grant.signedGrant,
    grant.grantSignature,
    'genstudio.content.download.v1',
    'Download grant',
  )
  const actual = {
    accountId: grant.accountId,
    productId: grant.productId,
    entitlementFamily: grant.entitlementFamily,
    releaseId: grant.releaseId,
    packId: grant.packId,
    version: grant.version,
    archiveSha256: grant.archiveSha256,
    archiveBytes: grant.archiveBytes,
  }
  for (const key of Object.keys(expected) as Array<keyof ExpectedContentDownload>) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Download grant ${key} does not match the expected owned release`)
    }
  }
  const issuedAt = Date.parse(String(grant.signedGrant.value.issued_at))
  const expiresAt = Date.parse(grant.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt - issuedAt !== grant.ttlSeconds * 1000) {
    throw new Error('Download grant lifetime does not match its signed issue and expiry instants')
  }
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new TypeError('Download grant verification time is invalid')
  if (nowMs < issuedAt) throw new Error('Download grant is not valid before its signed issue time')
  if (nowMs >= expiresAt) throw new Error('Download grant has expired')
}
