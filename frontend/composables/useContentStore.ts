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
  componentCreditValue: number
  owned: boolean
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

export interface ContentStoreProductDiscount {
  id: string
  version: number
  percent: number
  startsOn: string | null
  endsOn: string | null
  timezone: 'Asia/Phnom_Penh'
  listCreditPrice: number
  discountedCreditPrice: number
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
  creditPrice: number
  free: boolean
  owned: boolean
  retired: boolean
  successorProductId: string | null
  currentRelease: ContentStoreRelease | null
  compatible: boolean
  compatibilityReason: string | null
  bundleComponents: ContentStoreBundleComponent[]
  ownedComponentCreditValue: number
  showcaseVideos: ContentStoreShowcaseVideo[]
  presentation: ContentStoreProductPresentation
  discount: ContentStoreProductDiscount | null
}

export interface ContentStoreAccount {
  accountId: string
  contentAccountId: string
  availableCredits: number
  contentSpendableCredits: number
  owned: Array<{
    entitlementFamily: string
    productId: string
    title: string
    kind: ContentStoreProductKind
    grantedAt: string
    purchaseId: string | null
    currentRelease: ContentStoreRelease | null
    showcaseVideos: ContentStoreShowcaseVideo[]
    recalledReleaseVersions: string[]
    receiptVerification: 'verified' | 'unverified'
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
  ownedByActiveAccount: boolean
}

export type ContentPurchaseStatus = 'quoted' | 'submitting' | 'uncertain' | 'refused' | 'completed'

export type ContentStoreDependencyState =
  | 'free' | 'owned' | 'included' | 'installed'
  | 'unavailable' | 'withdrawn' | 'recalled'

export interface ContentStoreDependency {
  position: number
  productId: string
  entitlementFamily: string
  releaseId: string
  version: string
  archiveSha256: string
  title: string
  kind: ContentStoreProductKind | 'unknown'
  states: ContentStoreDependencyState[]
}

export interface PublicContentPurchaseAttempt {
  quote_id: string
  account_id: string
  product_id: string
  release_id: string
  entitlement_family: string
  expires_at: string
  status: ContentPurchaseStatus
  base_credit_price: number
  discount_credits: number
  entitlement_families?: string[]
  bundle_closure?: Array<{
    position: number
    product_id: string
    entitlement_family: string
    release_id: string
    version: string
    archive_sha256: string
  }>
  dependencies?: ContentStoreDependency[]
  operator_discount?: {
    discount_id: string
    version: number
    percent: number
    starts_on: string | null
    ends_on: string | null
    timezone: 'Asia/Phnom_Penh'
  } | null
  operator_discount_credits?: number
  quoted_credits: number
  balance_before: number
  balance_after: number
  owned_components: string[]
  sufficient_credits: boolean
  insufficient_reason: 'insufficient_credits' | null
  shortfall_credits: number
  refusal?: {
    status: number
    code: string
    detail: string
    required_credits?: number
    available_credits?: number
    shortfall_credits?: number
  }
  uncertain_detail?: string
  ownership?: 'owned_not_installed'
  credits_charged?: number
  component_discount_credits?: number
  granted_families?: string[]
  previously_owned_families?: string[]
  replayed?: boolean
  receipt_verification?: 'unverified_phase1'
}

interface ContentStoreOverview {
  phase: 'delivery_ready'
  origin: string
  account: ContentStoreAccount
  installed: ContentStoreInstalledPack[]
  products: ContentStoreProduct[]
  shelves: ContentStoreShelf[]
  attempts: PublicContentPurchaseAttempt[]
  capabilities: {
    purchase: true
    receipt_verification: true
    download: true
    install_after_purchase: true
    restore: true
  }
}

export interface ContentStoreUiError {
  status: number | null
  code: string
  detail: string
  requiredCredits?: number
  availableCredits?: number
  shortfallCredits?: number
  terminal?: boolean
  recallReason?: string | null
  recalledAt?: string | null
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
 *                 buying and installing are available.
 * - `'restored'`— the published catalogue saved on this Mac is drawn, and
 *                 NOTHING about this account is known yet. Ownership, install
 *                 state and the balance are unresolved, not negative.
 * - `'cached'`  — GenStudio verified this session and a later fetch failed, so
 *                 the last verified catalogue stays up and is labelled stale.
 * - `'unavailable'` — there is nothing trustworthy to show.
 *
 * Only `'fresh'` enables commerce; `networkActionsDisabled` on the Store page
 * is `catalogFreshness !== 'fresh'`, so `'restored'` disables purchase,
 * install and Restore purchases without needing a flag of its own.
 */
export type ContentStoreCatalogFreshness = 'fresh' | 'restored' | 'cached' | 'unavailable'

/**
 * How long a verified overview may back a SILENT background revalidation.
 *
 * Every `refresh()` still goes to the network with `cache: 'no-store'` — this
 * TTL never suppresses a fetch, and no ownership, install state or balance is
 * ever served from a store that was not just verified. All it decides is
 * whether re-opening the Store is allowed to look calm while that fetch runs.
 *
 * Five minutes is chosen against what actually changes underneath: ownership
 * and install state only move through this app's own purchase, install and
 * restore paths, and each of those forces its own visible refetch. What can
 * move without Story Studio knowing is the published catalogue and the credit
 * balance, and neither is worth a loading state a customer sees on every
 * visit. Past five minutes we stop being quiet: the fetch is identical, but
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
    case 'CONTENT_STORE_KEY_REQUIRED':
    case 'CONTENT_STORE_SCOPE_REQUIRED': return failure('Content Store access is needed', 'Open Settings and test the Content Store scope, then refresh.', true)
    case 'CONTENT_STORE_KEYCHAIN_UNAVAILABLE': return failure('This Mac\u2019s Keychain is not available', 'Sign in to macOS and unlock the Keychain, restart Story Studio, then try again.')
    case 'CONTENT_STORE_SIGNING_KEY_MISSING': return failure('Content Store access is needed', 'GenStudio did not publish the signing key needed to verify this Content Store proof. Refresh later.')
    case 'CONTENT_PRODUCT_NOT_AVAILABLE': return failure('This product is not available', 'Refresh the Store to see currently published products.')
    case 'CONTENT_PRODUCT_ALREADY_OWNED': return failure('Already owned in GenStudio', 'Restore purchases to verify ownership on this Mac.')
    case 'CONTENT_PRODUCT_RETIRED': return failure('This product is retired', 'Choose a currently published product instead.')
    case 'CONTENT_PRODUCT_INCOMPATIBLE':
    case 'incompatible_story_version': return failure('A newer Story Studio version is needed', 'Update Story Studio before requesting this release.')
    case 'CONTENT_RELEASE_NOT_AVAILABLE': return failure('This release is not available', 'Refresh the Store and choose a published release.')
    case 'CONTENT_STORE_QUOTE_NOT_FOUND': return failure('This quote is no longer available', 'Close it and request a new exact quote.')
    case 'CONTENT_PURCHASE_NOT_SENT': return failure('This purchase was not sent', 'Request or retry the saved exact quote when GenStudio is available.')
    case 'insufficient_credits': return failure('More credits are needed', 'Add credits, then request a new exact quote.')
    case 'quote_expired':
    case 'quote_rejected': return failure('This quote can no longer be used', 'Close it and request a new exact quote.')
    case 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN': return failure('GenStudio’s answer is uncertain', 'Retry this exact purchase; Story Studio will reuse its saved attempt.')
    case 'signing_unavailable': return failure('The Content Store is not open yet', 'Try again after GenStudio can sign Content Store evidence.')
    case 'CONTENT_STORE_ACCOUNT_MISMATCH':
    case 'CONTENT_PURCHASE_ACCOUNT_MISMATCH':
    case 'CONTENT_PACK_OWNED_RELEASE_MISMATCH':
    case 'CONTENT_PACK_NOT_OWNED':
    case 'not_entitled': return failure('Ownership could not be confirmed', 'Restore purchases to verify the active Gateway account.')
    case 'download_grant_expired': return failure('The download authorization expired', 'Request the owned release again to receive a new authorization.')
    case 'archive_limit_exceeded':
    case 'CONTENT_PACK_TOO_LARGE_FOR_THIS_APP': return failure('This archive is too large to install safely', 'Choose another published release or contact the publisher.')
    case 'CONTENT_PACK_REQUIRES_NEWER_APP': return failure('A newer Story Studio version is needed', 'Update Story Studio before installing this release.')
    case 'CONTENT_PACK_ARCHIVE_UNAVAILABLE': return failure('This archive is not available', 'Refresh the owned release and try again later.')
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
    case 'CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH': return failure('GenStudio has not attested to the versions this pack requires', 'Refreshing will not clear this. Install the newest release of this pack, or contact the publisher.')
    case 'CONTENT_PACK_DEPENDENCY_CYCLE':
    case 'CONTENT_PACK_DEPENDENCY_NOT_OWNED':
    case 'CONTENT_PACK_NESTED_CLOSURE_UNSUPPORTED': return failure('This Content Pack cannot be installed', 'Refresh the owned release and its required dependencies before trying again.')
    case 'CONTENT_PACK_RECEIPT_MISSING':
    case 'CONTENT_PACK_REMOTE_IDENTITY_MISMATCH': return failure('This Content Pack could not be verified', 'Restore purchases, then refresh the owned release before trying again.')
    case 'release_recalled': return failure('A Content Pack release was recalled', 'Ownership remains permanent. Install the newest safe owned release when available.')
    case 'CONTENT_PACK_DISK_UNAVAILABLE':
    case 'CONTENT_PACK_STAGING_FAILED':
    case 'CONTENT_PACK_ACTIVATION_FAILED': return failure('This Mac could not prepare the install', 'Check available disk space, then install the owned release again.')
    case 'CONTENT_STORE_REQUEST_INVALID':
    case 'CONTENT_STORE_REQUEST_TOO_LARGE': return failure('This Content Store request is invalid', 'Refresh the Store and try the action again.')
    case 'CONTENT_STORE_UPSTREAM_REFUSED': return failure('GenStudio could not complete this request', 'Refresh the Store before trying again.')
    // The limit lives in the installed build, so refreshing cannot clear it --
    // only a version with a larger bound can. On 2026-08-25 this fell to the
    // default below and told the owner his whole Store was "unavailable" while
    // every count sat at zero, which is a day of guessing instead of a sentence.
    case 'CONTENT_STORE_PAYLOAD_TOO_LARGE': return failure('The Content Store sent more than this version can read', 'Update Story Studio; refreshing will not clear this.')
    default: return failure('The Content Store is unavailable', 'Refresh the Store before trying again.')
  }
}

let sessionOverview: { accountId: string; origin: string; verifiedAt: string } | null = null
const sharedAccount = ref<ContentStoreAccount | null>(null)
const sharedProducts = ref<ContentStoreProduct[]>([])
const sharedInstalled = ref<ContentStoreInstalledPack[]>([])
const sharedShelves = ref<ContentStoreShelf[]>([])
const sharedAttempts = ref<PublicContentPurchaseAttempt[]>([])
const sharedCatalogFreshness = ref<ContentStoreCatalogFreshness>('unavailable')
const sharedLastVerifiedAt = ref<string | null>(null)
const sharedLastVerifiedProof = ref<ContentStoreCachedProof | null>(null)
const sharedRecovery = ref<ContentPackRecovery | null>(null)
const sharedRecoveryError = ref<ContentPackRecoveryError | null>(null)
const sharedCachedProof = computed<ContentStoreCachedProof | null>(() =>
  sharedCatalogFreshness.value === 'cached' ? sharedLastVerifiedProof.value : null)
/**
 * False for exactly one state: a catalogue restored from disk, before
 * GenStudio has answered. Every surface that would otherwise show ownership,
 * install state or a balance must show that it is still being checked instead.
 * An unverified absence is not the same fact as "you do not own this", and
 * rendering it as one is the mistake this flag exists to prevent.
 */
const sharedOwnershipResolved = computed<boolean>(() => sharedCatalogFreshness.value !== 'restored')
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
 * Only the catalogue is restored. `sharedAccount`, `sharedInstalled` and
 * `sharedAttempts` stay empty and `sharedLastVerifiedAt` stays null, because
 * nothing here was verified this session and `lastVerifiedAt` means exactly
 * that. Freshness becomes `'restored'`, which keeps commerce switched off and
 * tells every surface to say it is still checking.
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
async function persistVerifiedCatalog(overview: ContentStoreOverview, origin: string): Promise<void> {
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
  sharedAttempts.value = []
  sharedCatalogFreshness.value = 'unavailable'
  sharedLastVerifiedAt.value = null
  sharedLastVerifiedProof.value = null
  sharedRecovery.value = null
  sharedRecoveryError.value = null
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
    ...(Number.isInteger(data.required_credits) ? { requiredCredits: data.required_credits } : {}),
    ...(Number.isInteger(data.available_credits) ? { availableCredits: data.available_credits } : {}),
    ...(Number.isInteger(data.shortfall_credits) ? { shortfallCredits: data.shortfall_credits } : {}),
    ...(data.terminal === true ? { terminal: true } : {}),
    ...(typeof data.recall_reason === 'string' || data.recall_reason === null
      ? { recallReason: data.recall_reason as string | null } : {}),
    ...(typeof data.recalled_at === 'string' || data.recalled_at === null
      ? { recalledAt: data.recalled_at as string | null } : {}),
  }
}

export function useContentStore(): {
  account: Readonly<Ref<ContentStoreAccount | null>>
  products: Readonly<Ref<ContentStoreProduct[]>>
  installed: Readonly<Ref<ContentStoreInstalledPack[]>>
  shelves: Readonly<Ref<ContentStoreShelf[]>>
  attempts: Readonly<Ref<PublicContentPurchaseAttempt[]>>
  catalogFreshness: Readonly<Ref<ContentStoreCatalogFreshness>>
  ownershipResolved: Readonly<Ref<boolean>>
  lastVerifiedAt: Readonly<Ref<string | null>>
  cachedProof: Readonly<Ref<ContentStoreCachedProof | null>>
  recovery: Readonly<Ref<ContentPackRecovery | null>>
  recoveryError: Readonly<Ref<ContentPackRecoveryError | null>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<ContentStoreUiError | null>>
  refresh: (options?: { background?: boolean }) => Promise<void>
  refreshRecovery: () => Promise<void>
  dismissRecovery: (incidentId: string) => Promise<void>
  requestQuote: (productId: string, releaseId?: string | null) => Promise<PublicContentPurchaseAttempt>
  confirmPurchase: (quoteId: string, options?: { refreshOverview?: boolean }) => Promise<PublicContentPurchaseAttempt>
  restoreOwnership: () => Promise<void>
  installRelease: (releaseId: string, options?: { refreshOverview?: boolean; onProgress?: (operation: ContentStoreInstallOperation) => void }) => Promise<{ pack_id: string; version: string; activated: boolean }>
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
    sharedAccount.value = overview.account
    sharedProducts.value = overview.products
    sharedInstalled.value = overview.installed ?? []
    sharedShelves.value = overview.shelves
    sharedAttempts.value = overview.attempts
    sharedCatalogFreshness.value = 'fresh'
    sharedLastVerifiedAt.value = verifiedAt
    if (sessionOverview && (sessionOverview.accountId !== overview.account.accountId || sessionOverview.origin !== origin)) sessionOverview = null
    sessionOverview = { accountId: overview.account.accountId, origin, verifiedAt }
    sharedLastVerifiedProof.value = { accountId: overview.account.accountId, origin, verifiedAt }
    lastCatalogPersist = persistVerifiedCatalog(overview, origin).catch(() => {
      // Saving the catalogue is an optimisation for the next launch. It must
      // never turn a verified overview that is already on screen into an error.
    })
  }

  function replaceAttempt(attempt: PublicContentPurchaseAttempt): void {
    const index = sharedAttempts.value.findIndex(row => row.quote_id === attempt.quote_id)
    if (index === -1) sharedAttempts.value = [attempt, ...sharedAttempts.value]
    else sharedAttempts.value.splice(index, 1, attempt)
  }

  function applyFailedAttempt(quoteId: string, cause: any): void {
    const data = cause?.data || cause?.response?._data || {}
    if (data.attempt && typeof data.attempt === 'object') {
      const current = sharedAttempts.value.find(row => row.quote_id === quoteId)
      replaceAttempt({ ...current, ...data.attempt } as PublicContentPurchaseAttempt)
      return
    }
    const current = sharedAttempts.value.find(row => row.quote_id === quoteId)
    if (!current) return
    const status = data.status
    if (!['quoted', 'submitting', 'uncertain', 'refused', 'completed'].includes(status)) return
    replaceAttempt({
      ...current,
      status,
      ...(status === 'uncertain' ? { uncertain_detail: data.detail } : {}),
      ...(status === 'refused' && typeof data.code === 'string' ? {
        refusal: {
          status: Number(cause?.status || cause?.response?.status || 0),
          code: data.code,
          detail: data.detail || 'GenStudio declined this purchase.',
          ...(Number.isInteger(data.required_credits) ? { required_credits: data.required_credits } : {}),
          ...(Number.isInteger(data.available_credits) ? { available_credits: data.available_credits } : {}),
          ...(Number.isInteger(data.shortfall_credits) ? { shortfall_credits: data.shortfall_credits } : {}),
        },
      } : {}),
    })
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
      applyOverview(overview, generation)
      if (generation === sharedOverviewGeneration) error.value = null
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
          sharedAttempts.value = []
        }
        sharedCatalogFreshness.value = hasVerifiedOverview ? 'cached' : hasRestoredCatalog ? 'restored' : 'unavailable'
        if (!silent) error.value = uiError(cause, 'The Content Store could not be loaded.')
      }
      throw cause
    } finally {
      if (!silent) loading.value = false
    }
  }

  async function requestQuote(productId: string, releaseId: string | null = null): Promise<PublicContentPurchaseAttempt> {
    error.value = null
    try {
      const attempt = await post<PublicContentPurchaseAttempt>('/content-store/quotes', {
        product_id: productId,
        release_id: releaseId,
      })
      replaceAttempt(attempt)
      return attempt
    } catch (cause: any) {
      error.value = uiError(cause, 'GenStudio could not create an exact quote.')
      throw cause
    }
  }

  async function confirmPurchase(
    quoteId: string,
    options: { refreshOverview?: boolean } = {},
  ): Promise<PublicContentPurchaseAttempt> {
    const wantsOverview = options.refreshOverview !== false
    const generation = wantsOverview ? beginOverviewRequest() : sharedOverviewGeneration
    error.value = null
    try {
      const attempt = await post<PublicContentPurchaseAttempt>(
        `/content-store/quotes/${encodeURIComponent(quoteId)}/purchase`,
        {},
      )
      replaceAttempt(attempt)
      if (attempt.status === 'completed' && typeof attempt.balance_after === 'number' && sharedAccount.value) {
        sharedAccount.value = { ...sharedAccount.value, contentSpendableCredits: attempt.balance_after }
      }
      // A batch settles many quotes and re-reads the overview once at the end
      // rather than after every pack (each read is several GenStudio calls).
      if (attempt.status === 'completed' && wantsOverview) {
        void (async () => {
          try {
            const overview = await get<ContentStoreOverview>('/content-store', { cache: 'no-store' })
            if (generation === sharedOverviewGeneration) {
              applyOverview(overview, generation)
              if (!overview.attempts.some(row => row.quote_id === attempt.quote_id)) sharedAttempts.value = [attempt, ...overview.attempts]
            }
          } catch {
            // Ownership is already durable. A read-side refresh must not turn success into failure.
          }
        })()
      }
      return attempt
    } catch (cause: any) {
      applyFailedAttempt(quoteId, cause)
      error.value = uiError(cause, 'GenStudio could not finish this purchase.')
      throw cause
    }
  }

  async function restoreOwnership(): Promise<void> {
    const generation = beginOverviewRequest()
    loading.value = true
    error.value = null
    try {
      const overview = await post<ContentStoreOverview>('/content-store/restore', {})
      applyOverview(overview, generation)
    } catch (cause: any) {
      error.value = uiError(cause, 'GenStudio ownership could not be restored.')
      throw cause
    } finally {
      loading.value = false
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
          const failure = operation.failure || { code: 'CONTENT_STORE_UPSTREAM_REFUSED', detail: 'This Content Pack could not be installed.' }
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

  return {
    account: readonly(sharedAccount) as unknown as Readonly<Ref<ContentStoreAccount | null>>,
    products: readonly(sharedProducts) as unknown as Readonly<Ref<ContentStoreProduct[]>>,
    installed: readonly(sharedInstalled) as unknown as Readonly<Ref<ContentStoreInstalledPack[]>>,
    shelves: readonly(sharedShelves) as unknown as Readonly<Ref<ContentStoreShelf[]>>,
    attempts: readonly(sharedAttempts) as unknown as Readonly<Ref<PublicContentPurchaseAttempt[]>>,
    catalogFreshness: readonly(sharedCatalogFreshness),
    ownershipResolved: readonly(sharedOwnershipResolved),
    lastVerifiedAt: readonly(sharedLastVerifiedAt),
    cachedProof: readonly(sharedCachedProof),
    recovery: readonly(sharedRecovery),
    recoveryError: readonly(sharedRecoveryError),
    loading: readonly(loading),
    error: readonly(error),
    refresh,
    refreshRecovery,
    dismissRecovery,
    requestQuote,
    confirmPurchase,
    restoreOwnership,
    installRelease,
  }
}
