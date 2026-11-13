import { computed, readonly, ref, type Ref } from 'vue'
import { useApi } from './useApi'
import {
  clearStoredCatalog,
  contentAccountFingerprint,
  persistableCatalog,
  readStoredCatalog,
  restoredCatalogProducts,
  restoredCatalogShelves,
  storedCatalogFingerprint,
  writeStoredCatalog,
} from '../content-store/persisted-catalog'
import type { ContentStoreProductKind } from '../content-store/product-kinds'

// The wire kinds live in one leaf module so the persisted-catalogue reader and
// this composable cannot disagree about what a valid kind is (they did: the
// reader never learned `font_pack`, and one unrecognised product makes it
// discard the whole cached catalogue). Re-exported here because this module is
// where callers already import the type from.
export { CONTENT_STORE_PRODUCT_KINDS } from '../content-store/product-kinds'
export type { ContentStoreProductKind } from '../content-store/product-kinds'

export interface ContentStoreRelease {
  releaseId: string
  packId: string
  version: string
  archiveSha256: string
  archiveBytes: number
  archiveAvailable: boolean
  minStoryVersion: string
  changelog: string
  componentSummary: Record<string, unknown>
}

export type ContentStoreInstallPhase = 'queued' | 'downloading' | 'verifying' | 'installing' | 'complete' | 'failed'

export interface ContentStoreInstallOperation {
  operationId: string
  releaseId: string
  phase: ContentStoreInstallPhase
  downloadedBytes: number | null
  totalBytes: number | null
  failure: { code: string; detail: string } | null
  install: { pack_id: string; version: string; activated: boolean } | null
  updatedAt: string
}

export interface ContentStoreBundleComponent {
  productId: string
  entitlementFamily: string
  title: string
  kind: ContentStoreProductKind
}

export interface ContentStoreShowcaseVideo {
  url: string
  title: string
  description: string
}

export interface ContentStoreProductPresentation {
  cover: { src: string; alt: string } | null
  hero: { src: string; alt: string } | null
  licenseLabel: string | null
  licenseText: string | null
  tags: string[]
}

export interface ContentStoreShelf {
  id: string
  title: string
  productIds: string[]
}

export interface ContentStoreProduct {
  productId: string
  entitlementFamily: string
  kind: ContentStoreProductKind
  title: string
  summary: string
  description: string
  publisherId: string
  free: boolean
  /** This Gateway offers the pack to this Mac. Internal only: it is shown as availability, never as ownership. */
  owned: boolean
  retired: boolean
  successorProductId: string | null
  currentRelease: ContentStoreRelease | null
  compatible: boolean
  compatibilityReason: string | null
  bundleComponents: ContentStoreBundleComponent[]
  showcaseVideos: ContentStoreShowcaseVideo[]
  presentation: ContentStoreProductPresentation
}

/**
 * What the Gateway says this Mac may install, and how each release sits on it.
 *
 * Only the two ids are account facts; everything else is install state. The
 * field names are the wire's — the page never shows any of it as ownership.
 */
export interface ContentStoreAccount {
  accountId: string
  contentAccountId: string
  owned: Array<{
    entitlementFamily: string
    productId: string
    title: string
    kind: ContentStoreProductKind
    currentRelease: ContentStoreRelease | null
    showcaseVideos: ContentStoreShowcaseVideo[]
    recalledReleaseVersions: string[]
    downloadAvailable: boolean
    installState: 'not_installed' | 'installed_current' | 'installed_other_version' | 'update_available' | 'incomplete' | 'unavailable'
    installedVersion: string | null
    missingDependencies: Array<{ packId: string; version: string; reason: string }>
  }>
}

export interface ContentStoreInstalledPack {
  packId: string
  version: string
  active: boolean
  installState: 'installed_current' | 'incomplete'
  missingDependencies: Array<{ packId: string; version: string; reason: string }>
  productId: string
  title: string
  kind: ContentStoreProductKind | 'unknown'
}

/** What a channel pin move would change, read before anything is written. */
export interface ContentPackPinMovePlan {
  pack_id: string
  from: { pack_id: string; version: string; archive_sha256: string }
  to: { pack_id: string; version: string; archive_sha256: string }
  changed_item_ids: string[]
  affected_generation_types: string[]
}

/**
 * One part of the Studio Library, as the server could or could not answer it.
 *
 * `unavailable` is NOT an empty value: `code` and `reason` say what could not
 * be asked. "The Gateway does not serve the Studio Library" and "you own
 * nothing" must never render as the same screen.
 */
export interface ContentStoreSectionStatus {
  status: 'available' | 'unavailable'
  code?: string
  reason?: string
}

export interface ContentStoreOverviewSections {
  account: ContentStoreSectionStatus
  catalog: ContentStoreSectionStatus
  shelves: ContentStoreSectionStatus
  receipts: ContentStoreSectionStatus
  commerce: ContentStoreSectionStatus
  /** Applying the Gateway's "take this pack off installs" requests. */
  removals: ContentStoreSectionStatus
}

/**
 * The parts the page reports when the server could not answer them.
 *
 * `commerce` is deliberately absent: the shop is retired, nothing on the page
 * reads this Mac's old purchase journal, and a journal it cannot read must not
 * raise an error on a page that only installs packs.
 */
export const CONTENT_STORE_SECTION_KEYS = ['account', 'catalog', 'shelves', 'receipts', 'removals'] as const
export type ContentStoreSectionKey = typeof CONTENT_STORE_SECTION_KEYS[number]

interface ContentStoreOverview {
  phase: 'delivery_ready' | 'partial'
  origin: string
  /** Null only when the account section is unavailable. */
  account: ContentStoreAccount | null
  installed: ContentStoreInstalledPack[]
  products: ContentStoreProduct[]
  shelves: ContentStoreShelf[]
  capabilities: {
    purchase: false
    receipt_verification: true
    download: true
    install_after_purchase: false
    restore: true
  }
  sections: ContentStoreOverviewSections
}

/** One version Story Studio moved into its Trash. */
export interface ContentPackRemovalVersion {
  version: string
  install_path: string
  trash_path: string | null
  active: boolean
}

/**
 * What happened the last time this Mac dealt with one pack's removal.
 *
 * `kept_in_use` is a real outcome, not a failure: the Gateway or the customer
 * asked, and a channel still uses it. `channels` is what makes that actionable.
 */
export interface ContentPackRemovalEntry {
  pack_id: string
  removed_at: string
  outcome: 'removed' | 'kept_in_use' | 'failed'
  channels: string[]
  detail: string | null
  gateway_remove_at: string | null
  versions: ContentPackRemovalVersion[]
  restored_at: string | null
  reported_at: string | null
}

export interface ContentPackRemovalState {
  packs: Record<string, ContentPackRemovalEntry>
  /** Channels using each installed pack, read by the same reader the removal refuses on. */
  channels: Record<string, string[]>
  /** True when this Mac's removal records exist but cannot be read — not an empty list. */
  unreadable: boolean
}

export interface ContentStoreUiError {
  status: number | null
  code: string
  detail: string
  terminal?: boolean
  recallReason?: string | null
  recalledAt?: string | null
}

/** Local import limit; the backend enforces the same 50 MiB bound. */
export const CONTENT_PACK_IMPORT_MAX_BYTES = 50 * 1024 * 1024

/** The installed identity the local import response reports. */
export interface LocalContentPackInstall {
  packId: string
  version: string
}

export type GatewayArchiveIntegrity = 'verified' | 'unavailable' | 'unreadable'

/** Safe display metadata from the Gateway's authenticated archive bank. */
export interface GatewayContentArchive {
  archiveSha256: string
  bytes: number | null
  packId: string
  version: string
  title: string
  minAppVersion: string
  itemKinds: string[]
  integrity: GatewayArchiveIntegrity
}

export const GATEWAY_ARCHIVE_DIGEST_PATTERN = /^[a-f0-9]{64}$/

export interface ContentPackImportErrorPresentation {
  title: string
  detail: string
  recovery: string
}

/**
 * Copy for the Gateway archive shelf. `ownership` and `installable` from the
 * Gateway are deliberately absent: possessing a compatible archive is enough
 * for the shared local installer, which validates the bytes itself.
 */
export function gatewayArchiveErrorPresentation(
  error: ContentStoreUiError,
): ContentPackImportErrorPresentation {
  const failure = (title: string, recovery: string): ContentPackImportErrorPresentation =>
    ({ title, detail: error.detail, recovery })
  switch (error.code) {
    case 'CONTENT_PACK_GATEWAY_KEY_REQUIRED':
      return failure('Gateway access is needed', 'Open Settings → This Mac, save your Gateway API Key, then refresh archives.')
    case 'CONTENT_PACK_GATEWAY_CONFIG_UNAVAILABLE':
      return failure('The Gateway address could not be read', 'Open Settings → Connections, test the Gateway, then refresh archives.')
    case 'CONTENT_PACK_GATEWAY_UNREACHABLE':
      return failure('The Gateway is not answering', 'Open the Gateway app and check the connection in Settings, then try again.')
    case 'CONTENT_PACK_GATEWAY_REFUSED':
      return failure('The Gateway refused the saved API key', 'Check the Gateway API Key in Settings → This Mac, then try again.')
    case 'CONTENT_PACK_GATEWAY_ARCHIVE_UNAVAILABLE':
      return failure('That archive is no longer available', 'Refresh the Gateway archives and choose another copy.')
    case 'CONTENT_PACK_GATEWAY_ARCHIVE_MISMATCH':
      return failure('The downloaded archive did not match', 'Nothing was installed. Refresh the Gateway archives and try the install again.')
    case 'CONTENT_PACK_GATEWAY_ARCHIVE_TOO_LARGE':
      return failure('This archive is larger than the 50 MiB local limit', 'Choose a smaller Gateway archive.')
    case 'CONTENT_PACK_GATEWAY_ARCHIVE_EMPTY':
      return failure('The Gateway returned an empty archive', 'Nothing was installed. Refresh the Gateway archives and try another copy.')
    case 'CONTENT_PACK_GATEWAY_RESPONSE_INVALID':
    case 'CONTENT_PACK_GATEWAY_RESPONSE_TOO_LARGE':
      return failure('Gateway archives could not be read', 'Check the Gateway connection in Settings, then try again.')
    default:
      return failure('The Gateway archive could not be installed', 'Nothing was installed. Check the Gateway connection, then try again.')
  }
}

/** Copy for the local file install, which needs no Gateway, account or fresh catalog. */
export function contentPackImportErrorPresentation(
  error: ContentStoreUiError,
): ContentPackImportErrorPresentation {
  const failure = (title: string, recovery: string): ContentPackImportErrorPresentation =>
    ({ title, detail: error.detail, recovery })
  switch (error.code) {
    case 'CONTENT_PACK_IMPORT_TOO_LARGE':
      return failure('This archive is larger than the 50 MiB local limit', 'Choose a smaller .sspack archive and try again.')
    case 'CONTENT_PACK_IMPORT_EMPTY':
      return failure('This file is empty', 'Choose the .sspack archive you intend to install.')
    case 'CONTENT_PACK_IMPORT_RESPONSE_INVALID':
      return failure(
        'The installation result could not be read',
        'Check the library pickers. If the pack is not there, choose the .sspack file again.',
      )
    default:
      return {
        title: 'This Content Pack could not be installed',
        detail: error.detail,
        recovery: 'Story Studio did not confirm the installation. Check the file, then try again.',
      }
  }
}

export function contentPackImportUiError(
  cause: any,
  fallback = 'This Content Pack could not be installed.',
): ContentStoreUiError {
  const error = uiError(cause, fallback)
  // The local import route's size refusal carries only a detail, so name it
  // here. A Gateway archive already names its own 413 and keeps that code.
  return error.status === 413 && error.code === 'CONTENT_STORE_UNAVAILABLE'
    ? { ...error, code: 'CONTENT_PACK_IMPORT_TOO_LARGE', detail: 'This archive is larger than the 50 MiB local limit.' }
    : error
}

export interface ContentPackRecovery {
  incidentId: string
  kind: 'invalid_state_reset'
  detectedAt: string
}

export interface ContentPackRecoveryError {
  action: 'check' | 'dismiss'
  detail: string
}

/**
 * How much of what is on screen GenStudio has actually confirmed.
 *
 * - `'fresh'`   — GenStudio answered this session. Everything is verified and
 *                 installing is available.
 * - `'restored'`— the published catalogue saved on this Mac is drawn, and
 *                 NOTHING about this account is known yet. Ownership and
 *                 install state are unresolved, not negative.
 * - `'cached'`  — GenStudio verified this session and a later fetch failed, so
 *                 the last verified catalogue stays up and is labelled stale.
 * - `'unavailable'` — there is nothing trustworthy to show.
 *
 * Only `'fresh'` enables Gateway actions; `networkActionsDisabled` on the
 * Library page is `catalogFreshness !== 'fresh'`, so `'restored'` disables
 * Gateway download, install and the ownership re-check without needing a flag
 * of its own. The local file install is deliberately outside that gate.
 */
export type ContentStoreCatalogFreshness = 'fresh' | 'restored' | 'cached' | 'unavailable'

/**
 * How long a verified overview may back a SILENT background revalidation.
 *
 * Every `refresh()` still goes to the network with `cache: 'no-store'` — this
 * TTL never suppresses a fetch, and no ownership or install state is
 * ever served from a store that was not just verified. All it decides is
 * whether re-opening the Store is allowed to look calm while that fetch runs.
 *
 * Five minutes is chosen against what actually changes underneath: ownership
 * and install state only move through this app's own install and ownership
 * re-check paths, and each of those forces its own visible refetch. What can
 * move without Story Studio knowing is the published catalogue, and that is
 * not worth a loading state a customer sees on every visit. Past five minutes
 * we stop being quiet: the fetch is identical, but
 * the page says it is refreshing, because figures from an unbounded time ago
 * should not be presented as if nobody were re-checking them.
 */
export const CONTENT_STORE_CACHE_TTL_MS = 5 * 60_000

/** Identity attached to a historical proof; it is never current-account state. */
export interface ContentStoreCachedProof {
  accountId: string
  origin: string
  verifiedAt: string
}

export interface ContentStoreErrorPresentation {
  title: string
  detail: string
  recovery: string
  settingsAction: boolean
}

/** Maps the backend's public, exact error codes to recovery copy without inventing facts. */
export function contentStoreErrorPresentation(error: ContentStoreUiError): ContentStoreErrorPresentation {
  const failure = (title: string, recovery: string, settingsAction = false): ContentStoreErrorPresentation => ({ title, detail: error.detail, recovery, settingsAction })
  switch (error.code) {
    case 'GATEWAY_UNREACHABLE': return failure('The Gateway is not answering', 'Open the Gateway app, then press Refresh store. Nothing was bought or changed.', true)
    // A Gateway that answers but does not serve these endpoints is not a broken
    // Story Studio and not a refused key — it is a Gateway that does not offer
    // the Studio Library (or offers a shape this build cannot read).
    case 'CONTENT_STORE_NOT_SERVED': return failure('This Gateway does not serve the Studio Library', 'Update the Gateway app, or check its address in Settings → Connections, then refresh.', true)
    case 'CONTENT_STORE_RESPONSE_INVALID': return failure('The Gateway’s Studio Library answer could not be read', 'Update the Gateway app so it serves this Studio Library version, then refresh.', true)
    case 'CONTENT_STORE_GATEWAY_FAILED': return failure('The Gateway could not serve the Studio Library', 'Try again in a moment. If it keeps happening, check the Gateway in Settings → Connections.', true)
    case 'CONTENT_STORE_LOCAL_STATE_UNAVAILABLE': return failure('This Mac’s Studio Library records could not be read', 'Check that the disk has space and Story Studio can write its data folder, then restart Story Studio.')
    case 'CONTENT_STORE_KEY_REQUIRED':
    case 'CONTENT_STORE_SCOPE_REQUIRED': return failure('Studio Library access is needed', 'Open Settings and test the Studio Library scope, then refresh.', true)
    case 'CONTENT_STORE_SIGNING_KEY_MISSING': return failure('Studio Library access is needed', 'The Studio Library did not publish the signing key this Mac needs. Refresh later.')
    case 'CONTENT_PRODUCT_NOT_AVAILABLE': return failure('This product is not available', 'Refresh the Library to see currently published products.')
    case 'CONTENT_PRODUCT_ALREADY_OWNED': return failure('This is already available to this Mac', 'Refresh the Library to see its current install state.')
    case 'CONTENT_PRODUCT_RETIRED': return failure('This product is retired', 'Choose a currently published product instead.')
    case 'CONTENT_PRODUCT_INCOMPATIBLE':
    case 'incompatible_story_version': return failure('A newer Story Studio version is needed', 'Update Story Studio before requesting this release.')
    case 'CONTENT_RELEASE_NOT_AVAILABLE': return failure('This release is not available', 'Refresh the Library and choose a published release.')
    case 'CONTENT_STORE_QUOTE_NOT_FOUND': return failure('This quote is no longer available', 'Close it and start again.')
    case 'CONTENT_PURCHASE_NOT_SENT': return failure('This request was not sent', 'Try again when the Gateway is available.')
    case 'quote_expired':
    case 'quote_rejected': return failure('This quote can no longer be used', 'Close it and start again.')
    case 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN': return failure('The Studio Library’s answer is uncertain', 'Retry this request; Story Studio will reuse its saved attempt.')
    case 'signing_unavailable': return failure('The Studio Library is not open yet', 'Try again after the Studio Library can sign its answer.')
    case 'CONTENT_STORE_ACCOUNT_MISMATCH':
    case 'CONTENT_PURCHASE_ACCOUNT_MISMATCH':
    case 'CONTENT_PACK_OWNED_RELEASE_MISMATCH':
    case 'CONTENT_PACK_NOT_OWNED':
    case 'not_entitled': return failure('This Mac could not confirm availability', 'Refresh the Library to ask the Gateway again.')
    case 'download_grant_expired': return failure('The download authorization expired', 'Install again to receive a new authorization.')
    case 'archive_limit_exceeded':
    case 'CONTENT_PACK_TOO_LARGE_FOR_THIS_APP': return failure('This archive is too large to install safely', 'Choose another published release or contact the publisher.')
    case 'CONTENT_PACK_REQUIRES_NEWER_APP': return failure('A newer Story Studio version is needed', 'Update Story Studio before installing this release.')
    case 'CONTENT_PACK_ARCHIVE_UNAVAILABLE': return failure('This archive is not available', 'Refresh the Library and try again later.')
    // A retired family keeps its bytes but GenStudio withdraws the download.
    // Saying "retired" is the true reason; refreshing cannot change it.
    case 'CONTENT_PACK_DOWNLOAD_WITHDRAWN': return failure('This Content Pack can no longer be downloaded', 'The Studio Library retired this pack. A copy already installed on this Mac keeps working.')
    case 'CONTENT_PACK_SIGNATURE_INVALID':
    case 'CONTENT_PACK_ARCHIVE_HASH_MISMATCH':
    case 'CONTENT_PACK_SCHEMA_INVALID':
    case 'CONTENT_PACK_ASSET_INVALID': return failure('This Content Pack could not be verified', 'Do not retry this archive; refresh for a safe published release.')
    // Refreshing cannot clear this one. A restore receipt is minted fresh on
    // every call, so a refresh produces a byte-for-byte identical attestation
    // and the same refusal -- and the customer who is told to refresh does it
    // repeatedly, believing the next one will differ. The mismatch is between
    // this pack's required versions and what GenStudio's receipt attests to,
    // and only GenStudio can change that.
    case 'CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH': return failure('The Studio Library has not attested to the versions this pack requires', 'Refreshing will not clear this. Install the newest release of this pack, or contact the publisher.')
    case 'CONTENT_PACK_DEPENDENCY_CYCLE':
    case 'CONTENT_PACK_DEPENDENCY_NOT_OWNED':
    case 'CONTENT_PACK_NESTED_CLOSURE_UNSUPPORTED': return failure('This Content Pack cannot be installed', 'Refresh the Library and its required dependencies before trying again.')
    case 'CONTENT_PACK_RECEIPT_MISSING':
    case 'CONTENT_PACK_REMOTE_IDENTITY_MISMATCH': return failure('This Content Pack could not be verified', 'Refresh the Library, then try installing again.')
    case 'release_recalled': return failure('A Content Pack release was recalled', 'Install the newest release the Gateway still serves, when one is available.')
    case 'CONTENT_PACK_DISK_UNAVAILABLE':
    case 'CONTENT_PACK_STAGING_FAILED':
    case 'CONTENT_PACK_ACTIVATION_FAILED': return failure('This Mac could not prepare the install', 'Check available disk space, then install it again.')
    case 'CONTENT_STORE_REQUEST_INVALID':
    case 'CONTENT_STORE_REQUEST_TOO_LARGE': return failure('This Studio Library request is invalid', 'Refresh the Library and try the action again.')
    case 'CONTENT_STORE_UPSTREAM_REFUSED': return failure('The Studio Library could not complete this request', 'Refresh the Library before trying again.')
    // The install failed for a reason Story could not classify. That is NOT a
    // refusal by GenStudio, and calling it one told the customer the Gateway had
    // said no when nothing was ever refused (2026-10-30).
    case 'CONTENT_STORE_INSTALL_FAILED': return failure('This Content Pack could not be installed', 'Try again. If it keeps happening, check the Gateway in Settings → Connections.')
    // The limit lives in the installed build, so refreshing cannot clear it --
    // only a version with a larger bound can. On 2026-08-25 this fell to the
    // default below and told the owner his whole Store was "unavailable" while
    // every count sat at zero, which is a day of guessing instead of a sentence.
    case 'CONTENT_STORE_PAYLOAD_TOO_LARGE': return failure('The Studio Library sent more than this version can read', 'Update Story Studio; refreshing will not clear this.')
    default: return failure('The Studio Library is unavailable', 'Refresh the Library before trying again.')
  }
}

let sessionOverview: { accountId: string; origin: string; verifiedAt: string } | null = null
const sharedAccount = ref<ContentStoreAccount | null>(null)
const sharedProducts = ref<ContentStoreProduct[]>([])
const sharedInstalled = ref<ContentStoreInstalledPack[]>([])
const sharedShelves = ref<ContentStoreShelf[]>([])
const sharedCatalogFreshness = ref<ContentStoreCatalogFreshness>('unavailable')
const sharedLastVerifiedAt = ref<string | null>(null)
const sharedLastVerifiedProof = ref<ContentStoreCachedProof | null>(null)
const sharedRecovery = ref<ContentPackRecovery | null>(null)
const sharedRecoveryError = ref<ContentPackRecoveryError | null>(null)
const sharedRemovals = ref<ContentPackRemovalState | null>(null)
const sharedSectionStates = ref<ContentStoreOverviewSections | null>(null)
/** True once an overview has answered: the installed list is read from this Mac. */
const sharedInstallsResolved = ref(false)
const sharedCachedProof = computed<ContentStoreCachedProof | null>(() =>
  sharedCatalogFreshness.value === 'cached' ? sharedLastVerifiedProof.value : null)
/**
 * False for exactly one state: a catalogue restored from disk, before
 * GenStudio has answered. Every surface that would otherwise show ownership
 * or install state must show that it is still being checked instead.
 * An unverified absence is not the same fact as "you do not own this", and
 * rendering it as one is the mistake this flag exists to prevent.
 *
 * The account section can also answer "could not ask" — a Gateway that does not
 * serve the Studio Library, a refused key — and that is not an ownership answer
 * either, so it holds this false too.
 */
const sharedOwnershipResolved = computed<boolean>(() =>
  sharedCatalogFreshness.value !== 'restored' && sharedAccountResolved.value)
/** Whether the last answer carried this account's ownership at all. */
const sharedAccountResolved = computed<boolean>(() =>
  sharedSectionStates.value?.account.status === 'available')
/** Each part the server could not answer, in the order the page shows them. */
const sharedUnavailableSections = computed<Array<{ section: ContentStoreSectionKey; code: string; reason: string }>>(() =>
  CONTENT_STORE_SECTION_KEYS
    .map(section => ({ section, state: sharedSectionStates.value?.[section] }))
    .filter((entry): entry is { section: ContentStoreSectionKey; state: ContentStoreSectionStatus & { status: 'unavailable' } } =>
      entry.state?.status === 'unavailable')
    .map(({ section, state }) => ({ section, code: state.code ?? 'CONTENT_STORE_UNAVAILABLE', reason: state.reason ?? 'This part of the Studio Library could not be read.' })))

let sharedOverviewGeneration = 0
let sharedRecoveryGeneration = 0
let catalogHydrationAttempted = false
let lastCatalogPersist: Promise<void> = Promise.resolve()

/**
 * True while a verified catalog is on screen and still inside its TTL.
 *
 * `'fresh'` is the only freshness that qualifies: `'cached'` already means the
 * last fetch failed and the page is showing the stale-catalog notice, and a
 * revalidation out of that state must be visible, not quiet. A verified-at
 * stamp in the future is treated as not warm rather than trusted — a skewed
 * clock is not evidence of freshness.
 */
function warmVerifiedCatalog(now: number): boolean {
  if (sharedCatalogFreshness.value !== 'fresh') return false
  const verifiedAt = sharedLastVerifiedAt.value
  if (!verifiedAt) return false
  const age = now - Date.parse(verifiedAt)
  return Number.isFinite(age) && age >= 0 && age < CONTENT_STORE_CACHE_TTL_MS
}

/**
 * Draw the published catalogue saved on this Mac, once, before the first fetch.
 *
 * Only the catalogue is restored. `sharedAccount` and `sharedInstalled` stay
 * empty and `sharedLastVerifiedAt` stays null, because
 * nothing here was verified this session and `lastVerifiedAt` means exactly
 * that. Freshness becomes `'restored'`, which keeps Gateway actions switched
 * off and tells every surface to say it is still checking.
 *
 * Nothing runs if a live overview has already landed — a real answer is never
 * replaced by a saved one.
 */
function hydrateRestoredCatalog(): void {
  if (catalogHydrationAttempted) return
  catalogHydrationAttempted = true
  if (sharedCatalogFreshness.value !== 'unavailable') return
  const stored = readStoredCatalog()
  if (!stored) return
  sharedProducts.value = restoredCatalogProducts(stored)
  sharedShelves.value = restoredCatalogShelves(stored)
  sharedCatalogFreshness.value = 'restored'
}

/**
 * Save the catalogue GenStudio just published, and only the catalogue.
 *
 * Runs after the shared state is already updated, so a slow or failing write
 * can never delay or break what is on screen. If the account that wrote the
 * saved catalogue is not the account GenStudio just verified, the saved one is
 * deleted before anything replaces it — so even if this write then fails, the
 * other account's catalogue is gone rather than left behind. Web Crypto
 * missing means no fingerprint, which means no way to detect an account
 * change, which means we decline to save at all.
 */
async function persistVerifiedCatalog(
  overview: ContentStoreOverview & { account: ContentStoreAccount },
  origin: string,
): Promise<void> {
  const fingerprint = await contentAccountFingerprint({
    accountId: overview.account.accountId,
    contentAccountId: overview.account.contentAccountId,
    origin,
  })
  if (!fingerprint) { clearStoredCatalog(); return }
  const existing = storedCatalogFingerprint()
  if (existing !== null && existing !== fingerprint) clearStoredCatalog()
  writeStoredCatalog(persistableCatalog({
    products: overview.products,
    shelves: overview.shelves,
    accountFingerprint: fingerprint,
    capturedAt: new Date().toISOString(),
  }))
}

/** Resolves once the fire-and-forget catalogue save has finished, so tests need no sleep. */
export function _contentStoreCatalogPersistedForTests(): Promise<void> {
  return lastCatalogPersist
}

export function _clearContentStoreSessionCacheForTests(): void {
  sessionOverview = null
  sharedAccount.value = null
  sharedProducts.value = []
  sharedInstalled.value = []
  sharedShelves.value = []
  sharedCatalogFreshness.value = 'unavailable'
  sharedLastVerifiedAt.value = null
  sharedLastVerifiedProof.value = null
  sharedSectionStates.value = null
  sharedInstallsResolved.value = false
  sharedRecovery.value = null
  sharedRecoveryError.value = null
  sharedRemovals.value = null
  sharedOverviewGeneration = 0
  sharedRecoveryGeneration = 0
  catalogHydrationAttempted = false
  clearStoredCatalog()
}

function uiError(cause: any, fallback: string): ContentStoreUiError {
  const data = cause?.data || cause?.response?._data || {}
  return {
    status: Number.isInteger(cause?.status) ? cause.status
      : Number.isInteger(cause?.response?.status) ? cause.response.status
        : null,
    code: typeof data.code === 'string' ? data.code : 'CONTENT_STORE_UNAVAILABLE',
    detail: typeof data.detail === 'string' ? data.detail
      : typeof cause?.message === 'string' ? cause.message : fallback,
    ...(data.terminal === true ? { terminal: true } : {}),
    ...(typeof data.recall_reason === 'string' || data.recall_reason === null
      ? { recallReason: data.recall_reason as string | null } : {}),
    ...(typeof data.recalled_at === 'string' || data.recalled_at === null
      ? { recalledAt: data.recalled_at as string | null } : {}),
  }
}

function localImportFailure(code: string, detail: string): Error {
  return Object.assign(new Error(detail), { data: { code, detail } })
}

function gatewayArchiveFailure(code: string, detail: string): Error {
  return Object.assign(new Error(detail), { data: { code, detail } })
}

/** Read the safe projection the Story backend sends for the Gateway archive bank. */
function normalizeGatewayArchives(response: unknown): GatewayContentArchive[] {
  const body = response as { archives?: unknown } | null
  if (!body || typeof body !== 'object' || !Array.isArray(body.archives)) {
    throw gatewayArchiveFailure(
      'CONTENT_PACK_GATEWAY_RESPONSE_INVALID',
      'Story Studio could not read the Gateway archive list.',
    )
  }
  const archives: GatewayContentArchive[] = []
  for (const value of body.archives) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const archiveSha256 = typeof row.archiveSha256 === 'string' ? row.archiveSha256 : ''
    if (!GATEWAY_ARCHIVE_DIGEST_PATTERN.test(archiveSha256)) continue
    const itemKinds = Array.isArray(row.itemKinds)
      ? [...new Set(row.itemKinds
        .filter((kind): kind is string => typeof kind === 'string')
        .map(kind => kind.trim().slice(0, 64))
        .filter(Boolean))].slice(0, 12)
      : []
    archives.push({
      archiveSha256,
      bytes: typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes >= 0
        ? row.bytes
        : null,
      packId: typeof row.packId === 'string' ? row.packId.trim().slice(0, 160) : '',
      version: typeof row.version === 'string' ? row.version.trim().slice(0, 64) : '',
      title: typeof row.title === 'string' ? row.title.trim().slice(0, 200) : '',
      minAppVersion: typeof row.minAppVersion === 'string' ? row.minAppVersion.trim().slice(0, 64) : '',
      itemKinds,
      integrity: row.integrity === 'verified' || row.integrity === 'unavailable'
        ? row.integrity
        : 'unreadable',
    })
  }
  return archives
}

/**
 * The import route returns the existing `ContentPackInstallResult` shape flat:
 * `{ pack_id, version, archive_sha256, activated, retained_versions }`.
 */
function normalizeImportedPack(response: unknown): LocalContentPackInstall {
  const install = (response ?? {}) as { pack_id?: unknown; version?: unknown }
  if (typeof install.pack_id !== 'string' || install.pack_id.length === 0
    || typeof install.version !== 'string' || install.version.length === 0) {
    throw localImportFailure(
      'CONTENT_PACK_IMPORT_RESPONSE_INVALID',
      'Story Studio could not read which pack and version the server reported, so the installation is unconfirmed.',
    )
  }
  return { packId: install.pack_id, version: install.version }
}

export function useContentStore(): {
  account: Readonly<Ref<ContentStoreAccount | null>>
  products: Readonly<Ref<ContentStoreProduct[]>>
  installed: Readonly<Ref<ContentStoreInstalledPack[]>>
  shelves: Readonly<Ref<ContentStoreShelf[]>>
  catalogFreshness: Readonly<Ref<ContentStoreCatalogFreshness>>
  ownershipResolved: Readonly<Ref<boolean>>
  /** Whether the last answer carried this account's ownership at all. */
  accountResolved: Readonly<Ref<boolean>>
  /** True once an answer has arrived: the installed list is read from this Mac. */
  installsResolved: Readonly<Ref<boolean>>
  /** Each part of the Studio Library the server could not answer, and why. */
  unavailableSections: Readonly<Ref<Array<{ section: ContentStoreSectionKey; code: string; reason: string }>>>
  lastVerifiedAt: Readonly<Ref<string | null>>
  cachedProof: Readonly<Ref<ContentStoreCachedProof | null>>
  recovery: Readonly<Ref<ContentPackRecovery | null>>
  recoveryError: Readonly<Ref<ContentPackRecoveryError | null>>
  /** Installed-pack usage and removal records. Null until this Mac has answered. */
  removals: Readonly<Ref<ContentPackRemovalState | null>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<ContentStoreUiError | null>>
  refresh: (options?: { background?: boolean }) => Promise<void>
  refreshRecovery: () => Promise<void>
  dismissRecovery: (incidentId: string) => Promise<void>
  refreshRemovals: () => Promise<void>
  removePack: (packId: string) => Promise<void>
  restorePack: (packId: string) => Promise<void>
  planPinMove: (packId: string, projectSlug: string) => Promise<ContentPackPinMovePlan>
  applyPinMove: (packId: string, projectSlug: string) => Promise<ContentPackPinMovePlan>
  uninstallPackVersion: (packId: string, version: string) => Promise<void>
  installRelease: (releaseId: string, options?: { refreshOverview?: boolean; onProgress?: (operation: ContentStoreInstallOperation) => void }) => Promise<{ pack_id: string; version: string; activated: boolean }>
  importPack: (archive: ArrayBuffer) => Promise<LocalContentPackInstall>
  listGatewayArchives: () => Promise<GatewayContentArchive[]>
  installGatewayArchive: (digest: string) => Promise<LocalContentPackInstall>
} {
  const { get, post, del } = useApi()
  const loading = ref(false)
  const error = ref<ContentStoreUiError | null>(null)
  // Before the first render, not after it: the whole point is that the Store
  // paints its catalogue without ever showing an empty frame.
  hydrateRestoredCatalog()

  function beginOverviewRequest(): number { sharedOverviewGeneration += 1; return sharedOverviewGeneration }
  function beginRecoveryRequest(): number { sharedRecoveryGeneration += 1; return sharedRecoveryGeneration }
  function applyOverview(overview: ContentStoreOverview, generation: number): void {
    if (generation !== sharedOverviewGeneration) return
    const verifiedAt = new Date().toISOString()
    const origin = overview.origin
    if (!origin) {
      sessionOverview = null
      sharedLastVerifiedProof.value = null
      return
    }
    // Vue batches these synchronous assignments, so every mounted consumer
    // observes one verified account/origin snapshot rather than mixed facts.
    const sections = overview.sections
    const accountReady = sections.account.status === 'available'
    const catalogReady = sections.catalog.status === 'available'
    const hadVerifiedThisSession = sharedLastVerifiedAt.value !== null
    // A part the server could not answer NEVER overwrites a catalogue this
    // session already verified, and never leaves an empty list in its place:
    // the section states below are what says it could not be asked.
    // The ACCOUNT is different: `null` on the wire means "could not ask", so a
    // stale ownership snapshot is dropped rather than presented as the
    // current answer. `ownershipResolved` stays false, so nothing renders that
    // as "you own nothing".
    sharedAccount.value = accountReady ? overview.account : null
    if (catalogReady) {
      sharedProducts.value = overview.products
      sharedShelves.value = overview.shelves
    }
    // Installed packs are read from this Mac, so they answer whether or not the
    // Gateway can be asked — but only an answer that carried a list is trusted.
    sharedInstalled.value = overview.installed ?? []
    sharedInstallsResolved.value = true
    sharedSectionStates.value = sections
    if (catalogReady) {
      sharedCatalogFreshness.value = 'fresh'
      sharedLastVerifiedAt.value = verifiedAt
    } else {
      // Keep a catalogue already on screen, and label where it came from.
      sharedCatalogFreshness.value = hadVerifiedThisSession ? 'cached'
        : sharedCatalogFreshness.value === 'restored' ? 'restored' : 'unavailable'
      if (!hadVerifiedThisSession) sharedLastVerifiedAt.value = null
    }
    const account = overview.account
    if (account) {
      if (sessionOverview && (sessionOverview.accountId !== account.accountId || sessionOverview.origin !== origin)) sessionOverview = null
      sessionOverview = { accountId: account.accountId, origin, verifiedAt }
    } else {
      sessionOverview = null
      sharedLastVerifiedProof.value = null
    }
    if (accountReady && catalogReady && account) {
      sharedLastVerifiedProof.value = { accountId: account.accountId, origin, verifiedAt }
      lastCatalogPersist = persistVerifiedCatalog({ ...overview, account }, origin).catch(() => {
        // Saving the catalogue is an optimisation for the next launch. It must
        // never turn a verified overview that is already on screen into an error.
      })
    }
    // A partial answer is not a failure, but it is not silence either: the page
    // shows the first part that could not be asked with its own words.
    const firstUnavailable = sharedUnavailableSections.value[0]
    error.value = firstUnavailable
      ? { status: null, code: firstUnavailable.code, detail: firstUnavailable.reason }
      : null
  }

  /**
   * Read the overview from GenStudio. Always a real fetch, never a cache read.
   *
   * `background: true` is a request to stay quiet, not permission to skip the
   * network. It is honoured only while `warmVerifiedCatalog()` holds, so a cold
   * start, an expired cache and the explicit Refresh store button all load in
   * the open. When it is honoured, a failure does not raise an error box: the
   * catalog falls to `'cached'`, which is the page's own "last verified catalog,
   * purchase and install disabled" notice. Good data already on screen is not
   * worth replacing with an alert, but it is never presented as fresh either.
   */
  async function refresh(options: { background?: boolean } = {}): Promise<void> {
    const generation = beginOverviewRequest()
    const silent = options.background === true && warmVerifiedCatalog(Date.now())
    if (!silent) {
      loading.value = true
      error.value = null
    }
    try {
      const overview = await get<ContentStoreOverview>('/content-store', { cache: 'no-store' })
      // `applyOverview` owns `error` from here: a partial answer is a 200 whose
      // unavailable sections are the notice, so clearing it would hide them.
      applyOverview(overview, generation)
    } catch (cause: any) {
      if (generation === sharedOverviewGeneration) {
        const hasVerifiedOverview = sharedLastVerifiedAt.value !== null
        // A launch with no network keeps the saved catalogue up rather than
        // throwing away the one thing it can honestly show. It stays
        // `'restored'` — not `'cached'`, which promises a catalogue GenStudio
        // verified in this session, and which this is not.
        const hasRestoredCatalog = sharedCatalogFreshness.value === 'restored'
        if (!hasVerifiedOverview && !hasRestoredCatalog) {
          sharedAccount.value = null
          sharedProducts.value = []
          sharedInstalled.value = []
          sharedShelves.value = []
        }
        sharedCatalogFreshness.value = hasVerifiedOverview ? 'cached' : hasRestoredCatalog ? 'restored' : 'unavailable'
        if (!silent) error.value = uiError(cause, 'The Studio Library could not be loaded.')
      }
      throw cause
    } finally {
      if (!silent) loading.value = false
    }
  }

  /** This local recovery check has no dependency on a remote Store overview. */
  async function refreshRecovery(): Promise<void> {
    const generation = beginRecoveryRequest()
    try {
      const response = await get<{ recovery: ContentPackRecovery | null }>('/content-packs/recovery', { cache: 'no-store' })
      if (generation !== sharedRecoveryGeneration) return
      sharedRecovery.value = response.recovery
      sharedRecoveryError.value = null
    } catch (cause: any) {
      if (generation !== sharedRecoveryGeneration) return
      sharedRecoveryError.value = { action: 'check', detail: uiError(cause, 'Your Content Pack recovery notice could not be read.').detail }
    }
  }

  async function dismissRecovery(incidentId: string): Promise<void> {
    const generation = beginRecoveryRequest()
    try {
      const response = await del<{ ok: true }>(`/content-packs/recovery/${encodeURIComponent(incidentId)}`)
      if (response?.ok !== true) throw new Error('This recovery notice could not be dismissed.')
      // Invalidate every in-flight read, including one that began while this
      // exact dismissal was pending, before it can restore the old incident.
      sharedRecoveryGeneration += 1
      if (sharedRecovery.value?.incidentId === incidentId) sharedRecovery.value = null
      sharedRecoveryError.value = null
    } catch (cause: any) {
      if (generation === sharedRecoveryGeneration) {
        sharedRecoveryError.value = { action: 'dismiss', detail: uiError(cause, 'This recovery notice could not be dismissed.').detail }
      }
      throw cause
    }
  }

  /**
   * This Mac's own answer: which channels use each installed pack, and what
   * happened the last time one was removed. No Gateway request.
   *
   * A read that fails leaves `removals` null, which the page renders as "could
   * not read" — never as "nothing was removed".
   */
  async function refreshRemovals(): Promise<void> {
    try {
      sharedRemovals.value = await get<ContentPackRemovalState>('/content-packs/removals', { cache: 'no-store' })
    } catch (cause: any) {
      sharedRemovals.value = null
      throw cause
    }
  }

  async function removePack(packId: string): Promise<void> {
    await post(`/content-packs/${encodeURIComponent(packId)}/remove`)
    await Promise.all([
      refreshRemovals().catch(() => { /* the page keeps the refusal it already shows */ }),
      refresh({ background: true }).catch(() => { /* the install list refreshes on the next read */ }),
    ])
  }

  async function restorePack(packId: string): Promise<void> {
    await post(`/content-packs/${encodeURIComponent(packId)}/restore`)
    await Promise.all([
      refreshRemovals().catch(() => {}),
      refresh({ background: true }).catch(() => {}),
    ])
  }

  /** Read the move first; this writes nothing. */
  async function planPinMove(packId: string, projectSlug: string): Promise<ContentPackPinMovePlan> {
    return post<ContentPackPinMovePlan>(
      `/content-packs/${encodeURIComponent(packId)}/pin-move/plan`,
      { project_slug: projectSlug },
    )
  }

  async function applyPinMove(packId: string, projectSlug: string): Promise<ContentPackPinMovePlan> {
    return post<ContentPackPinMovePlan>(
      `/content-packs/${encodeURIComponent(packId)}/pin-move/apply`,
      { project_slug: projectSlug },
    )
  }

  async function uninstallPackVersion(packId: string, version: string): Promise<void> {
    await post(`/content-packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(version)}/uninstall`)
    await Promise.all([
      refreshRemovals().catch(() => {}),
      refresh({ background: true }).catch(() => {}),
    ])
  }

  async function installRelease(
    releaseId: string,
    options: { refreshOverview?: boolean; onProgress?: (operation: ContentStoreInstallOperation) => void } = {},
  ): Promise<{ pack_id: string; version: string; activated: boolean }> {
    // `refreshOverview: false` is the queue's form: the server skips the
    // ~5 s overview rebuild per pack and the queue refreshes once at the end.
    // No overview will be applied, so no generation is claimed either — a
    // claimed generation would silently discard the queue's own background
    // refresh that lands while the next install is already in flight.
    const wantsOverview = options.refreshOverview !== false
    const generation = wantsOverview ? beginOverviewRequest() : sharedOverviewGeneration
    error.value = null
    try {
      const useBackgroundOperation = Boolean(options.onProgress) && !wantsOverview
      const query = useBackgroundOperation ? '?overview=0&async=1' : (wantsOverview ? '' : '?overview=0')
      const response = await post<{
        install: { pack_id: string; version: string; activated: boolean }
        overview: ContentStoreOverview | null
      } | { operation: ContentStoreInstallOperation }>(`/content-store/releases/${encodeURIComponent(releaseId)}/install${query}`, {})
      if ('operation' in response) {
        let operation = response.operation
        options.onProgress?.(operation)
        while (!['complete', 'failed'].includes(operation.phase)) {
          await new Promise<void>(resolve => setTimeout(resolve, 1_000))
          try {
            const monitor = await get<{ operation: ContentStoreInstallOperation }>(`/content-store/installs/${encodeURIComponent(operation.operationId)}`, { cache: 'no-store' })
            operation = monitor.operation
            options.onProgress?.(operation)
          } catch (cause: any) {
            const status = Number(cause?.status ?? cause?.response?.status ?? cause?.data?.status)
            // A transient monitor failure says nothing about the signed server
            // install, which keeps running independently of this route.
            if (status === 404) throw cause
          }
        }
        if (operation.phase === 'failed' || !operation.install) {
          const failure = operation.failure || { code: 'CONTENT_STORE_INSTALL_FAILED', detail: 'This Content Pack could not be installed.' }
          throw Object.assign(new Error(failure.detail), { data: failure })
        }
        return operation.install
      }
      if (wantsOverview && response.overview) applyOverview(response.overview, generation)
      return response.install
    } catch (cause: any) {
      const installError = uiError(cause, 'This owned Content Pack could not be installed.')
      error.value = installError
      if (installError.code === 'release_recalled') {
        try {
          applyOverview(await get<ContentStoreOverview>('/content-store', { cache: 'no-store' }), generation)
        } catch {
          // Preserve the terminal recall. A failed read refresh is not permission to retry the recalled version.
        }
        error.value = installError
      }
      throw cause
    }
  }

  /** Install a `.sspack` chosen from this Mac. No Gateway overview or account is read. */
  async function importPack(archive: ArrayBuffer): Promise<LocalContentPackInstall> {
    const bytes = typeof archive?.byteLength === 'number' ? archive.byteLength : 0
    if (bytes <= 0) {
      throw localImportFailure('CONTENT_PACK_IMPORT_EMPTY', 'The chosen file is empty.')
    }
    if (bytes > CONTENT_PACK_IMPORT_MAX_BYTES) {
      const mib = (bytes / (1024 * 1024)).toFixed(1)
      throw localImportFailure(
        'CONTENT_PACK_IMPORT_TOO_LARGE',
        `This archive is ${mib} MiB; local installs are limited to 50 MiB.`,
      )
    }
    const response = await post<unknown>('/content-packs/import', archive, {
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    return normalizeImportedPack(response)
  }

  /** Browse the Gateway's archive bank. This is not a Store account or shelf read. */
  async function listGatewayArchives(): Promise<GatewayContentArchive[]> {
    const response = await get<unknown>('/content-packs/gateway-archives', { cache: 'no-store' })
    return normalizeGatewayArchives(response)
  }

  /** Download one exact Gateway archive and pass its bytes to the same local installer. */
  async function installGatewayArchive(digest: string): Promise<LocalContentPackInstall> {
    if (typeof digest !== 'string' || !GATEWAY_ARCHIVE_DIGEST_PATTERN.test(digest)) {
      throw gatewayArchiveFailure(
        'CONTENT_PACK_GATEWAY_DIGEST_INVALID',
        'Choose a valid Gateway archive digest.',
      )
    }
    const response = await post<unknown>(`/content-packs/gateway-archives/${digest}/install`)
    return normalizeImportedPack(response)
  }

  return {
    account: readonly(sharedAccount) as unknown as Readonly<Ref<ContentStoreAccount | null>>,
    products: readonly(sharedProducts) as unknown as Readonly<Ref<ContentStoreProduct[]>>,
    installed: readonly(sharedInstalled) as unknown as Readonly<Ref<ContentStoreInstalledPack[]>>,
    shelves: readonly(sharedShelves) as unknown as Readonly<Ref<ContentStoreShelf[]>>,
    catalogFreshness: readonly(sharedCatalogFreshness),
    ownershipResolved: readonly(sharedOwnershipResolved),
    accountResolved: readonly(sharedAccountResolved),
    installsResolved: readonly(sharedInstallsResolved),
    unavailableSections: sharedUnavailableSections as unknown as Readonly<Ref<Array<{ section: ContentStoreSectionKey; code: string; reason: string }>>>,
    lastVerifiedAt: readonly(sharedLastVerifiedAt),
    cachedProof: readonly(sharedCachedProof),
    recovery: readonly(sharedRecovery),
    recoveryError: readonly(sharedRecoveryError),
    removals: readonly(sharedRemovals) as unknown as Readonly<Ref<ContentPackRemovalState | null>>,
    loading: readonly(loading),
    error: readonly(error),
    refresh,
    refreshRecovery,
    dismissRecovery,
    refreshRemovals,
    removePack,
    restorePack,
    planPinMove,
    applyPinMove,
    uninstallPackVersion,
    installRelease,
    importPack,
    listGatewayArchives,
    installGatewayArchive,
  }
}
