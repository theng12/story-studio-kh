import {
  downloadGenStudioContentArchive,
  getGenStudioContentAccount,
  getGenStudioContentPublicKey,
  getGenStudioContentReceipts,
  issueGenStudioContentDownload,
  listGenStudioOwnedContentReleases,
  type GenStudioContentAccount,
  type GenStudioContentPublicKey,
  type GenStudioOwnedContentRelease,
  type GenStudioOwnedContentReleases,
  type GenStudioContentReceipts,
  type GenStudioContentRelease,
  type GenStudioContentRestoreEntitlement,
  GenStudioContentStoreApiError,
  GenStudioContentStoreTransportError,
} from '../lib/genstudio-content-store.js'
import {
  verifyContentStoreDownloadGrant,
  verifyContentStoreRestore,
} from '../lib/genstudio-content-store-trust.js'
import {
  ContentStoreRevalidationRequiredError,
  recordVerifiedContentRestore,
} from '../content-store/commerce-state.js'
import { verifyDeliveryAttestedContentPackArchive } from '../content-packs/archive.js'
import type { ContentPackDeliveryAttestation } from '../content-packs/runtime-types.js'
import {
  assertContentPackAppCompatible,
  installContentPackLocked,
  resolveContentPackAppVersion,
  verifyInstalledContentPackClosure,
  verifyInstalledContentPackVersion,
} from '../content-packs/installer.js'
import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState, withContentPackCoordinationLock } from '../content-packs/state.js'
import type { ContentPackInstallResult } from '../content-packs/runtime-types.js'
import { getApiKey, getApiKeySnapshot } from './app-secrets-store.js'
import { getGenStudioUrl } from './app-settings.js'
import { ContentStoreLocalError, loadContentStoreOverview, type ContentStoreOverview } from './content-store.js'
import { reconcileContentStoreRecalledVersions } from './content-store-install-state.js'
import { compareVersionStrings } from '../content-packs/version-order.js'
import { randomUUID } from 'crypto'

const STORY_CONTENT_PACK_MAX_BYTES = 50 * 1024 * 1024
const trustRevalidations = new Map<string, Promise<void>>()

export interface ContentStoreInstallResponse {
  install: ContentPackInstallResult
  overview: ContentStoreOverview | null
}

export type ContentStoreInstallPhase = 'queued' | 'downloading' | 'verifying' | 'installing' | 'complete' | 'failed'
export type ContentStoreInstallProgressReporter = (progress: {
  phase: ContentStoreInstallPhase
  downloadedBytes?: number | null
  totalBytes?: number | null
}) => void

export interface ContentStoreInstallOperation {
  operationId: string
  releaseId: string
  phase: ContentStoreInstallPhase
  downloadedBytes: number | null
  totalBytes: number | null
  failure: { code: string; detail: string } | null
  install: ContentPackInstallResult | null
  updatedAt: string
}

const INSTALL_OPERATION_RETENTION_MS = 15 * 60 * 1000
const installOperations = new Map<string, ContentStoreInstallOperation>()
const activeInstallOperationsByRelease = new Map<string, string>()

function pruneInstallOperations(now = Date.now()): void {
  for (const [id, operation] of installOperations) {
    if (!['complete', 'failed'].includes(operation.phase)) continue
    if (now - Date.parse(operation.updatedAt) > INSTALL_OPERATION_RETENTION_MS) installOperations.delete(id)
  }
}

function updateInstallOperation(
  operationId: string,
  update: Partial<Omit<ContentStoreInstallOperation, 'operationId' | 'releaseId' | 'updatedAt'>>,
): void {
  const current = installOperations.get(operationId)
  if (!current) return
  installOperations.set(operationId, { ...current, ...update, updatedAt: new Date().toISOString() })
}

async function activeKey(): Promise<string> {
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) {
    throw new ContentStoreLocalError(
      400,
      'CONTENT_STORE_KEY_REQUIRED',
      'Save your Gateway key in Settings → This Mac before restoring Content Store packs.',
    )
  }
  return apiKey
}

async function currentGenStudioOrigin(): Promise<string> {
  return new URL(await getGenStudioUrl()).origin
}

async function fetchVerifiedOwnership(expected?: {
  accountId: string
  origin: string
  credentialGeneration: string
}): Promise<{
  apiKey: string
  account: GenStudioContentAccount
  publicKey: GenStudioContentPublicKey
  receipts: GenStudioContentReceipts
  origin: string
}> {
  const apiKey = await activeKey()
  const account = await getGenStudioContentAccount(apiKey)
  if (expected && account.accountId !== expected.accountId) {
    throw new ContentStoreLocalError(409, 'CONTENT_STORE_ACCOUNT_MISMATCH', 'The active GenStudio account does not own this installed Content Pack.')
  }
  const [publicKey, receipts] = await Promise.all([
    getGenStudioContentPublicKey(apiKey),
    getGenStudioContentReceipts(apiKey),
  ])
  verifyContentStoreRestore(publicKey, receipts, account.accountId)
  if (receipts.accountId !== account.accountId || receipts.contentAccountId !== account.contentAccountId) {
    throw new ContentStoreLocalError(409, 'CONTENT_STORE_ACCOUNT_MISMATCH', 'GenStudio returned ownership for a different account.')
  }
  const restoreSigningKey = publicKey.keys.find(key => key.keyId === receipts.restoreReceipt.keyId)
  if (!restoreSigningKey) {
    throw new ContentStoreLocalError(409, 'CONTENT_STORE_SIGNING_KEY_MISSING', 'GenStudio did not publish the restore receipt signing key.')
  }
  const origin = await currentGenStudioOrigin()
  if (expected && origin !== expected.origin) {
    throw new ContentStoreLocalError(409, 'CONTENT_STORE_ORIGIN_MISMATCH', 'This installed Content Pack belongs to a different GenStudio origin.')
  }
  if (expected) {
    const current = await getApiKeySnapshot('genstudio')
    if (current.apiKey !== apiKey || current.generation !== expected.credentialGeneration) {
      throw new ContentStoreRevalidationRequiredError({ accountId: expected.accountId, origin: expected.origin })
    }
  }
  await recordVerifiedContentRestore({
    account_id: receipts.accountId,
    content_account_id: receipts.contentAccountId,
    genstudio_origin: origin,
    key_id: restoreSigningKey.keyId,
    public_key_base64: restoreSigningKey.publicKeyBase64,
    receipt_canonical_json: receipts.restoreReceipt.signedReceipt.canonicalJson,
    receipt_signature: receipts.restoreReceipt.receiptSignature,
    verified_at: new Date().toISOString(),
    key_history: publicKey.keys.map(key => ({ key_id: key.keyId, public_key_base64: key.publicKeyBase64 })),
  }, expected ? { credentialGeneration: expected.credentialGeneration } : undefined)
  return { apiKey, account, publicKey, receipts, origin }
}

/** Restore only verified signing trust for an installed Store pack; never purchases, downloads, or queues work. */
export async function revalidateContentStoreTrustForGeneration(scope: {
  accountId: string
  origin: string
}): Promise<void> {
  const currentOrigin = await currentGenStudioOrigin()
  const credential = await getApiKeySnapshot('genstudio')
  if (!credential.apiKey) throw new ContentStoreRevalidationRequiredError(scope)
  if (currentOrigin !== scope.origin) {
    throw new ContentStoreLocalError(
      409,
      'CONTENT_STORE_ORIGIN_MISMATCH',
      'This installed Content Pack belongs to a different GenStudio origin.',
    )
  }
  const key = `${scope.origin}\u0000${scope.accountId}\u0000${credential.generation}`
  const existing = trustRevalidations.get(key)
  if (existing) return existing
  const leader = (async () => {
    try {
      await fetchVerifiedOwnership({
        ...scope, credentialGeneration: credential.generation,
      })
    } catch (error) {
      if (error instanceof GenStudioContentStoreApiError || error instanceof GenStudioContentStoreTransportError) {
        throw new ContentStoreRevalidationRequiredError(scope)
      }
      throw error
    }
  })()
  trustRevalidations.set(key, leader)
  try { await leader } finally {
    if (trustRevalidations.get(key) === leader) trustRevalidations.delete(key)
  }
}

export async function restoreContentStoreOwnership(): Promise<ContentStoreOverview> {
  const verified = await fetchVerifiedOwnership()
  await reconcileRecalledContentStoreReleases(verified)
  return loadContentStoreOverview()
}

/**
 * Persist an online recall as a local disablement without deleting permanent
 * ownership/history.
 *
 * The recall facts come out of the verified restore receipts this function is
 * already handed. They used to be rebuilt instead by fetching every owned
 * family's full release history and filtering it for `recalled` -- one HTTP
 * round trip per owned pack, on a path that runs before EVERY install. With
 * sixty-five owned packs that was sixty-five requests to learn something the
 * receipts response had already stated, and installing the whole library paid
 * it sixty-five times over: ~4,200 requests to install 65 packs. Long enough
 * for the client's own 8-12s request timeouts to start firing, which is what
 * surfaced to the customer as "the Content Store is unavailable".
 *
 * `recalled_release_versions` is computed server-side as every release of that
 * product in state RECALLED (see GenStudio `content_store/service.py`
 * `restore`), which is exactly what the old loop reconstructed. Reading it
 * costs nothing and cannot disagree with itself, because it arrives inside the
 * same signature-verified restore payload as the ownership it describes.
 */
function reconcileRecalledContentStoreReleases(verified: {
  apiKey: string
  account: GenStudioContentAccount
  receipts: GenStudioContentReceipts
  origin: string
}): Promise<void> {
  const recalled = new Map<string, string[]>()
  for (const entitlement of verified.receipts.entitlements) {
    if (entitlement.recalledReleaseVersions.length > 0) {
      recalled.set(entitlement.entitlementFamily, [...entitlement.recalledReleaseVersions])
    }
  }
  return reconcileContentStoreRecalledVersions({
    accountId: verified.account.accountId, origin: verified.origin, recalledVersionsByFamily: recalled,
  })
}

interface DeliveryContext {
  apiKey: string
  account: GenStudioContentAccount
  publicKey: GenStudioContentPublicKey
  receipts: GenStudioContentReceipts
  origin: string
  policy: Awaited<ReturnType<typeof getFirstPartyContentPackVerificationPolicy>>
  paths: ContentPackRuntimePaths
  completed: Map<string, ContentPackInstallResult>
  visiting: Set<string>
  releaseHistories: Map<string, GenStudioOwnedContentReleases>
  appVersion: string
  progress?: ContentStoreInstallProgressReporter
}

export interface ContentStoreDeliveryOptions {
  /** Test-only seam; production resolves the installed Story Studio version once per delivery. */
  appVersion?: string
}

interface OwnedReleaseLookupContext {
  apiKey: string
  receipts: GenStudioContentReceipts
  releaseHistories: Map<string, GenStudioOwnedContentReleases>
}

async function ownedReleaseHistory(
  entitlement: GenStudioContentRestoreEntitlement,
  context: OwnedReleaseLookupContext,
): Promise<GenStudioOwnedContentReleases> {
  let history = context.releaseHistories.get(entitlement.entitlementFamily)
  if (!history) {
    history = await listGenStudioOwnedContentReleases(context.apiKey, entitlement.entitlementFamily)
    if (history.entitlementFamily !== entitlement.entitlementFamily
      || history.entitlementId !== entitlement.entitlementId
      || history.productId !== entitlement.productId
      || history.title !== entitlement.title
      || history.kind !== entitlement.kind
      || history.publisherId !== entitlement.publisherId
      || history.grantedAt !== entitlement.grantedAt
      || history.retired !== entitlement.retired
      || history.currentReleaseId !== (entitlement.currentRelease?.releaseId ?? null)) {
      throw new ContentStoreLocalError(
        409,
        'CONTENT_PACK_OWNED_RELEASE_MISMATCH',
        'GenStudio returned release history for different verified ownership.',
      )
    }
    context.releaseHistories.set(entitlement.entitlementFamily, history)
  }
  return history
}

export async function resolveOwnedContentStoreDependency(
  context: OwnedReleaseLookupContext,
  packId: string,
  version: string,
): Promise<{ entitlement: GenStudioContentRestoreEntitlement; release: GenStudioOwnedContentRelease }> {
  const candidates = [...context.receipts.entitlements].sort((left, right) =>
    Number(right.currentRelease?.packId === packId) - Number(left.currentRelease?.packId === packId))
  for (const entitlement of candidates) {
    const history = await ownedReleaseHistory(entitlement, context)
    const release = history.releases.find(candidate => candidate.packId === packId && candidate.version === version)
    if (release?.state === 'recalled') {
      throw new ContentStoreLocalError(
        410,
        'release_recalled',
        `GenStudio recalled ${packId}@${version}: ${release.recallReason}. Ownership remains permanent, but that exact version cannot be downloaded.`,
      )
    }
    if (release) return { entitlement, release }
  }
  throw new ContentStoreLocalError(
    409,
    'CONTENT_PACK_DEPENDENCY_NOT_OWNED',
    `This pack requires owned dependency ${packId}@${version}, but that exact release is not in the verified GenStudio library.`,
  )
}

/**
 * Does this signed restore-receipt `releases[]` row attest to exactly this
 * release of exactly this family?
 *
 * Exported so the matching rule can be tested on its own: it is the whole of
 * what makes accepting a restore receipt safe, and it must never soften into
 * "same family, close enough".
 */
export function restoreReceiptAttestsRelease(
  row: Record<string, unknown>,
  entitlementFamily: string,
  release: Pick<GenStudioContentRelease, 'releaseId' | 'packId' | 'version' | 'archiveSha256' | 'archiveBytes'>,
): boolean {
  return row.entitlement_family === entitlementFamily
    && row.release_id === release.releaseId
    && row.pack_id === release.packId
    && row.version === release.version
    && row.archive_sha256 === release.archiveSha256
    && row.archive_bytes === release.archiveBytes
}

function releaseKey(release: GenStudioContentRelease): string {
  return `${release.packId}@${release.version}`
}

function deliveryAttestation(
  context: Pick<DeliveryContext, 'account' | 'receipts' | 'origin'>,
  entitlement: GenStudioContentRestoreEntitlement,
  release: GenStudioContentRelease,
): ContentPackDeliveryAttestation {
  const matchingReceipt = context.receipts.purchaseReceipts.find(candidate => {
    const payload = candidate.signedReceipt.value
    const product = payload.product as Record<string, unknown> | undefined
    const receiptRelease = payload.release as Record<string, unknown> | undefined
    const direct = product?.product_id === entitlement.productId
      && product.entitlement_family === entitlement.entitlementFamily
      && receiptRelease?.release_id === release.releaseId
      && receiptRelease.pack_id === release.packId
      && receiptRelease.version === release.version
      && receiptRelease.archive_sha256 === release.archiveSha256
      && receiptRelease.archive_bytes === release.archiveBytes
    const closure = Array.isArray(payload.bundle_closure) && payload.bundle_closure.some(entry => {
      const pin = entry as Record<string, unknown>
      return pin.product_id === entitlement.productId
        && pin.entitlement_family === entitlement.entitlementFamily
        && pin.release_id === release.releaseId
        && pin.version === release.version
        && pin.archive_sha256 === release.archiveSha256
    })
    return direct || closure
  })
  if (!matchingReceipt) {
    // v1.4.45 — a FREE UPGRADE has no purchase receipt, and never will.
    //
    // Ownership is family-level: buying "A Life As…" entitles the account to
    // whatever release that family currently points at, for ever. The purchase
    // receipt is deliberately frozen at the version bought on the day —
    // GenStudio's `purchase_receipts` says so in as many words: "a receipt
    // attests to what was bought on the day, and a retirement or a reprice
    // since then must not be able to restate it." So no purchase receipt can
    // ever name 1.0.1, and the check above refused every free upgrade the
    // Store has ever offered. The owner hit it on all five kit successors:
    // "i tried updating, nothing happened here."
    //
    // The RESTORE receipt is the artefact for this, and GenStudio mints it
    // fresh on every call precisely to say "this account, these families,
    // these current releases, at this instant". It is signed by the same
    // keyring and is already verified in `fetchVerifiedOwnership` before we
    // get here, so accepting it is not a weakening — for an upgrade it is the
    // stronger evidence, because it is current rather than historical.
    //
    // Every identifying field is still matched exactly. A restore receipt that
    // does not name this precise release, pack, version, hash AND byte count
    // is no more acceptable than a missing one.
    const attested = Array.isArray(context.receipts.restoreReceipt.signedReceipt.value.releases)
      ? context.receipts.restoreReceipt.signedReceipt.value.releases as Array<Record<string, unknown>>
      : []
    const currentRelease = attested.find(row =>
      restoreReceiptAttestsRelease(row, entitlement.entitlementFamily, release))
    if (!currentRelease) {
      throw new ContentStoreLocalError(409, 'CONTENT_PACK_RECEIPT_MISSING', 'GenStudio did not return permanent signed receipt evidence for this owned release.')
    }
    return {
      account_id: context.account.accountId,
      product_id: entitlement.productId,
      entitlement_family: entitlement.entitlementFamily,
      release_id: release.releaseId,
      pack_id: release.packId,
      version: release.version,
      archive_sha256: release.archiveSha256,
      archive_bytes: release.archiveBytes,
      genstudio_origin: context.origin,
      // The evidence is the release the restore receipt itself attests to, so
      // the subject is the receipt root; a bundle closure is a purchase-time
      // shape and does not apply.
      subject: 'receipt-root',
      closure_members: [],
      key_id: context.receipts.restoreReceipt.keyId,
      receipt_canonical_json: context.receipts.restoreReceipt.signedReceipt.canonicalJson,
      receipt_signature: context.receipts.restoreReceipt.receiptSignature,
    }
  }
  const payload = matchingReceipt.signedReceipt.value
  const direct = (payload.product as Record<string, unknown> | undefined)?.product_id === entitlement.productId
    && (payload.release as Record<string, unknown> | undefined)?.release_id === release.releaseId
  return {
    account_id: context.account.accountId,
    product_id: entitlement.productId,
    entitlement_family: entitlement.entitlementFamily,
    release_id: release.releaseId,
    pack_id: release.packId,
    version: release.version,
    archive_sha256: release.archiveSha256,
    archive_bytes: release.archiveBytes,
    genstudio_origin: context.origin,
    subject: direct ? 'receipt-root' : 'bundle-closure-member',
    closure_members: [],
    key_id: matchingReceipt.keyId,
    receipt_canonical_json: matchingReceipt.signedReceipt.canonicalJson,
    receipt_signature: matchingReceipt.receiptSignature,
  }
}

/**
 * Build the only pack-id mapping that 1.14 permits: signed root manifest +
 * signed receipt pins.
 *
 * Exported for the same reason `restoreReceiptAttestsRelease` is: this is the
 * decision that admits or refuses a kit's dependency, and it is worth testing
 * on its own rather than only through an install that can fail for ten other
 * reasons.
 */
export async function bindRootClosure(
  evidence: ContentPackDeliveryAttestation,
  dependencies: ReadonlyArray<{ pack_id: string; version: string }>,
  // Narrowed to what resolving an owned dependency actually needs. A full
  // DeliveryContext would make this look like it consults the install
  // transaction, and it does not.
  context: OwnedReleaseLookupContext,
): Promise<ContentPackDeliveryAttestation> {
  if (evidence.subject === 'bundle-closure-member') {
    if (dependencies.length) throw new ContentStoreLocalError(409, 'CONTENT_PACK_NESTED_CLOSURE_UNSUPPORTED', 'GenStudio 1.14 receipt closure does not authorize nested bundle-member dependencies.')
    return evidence
  }
  const payload = JSON.parse(evidence.receipt_canonical_json) as {
    bundle_closure?: unknown[]
    releases?: unknown[]
    owned_releases?: unknown[]
  }
  // v1.4.45 — a free upgrade is authorised by the RESTORE receipt, which
  // carries no `bundle_closure`: it is not a purchase, so nothing was pinned
  // at purchase time. What it carries instead is `releases` — the current
  // release of every family this account owns — and that is the right binding
  // for an upgrade, because a kit's dependency must be the version the account
  // is entitled to NOW, not the one it was entitled to on the day it was
  // bought. Derived from the receipt's own shape rather than a flag, so a
  // persisted attestation needs no new field to be read correctly.
  const restoreAttested = Array.isArray(payload.releases) && !Array.isArray(payload.bundle_closure)
  if (restoreAttested) {
    // 2026-08-27 -- `releases` names one release per family, the CURRENT one, and
    // that under-states a permanent per-family entitlement: an account that
    // owns a family owns every release of it. Binding against the narrow list
    // refused dependencies the account was fully entitled to -- kit 1.0.2
    // pinning `topic@1.0.0` stopped installing the day the topic family
    // shipped 1.0.1. `owned_releases` is the receipt's full statement of what
    // is owned and fetchable; search it first and fall back to `releases`, so
    // a receipt minted before GenStudio carried the wider key still verifies.
    // The five-field match below is unchanged: only where the truth is looked
    // up widened, never how exactly it must match.
    const attested = [
      ...(Array.isArray(payload.owned_releases) ? payload.owned_releases : []),
      ...(payload.releases ?? []),
    ] as Array<Record<string, unknown>>
    const closure_members = await Promise.all(dependencies.map(async (dependency, position) => {
      const owned = await resolveOwnedContentStoreDependency(context, dependency.pack_id, dependency.version)
      const pin = attested.find(row =>
        row.entitlement_family === owned.entitlement.entitlementFamily
        && row.release_id === owned.release.releaseId
        && row.pack_id === owned.release.packId
        && row.version === owned.release.version
        && row.archive_sha256 === owned.release.archiveSha256)
      if (!pin) {
        throw new ContentStoreLocalError(409, 'CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH', 'The signed GenStudio restore receipt does not attest to this exact dependency.')
      }
      return { position, pack_id: dependency.pack_id, version: dependency.version, product_id: owned.entitlement.productId,
        entitlement_family: owned.entitlement.entitlementFamily, release_id: owned.release.releaseId, archive_sha256: owned.release.archiveSha256 }
    }))
    return { ...evidence, closure_members }
  }
  if (!Array.isArray(payload.bundle_closure) || payload.bundle_closure.length !== dependencies.length) {
    throw new ContentStoreLocalError(409, 'CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH', 'The signed GenStudio receipt closure does not match this pack before installation.')
  }
  const closure_members = await Promise.all(dependencies.map(async (dependency, position) => {
    const owned = await resolveOwnedContentStoreDependency(context, dependency.pack_id, dependency.version)
    const pin = payload.bundle_closure![position] as Record<string, unknown>
    if (!pin || pin.position !== position || pin.product_id !== owned.entitlement.productId
      || pin.entitlement_family !== owned.entitlement.entitlementFamily || pin.release_id !== owned.release.releaseId
      || pin.version !== owned.release.version || pin.archive_sha256 !== owned.release.archiveSha256) {
      throw new ContentStoreLocalError(409, 'CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH', 'The signed GenStudio receipt closure does not authorize this exact dependency.')
    }
    return { position, pack_id: dependency.pack_id, version: dependency.version, product_id: owned.entitlement.productId,
      entitlement_family: owned.entitlement.entitlementFamily, release_id: owned.release.releaseId, archive_sha256: owned.release.archiveSha256 }
  }))
  return { ...evidence, closure_members }
}

async function alreadyInstalled(
  release: GenStudioContentRelease,
  context: Pick<DeliveryContext, 'paths' | 'policy' | 'appVersion'>,
): Promise<{ install: ContentPackInstallResult; dependencies: ReadonlyArray<{ pack_id: string; version: string }> } | null> {
  const state = await readContentPackState(context.paths)
  const pack = state.packs[release.packId]
  const installed = pack?.versions[release.version]
  if (!installed || installed.pending_removal || installed.archive_sha256 !== release.archiveSha256) return null
  let verified: Awaited<ReturnType<typeof verifyInstalledContentPackVersion>>
  try {
    verified = await verifyInstalledContentPackVersion(installed, context.policy)
  } catch {
    return null
  }
  return {
    install: {
      pack_id: release.packId,
      version: release.version,
      archive_sha256: release.archiveSha256,
      activated: pack.active_version === release.version,
      // v1.4.1 — numeric, not the default lexicographic sort.
      retained_versions: Object.keys(pack.versions).sort(compareVersionStrings),
    },
    dependencies: verified.manifest.dependencies ?? [],
  }
}

async function installOwnedEntitlement(
  entitlement: GenStudioContentRestoreEntitlement,
  release: GenStudioContentRelease,
  context: DeliveryContext,
): Promise<ContentPackInstallResult> {
  if (!release.archiveAvailable) {
    throw new ContentStoreLocalError(409, 'CONTENT_PACK_ARCHIVE_UNAVAILABLE', 'This owned pack has no downloadable release right now.')
  }
  if (release.archiveBytes > STORY_CONTENT_PACK_MAX_BYTES) {
    throw new ContentStoreLocalError(
      409,
      'CONTENT_PACK_TOO_LARGE_FOR_THIS_APP',
      'This release exceeds Story Studio\'s 50 MiB signed-pack safety limit. GenStudio must publish a smaller compatible release.',
    )
  }
  try {
    await assertContentPackAppCompatible(release.minStoryVersion, context.appVersion)
  } catch {
    throw new ContentStoreLocalError(
      409,
      'CONTENT_PACK_REQUIRES_NEWER_APP',
      `This release requires Story Studio ${release.minStoryVersion} or newer (this app is ${context.appVersion}). Update Story Studio before installing it.`,
    )
  }
  const key = releaseKey(release)
  const completed = context.completed.get(key)
  if (completed) return completed
  if (context.visiting.has(key)) {
    throw new ContentStoreLocalError(409, 'CONTENT_PACK_DEPENDENCY_CYCLE', `The owned Content Pack dependency graph contains a cycle at ${key}.`)
  }
  context.visiting.add(key)
  try {
    const local = await alreadyInstalled(release, context)
    if (local) {
      for (const dependency of local.dependencies) {
        const ownedDependency = await resolveOwnedContentStoreDependency(context, dependency.pack_id, dependency.version)
        await installOwnedEntitlement(ownedDependency.entitlement, ownedDependency.release, context)
      }
      context.completed.set(key, local.install)
      return local.install
    }
    const grant = await issueGenStudioContentDownload(context.apiKey, {
      entitlementFamily: entitlement.entitlementFamily,
      version: release.version,
    })
    verifyContentStoreDownloadGrant(context.publicKey, grant, {
      accountId: context.account.accountId,
      productId: entitlement.productId,
      entitlementFamily: entitlement.entitlementFamily,
      releaseId: release.releaseId,
      packId: release.packId,
      version: release.version,
      archiveSha256: release.archiveSha256,
      archiveBytes: release.archiveBytes,
    })
    context.progress?.({ phase: 'downloading', downloadedBytes: 0, totalBytes: release.archiveBytes })
    const archiveBytes = await downloadGenStudioContentArchive(grant.downloadUrl, {
      archiveSha256: release.archiveSha256,
      archiveBytes: release.archiveBytes,
    }, progress => context.progress?.({ phase: 'downloading', ...progress }))
    let evidence = deliveryAttestation(context, entitlement, release)
    context.progress?.({ phase: 'verifying', downloadedBytes: null, totalBytes: null })
    const verified = await verifyDeliveryAttestedContentPackArchive(archiveBytes)
    if (verified.manifest.pack_id !== release.packId || verified.manifest.version !== release.version) {
      throw new ContentStoreLocalError(409, 'CONTENT_PACK_REMOTE_IDENTITY_MISMATCH', 'The downloaded signed pack identity does not match the owned release.')
    }
    evidence = await bindRootClosure(evidence, verified.manifest.dependencies ?? [], context)
    for (const dependency of verified.manifest.dependencies ?? []) {
      const ownedDependency = await resolveOwnedContentStoreDependency(context, dependency.pack_id, dependency.version)
      await installOwnedEntitlement(ownedDependency.entitlement, ownedDependency.release, context)
    }
    context.progress?.({ phase: 'installing', downloadedBytes: null, totalBytes: null })
    const installed = await installContentPackLocked({
      archiveBytes,
      // model-drift-allow: Persisted Content Pack provenance discriminator, not a GenStudio catalog product ID.
      source: 'genstudio-store',
      expectedArchiveSha256: release.archiveSha256,
      expectedPackId: release.packId,
      expectedVersion: release.version,
      deliveryAttestation: evidence,
    }, {
      activate: false,
      policy: context.policy,
      appVersion: context.appVersion,
      repairCorruptExactStoreVersion: true,
    }, context.paths)
    const installedState = await readContentPackState(context.paths)
    await verifyInstalledContentPackClosure(installedState, release.packId, release.version, context.policy, context.appVersion)
    context.completed.set(key, installed)
    return installed
  } finally {
    context.visiting.delete(key)
  }
}

/** Activate a fully verified owned closure in one locked state checkpoint. */
async function activateOwnedDeliveryClosure(
  root: GenStudioContentRelease,
  context: DeliveryContext,
): Promise<ContentPackInstallResult> {
  return mutateContentPackState(async state => {
    for (const installed of context.completed.values()) {
      const retained = state.packs[installed.pack_id]?.versions[installed.version]
      if (!retained || retained.pending_removal || retained.recalled || retained.archive_sha256 !== installed.archive_sha256) {
        throw new Error(`Content Pack delivery candidate changed before activation: ${installed.pack_id}@${installed.version}`)
      }
    }
    await verifyInstalledContentPackClosure(state, root.packId, root.version, context.policy, context.appVersion)
    for (const installed of context.completed.values()) state.packs[installed.pack_id]!.active_version = installed.version
    const activated = context.completed.get(releaseKey(root))
    if (!activated) throw new Error(`Content Pack root was not staged: ${releaseKey(root)}`)
    return {
      ...activated,
      activated: true,
      // v1.4.1 — numeric, not the default lexicographic sort.
      retained_versions: Object.keys(state.packs[root.packId]!.versions).sort(compareVersionStrings),
    }
  }, context.paths)
}

export async function installOwnedContentStoreRelease(
  releaseId: string,
  options: ContentStoreDeliveryOptions = {},
  /**
   * `overview: false` skips rebuilding the whole Store overview after the
   * install. Rebuilding is four GenStudio round trips plus a verification sweep
   * of every installed pack — ~5 s of a 14 s install (measured 2026-09-12) —
   * and a queue installing 125 packs paid it 125 times. The queue refreshes
   * once when it drains; a single Install still gets the overview back.
   */
  response: { overview?: boolean; progress?: ContentStoreInstallProgressReporter } = {},
): Promise<ContentStoreInstallResponse> {
  const verified = await fetchVerifiedOwnership()
  await reconcileRecalledContentStoreReleases(verified)
  const entitlement = verified.receipts.entitlements.find(row => row.currentRelease?.releaseId === releaseId)
  if (!entitlement) {
    throw new ContentStoreLocalError(404, 'CONTENT_PACK_NOT_OWNED', 'The active GenStudio account does not own this release.')
  }
  const release = entitlement.currentRelease!
  const paths = getContentPackRuntimePaths()
  const context: DeliveryContext = {
    ...verified,
    policy: await getFirstPartyContentPackVerificationPolicy(),
    paths,
    completed: new Map(),
    visiting: new Set(),
    releaseHistories: new Map(),
    appVersion: options.appVersion ?? await resolveContentPackAppVersion(),
    progress: response.progress,
  }
  const install = await withContentPackCoordinationLock(paths, async () => {
    await installOwnedEntitlement(entitlement, release, context)
    return activateOwnedDeliveryClosure(release, context)
  })
  return { install, overview: response.overview === false ? null : await loadContentStoreOverview() }
}

/**
 * Starts the exact same signed delivery path in the background so a shared UI
 * queue can report observed archive bytes and verification phases. This record
 * is deliberately process-local: delivery itself is not resumable across an
 * app restart, and no unverified install state is written to disk.
 */
export function startOwnedContentStoreReleaseInstall(
  releaseId: string,
  options: ContentStoreDeliveryOptions = {},
  operationOptions: { presentFailure?: (error: unknown) => { code: string; detail: string } } = {},
): ContentStoreInstallOperation {
  pruneInstallOperations()
  const activeId = activeInstallOperationsByRelease.get(releaseId)
  if (activeId) {
    const active = installOperations.get(activeId)
    if (active && !['complete', 'failed'].includes(active.phase)) return active
    activeInstallOperationsByRelease.delete(releaseId)
  }
  const operation: ContentStoreInstallOperation = {
    operationId: randomUUID(), releaseId, phase: 'queued',
    downloadedBytes: null, totalBytes: null, failure: null, install: null,
    updatedAt: new Date().toISOString(),
  }
  installOperations.set(operation.operationId, operation)
  activeInstallOperationsByRelease.set(releaseId, operation.operationId)
  void installOwnedContentStoreRelease(releaseId, options, { overview: false, progress: progress => {
    updateInstallOperation(operation.operationId, {
      phase: progress.phase,
      ...(progress.downloadedBytes !== undefined ? { downloadedBytes: progress.downloadedBytes } : {}),
      ...(progress.totalBytes !== undefined ? { totalBytes: progress.totalBytes } : {}),
    })
  } }).then(result => {
    updateInstallOperation(operation.operationId, {
      phase: 'complete', downloadedBytes: null, totalBytes: null, install: result.install,
    })
    if (activeInstallOperationsByRelease.get(releaseId) === operation.operationId) activeInstallOperationsByRelease.delete(releaseId)
  }).catch(error => {
    const fallbackFailure = {
      code: 'CONTENT_STORE_UPSTREAM_REFUSED', detail: 'GenStudio could not complete this Content Store install.',
    }
    let failure = fallbackFailure
    try { failure = operationOptions.presentFailure?.(error) ?? fallbackFailure } catch { /* monitoring must still reach a terminal state */ }
    updateInstallOperation(operation.operationId, {
      phase: 'failed', downloadedBytes: null, totalBytes: null,
      failure,
    })
    if (activeInstallOperationsByRelease.get(releaseId) === operation.operationId) activeInstallOperationsByRelease.delete(releaseId)
  })
  return operation
}

export function readContentStoreInstallOperation(operationId: string): ContentStoreInstallOperation | null {
  pruneInstallOperations()
  return installOperations.get(operationId) ?? null
}
