import { createPublicKey, verify } from 'node:crypto'

import {
  canonicalizeContentStoreObject,
  type CanonicalJsonObject,
  type GenStudioContentDownloadGrant,
  type GenStudioContentPublicKey,
  type GenStudioContentPurchase,
  type GenStudioContentReceipt,
  type GenStudioContentReceipts,
} from './genstudio-content-store.js'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function assertMatchingKey(publicKey: GenStudioContentPublicKey, keyId: string, field: string): void {
  if (keyId !== publicKey.keyId) throw new Error(`${field} key_id does not match the trusted Content Store public key`)
}

function verifySignature(
  publicKey: GenStudioContentPublicKey,
  payload: CanonicalJsonObject,
  signatureBase64: string,
  expectedType: string,
  field: string,
): void {
  if (payload.value.typ !== expectedType) throw new Error(`${field} has the wrong signed payload type`)
  if (payload.value.key_id !== publicKey.keyId) throw new Error(`${field} key_id does not match the trusted Content Store public key`)
  const currentPayload = canonicalizeContentStoreObject(payload.value)
  if (currentPayload.canonicalJson !== payload.canonicalJson) {
    throw new Error(`${field} canonical payload changed after parsing`)
  }
  const signature = Buffer.from(signatureBase64, 'base64')
  if (signature.byteLength !== 64 || signature.toString('base64') !== signatureBase64) {
    throw new Error(`${field} signature is not canonical 64-byte base64`)
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey.publicKeyBytes)]),
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
    assertMatchingKey(publicKey, receipt.keyId, `Purchase receipt ${index}`)
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
  assertMatchingKey(publicKey, receipt.keyId, 'Restore receipt')
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
  assertMatchingKey(publicKey, purchase.receipt.keyId, 'Purchase receipt')
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

export function verifyContentStoreDownloadGrant(
  publicKey: GenStudioContentPublicKey,
  grant: GenStudioContentDownloadGrant,
  expected: ExpectedContentDownload,
  now = new Date(),
): void {
  assertMatchingKey(publicKey, grant.keyId, 'Download grant')
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
