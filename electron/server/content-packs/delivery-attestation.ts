import {
  canonicalizeContentStoreObject,
  parseContentStorePublicKey,
} from '../lib/genstudio-content-store.js'
import {
  verifyContentStoreDeliveryClosureMemberReceipt,
  verifyContentStoreDeliveryReceipt,
  verifyContentStoreRestoreDeliveryReceipt,
} from '../lib/genstudio-content-store-trust.js'

export interface GenStudioDeliveryAttestation {
  account_id: string
  product_id: string
  entitlement_family: string
  release_id: string
  pack_id: string
  version: string
  archive_sha256: string
  archive_bytes: number
  genstudio_origin: string
  subject: 'receipt-root' | 'bundle-closure-member'
  closure_members: GenStudioDeliveryClosureAssignment[]
  key_id: string
  receipt_canonical_json: string
  receipt_signature: string
}

export interface GenStudioDeliveryClosureAssignment extends GenStudioDeliveryClosurePin {
  position: number
  pack_id: string
}

interface DeliveryManifestIdentity {
  pack_id: string
  version: string
  entitlement: { family: string }
  dependencies?: Array<{ pack_id: string; version: string }>
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
/**
 * The `releases[]` a RESTORE receipt attests to, or null when this evidence is
 * not a restore receipt at all. Never throws for a purchase receipt — the
 * caller falls through to the closure path in that case.
 */
function readGenStudioRestoreReleases(
  evidence: Pick<GenStudioDeliveryAttestation, 'receipt_canonical_json'>,
): Array<Record<string, unknown>> | null {
  let payload: Record<string, unknown>
  try { payload = JSON.parse(evidence.receipt_canonical_json) as Record<string, unknown> } catch {
    throw new Error('GenStudio delivery receipt evidence is not valid JSON')
  }
  if (String(payload.typ || '') !== 'genstudio.content.restore.v1') return null
  if (!Array.isArray(payload.releases)) throw new Error('GenStudio restore receipt has no attested releases')
  // 2026-08-27 -- must stay the same set the live install bound against. A live
  // install resolves a dependency out of `owned_releases` (every owned,
  // fetchable release) and falls back to `releases` (each family's current one
  // only). Reading just `releases` here would re-verify persisted evidence
  // against a narrower truth than the one that authorised it, so a reinstall
  // from cached evidence would fail where the live install had succeeded.
  return [
    ...(Array.isArray(payload.owned_releases) ? payload.owned_releases : []),
    ...payload.releases,
  ].filter((value): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value))
}

export function readGenStudioDeliveryClosure(
  evidence: Pick<GenStudioDeliveryAttestation, 'receipt_canonical_json'>,
): GenStudioDeliveryClosurePin[] {
  let payload: Record<string, unknown>
  try { payload = JSON.parse(evidence.receipt_canonical_json) as Record<string, unknown> } catch {
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
    return { product_id: pin.product_id, entitlement_family: pin.entitlement_family, release_id: pin.release_id, version: pin.version, archive_sha256: pin.archive_sha256 }
  })
}

function verifyClosureAssignments(evidence: GenStudioDeliveryAttestation, manifest: DeliveryManifestIdentity): void {
  const dependencies = manifest.dependencies ?? []
  if (evidence.subject === 'bundle-closure-member') {
    if (dependencies.length || evidence.closure_members.length) {
      throw new Error('A GenStudio bundle closure member may not declare an unbound nested dependency closure')
    }
    return
  }
  // v1.4.46 — a restore receipt pins nothing, because nothing was bought. It
  // states the account's CURRENT release per family, and for a free upgrade
  // that is the correct binding: a kit's dependency must be the version the
  // account is entitled to now, not the one pinned on the day it was bought.
  // Every field is still matched exactly; only where the truth is read from
  // changes.
  const attested = readGenStudioRestoreReleases(evidence)
  if (attested !== null) {
    if (evidence.closure_members.length !== dependencies.length) {
      throw new Error('GenStudio delivery closure does not match Content Pack dependencies')
    }
    for (const [index, dependency] of dependencies.entries()) {
      const assignment = evidence.closure_members[index]
      const row = assignment && attested.find(candidate =>
        candidate.entitlement_family === assignment.entitlement_family
        && candidate.release_id === assignment.release_id
        && candidate.pack_id === dependency.pack_id
        && candidate.version === dependency.version
        && candidate.archive_sha256 === assignment.archive_sha256)
      if (!assignment || !row || assignment.position !== index
        || assignment.pack_id !== dependency.pack_id || assignment.version !== dependency.version) {
        throw new Error(`GenStudio restore attestation ${index} does not bind this dependency`)
      }
    }
    return
  }
  const pins = readGenStudioDeliveryClosure(evidence)
  if (pins.length !== dependencies.length || evidence.closure_members.length !== dependencies.length) {
    throw new Error('GenStudio delivery closure does not match Content Pack dependencies')
  }
  for (const [index, dependency] of dependencies.entries()) {
    const assignment = evidence.closure_members[index]
    const pin = pins[index]
    if (!assignment || !pin || assignment.position !== index || assignment.pack_id !== dependency.pack_id
      || assignment.version !== dependency.version || assignment.product_id !== pin.product_id
      || assignment.entitlement_family !== pin.entitlement_family || assignment.release_id !== pin.release_id
      || assignment.version !== pin.version || assignment.archive_sha256 !== pin.archive_sha256) {
      throw new Error(`GenStudio delivery closure assignment ${index} does not bind the signed root dependency`)
    }
  }
}

/**
 * Revalidate bounded signed Store evidence with a key supplied by the separate
 * account/origin-bound commerce key history. Mutable installed evidence has
 * only a key id and can therefore never repoint that key.
 */
export function verifyGenStudioDeliveryAttestation(
  evidence: GenStudioDeliveryAttestation,
  manifest: DeliveryManifestIdentity,
  archiveSha256: string,
  archiveBytes: number,
  trustedPublicKeyBase64: string,
): void {
  // model-drift-allow: Frozen Content Store receipt profile binds delivery evidence to its manifest format.
  if (manifest.delivery_profile !== 'genstudio-store-receipt-v1'
    || manifest.pack_id !== evidence.pack_id || manifest.version !== evidence.version
    || manifest.entitlement.family !== evidence.entitlement_family) {
    throw new Error('GenStudio delivery evidence does not match the Content Pack manifest identity')
  }
  if (archiveSha256 !== evidence.archive_sha256 || archiveBytes !== evidence.archive_bytes) {
    throw new Error('GenStudio delivery evidence does not match the exact archive hash or byte count')
  }
  let payload: Record<string, unknown>
  try { payload = JSON.parse(evidence.receipt_canonical_json) as Record<string, unknown> } catch {
    throw new Error('GenStudio delivery receipt evidence is not valid JSON')
  }
  const signedReceipt = canonicalizeContentStoreObject(payload)
  if (signedReceipt.canonicalJson !== evidence.receipt_canonical_json) throw new Error('GenStudio delivery receipt evidence is not canonical')
  const publicKey = parseContentStorePublicKey({
    key_id: evidence.key_id, algorithm: 'ed25519', public_key_base64: trustedPublicKeyBase64,
    payload_types: ['genstudio.content.download.v1', 'genstudio.content.quote.v1', 'genstudio.content.receipt.v1', 'genstudio.content.restore.v1'],
    canonicalization: 'json:sorted-keys,no-whitespace,utf-8',
  })
  const receipt = { signedReceipt, receiptSignature: evidence.receipt_signature, keyId: evidence.key_id, raw: canonicalizeContentStoreObject({ receipt: payload, receipt_signature: evidence.receipt_signature, key_id: evidence.key_id }) }
  // Which KIND of receipt this is, read from the receipt itself rather than a
  // flag beside it: a restore receipt authorises a free upgrade and states the
  // account's CURRENT releases; a purchase receipt states one frozen release.
  // See `verifyContentStoreRestoreDeliveryReceipt`.
  if (String((payload as { typ?: unknown }).typ || '') === 'genstudio.content.restore.v1') {
    verifyContentStoreRestoreDeliveryReceipt(publicKey, receipt, {
      accountId: evidence.account_id, entitlementFamily: evidence.entitlement_family,
      releaseId: evidence.release_id, packId: evidence.pack_id, version: evidence.version,
      archiveSha256: evidence.archive_sha256, archiveBytes: evidence.archive_bytes,
    })
  } else if (evidence.subject === 'receipt-root') {
    verifyContentStoreDeliveryReceipt(publicKey, receipt, {
      accountId: evidence.account_id, productId: evidence.product_id, entitlementFamily: evidence.entitlement_family,
      releaseId: evidence.release_id, packId: evidence.pack_id, version: evidence.version,
      archiveSha256: evidence.archive_sha256, archiveBytes: evidence.archive_bytes,
    })
  } else {
    verifyContentStoreDeliveryClosureMemberReceipt(publicKey, receipt, {
      accountId: evidence.account_id, productId: evidence.product_id, entitlementFamily: evidence.entitlement_family,
      releaseId: evidence.release_id, version: evidence.version, archiveSha256: evidence.archive_sha256,
    })
  }
  verifyClosureAssignments(evidence, manifest)
}
