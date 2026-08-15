import {
  canonicalizeContentStoreObject,
  parseContentStorePublicKey,
} from '../lib/genstudio-content-store.js'
import { verifyContentStoreDeliveryReceipt } from '../lib/genstudio-content-store-trust.js'

export interface GenStudioDeliveryAttestation {
  account_id: string
  product_id: string
  entitlement_family: string
  release_id: string
  pack_id: string
  version: string
  archive_sha256: string
  archive_bytes: number
  key_id: string
  public_key_base64: string
  receipt_canonical_json: string
  receipt_signature: string
}

interface DeliveryManifestIdentity {
  pack_id: string
  version: string
  entitlement: { family: string }
  delivery_profile?: string
}

export interface GenStudioDeliveryClosurePin {
  product_id: string
  entitlement_family: string
  release_id: string
  version: string
  archive_sha256: string
}

/** Read closure facts only from the already-signed canonical receipt payload. */
export function readGenStudioDeliveryClosure(
  evidence: Pick<GenStudioDeliveryAttestation, 'receipt_canonical_json'>,
): GenStudioDeliveryClosurePin[] {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(evidence.receipt_canonical_json) as Record<string, unknown>
  } catch {
    throw new Error('GenStudio delivery receipt evidence is not valid JSON')
  }
  if (!Array.isArray(payload.bundle_closure)) throw new Error('GenStudio delivery receipt has no exact closure')
  return payload.bundle_closure.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`GenStudio delivery closure pin ${index} is invalid`)
    const pin = value as Record<string, unknown>
    if (pin.position !== index || typeof pin.product_id !== 'string' || typeof pin.entitlement_family !== 'string'
      || typeof pin.release_id !== 'string' || typeof pin.version !== 'string'
      || typeof pin.archive_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.archive_sha256)) {
      throw new Error(`GenStudio delivery closure pin ${index} is invalid`)
    }
    return {
      product_id: pin.product_id,
      entitlement_family: pin.entitlement_family,
      release_id: pin.release_id,
      version: pin.version,
      archive_sha256: pin.archive_sha256,
    }
  })
}

/** Revalidate bounded, signed Store evidence without network or local state authority. */
export function verifyGenStudioDeliveryAttestation(
  evidence: GenStudioDeliveryAttestation,
  manifest: DeliveryManifestIdentity,
  archiveSha256: string,
  archiveBytes: number,
): void {
  if (manifest.delivery_profile !== 'genstudio-store-receipt-v1'
    || manifest.pack_id !== evidence.pack_id
    || manifest.version !== evidence.version
    || manifest.entitlement.family !== evidence.entitlement_family) {
    throw new Error('GenStudio delivery evidence does not match the Content Pack manifest identity')
  }
  if (archiveSha256 !== evidence.archive_sha256 || archiveBytes !== evidence.archive_bytes) {
    throw new Error('GenStudio delivery evidence does not match the exact archive hash or byte count')
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(evidence.receipt_canonical_json) as Record<string, unknown>
  } catch {
    throw new Error('GenStudio delivery receipt evidence is not valid JSON')
  }
  const signedReceipt = canonicalizeContentStoreObject(payload)
  if (signedReceipt.canonicalJson !== evidence.receipt_canonical_json) {
    throw new Error('GenStudio delivery receipt evidence is not canonical')
  }
  const publicKey = parseContentStorePublicKey({
    key_id: evidence.key_id,
    algorithm: 'ed25519',
    public_key_base64: evidence.public_key_base64,
    payload_types: [
      'genstudio.content.download.v1', 'genstudio.content.quote.v1',
      'genstudio.content.receipt.v1', 'genstudio.content.restore.v1',
    ],
    canonicalization: 'json:sorted-keys,no-whitespace,utf-8',
  })
  verifyContentStoreDeliveryReceipt(publicKey, {
    signedReceipt,
    receiptSignature: evidence.receipt_signature,
    keyId: evidence.key_id,
    raw: canonicalizeContentStoreObject({
      receipt: payload,
      receipt_signature: evidence.receipt_signature,
      key_id: evidence.key_id,
    }),
  }, {
    accountId: evidence.account_id,
    productId: evidence.product_id,
    entitlementFamily: evidence.entitlement_family,
    releaseId: evidence.release_id,
    packId: evidence.pack_id,
    version: evidence.version,
    archiveSha256: evidence.archive_sha256,
    archiveBytes: evidence.archive_bytes,
  })
}
