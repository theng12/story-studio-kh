import {
  downloadGenStudioContentArchive,
  getGenStudioContentAccount,
  getGenStudioContentPublicKey,
  getGenStudioContentReceipts,
  issueGenStudioContentDownload,
  type GenStudioContentAccount,
  type GenStudioContentPublicKey,
  type GenStudioContentReceipts,
  type GenStudioContentRelease,
  type GenStudioContentRestoreEntitlement,
} from '../lib/genstudio-content-store.js'
import {
  verifyContentStoreDownloadGrant,
  verifyContentStoreRestore,
} from '../lib/genstudio-content-store-trust.js'
import { recordVerifiedContentRestore } from '../content-store/commerce-state.js'
import { verifyContentPackArchive } from '../content-packs/archive.js'
import {
  assertContentPackAppCompatible,
  installContentPack,
  verifyInstalledContentPackClosure,
} from '../content-packs/installer.js'
import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { rollbackContentPack } from '../content-packs/lifecycle.js'
import { readContentPackState } from '../content-packs/state.js'
import type { ContentPackInstallResult } from '../content-packs/runtime-types.js'
import { getApiKey } from './app-secrets-store.js'
import { getGenStudioUrl } from './app-settings.js'
import { ContentStoreLocalError, loadContentStoreOverview, type ContentStoreOverview } from './content-store.js'

const STORY_CONTENT_PACK_MAX_BYTES = 50 * 1024 * 1024

export interface ContentStoreInstallResponse {
  install: ContentPackInstallResult
  overview: ContentStoreOverview
}

async function activeKey(): Promise<string> {
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) {
    throw new ContentStoreLocalError(
      400,
      'CONTENT_STORE_KEY_REQUIRED',
      'Save a GenStudio API key with content:read access before restoring Content Store purchases.',
    )
  }
  return apiKey
}

async function currentGenStudioOrigin(): Promise<string> {
  return new URL(await getGenStudioUrl()).origin
}

async function fetchVerifiedOwnership(): Promise<{
  apiKey: string
  account: GenStudioContentAccount
  publicKey: GenStudioContentPublicKey
  receipts: GenStudioContentReceipts
}> {
  const apiKey = await activeKey()
  const account = await getGenStudioContentAccount(apiKey)
  const [publicKey, receipts] = await Promise.all([
    getGenStudioContentPublicKey(apiKey),
    getGenStudioContentReceipts(apiKey),
  ])
  verifyContentStoreRestore(publicKey, receipts, account.accountId)
  if (receipts.accountId !== account.accountId || receipts.contentAccountId !== account.contentAccountId) {
    throw new ContentStoreLocalError(409, 'CONTENT_STORE_ACCOUNT_MISMATCH', 'GenStudio returned ownership for a different account.')
  }
  await recordVerifiedContentRestore({
    account_id: receipts.accountId,
    content_account_id: receipts.contentAccountId,
    genstudio_origin: await currentGenStudioOrigin(),
    key_id: publicKey.keyId,
    public_key_base64: publicKey.publicKeyBase64,
    receipt_canonical_json: receipts.restoreReceipt.signedReceipt.canonicalJson,
    receipt_signature: receipts.restoreReceipt.receiptSignature,
    verified_at: new Date().toISOString(),
  })
  return { apiKey, account, publicKey, receipts }
}

export async function restoreContentStoreOwnership(): Promise<ContentStoreOverview> {
  await fetchVerifiedOwnership()
  return loadContentStoreOverview()
}

interface DeliveryContext {
  apiKey: string
  account: GenStudioContentAccount
  publicKey: GenStudioContentPublicKey
  receipts: GenStudioContentReceipts
  policy: Awaited<ReturnType<typeof getFirstPartyContentPackVerificationPolicy>>
  completed: Map<string, ContentPackInstallResult>
  visiting: Set<string>
}

function releaseKey(release: GenStudioContentRelease): string {
  return `${release.packId}@${release.version}`
}

async function alreadyInstalled(
  release: GenStudioContentRelease,
  policy: DeliveryContext['policy'],
): Promise<ContentPackInstallResult | null> {
  const state = await readContentPackState()
  const pack = state.packs[release.packId]
  const installed = pack?.versions[release.version]
  if (!installed || installed.pending_removal || installed.archive_sha256 !== release.archiveSha256) return null
  await verifyInstalledContentPackClosure(state, release.packId, release.version, policy)
  return {
    pack_id: release.packId,
    version: release.version,
    archive_sha256: release.archiveSha256,
    activated: pack.active_version === release.version,
    retained_versions: Object.keys(pack.versions).sort(),
  }
}

async function installOwnedEntitlement(
  entitlement: GenStudioContentRestoreEntitlement,
  context: DeliveryContext,
): Promise<ContentPackInstallResult> {
  const release = entitlement.currentRelease
  if (!release || !entitlement.downloadAvailable || !release.archiveAvailable) {
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
    await assertContentPackAppCompatible(release.minStoryVersion)
  } catch {
    throw new ContentStoreLocalError(
      409,
      'CONTENT_PACK_REQUIRES_NEWER_APP',
      `This release requires Story Studio ${release.minStoryVersion} or newer. Update Story Studio before installing it.`,
    )
  }
  const key = releaseKey(release)
  const completed = context.completed.get(key)
  if (completed) return completed
  if (context.visiting.has(key)) {
    throw new ContentStoreLocalError(409, 'CONTENT_PACK_DEPENDENCY_CYCLE', `The owned Content Pack dependency graph contains a cycle at ${key}.`)
  }
  const local = await alreadyInstalled(release, context.policy)
  if (local) {
    if (!local.activated) await rollbackContentPack(release.packId, release.version)
    const activated = { ...local, activated: true }
    context.completed.set(key, activated)
    return activated
  }

  context.visiting.add(key)
  try {
    const grant = await issueGenStudioContentDownload(context.apiKey, release.releaseId)
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
    const archiveBytes = await downloadGenStudioContentArchive(grant.downloadUrl, {
      archiveSha256: release.archiveSha256,
      archiveBytes: release.archiveBytes,
    })
    const verified = await verifyContentPackArchive(archiveBytes, context.policy)
    if (verified.manifest.pack_id !== release.packId || verified.manifest.version !== release.version) {
      throw new ContentStoreLocalError(409, 'CONTENT_PACK_REMOTE_IDENTITY_MISMATCH', 'The downloaded signed pack identity does not match the owned release.')
    }
    for (const dependency of verified.manifest.dependencies ?? []) {
      const dependencyEntitlement = context.receipts.entitlements.find(row =>
        row.currentRelease?.packId === dependency.pack_id && row.currentRelease.version === dependency.version)
      if (!dependencyEntitlement) {
        throw new ContentStoreLocalError(
          409,
          'CONTENT_PACK_DEPENDENCY_NOT_OWNED',
          `This pack requires owned dependency ${dependency.pack_id}@${dependency.version}, but GenStudio did not include that exact release in the verified library.`,
        )
      }
      await installOwnedEntitlement(dependencyEntitlement, context)
    }
    const installed = await installContentPack({
      archiveBytes,
      source: 'genstudio-store',
      expectedArchiveSha256: release.archiveSha256,
      expectedPackId: release.packId,
      expectedVersion: release.version,
    })
    const installedState = await readContentPackState()
    await verifyInstalledContentPackClosure(installedState, release.packId, release.version, context.policy)
    context.completed.set(key, installed)
    return installed
  } finally {
    context.visiting.delete(key)
  }
}

export async function installOwnedContentStoreRelease(releaseId: string): Promise<ContentStoreInstallResponse> {
  const verified = await fetchVerifiedOwnership()
  const entitlement = verified.receipts.entitlements.find(row => row.currentRelease?.releaseId === releaseId)
  if (!entitlement) {
    throw new ContentStoreLocalError(404, 'CONTENT_PACK_NOT_OWNED', 'The active GenStudio account does not own this release.')
  }
  const install = await installOwnedEntitlement(entitlement, {
    ...verified,
    policy: await getFirstPartyContentPackVerificationPolicy(),
    completed: new Map(),
    visiting: new Set(),
  })
  return { install, overview: await loadContentStoreOverview() }
}
